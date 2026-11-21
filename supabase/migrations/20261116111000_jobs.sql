-- Fase 2 · Cola de trabajos asíncronos (docs/01-arquitectura.md, §4).
--
-- Una sola tabla para todo lo que no cabe en una petición: render de imagen,
-- vídeo, procesado de fuentes… El contrato es pequeño a propósito —encolar,
-- reclamar, terminar, fallar, cancelar— para poder mover la cola a un servicio
-- dedicado si el volumen lo pide.
--
--   * Reclamar usa FOR UPDATE SKIP LOCKED y una reserva con caducidad: si el
--     trabajador muere, otro recoge el trabajo cuando caduca.
--   * Clave de idempotencia por organización: encolar dos veces no duplica.
--   * Reintentos con espera creciente hasta `max_attempts`; después el trabajo
--     queda `failed`, visible, con su último error.
--   * Solo el servidor (clave de servicio) encola y mueve trabajos. Las
--     personas ven el estado de los trabajos de sus marcas.
--   * `kind` es texto libre («media.render», «source.process»…): qué tipos
--     existen lo decide quien los encola y quien los reclama, no esta tabla.

create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Opcional: hay trabajos de toda la organización.
  brand_id uuid,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 262144),
  status public.job_status not null default 'queued',
  -- Mayor número = antes. La prioridad por plan la decidirá quien encola.
  priority integer not null default 0 check (priority between -100 and 100),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  run_after timestamptz not null default now(),
  locked_by text check (locked_by is null or char_length(locked_by) between 1 and 200),
  locked_until timestamptz,
  result jsonb check (result is null or pg_column_size(result) <= 262144),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  unique (organization_id, idempotency_key),
  -- Un trabajo tiene dueño exactamente mientras está en curso.
  check ((status = 'running') = (locked_by is not null)),
  check ((locked_by is null) = (locked_until is null))
);
create index jobs_queued_idx on public.jobs (priority desc, run_after, created_at) where status = 'queued';
create index jobs_running_idx on public.jobs (locked_until) where status = 'running';
create index jobs_brand_created_idx on public.jobs (brand_id, created_at desc) where brand_id is not null;
create index jobs_org_created_idx on public.jobs (organization_id, created_at desc);

create trigger jobs_touch before update on public.jobs
  for each row execute function private.touch_updated_at();

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Encola un trabajo. Con una clave de idempotencia ya usada en la organización
-- devuelve el trabajo que ya existía, sin tocarlo.
create function public.enqueue_job(
  p_organization_id uuid,
  p_kind text,
  p_payload jsonb,
  p_idempotency_key text,
  p_brand_id uuid default null,
  p_priority integer default 0,
  p_max_attempts integer default 3,
  p_run_after timestamptz default null,
  p_created_by uuid default null
) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  insert into public.jobs (organization_id, brand_id, kind, payload, idempotency_key, priority, max_attempts,
                           run_after, created_by)
  values (p_organization_id, p_brand_id, p_kind, coalesce(p_payload, '{}'::jsonb), p_idempotency_key,
          coalesce(p_priority, 0), coalesce(p_max_attempts, 3), coalesce(p_run_after, now()), p_created_by)
  on conflict (organization_id, idempotency_key) do nothing
  returning * into v_job;

  if not found then
    select * into v_job from public.jobs j
    where j.organization_id = p_organization_id and j.idempotency_key = p_idempotency_key;
  end if;
  return v_job;
end $$;

