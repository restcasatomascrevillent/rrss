-- Fase 2 · Cimientos del servicio de IA: registro de generaciones, libro de
-- consumo y cupo por organización.
--
-- Reglas de diseño (ver docs/02-modelo-de-datos.md, «Consumo y cupos de IA»):
--   * El cupo lo impone la base de datos. Antes de llamar a un proveedor se
--     RESERVA una cota superior del coste; al terminar se sustituye por el coste
--     real, y si el proveedor falla la reserva se devuelve entera.
--   * Las reservas de una organización se serializan bloqueando la fila de su
--     cupo: dos peticiones simultáneas no pueden superarlo.
--   * El consumo es un libro de solo añadir (`ai_usage`), sin clave foránea: los
--     costes sobreviven al borrado de la marca o de la organización.
--   * Nada de esto se puede escribir desde el navegador. Reservar, cerrar y
--     fallar una generación son funciones que solo ejecuta el servidor (clave de
--     servicio), que indica en nombre de qué usuario actúa.
--   * Sin cupo asignado no se genera: el presupuesto es una decisión del
--     negocio y aquí no se inventa ninguno.
--   * Todas las cantidades van en millonésimas («micros») de la moneda de
--     cuenta de la plataforma, que es única y no se guarda en estas tablas.
--   * No hay ningún proveedor ni modelo escrito aquí: son texto libre que
--     rellena el servicio de IA a partir de su configuración.

-- ───────────────────────────── Tipos ─────────────────────────────

create type public.ai_task as enum ('text', 'vision', 'image', 'video', 'transcription', 'embedding');
-- reserved: cupo apartado, proveedor en curso · succeeded: terminada, con coste ·
-- failed: el proveedor falló, sin coste · expired: nadie la cerró a tiempo y la
-- reserva se devolvió sola.
create type public.ai_generation_status as enum ('reserved', 'succeeded', 'failed', 'expired');

-- ───────────────────────────── Tablas ─────────────────────────────

-- Límites por organización. Hoy solo existe la métrica del coste mensual de IA;
-- la tabla es genérica para que los planes (Fase 6) añadan otras sin migrar.
create table public.usage_quotas (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  metric text not null check (metric in ('ai_cost_micros')),
  -- Mes natural en UTC.
  period text not null default 'month' check (period in ('month')),
  limit_value bigint not null check (limit_value >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, metric)
);

-- Una fila por llamada a un proveedor de IA: qué se pidió, con qué modelo, qué
-- consumió, cuánto costó, cuánto tardó y cómo acabó.
create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  requested_by uuid references auth.users (id) on delete set null,
  task public.ai_task not null,
  -- Para qué se pidió («post.caption», «profile.proposal»…): lo fija el producto.
  purpose text not null check (purpose ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  provider text not null check (char_length(provider) between 1 and 64),
  model text not null check (char_length(model) between 1 and 128),
  status public.ai_generation_status not null default 'reserved',
  -- Mes al que se imputan la reserva y el coste (el de la reserva).
  period_start date not null,
  reserved_micros bigint not null check (reserved_micros > 0),
  reserved_until timestamptz not null,
  cost_micros bigint check (cost_micros is null or cost_micros >= 0),
  -- Unidades consumidas tal como las da el proveedor: {"input_tokens": 812, …}
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  output jsonb check (output is null or pg_column_size(output) <= 262144),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 200),
  error_code text check (error_code is null or char_length(error_code) <= 64),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  check ((status = 'succeeded') = (cost_micros is not null))
);
create index ai_generations_brand_created_idx on public.ai_generations (brand_id, created_at desc);
create index ai_generations_org_created_idx on public.ai_generations (organization_id, created_at desc);
-- Reservas vivas: es lo que recorre la limpieza de caducadas.
create index ai_generations_reserved_idx on public.ai_generations (organization_id, reserved_until) where status = 'reserved';

