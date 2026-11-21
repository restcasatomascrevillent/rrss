-- Vuelta atrás de 20261123010000_integrations_drive_copilot.sql. Borra lo
-- guardado de Google Drive y del copiloto por voz en Plataforma → Integraciones
-- (con sus secretos de Vault) y deja el catálogo como en 20261120010000: las
-- funciones vuelven a leer esas variables solo del entorno.

do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets vs
    where vs.id in (
      select s.vault_secret_id from private.integration_settings s
      join private.integration_setting_keys k on k.setting_key = s.setting_key
      where s.vault_secret_id is not null
        and (k.integration = 'google_drive'
             or s.setting_key in ('AI_TEXT_EDITOR_COPILOT_PROVIDER', 'AI_TEXT_EDITOR_COPILOT_MODEL'))
    );
  end if;
end $$;

-- Los valores caen en cascada con su ajuste del catálogo.
delete from private.integration_setting_keys
where integration = 'google_drive'
   or setting_key in ('AI_TEXT_EDITOR_COPILOT_PROVIDER', 'AI_TEXT_EDITOR_COPILOT_MODEL');
delete from private.integration_tests where integration = 'google_drive';

alter table private.integration_setting_keys
  drop constraint integration_setting_keys_integration_check,
  add constraint integration_setting_keys_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe'));

alter table private.integration_tests
  drop constraint integration_tests_integration_check,
  add constraint integration_tests_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe'));

create or replace function public.integration_record_test(p_user_id uuid, p_integration text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_integration is null or p_integration not in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe') then
    raise exception 'Esa integración no existe' using errcode = '22023';
  end if;
  insert into private.integration_tests (integration, ok, message, tested_by, tested_at)
  values (p_integration, coalesce(p_ok, false), left(coalesce(p_message, ''), 500), p_user_id, now())
  on conflict (integration) do update
    set ok = excluded.ok, message = excluded.message, tested_by = excluded.tested_by, tested_at = now();
  insert into private.integration_audit (actor_id, action, integration, data)
  values (p_user_id, 'test', p_integration, jsonb_build_object('ok', coalesce(p_ok, false)));
end $$;
