-- Plataforma → Integraciones: Google Drive y el copiloto por voz.
--
--   * Integración nueva `google_drive` (biblioteca con fotos de Drive,
--     20261122010000): el cliente OAuth «Aplicación web» del producto
--     (GOOGLE_DRIVE_CLIENT_ID y, secreto en Vault, GOOGLE_DRIVE_CLIENT_SECRET) y
--     la dirección de la aplicación a la que se vuelve tras conectar
--     (DRIVE_APP_URL). La dirección de vuelta de Google (DRIVE_CALLBACK_URL) se
--     deduce de la URL de Supabase y se queda en el entorno.
--   * Proveedor y modelo propios de la tarea `editor.copilot` (copiloto por voz,
--     20261121010000): AI_TEXT_EDITOR_COPILOT_PROVIDER y _MODEL, como el resto
--     de tareas de texto.
--
-- Los mismos nombres están en supabase/functions/_shared/integrations/catalog.ts
-- y en la pantalla (src/features/platform/integrations/catalog.ts); una prueba
-- comprueba que coinciden. Vuelta atrás en supabase/rollbacks/.

alter table private.integration_setting_keys
  drop constraint integration_setting_keys_integration_check,
  add constraint integration_setting_keys_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive'));

alter table private.integration_tests
  drop constraint integration_tests_integration_check,
  add constraint integration_tests_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive'));

insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  ('AI_TEXT_EDITOR_COPILOT_PROVIDER', 'ai_text', false),
  ('AI_TEXT_EDITOR_COPILOT_MODEL', 'ai_text', false),
  ('GOOGLE_DRIVE_CLIENT_ID', 'google_drive', false),
  ('GOOGLE_DRIVE_CLIENT_SECRET', 'google_drive', true),
  ('DRIVE_APP_URL', 'google_drive', false);

-- Igual que en 20261120010000, admitiendo la integración nueva.
create or replace function public.integration_record_test(p_user_id uuid, p_integration text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_integration is null
     or p_integration not in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive') then
    raise exception 'Esa integración no existe' using errcode = '22023';
  end if;
  insert into private.integration_tests (integration, ok, message, tested_by, tested_at)
  values (p_integration, coalesce(p_ok, false), left(coalesce(p_message, ''), 500), p_user_id, now())
  on conflict (integration) do update
    set ok = excluded.ok, message = excluded.message, tested_by = excluded.tested_by, tested_at = now();
  insert into private.integration_audit (actor_id, action, integration, data)
  values (p_user_id, 'test', p_integration, jsonb_build_object('ok', coalesce(p_ok, false)));
end $$;
