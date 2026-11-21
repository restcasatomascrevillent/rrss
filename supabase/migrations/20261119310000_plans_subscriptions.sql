-- Fase 6 · Planes, suscripciones y límites por plan.
--
-- Reglas de diseño (ver docs/02-modelo-de-datos.md, «Planes y facturación»):
--   * Los planes son FILAS (`plans`), no código: precio, periodo, derechos
--     (funciones activables) y cuotas (marcas, personas, almacenamiento, cupo
--     mensual de IA). Editar un plan o cambiar el de una organización cambia sus
--     límites en la siguiente operación, sin desplegar nada.
--   * Cada organización tiene una fila en `subscriptions` (se crea sola al dar
--     de alta la organización). Su plan efectivo es el de la suscripción si
--     está vigente (`active`, `trialing`, `past_due`); si no hay plan asignado o
--     la suscripción terminó (cancelada, impagada…), el plan POR DEFECTO
--     (`plans.is_default`, hoy «Prueba»: límites bajos y sin cupo de IA).
--   * Los límites los impone la base de datos, con mensajes para personas:
--     crear o desarchivar una marca, invitar y aceptar invitaciones, subir
--     archivos, encargar reels y reservar cupo de IA. Errores:
--       PL001  se ha llegado a un límite del plan (DETAIL: cifras en JSON)
--       PL002  el plan no incluye esa función
--   * Lo que genera el servidor (reels, imágenes con IA) se comprueba al
--     ENCARGARLO; el resultado puede rebasar el almacenamiento en lo que ocupe.
--   * El cupo mensual de IA sale del plan, salvo que un superadministrador lo
--     sobrescriba con `admin_set_ai_quota` (fila en `usage_quotas`), que se
--     retira con `admin_clear_ai_quota`.
--   * Importes en millonésimas («micros») de la moneda de cuenta de la
--     plataforma, la MISMA que los costes de IA: así ingresos − coste = margen.
--   * Stripe solo escribe por `billing_apply_stripe_event` (clave de servicio),
--     idempotente por evento. Ningún dato de pago pasa por aquí.
--   * Las organizaciones que ya existían quedan en el plan «Heredado» (sin
--     límites, sin cupo de IA del plan): conservan exactamente lo que tenían.

-- ───────────────────────────── Tipos ─────────────────────────────

create type public.billing_interval as enum ('month', 'year');
-- Los estados de una suscripción de Stripe, tal cual. Las asignadas a mano o
-- por defecto están siempre `active`.
create type public.subscription_status as enum (
  'active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'
);
-- default: sin plan asignado (manda el plan por defecto) · manual: lo asignó un
-- superadministrador · stripe: lo mantiene el aviso de Stripe.
create type public.subscription_source as enum ('default', 'manual', 'stripe');

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  -- Identificador estable para el código y las pruebas; no se edita.
  code text not null unique check (code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  -- Precio por periodo, en micros de la moneda de cuenta. 0 = gratis o «a medida»
  -- (el precio pactado va en subscriptions.custom_price_micros).
  price_micros bigint not null default 0 check (price_micros >= 0),
  billing_interval public.billing_interval not null default 'month',
  -- Cuotas. NULL = sin límite.
  max_brands integer check (max_brands is null or max_brands >= 1),
  max_members integer check (max_members is null or max_members >= 1),
  max_storage_bytes bigint check (max_storage_bytes is null or max_storage_bytes >= 0),
  -- Cupo mensual de IA. 0 = el plan no incluye IA (sin cupo asignado).
  ai_monthly_micros bigint not null default 0 check (ai_monthly_micros >= 0),
  -- Derechos: funciones que el plan activa. Una función nueva necesita código
  -- que la use, así que ampliar la lista es una migración.
  features text[] not null default '{}'
    check (features <@ array['ai_text', 'ai_image', 'ai_video', 'reels', 'publishing']::text[]),
  -- Se ofrece para contratar en línea (Stripe).
  is_public boolean not null default false,
  -- El de las organizaciones sin plan asignado. Exactamente uno.
  is_default boolean not null default false,
  -- Se puede asignar. Desactivar no quita el plan a quien ya lo tiene.
  active boolean not null default true,
  -- Precio de Stripe que corresponde a este plan (modo de pruebas o real).
  stripe_price_id text unique check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9_]{1,200}$'),
  sort_order integer not null default 0,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_default or active)
);
create unique index plans_one_default_idx on public.plans (is_default) where is_default;

