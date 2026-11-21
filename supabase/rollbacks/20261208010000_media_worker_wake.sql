-- Vuelta atrás de 20261208010000_media_worker_wake.sql.
-- Quita el reloj, el disparador y las funciones del despertador del trabajador
-- de medios, y la integración «Trabajador de medios (Fly.io)» con su secreto
-- de Vault. No toca la cola: los trabajos siguen ahí y el trabajador los
-- recoge cuando se arranque a mano (desde el panel de Fly). Los secretos
-- sueltos de Vault (`rrss_fly_*`, del script alternativo) se quedan; se
-- borran a mano si ya no hacen falta.
do $do$
declare
  v_scheduled boolean;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_scheduled using 'rrss-media-worker-wake';
    if v_scheduled then
      execute 'select cron.unschedule($1)' using 'rrss-media-worker-wake';
    end if;
  end if;
end
$do$;

drop trigger if exists jobs_wake_media_worker on public.jobs;
drop function if exists private.jobs_wake_media_worker();
drop function if exists private.media_worker_wake();
drop function if exists private.is_media_worker_kind(text);
drop table if exists private.media_worker_wake_state;

-- Integración: secreto de Vault, ajustes (caen en cascada), última prueba.
do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets vs
    where vs.id in (
      select s.vault_secret_id from private.integration_settings s
      join private.integration_setting_keys k on k.setting_key = s.setting_key
      where s.vault_secret_id is not null and k.integration = 'media_worker'
    );
  end if;
end $$;

delete from private.integration_setting_keys where integration = 'media_worker';
delete from private.integration_tests where integration = 'media_worker';

alter table private.integration_setting_keys
  drop constraint integration_setting_keys_integration_check,
  add constraint integration_setting_keys_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2'));

alter table private.integration_tests
  drop constraint integration_tests_integration_check,
  add constraint integration_tests_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2'));

-- Como quedó en 20261124010000.
create or replace function public.integration_record_test(p_user_id uuid, p_integration text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_integration is null
     or p_integration not in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2') then
    raise exception 'Esa integración no existe' using errcode = '22023';
  end if;
  insert into private.integration_tests (integration, ok, message, tested_by, tested_at)
  values (p_integration, coalesce(p_ok, false), left(coalesce(p_message, ''), 500), p_user_id, now())
  on conflict (integration) do update
    set ok = excluded.ok, message = excluded.message, tested_by = excluded.tested_by, tested_at = now();
  insert into private.integration_audit (actor_id, action, integration, data)
  values (p_user_id, 'test', p_integration, jsonb_build_object('ok', coalesce(p_ok, false)));
end $$;