-- Libro de consumo, de solo añadir. Cada generación deja como mucho un apunte
-- de cada tipo:
--   reserve   +reserva                 al apartar el cupo
--   settle    −reserva, +coste real    al terminar bien
--   release   −reserva                 al fallar o caducar
-- Cupo comprometido de un mes = suma de (reserved_delta + cost_delta).
-- Coste real = suma de cost_delta.
-- Sin FK a propósito, como audit_logs: el coste debe sobrevivir a lo que lo causó.
create table public.ai_usage (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  brand_id uuid,
  generation_id uuid not null,
  period_start date not null,
  entry text not null check (entry in ('reserve', 'settle', 'release')),
  reserved_delta_micros bigint not null,
  cost_delta_micros bigint not null default 0 check (cost_delta_micros >= 0),
  created_at timestamptz not null default now(),
  unique (generation_id, entry)
);
create index ai_usage_org_period_idx on public.ai_usage (organization_id, period_start);
create index ai_usage_org_created_idx on public.ai_usage (organization_id, created_at);

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Primer día del mes (UTC) al que pertenece un instante.
create function private.ai_period_start(p_at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (date_trunc('month', p_at at time zone 'UTC'))::date;
$$;

-- ¿Tiene este usuario la capacidad sobre la marca? Igual que
-- private.brand_ids_with(), pero para un usuario indicado: la usan las
-- funciones que el servidor ejecuta en nombre de alguien.
create function private.user_has_brand_capability(p_user_id uuid, p_brand_id uuid, p_capability text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.brands b
    join public.organization_members om
      on om.organization_id = b.organization_id and om.user_id = p_user_id
    left join public.brand_members bm
      on bm.brand_id = b.id and bm.user_id = om.user_id
    where b.id = p_brand_id
      and ((om.role in ('owner', 'admin') and private.brand_role_grants('manager', p_capability))
        or (bm.role is not null and private.brand_role_grants(bm.role, p_capability)))
  );
$$;

-- Devuelve el cupo de las reservas que nadie cerró a tiempo (el servidor murió
-- a media llamada). Se ejecuta al reservar, así no depende de ningún reloj.
create function private.ai_release_expired(p_organization_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with expired as (
    update public.ai_generations g
    set status = 'expired', finished_at = now(), error_code = 'reservation_expired',
        error_message = 'La generación no se cerró antes de que caducara su reserva'
    where g.organization_id = p_organization_id and g.status = 'reserved' and g.reserved_until < now()
    returning g.organization_id, g.brand_id, g.id, g.period_start, g.reserved_micros
  )
  insert into public.ai_usage (organization_id, brand_id, generation_id, period_start, entry, reserved_delta_micros)
  select e.organization_id, e.brand_id, e.id, e.period_start, 'release', -e.reserved_micros from expired e;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Aparta cupo para una generación y la registra. Falla, sin dejar rastro, si:
--   42501  el usuario no puede crear contenido en esa marca
--   AI002  la organización no tiene cupo de IA asignado
--   AI001  no queda cupo suficiente este mes (DETAIL: cifras en JSON)
create function public.ai_reserve_generation(
  p_user_id uuid,
  p_brand_id uuid,
  p_task public.ai_task,
  p_purpose text,
  p_provider text,
  p_model text,
  p_reserve_micros bigint,
  p_ttl_seconds integer default 600
) returns public.ai_generations
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_limit bigint;
  v_committed bigint;
  v_period date := private.ai_period_start(now());
  v_gen public.ai_generations;
begin
  if p_reserve_micros is null or p_reserve_micros <= 0 then
    raise exception 'La reserva de cupo debe ser mayor que cero' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 10 and 86400 then
    raise exception 'La caducidad de la reserva debe estar entre 10 segundos y un día' using errcode = '22023';
  end if;

  select b.organization_id into v_org from public.brands b where b.id = p_brand_id;
  if v_org is null or p_user_id is null
     or not private.user_has_brand_capability(p_user_id, p_brand_id, 'edit') then
    raise exception 'No tienes permiso para generar contenido en esta marca' using errcode = '42501';
  end if;

  -- El bloqueo de la fila del cupo serializa las reservas de la organización:
  -- la siguiente espera aquí y, al continuar, ya ve lo que apartó la anterior.
  select q.limit_value into v_limit
  from public.usage_quotas q
  where q.organization_id = v_org and q.metric = 'ai_cost_micros'
  for update;
  if not found then
    raise exception 'Esta organización no tiene cupo de IA asignado' using errcode = 'AI002';
  end if;

  perform private.ai_release_expired(v_org);

  select coalesce(sum(u.reserved_delta_micros + u.cost_delta_micros), 0) into v_committed
  from public.ai_usage u
  where u.organization_id = v_org and u.period_start = v_period;

  if v_committed + p_reserve_micros > v_limit then
    raise exception 'El cupo de IA de este mes está agotado: no queda saldo suficiente para esta generación'
      using errcode = 'AI001',
            detail = jsonb_build_object(
              'period_start', v_period, 'limit_micros', v_limit,
              'committed_micros', v_committed, 'requested_micros', p_reserve_micros)::text;
  end if;

  insert into public.ai_generations (brand_id, organization_id, requested_by, task, purpose, provider, model,
                                     period_start, reserved_micros, reserved_until)
  values (p_brand_id, v_org, p_user_id, p_task, p_purpose, p_provider, p_model,
          v_period, p_reserve_micros, now() + make_interval(secs => p_ttl_seconds))
  returning * into v_gen;

  insert into public.ai_usage (organization_id, brand_id, generation_id, period_start, entry, reserved_delta_micros)
  values (v_org, p_brand_id, v_gen.id, v_period, 'reserve', p_reserve_micros);

  return v_gen;
end $$;

-- Cierra una generación que terminó bien: la reserva se cambia por el coste real.
-- Si la reserva ya había caducado, el coste se apunta igualmente (el gasto es
-- real aunque llegue tarde). Repetir la llamada no apunta dos veces.
create function public.ai_complete_generation(
  p_generation_id uuid,
  p_cost_micros bigint,
  p_usage jsonb default '{}'::jsonb,
  p_output jsonb default null,
  p_latency_ms integer default null,
  p_provider_request_id text default null
) returns public.ai_generations
language plpgsql security definer set search_path = '' as $$
declare
  v_gen public.ai_generations;
begin
  if p_cost_micros is null or p_cost_micros < 0 then
    raise exception 'El coste no puede ser negativo' using errcode = '22023';
  end if;

  select * into v_gen from public.ai_generations g where g.id = p_generation_id for update;
  if not found then
    raise exception 'La generación no existe' using errcode = 'P0001';
  end if;
  if v_gen.status = 'succeeded' then
    return v_gen;
  end if;
  if v_gen.status = 'failed' then
    raise exception 'La generación ya se cerró como fallida' using errcode = 'P0001';
  end if;

  insert into public.ai_usage (organization_id, brand_id, generation_id, period_start, entry,
                               reserved_delta_micros, cost_delta_micros)
  values (v_gen.organization_id, v_gen.brand_id, v_gen.id, v_gen.period_start, 'settle',
          case when v_gen.status = 'reserved' then -v_gen.reserved_micros else 0 end, p_cost_micros);

  update public.ai_generations g
  set status = 'succeeded', cost_micros = p_cost_micros, usage = coalesce(p_usage, '{}'::jsonb), output = p_output,
      latency_ms = p_latency_ms, provider_request_id = left(p_provider_request_id, 200),
      error_code = null, error_message = null, finished_at = now()
  where g.id = v_gen.id
  returning * into v_gen;

  return v_gen;
end $$;

-- Cierra una generación que falló: devuelve la reserva y no apunta coste.
create function public.ai_fail_generation(
  p_generation_id uuid,
  p_error_code text,
  p_error_message text default '',
  p_latency_ms integer default null
) returns public.ai_generations
language plpgsql security definer set search_path = '' as $$
declare
  v_gen public.ai_generations;
begin
  select * into v_gen from public.ai_generations g where g.id = p_generation_id for update;
  if not found then
    raise exception 'La generación no existe' using errcode = 'P0001';
  end if;
  if v_gen.status = 'failed' then
    return v_gen;
  end if;
  if v_gen.status = 'succeeded' then
    raise exception 'La generación ya se cerró como terminada' using errcode = 'P0001';
  end if;

  if v_gen.status = 'reserved' then
    insert into public.ai_usage (organization_id, brand_id, generation_id, period_start, entry, reserved_delta_micros)
    values (v_gen.organization_id, v_gen.brand_id, v_gen.id, v_gen.period_start, 'release', -v_gen.reserved_micros);
  end if;

  update public.ai_generations g
  set status = 'failed', error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'unknown'), 64),
      error_message = left(coalesce(p_error_message, ''), 500), latency_ms = p_latency_ms, finished_at = now()
  where g.id = v_gen.id
  returning * into v_gen;

  return v_gen;