-- Reclama hasta p_limit trabajos para un trabajador durante p_lease_seconds.
-- Entran los que están en cola y ya toca ejecutar, y los que estaban en curso
-- con la reserva caducada (su trabajador murió). Los caducados sin intentos
-- restantes se cierran antes como fallidos.
create function public.claim_jobs(
  p_worker text,
  p_kinds text[] default null,
  p_limit integer default 1,
  p_lease_seconds integer default 300
) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'Hace falta el nombre del trabajador' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Se pueden reclamar entre 1 y 100 trabajos a la vez' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 5 and 3600 then
    raise exception 'La reserva debe durar entre 5 segundos y una hora' using errcode = '22023';
  end if;

  update public.jobs j
  set status = 'failed', locked_by = null, locked_until = null, finished_at = now(),
      last_error = 'El trabajador dejó de responder y no quedan intentos'
  where j.id in (
    select d.id from public.jobs d
    where d.status = 'running' and d.locked_until < now() and d.attempts >= d.max_attempts
    for update skip locked
  );

  return query
    with candidates as (
      select c.id from public.jobs c
      where ((c.status = 'queued' and c.run_after <= now()) or (c.status = 'running' and c.locked_until < now()))
        and c.attempts < c.max_attempts
        and (p_kinds is null or c.kind = any (p_kinds))
      order by c.priority desc, c.run_after, c.created_at
      limit p_limit
      for update skip locked
    )
    update public.jobs j
    set status = 'running', attempts = j.attempts + 1, locked_by = p_worker,
        locked_until = now() + make_interval(secs => p_lease_seconds)
    from candidates
    where j.id = candidates.id
    returning j.*;
end $$;

-- Cierra un trabajo como terminado. Solo quien lo tiene reservado: si la
-- reserva caducó y otro lo reclamó, falla y el resultado tardío se descarta.
create function public.complete_job(p_job_id uuid, p_worker text, p_result jsonb default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  update public.jobs j
  set status = 'succeeded', result = p_result, locked_by = null, locked_until = null,
      last_error = null, finished_at = now()
  where j.id = p_job_id and j.status = 'running' and j.locked_by = p_worker
  returning * into v_job;
  if not found then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;
  return v_job;
end $$;

-- Anota un fallo. Si quedan intentos (y p_retry), vuelve a la cola con espera
-- creciente: 30 s, 1 min, 2 min… hasta una hora. Si no, queda como fallido.
create function public.fail_job(p_job_id uuid, p_worker text, p_error text, p_retry boolean default true)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_error text := left(coalesce(nullif(btrim(p_error), ''), 'Error sin descripción'), 1000);
begin
  select * into v_job from public.jobs j
  where j.id = p_job_id and j.status = 'running' and j.locked_by = p_worker
  for update;
  if not found then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;

  if coalesce(p_retry, true) and v_job.attempts < v_job.max_attempts then
    update public.jobs j
    set status = 'queued', locked_by = null, locked_until = null, last_error = v_error,
        run_after = now() + make_interval(secs => least(3600, 30 * power(2, v_job.attempts - 1)))
    where j.id = v_job.id
    returning * into v_job;
  else
    update public.jobs j
    set status = 'failed', locked_by = null, locked_until = null, last_error = v_error, finished_at = now()
    where j.id = v_job.id
    returning * into v_job;
  end if;
  return v_job;
end $$;

-- Cancela un trabajo en cola o en curso. Si estaba en curso, su trabajador lo
-- descubre al intentar cerrarlo.
create function public.cancel_job(p_job_id uuid)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  update public.jobs j
  set status = 'cancelled', locked_by = null, locked_until = null, finished_at = now()
  where j.id = p_job_id and j.status in ('queued', 'running')
  returning * into v_job;
  if not found then
    raise exception 'El trabajo no existe o ya ha terminado' using errcode = 'P0001';
  end if;
  return v_job;
end $$;

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.jobs enable row level security;

-- Los trabajos de una marca los ve quien ve la marca; los de toda la
-- organización, sus administradores.
create policy jobs_select on public.jobs for select to authenticated
  using (
    (brand_id is not null and brand_id in (select private.brand_ids_with('view')))
    or (brand_id is null and organization_id in (select private.my_admin_org_ids()))
  );

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select on public.jobs to authenticated, service_role;

revoke all on function public.enqueue_job(uuid, text, jsonb, text, uuid, integer, integer, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.claim_jobs(text, text[], integer, integer) from public, anon, authenticated;
revoke all on function public.complete_job(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.cancel_job(uuid) from public, anon, authenticated;

grant execute on function public.enqueue_job(uuid, text, jsonb, text, uuid, integer, integer, timestamptz, uuid) to service_role;
grant execute on function public.claim_jobs(text, text[], integer, integer) to service_role;
grant execute on function public.complete_job(uuid, text, jsonb) to service_role;
grant execute on function public.fail_job(uuid, text, text, boolean) to service_role;
grant execute on function public.cancel_job(uuid) to service_role;