create table public.subscriptions (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- NULL = plan por defecto.
  plan_id uuid references public.plans (id) on delete restrict,
  source public.subscription_source not null default 'default',
  status public.subscription_status not null default 'active',
  -- Precio pactado (clientes sin Stripe). NULL = el del plan.
  custom_price_micros bigint check (custom_price_micros is null or custom_price_micros >= 0),
  note text not null default '' check (char_length(note) <= 500),
  stripe_customer_id text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,200}$'),
  stripe_subscription_id text unique check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9_]{1,200}$'),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'default') = (plan_id is null)),
  check (source = 'stripe' or (stripe_subscription_id is null and status = 'active'))
);
create index subscriptions_plan_idx on public.subscriptions (plan_id);

-- Avisos de Stripe recibidos: la clave primaria es el id del evento, y eso es
-- lo que hace idempotente el webhook. Sin FK: sobrevive a la organización.
create table public.billing_events (
  id text primary key check (char_length(id) between 1 and 255),
  type text not null check (char_length(type) between 1 and 100),
  organization_id uuid,
  outcome text not null default 'received' check (outcome in ('received', 'applied', 'ignored')),
  detail text not null default '' check (char_length(detail) <= 500),
  received_at timestamptz not null default now()
);
create index billing_events_org_idx on public.billing_events (organization_id, received_at desc);

-- ───────────────────────── Planes iniciales ─────────────────────────
-- Precios y cuotas son PROPUESTAS editables desde Plataforma: los fija el dueño.
-- Importes en micros de la moneda de cuenta (sin decidir: docs/facturacion.md).

insert into public.plans (code, name, description, price_micros, billing_interval, max_brands, max_members,
                          max_storage_bytes, ai_monthly_micros, features, is_public, is_default, sort_order)
values
  ('trial', 'Prueba', 'Para conocer la plataforma: una marca, dos personas y sin IA.',
   0, 'month', 1, 2, 524288000, 0, array['ai_text'], false, true, 0),
  ('basic', 'Básico', 'Una marca con su equipo pequeño y texto con IA.',
   29000000, 'month', 1, 3, 5368709120, 5000000, array['ai_text'], true, false, 10),
  ('professional', 'Profesional', 'Varias marcas, imagen con IA, reels y publicación.',
   79000000, 'month', 5, 10, 26843545600, 25000000,
   array['ai_text', 'ai_image', 'reels', 'publishing'], true, false, 20),
  ('agency', 'Agencia', 'Para agencias que gestionan las marcas de sus clientes.',
   199000000, 'month', 25, 30, 107374182400, 100000000,
   array['ai_text', 'ai_image', 'reels', 'publishing'], true, false, 30),
  ('enterprise', 'Enterprise', 'A medida: sin límites de marcas, personas ni almacenamiento. Precio pactado.',
   0, 'month', null, null, null, 500000000,
   array['ai_text', 'ai_image', 'ai_video', 'reels', 'publishing'], false, false, 40),
  ('legacy', 'Heredado', 'Organizaciones dadas de alta antes de los planes: sin límites y sin cupo de IA del plan.',
   0, 'month', null, null, null, 0,
   array['ai_text', 'ai_image', 'ai_video', 'reels', 'publishing'], false, false, 90);

-- Las organizaciones existentes conservan todo: plan «Heredado», asignado a mano.
insert into public.subscriptions (organization_id, plan_id, source, note)
select o.id, (select p.id from public.plans p where p.code = 'legacy'), 'manual',
       'Asignado al introducir los planes: conserva lo que la organización tenía'
from public.organizations o;

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Plan efectivo de una organización (ver cabecera). Si ni siquiera hay plan por
-- defecto, un plan vacío que no deja crear nada.
create function private.org_plan(p_organization_id uuid) returns public.plans
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan public.plans;
begin
  select p.* into v_plan
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.organization_id = p_organization_id and s.status in ('active', 'trialing', 'past_due');
  if found then
    return v_plan;
  end if;
  select p.* into v_plan from public.plans p where p.is_default;
  if found then
    return v_plan;
  end if;
  v_plan.code := 'none';
  v_plan.name := 'Sin plan';
  v_plan.price_micros := 0;
  v_plan.billing_interval := 'month';
  v_plan.max_brands := 0;
  v_plan.max_members := 1;
  v_plan.max_storage_bytes := 0;
  v_plan.ai_monthly_micros := 0;
  v_plan.features := '{}';
  return v_plan;
end $$;

-- Garantiza la fila de suscripción y la bloquea: serializa las operaciones que
-- comprueban un límite (dos altas simultáneas no pueden pasarse del plan) y las
-- reservas de cupo de IA.
create function private.lock_subscription(p_organization_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions (organization_id) values (p_organization_id) on conflict do nothing;
  perform 1 from public.subscriptions s where s.organization_id = p_organization_id for update;
end $$;

-- Bytes que ocupa una organización: biblioteca y fuentes de conocimiento.
create function private.org_storage_bytes(p_organization_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(ma.bytes) from public.media_assets ma where ma.organization_id = p_organization_id), 0)
        + coalesce((select sum(ks.bytes) from public.brand_knowledge_sources ks
                    where ks.organization_id = p_organization_id), 0))::bigint;
