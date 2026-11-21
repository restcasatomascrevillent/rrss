-- Vuelta atrás de 20261119310000_plans_subscriptions.sql.
-- DESTRUCTIVA: elimina los planes, la suscripción de cada organización (plan
-- asignado, precio pactado, identificadores de Stripe) y el registro de avisos
-- de Stripe. En un entorno con datos hay que exportar antes `plans`,
-- `subscriptions` y `billing_events`. Los cupos de IA sobrescritos
-- (`usage_quotas`) se quedan y vuelven a ser el único cupo: las organizaciones
-- sin fila en `usage_quotas` se quedan sin IA, como antes de los planes.

drop trigger if exists jobs_plan_limit on public.jobs;
drop trigger if exists brand_knowledge_sources_plan_limit on public.brand_knowledge_sources;
drop trigger if exists media_assets_plan_limit on public.media_assets;
drop trigger if exists invitations_plan_limit on public.invitations;
drop trigger if exists organization_members_plan_limit on public.organization_members;
drop trigger if exists brands_plan_limit on public.brands;
drop trigger if exists organizations_subscription on public.organizations;

-- El cupo de IA vuelve a salir solo de `usage_quotas` (versión de 20261116110000).
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

comment on function public.admin_set_ai_quota(uuid, bigint) is null;

drop function if exists public.billing_apply_stripe_event(text, text, uuid, text, text, text, text, timestamptz, boolean, text);
drop function if exists public.billing_checkout_context(uuid, uuid, text);
drop function if exists public.admin_clear_ai_quota(uuid);
drop function if exists public.admin_set_default_plan(uuid);
drop function if exists public.admin_set_organization_plan(uuid, uuid, bigint, text);
drop function if exists public.admin_billing_overview(date);
drop function if exists public.organization_plan_usage(uuid);

drop table if exists public.billing_events, public.subscriptions, public.plans cascade;

drop function if exists private.plans_stamp();
drop function if exists private.jobs_plan_limit();
drop function if exists private.storage_plan_limit();
drop function if exists private.invitations_plan_limit();
drop function if exists private.members_plan_limit();
drop function if exists private.brands_plan_limit();
drop function if exists private.subscriptions_on_new_org();
drop function if exists private.check_storage_limit(uuid, bigint);
drop function if exists private.check_invitation_limit(uuid, text);
drop function if exists private.check_member_limit(uuid);
drop function if exists private.check_brand_limit(uuid, uuid);
drop function if exists private.require_plan_feature(uuid, text);
drop function if exists private.org_has_feature(uuid, text);
drop function if exists private.plan_feature_label(text);
drop function if exists private.org_storage_bytes(uuid);
drop function if exists private.lock_subscription(uuid);
drop function if exists private.org_plan(uuid);

drop type if exists public.subscription_source;
drop type if exists public.subscription_status;
drop type if exists public.billing_interval;