end $$;

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Fija el cupo mensual de IA de una organización. Solo superadministradores;
-- el cambio queda en el registro de auditoría de la organización.
create function public.admin_set_ai_quota(p_organization_id uuid, p_monthly_limit_micros bigint)
returns public.usage_quotas
language plpgsql security definer set search_path = '' as $$
declare
  v_quota public.usage_quotas;
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_monthly_limit_micros is null or p_monthly_limit_micros < 0 then
    raise exception 'El cupo no puede ser negativo' using errcode = '22023';
  end if;

  insert into public.usage_quotas (organization_id, metric, limit_value, updated_by)
  values (p_organization_id, 'ai_cost_micros', p_monthly_limit_micros, (select auth.uid()))
  on conflict (organization_id, metric)
  do update set limit_value = excluded.limit_value, updated_by = excluded.updated_by
  returning * into v_quota;

  return v_quota;
end $$;

-- Coste real de IA por organización entre dos instantes (desde incluido, hasta
-- excluido). Un administrador ve las organizaciones que administra; un
-- superadministrador, todas (también las ya borradas, sin nombre).
create function public.ai_cost_by_organization(p_from timestamptz, p_to timestamptz)
returns table (organization_id uuid, organization_name text, generations bigint, cost_micros bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'Indica un periodo válido: la fecha inicial debe ser anterior a la final' using errcode = '22023';
  end if;
  return query
    select u.organization_id, o.name, count(*), coalesce(sum(u.cost_delta_micros), 0)::bigint
    from public.ai_usage u
    left join public.organizations o on o.id = u.organization_id
    where u.entry = 'settle' and u.created_at >= p_from and u.created_at < p_to
      and (private.is_platform_admin() or u.organization_id in (select private.my_admin_org_ids()))
    group by u.organization_id, o.name
    order by 4 desc, 1;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger usage_quotas_touch before update on public.usage_quotas
  for each row execute function private.touch_updated_at();
create trigger usage_quotas_audit after insert or update or delete on public.usage_quotas
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.usage_quotas enable row level security;
alter table public.ai_generations enable row level security;
alter table public.ai_usage enable row level security;

-- El cupo y el libro de consumo (dinero) solo los ven los administradores de
-- la organización. El detalle de cada generación, quien crea contenido en la marca.
create policy usage_quotas_select on public.usage_quotas for select to authenticated
  using (organization_id in (select private.my_admin_org_ids()));
create policy ai_generations_select on public.ai_generations for select to authenticated
  using (brand_id in (select private.brand_ids_with('edit')));
create policy ai_usage_select on public.ai_usage for select to authenticated
  using (organization_id in (select private.my_admin_org_ids()));

-- ───────────────────────────── Privilegios ─────────────────────────────
-- El cliente solo lee. Ni siquiera la clave de servicio escribe a mano las
-- generaciones o el libro: lo hacen las funciones de arriba.

grant select on public.usage_quotas, public.ai_generations, public.ai_usage to authenticated, service_role;
grant insert, update, delete on public.usage_quotas to service_role;

revoke all on function private.ai_period_start(timestamptz) from public, anon, authenticated;
revoke all on function private.user_has_brand_capability(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.ai_release_expired(uuid) from public, anon, authenticated;

revoke all on function public.ai_reserve_generation(uuid, uuid, public.ai_task, text, text, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.ai_complete_generation(uuid, bigint, jsonb, jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.ai_fail_generation(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.admin_set_ai_quota(uuid, bigint) from public, anon, authenticated;
revoke all on function public.ai_cost_by_organization(timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.ai_reserve_generation(uuid, uuid, public.ai_task, text, text, text, bigint, integer) to service_role;
grant execute on function public.ai_complete_generation(uuid, bigint, jsonb, jsonb, integer, text) to service_role;
grant execute on function public.ai_fail_generation(uuid, text, text, integer) to service_role;
grant execute on function public.admin_set_ai_quota(uuid, bigint) to authenticated, service_role;
grant execute on function public.ai_cost_by_organization(timestamptz, timestamptz) to authenticated, service_role;