$$;

create function private.plan_feature_label(p_feature text) returns text
language sql immutable set search_path = '' as $$
  select case p_feature
    when 'ai_text' then 'la IA de texto'
    when 'ai_image' then 'la imagen con IA'
    when 'ai_video' then 'el vídeo con IA'
    when 'reels' then 'los reels'
    when 'publishing' then 'la publicación en redes'
    else p_feature
  end;
$$;

create function private.org_has_feature(p_organization_id uuid, p_feature text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_feature = any ((private.org_plan(p_organization_id)).features);
$$;

-- Falla con PL002 si el plan no incluye la función. Para las fases que vienen
-- (publicación…): `perform private.require_plan_feature(org, 'publishing')`.
create function private.require_plan_feature(p_organization_id uuid, p_feature text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan public.plans := private.org_plan(p_organization_id);
begin
  if not (p_feature = any (v_plan.features)) then
    raise exception 'Tu plan «%» no incluye %. Cambia de plan para usarlo.', v_plan.name, private.plan_feature_label(p_feature)
      using errcode = 'PL002', detail = jsonb_build_object('plan', v_plan.code, 'feature', p_feature)::text;
  end if;
end $$;

create function private.check_brand_limit(p_organization_id uuid, p_brand_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_count integer;
begin
  perform private.lock_subscription(p_organization_id);
  v_plan := private.org_plan(p_organization_id);
  if v_plan.max_brands is null then
    return;
  end if;
  select count(*) into v_count from public.brands b
  where b.organization_id = p_organization_id and b.status <> 'archived' and b.id <> p_brand_id;
  if v_count >= v_plan.max_brands then
    raise exception 'Has llegado al límite de marcas activas de tu plan «%»: % de %. Archiva una marca o cambia de plan.',
      v_plan.name, v_count, v_plan.max_brands
      using errcode = 'PL001',
            detail = jsonb_build_object('limit', 'brands', 'plan', v_plan.code, 'used', v_count, 'max', v_plan.max_brands)::text;
  end if;
end $$;

create function private.check_member_limit(p_organization_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_count integer;
begin
  perform private.lock_subscription(p_organization_id);
  v_plan := private.org_plan(p_organization_id);
  if v_plan.max_members is null then
    return;
  end if;
  select count(*) into v_count from public.organization_members om where om.organization_id = p_organization_id;
  if v_count >= v_plan.max_members then
    raise exception 'Has llegado al límite de personas de tu plan «%»: % de %. Quita a alguien de la organización o cambia de plan.',
      v_plan.name, v_count, v_plan.max_members
      using errcode = 'PL001',
            detail = jsonb_build_object('limit', 'members', 'plan', v_plan.code, 'used', v_count, 'max', v_plan.max_members)::text;
  end if;
end $$;

-- Una invitación ocupa plaza mientras está pendiente: no se pueden repartir más
-- invitaciones que plazas libres. No cuenta si la persona ya es miembro.
create function private.check_invitation_limit(p_organization_id uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_members integer;
  v_pending integer;
begin
  if exists (
    select 1 from public.organization_members om
    join public.profiles pr on pr.user_id = om.user_id
    where om.organization_id = p_organization_id and pr.email = p_email
  ) then
    return;
  end if;
  perform private.lock_subscription(p_organization_id);
  v_plan := private.org_plan(p_organization_id);
  if v_plan.max_members is null then
    return;
  end if;
  select count(*) into v_members from public.organization_members om where om.organization_id = p_organization_id;
  select count(*) into v_pending from public.invitations i
  where i.organization_id = p_organization_id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    and i.email <> p_email;
  if v_members + v_pending >= v_plan.max_members then
    raise exception 'Tu plan «%» admite % personas: ya hay % en la organización y % invitaciones pendientes. Anula alguna invitación o cambia de plan.',
      v_plan.name, v_plan.max_members, v_members, v_pending
      using errcode = 'PL001',
            detail = jsonb_build_object('limit', 'members', 'plan', v_plan.code, 'used', v_members,
                                        'pending', v_pending, 'max', v_plan.max_members)::text;
  end if;
end $$;

-- p_new_bytes: lo que se va a añadir. Con 0 solo comprueba que no esté ya lleno.
create function private.check_storage_limit(p_organization_id uuid, p_new_bytes bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_used bigint;
begin
  v_plan := private.org_plan(p_organization_id);
  if v_plan.max_storage_bytes is null then
    return;
  end if;
  perform private.lock_subscription(p_organization_id);
  v_used := private.org_storage_bytes(p_organization_id);
  if (p_new_bytes > 0 and v_used + p_new_bytes > v_plan.max_storage_bytes)
     or (p_new_bytes <= 0 and v_used >= v_plan.max_storage_bytes) then
    raise exception 'No queda espacio en tu plan «%»: usas % de %. Borra archivos de la biblioteca o cambia de plan.',
      v_plan.name, pg_size_pretty(v_used), pg_size_pretty(v_plan.max_storage_bytes)
      using errcode = 'PL001',
            detail = jsonb_build_object('limit', 'storage', 'plan', v_plan.code, 'used', v_used,
                                        'requested', greatest(p_new_bytes, 0), 'max', v_plan.max_storage_bytes)::text;
  end if;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────
-- Los disparadores de límites son SECURITY INVOKER a propósito: así saben qué
-- rol escribe (`current_user`). La clave de servicio (operaciones de la
-- plataforma) no tiene límites de plan; el trabajo lo hacen las funciones
-- `private.check_*`, que sí son SECURITY DEFINER.

create function private.subscriptions_on_new_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions (organization_id) values (new.id) on conflict do nothing;
  return null;
end $$;

create trigger organizations_subscription after insert on public.organizations
  for each row execute function private.subscriptions_on_new_org();

create function private.brands_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'service_role' or new.status = 'archived' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'archived' then
    return new;
  end if;
  perform private.check_brand_limit(new.organization_id, new.id);
  return new;
end $$;

create trigger brands_plan_limit before insert or update of status on public.brands
  for each row execute function private.brands_plan_limit();

create function private.members_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'service_role' then
    perform private.check_member_limit(new.organization_id);
  end if;
  return new;
end $$;

create trigger organization_members_plan_limit before insert on public.organization_members
  for each row execute function private.members_plan_limit();

create function private.invitations_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'service_role' then
    perform private.check_invitation_limit(new.organization_id, new.email);
  end if;
  return new;
end $$;

create trigger invitations_plan_limit before insert on public.invitations
  for each row execute function private.invitations_plan_limit();

-- Solo lo que sube una persona (escritura directa con su sesión). Lo que da de
-- alta el servidor se comprobó al encargarlo.
create function private.storage_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    perform private.check_storage_limit(new.organization_id, coalesce(new.bytes, 0));
  end if;
  return new;
end $$;

create trigger media_assets_plan_limit before insert on public.media_assets
  for each row execute function private.storage_plan_limit();
create trigger brand_knowledge_sources_plan_limit before insert on public.brand_knowledge_sources
  for each row execute function private.storage_plan_limit();

-- Encargos de medios: los reels son una función del plan, y sin espacio no se
-- encarga nada que vaya a acabar en la biblioteca.
create function private.jobs_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'media.reel.template' then
    perform private.require_plan_feature(new.organization_id, 'reels');
  end if;
  if new.kind in ('media.reel.template', 'media.image.process') then
    perform private.check_storage_limit(new.organization_id, 0);
  end if;
  return new;
end $$;

create trigger jobs_plan_limit before insert on public.jobs
  for each row execute function private.jobs_plan_limit();

create trigger plans_touch before update on public.plans
  for each row execute function private.touch_updated_at();
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function private.touch_updated_at();
create trigger subscriptions_audit after insert or update or delete on public.subscriptions
  for each row execute function private.audit();

-- Quién tocó un plan por última vez (los planes no son de ninguna organización
-- y no van al registro de auditoría).
create function private.plans_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_by := (select auth.uid());
  return new;
end $$;

create trigger plans_stamp before insert or update on public.plans
  for each row execute function private.plans_stamp();

-- ─────────────────── Cupo de IA: del plan o sobrescrito ───────────────────

-- Igual que la versión de 20261116110000, salvo de dónde sale el cupo:
--   * El bloqueo pasa de la fila de `usage_quotas` a la de `subscriptions`, que
--     existe siempre (serializa igual las reservas de la organización).
--   * Cupo = el sobrescrito por un superadministrador (`usage_quotas`) o, si no
--     hay, el del plan. Si el plan no trae cupo y nadie lo sobrescribió: AI002.
--   * La tarea tiene que estar en el plan (imagen → ai_image, vídeo → ai_video,
--     el resto → ai_text): si no, PL002. Imagen y vídeo acaban en la
--     biblioteca: sin espacio, PL001.
create or replace function public.ai_reserve_generation(
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
  v_plan public.plans;
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

  -- El bloqueo serializa las reservas de la organización: la siguiente espera
  -- aquí y, al continuar, ya ve lo que apartó la anterior.
  perform private.lock_subscription(v_org);
  v_plan := private.org_plan(v_org);

  perform private.require_plan_feature(v_org, case p_task
    when 'image' then 'ai_image' when 'video' then 'ai_video' else 'ai_text' end);

  select q.limit_value into v_limit
  from public.usage_quotas q
  where q.organization_id = v_org and q.metric = 'ai_cost_micros';
  if not found then
    if v_plan.ai_monthly_micros <= 0 then
      raise exception 'Esta organización no tiene cupo de IA asignado: su plan «%» no incluye IA', v_plan.name
        using errcode = 'AI002';
    end if;
    v_limit := v_plan.ai_monthly_micros;
  end if;

  if p_task in ('image', 'video') then
    perform private.check_storage_limit(v_org, 0);
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

comment on function public.admin_set_ai_quota(uuid, bigint) is
  'Sobrescribe el cupo mensual de IA del plan para una organización (superadministrador, auditado). admin_clear_ai_quota lo devuelve al del plan.';

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Plan, límites y uso de una organización. Para sus propietarios y
-- administradores (y los superadministradores). Lo pinta «Configuración → Plan».
create function public.organization_plan_usage(p_organization_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan public.plans;
  v_sub public.subscriptions;
  v_override bigint;
  v_period date := private.ai_period_start(now());
begin
  if p_organization_id is null
     or not (p_organization_id in (select private.my_admin_org_ids()) or private.is_platform_admin()) then
    raise exception 'Solo los administradores de la organización ven su plan' using errcode = '42501';
  end if;
  v_plan := private.org_plan(p_organization_id);
  select * into v_sub from public.subscriptions s where s.organization_id = p_organization_id;
  select q.limit_value into v_override from public.usage_quotas q
  where q.organization_id = p_organization_id and q.metric = 'ai_cost_micros';

  return jsonb_build_object(
    'plan', jsonb_build_object(
      'code', v_plan.code, 'name', v_plan.name, 'description', v_plan.description,
      'price_micros', v_plan.price_micros, 'billing_interval', v_plan.billing_interval,
      'max_brands', v_plan.max_brands, 'max_members', v_plan.max_members,
      'max_storage_bytes', v_plan.max_storage_bytes, 'ai_monthly_micros', v_plan.ai_monthly_micros,
      'features', to_jsonb(v_plan.features)),
    'subscription', jsonb_build_object(
      'source', coalesce(v_sub.source, 'default'), 'status', coalesce(v_sub.status, 'active'),
      -- El plan asignado aunque no esté vigente (p. ej., cancelado en Stripe).
      'assigned_plan_code', (select p.code from public.plans p where p.id = v_sub.plan_id),
      'custom_price_micros', v_sub.custom_price_micros,
      'current_period_end', v_sub.current_period_end,
      'cancel_at_period_end', coalesce(v_sub.cancel_at_period_end, false),
      'has_billing_account', v_sub.stripe_customer_id is not null),
    'usage', jsonb_build_object(
      'brands', (select count(*) from public.brands b where b.organization_id = p_organization_id and b.status <> 'archived'),
      'members', (select count(*) from public.organization_members om where om.organization_id = p_organization_id),
      'pending_invitations', (select count(*) from public.invitations i
                              where i.organization_id = p_organization_id and i.accepted_at is null
                                and i.revoked_at is null and i.expires_at > now()),
      'storage_bytes', private.org_storage_bytes(p_organization_id),
      'ai_committed_micros', (select coalesce(sum(u.reserved_delta_micros + u.cost_delta_micros), 0)
                              from public.ai_usage u
                              where u.organization_id = p_organization_id and u.period_start = v_period)),
    'ai_limit_micros', coalesce(v_override, v_plan.ai_monthly_micros),
    'ai_limit_overridden', v_override is not null,
    'period_start', v_period);
end $$;

-- Panel de superadministración: por organización, plan, ingresos del plan en el
-- mes, coste de IA del mes y margen. Ingresos = precio pactado o del plan,
-- llevado a un mes (los anuales, entre 12), solo si la suscripción está vigente
-- y no en periodo de prueba. Es el precio de catálogo, no lo cobrado: Stripe
-- (impuestos, descuentos, prorrateos) tiene la cifra exacta.
create function public.admin_billing_overview(p_period_start date)
returns table (
  organization_id uuid, organization_name text, kind public.org_kind,
  plan_code text, plan_name text, assigned_plan_code text,
  source public.subscription_source, status public.subscription_status,
  custom_price_micros bigint, monthly_revenue_micros bigint, ai_cost_micros bigint, margin_micros bigint,
  ai_limit_micros bigint, ai_limit_overridden boolean,
  brands bigint, members bigint, storage_bytes bigint,
  current_period_end timestamptz, cancel_at_period_end boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception 'Indica el primer día del mes' using errcode = '22023';
  end if;
  v_from := p_period_start::timestamp at time zone 'UTC';
  v_to := (p_period_start + interval '1 month')::timestamp at time zone 'UTC';

  return query
    with base as (
      select o.id, o.name, o.kind, s.source as src, s.status as st, s.custom_price_micros as custom,
             s.current_period_end as cpe, s.cancel_at_period_end as cape,
             private.org_plan(o.id) as plan,
             (select p.code from public.plans p where p.id = s.plan_id) as assigned,
             (select q.limit_value from public.usage_quotas q
              where q.organization_id = o.id and q.metric = 'ai_cost_micros') as override,
             (select coalesce(sum(u.cost_delta_micros), 0) from public.ai_usage u
              where u.organization_id = o.id and u.entry = 'settle'
                and u.created_at >= v_from and u.created_at < v_to)::bigint as cost
      from public.organizations o
      left join public.subscriptions s on s.organization_id = o.id
    ), priced as (
      select b.*,
             case when coalesce(b.st, 'active') in ('active', 'past_due') then
               case (b.plan).billing_interval
                 when 'year' then round(coalesce(b.custom, (b.plan).price_micros) / 12.0)::bigint
                 else coalesce(b.custom, (b.plan).price_micros)
               end
             else 0 end as revenue
      from base b
    )
    select p.id, p.name, p.kind, (p.plan).code, (p.plan).name, p.assigned,
           coalesce(p.src, 'default'::public.subscription_source), coalesce(p.st, 'active'::public.subscription_status),
           p.custom, p.revenue, p.cost, p.revenue - p.cost,
           coalesce(p.override, (p.plan).ai_monthly_micros), p.override is not null,
           (select count(*) from public.brands b where b.organization_id = p.id and b.status <> 'archived'),
           (select count(*) from public.organization_members om where om.organization_id = p.id),
           private.org_storage_bytes(p.id),
           p.cpe, coalesce(p.cape, false)
    from priced p
    order by p.revenue - p.cost, p.name;
end $$;

-- Asigna un plan a mano (clientes sin Stripe, como los de una agencia).
-- p_plan_id NULL devuelve la organización al plan por defecto. Auditado.
create function public.admin_set_organization_plan(
  p_organization_id uuid,
  p_plan_id uuid,
  p_custom_price_micros bigint default null,
  p_note text default ''
) returns public.subscriptions
language plpgsql security definer set search_path = '' as $$
declare
  v_sub public.subscriptions;
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization_id) then
    raise exception 'La organización no existe' using errcode = '22023';
  end if;
  if p_plan_id is not null and not exists (select 1 from public.plans p where p.id = p_plan_id and p.active) then
    raise exception 'Ese plan no existe o está desactivado' using errcode = '22023';
  end if;
  if p_custom_price_micros is not null and p_custom_price_micros < 0 then
    raise exception 'El precio no puede ser negativo' using errcode = '22023';
  end if;

  perform private.lock_subscription(p_organization_id);
  select * into v_sub from public.subscriptions s where s.organization_id = p_organization_id;
  if v_sub.source = 'stripe' and v_sub.status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused') then
    raise exception 'Esta organización paga con Stripe: cambia o cancela su suscripción en Stripe antes de asignarle un plan a mano'
      using errcode = 'P0001';
  end if;

  update public.subscriptions s
  set plan_id = p_plan_id,
      source = case when p_plan_id is null then 'default' else 'manual' end::public.subscription_source,
      status = 'active',
      custom_price_micros = case when p_plan_id is null then null else p_custom_price_micros end,
      note = left(coalesce(p_note, ''), 500),
      stripe_subscription_id = null,
      current_period_end = null,
      cancel_at_period_end = false,
      updated_by = (select auth.uid())
  where s.organization_id = p_organization_id
  returning * into v_sub;
  return v_sub;
end $$;

-- Cambia el plan por defecto (el de las organizaciones sin plan asignado).
create function public.admin_set_default_plan(p_plan_id uuid) returns public.plans
language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.plans;
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if not exists (select 1 from public.plans p where p.id = p_plan_id and p.active) then
    raise exception 'Ese plan no existe o está desactivado' using errcode = '22023';
  end if;
  update public.plans p set is_default = false where p.is_default and p.id <> p_plan_id;
  update public.plans p set is_default = true where p.id = p_plan_id returning * into v_plan;
  return v_plan;
end $$;

-- Retira el cupo de IA sobrescrito: vuelve a mandar el del plan. Auditado.
create function public.admin_clear_ai_quota(p_organization_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  delete from public.usage_quotas q where q.organization_id = p_organization_id and q.metric = 'ai_cost_micros';
end $$;

-- ─────────────────────── RPC del servidor (facturación) ───────────────────────

-- Lo que necesitan las funciones de pago (alta y portal) antes de hablar con
-- Stripe. Comprueba que el usuario es propietario o administrador y, si se
-- indica plan, que se puede contratar en línea.
create function public.billing_checkout_context(p_user_id uuid, p_organization_id uuid, p_plan_code text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
begin
  if p_user_id is null or not exists (
    select 1 from public.organization_members om
    where om.organization_id = p_organization_id and om.user_id = p_user_id and om.role in ('owner', 'admin')
  ) then
    raise exception 'Solo los propietarios y administradores gestionan el plan' using errcode = '42501';
  end if;
  select * into v_sub from public.subscriptions s where s.organization_id = p_organization_id;
  if p_plan_code is not null then
    select * into v_plan from public.plans p
    where p.code = p_plan_code and p.active and p.is_public and p.stripe_price_id is not null;
    if not found then
      raise exception 'Ese plan no se puede contratar en línea' using errcode = '22023';
    end if;
  end if;
  return jsonb_build_object(
    'organization_id', p_organization_id,
    'stripe_customer_id', v_sub.stripe_customer_id,
    'stripe_subscription_active', coalesce(v_sub.source = 'stripe'
      and v_sub.status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'), false),
    'plan_code', v_plan.code,
    'stripe_price_id', v_plan.stripe_price_id);
end $$;

-- Aplica a una organización el estado de una suscripción de Stripe. Lo llama
-- el webhook con el estado LEÍDO DE STRIPE en ese momento (no el del aviso):
-- así el orden de llegada de los avisos no importa. Idempotente por evento:
-- un evento repetido no hace nada. Nunca falla por datos que no reconoce: los
-- deja anotados en `billing_events` («ignored») para revisarlos.
create function public.billing_apply_stripe_event(
  p_event_id text,
  p_event_type text,
  p_organization_id uuid default null,
  p_customer_id text default null,
  p_subscription_id text default null,
  p_price_id text default null,
  p_status text default null,
  p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false,
  p_ignore_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_sub public.subscriptions;
  v_plan uuid;
  v_status public.subscription_status;

  -- Cierra el evento como ignorado.
  v_reason text;
begin
  if p_event_id is null or p_event_type is null then
    raise exception 'Falta el evento' using errcode = '22023';
  end if;
  insert into public.billing_events (id, type) values (p_event_id, left(p_event_type, 100)) on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('result', 'duplicate');
  end if;

  v_reason := p_ignore_reason;
  if v_reason is null and (p_subscription_id is null or p_status is null) then
    v_reason := 'missing_subscription';
  end if;
  if v_reason is null and not (p_status = any (enum_range(null::public.subscription_status)::text[])) then
    v_reason := 'unknown_status';
  end if;

  if v_reason is null then
    -- La organización: la de los metadatos (los pone nuestra función de alta), o
    -- la que ya tiene esa suscripción o ese cliente.
    select o.id into v_org from public.organizations o where o.id = p_organization_id;
    if v_org is null then
      select s.organization_id into v_org from public.subscriptions s where s.stripe_subscription_id = p_subscription_id;
    end if;
    if v_org is null and p_customer_id is not null then
      select s.organization_id into v_org from public.subscriptions s where s.stripe_customer_id = p_customer_id;
    end if;
    if v_org is null then
      v_reason := 'organization_not_found';
    end if;
  end if;

  if v_reason is null then
    perform private.lock_subscription(v_org);
    select * into v_sub from public.subscriptions s where s.organization_id = v_org;
    v_status := p_status::public.subscription_status;
    if exists (select 1 from public.subscriptions s
               where s.organization_id <> v_org
                 and (s.stripe_subscription_id = p_subscription_id or s.stripe_customer_id = p_customer_id)) then
      v_reason := 'belongs_to_other_organization';
    elsif v_sub.stripe_subscription_id is not null and v_sub.stripe_subscription_id <> p_subscription_id
          and v_sub.status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused')
          and v_status in ('canceled', 'incomplete_expired') then
      -- Una suscripción antigua que termina no le quita el plan a la vigente.
      v_reason := 'stale_subscription';
    end if;
  end if;

  if v_reason is null then
    select p.id into v_plan from public.plans p where p.stripe_price_id = p_price_id;
    if v_plan is null then
      v_reason := 'unknown_price';
    end if;
  end if;

  if v_reason is not null then
    update public.billing_events e set outcome = 'ignored', detail = left(v_reason, 500), organization_id = v_org
    where e.id = p_event_id;
    return jsonb_build_object('result', 'ignored', 'reason', v_reason);
  end if;

  update public.subscriptions s
  set plan_id = v_plan, source = 'stripe', status = v_status, custom_price_micros = null,
      stripe_customer_id = coalesce(p_customer_id, s.stripe_customer_id),
      stripe_subscription_id = p_subscription_id,
      current_period_end = p_current_period_end,
      cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
      updated_by = null
  where s.organization_id = v_org;

  update public.billing_events e set outcome = 'applied', organization_id = v_org where e.id = p_event_id;
  return jsonb_build_object('result', 'applied', 'organization_id', v_org, 'status', v_status);
end $$;

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;

-- Catálogo: cualquiera con sesión ve los planes activos (para elegir); el
-- superadministrador, todos, y es el único que los crea y edita. No se borran.
create policy plans_select on public.plans for select to authenticated
  using (active or private.is_platform_admin());
create policy plans_insert on public.plans for insert to authenticated
  with check (private.is_platform_admin());
create policy plans_update on public.plans for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());

-- La suscripción (dinero) la ven los administradores de la organización.
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (organization_id in (select private.my_admin_org_ids()) or private.is_platform_admin());

create policy billing_events_select on public.billing_events for select to authenticated
  using (private.is_platform_admin());

-- ───────────────────────────── Privilegios ─────────────────────────────
-- Nadie escribe a mano suscripciones ni avisos: solo las funciones de arriba.
-- `code` e `is_default` no se editan directamente (el segundo, con su RPC).

grant select on public.plans, public.subscriptions, public.billing_events to authenticated, service_role;
grant insert (code, name, description, price_micros, billing_interval, max_brands, max_members, max_storage_bytes,
              ai_monthly_micros, features, is_public, active, stripe_price_id, sort_order)
  on public.plans to authenticated;
grant update (name, description, price_micros, billing_interval, max_brands, max_members, max_storage_bytes,
              ai_monthly_micros, features, is_public, active, stripe_price_id, sort_order)
  on public.plans to authenticated;

revoke all on function private.org_plan(uuid) from public, anon;
revoke all on function private.lock_subscription(uuid) from public, anon;
revoke all on function private.org_storage_bytes(uuid) from public, anon;
revoke all on function private.plan_feature_label(text) from public, anon;
revoke all on function private.org_has_feature(uuid, text) from public, anon;
revoke all on function private.require_plan_feature(uuid, text) from public, anon;
revoke all on function private.check_brand_limit(uuid, uuid) from public, anon;
revoke all on function private.check_member_limit(uuid) from public, anon;
revoke all on function private.check_invitation_limit(uuid, text) from public, anon;
revoke all on function private.check_storage_limit(uuid, bigint) from public, anon;
revoke all on function private.subscriptions_on_new_org() from public, anon, authenticated;
revoke all on function private.brands_plan_limit() from public, anon;
revoke all on function private.members_plan_limit() from public, anon;
revoke all on function private.invitations_plan_limit() from public, anon;
revoke all on function private.storage_plan_limit() from public, anon;
revoke all on function private.jobs_plan_limit() from public, anon;
revoke all on function private.plans_stamp() from public, anon;

-- Los disparadores de límites corren con el rol de quien escribe: necesita
-- ejecutar las comprobaciones (que no devuelven nada que no pueda ver).
grant execute on function private.org_plan(uuid), private.lock_subscription(uuid), private.org_storage_bytes(uuid),
  private.plan_feature_label(text), private.org_has_feature(uuid, text), private.require_plan_feature(uuid, text),
  private.check_brand_limit(uuid, uuid), private.check_member_limit(uuid), private.check_invitation_limit(uuid, text),
  private.check_storage_limit(uuid, bigint), private.brands_plan_limit(), private.members_plan_limit(),
  private.invitations_plan_limit(), private.storage_plan_limit(), private.jobs_plan_limit(), private.plans_stamp()
  to authenticated, service_role;

revoke all on function public.organization_plan_usage(uuid) from public, anon, authenticated;
revoke all on function public.admin_billing_overview(date) from public, anon, authenticated;
revoke all on function public.admin_set_organization_plan(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.admin_set_default_plan(uuid) from public, anon, authenticated;
revoke all on function public.admin_clear_ai_quota(uuid) from public, anon, authenticated;
revoke all on function public.billing_checkout_context(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.billing_apply_stripe_event(text, text, uuid, text, text, text, text, timestamptz, boolean, text)
  from public, anon, authenticated;

grant execute on function public.organization_plan_usage(uuid) to authenticated, service_role;
grant execute on function public.admin_billing_overview(date) to authenticated, service_role;
grant execute on function public.admin_set_organization_plan(uuid, uuid, bigint, text) to authenticated, service_role;
grant execute on function public.admin_set_default_plan(uuid) to authenticated, service_role;
grant execute on function public.admin_clear_ai_quota(uuid) to authenticated, service_role;
grant execute on function public.billing_checkout_context(uuid, uuid, text) to service_role;
grant execute on function public.billing_apply_stripe_event(text, text, uuid, text, text, text, text, timestamptz, boolean, text)
  to service_role;
