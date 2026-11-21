-- Vuelta atrás de 20261124010000_media_storage_r2.sql. Quita el almacén de
-- cada archivo y la integración de Cloudflare R2 (con sus secretos de Vault).
--
-- Se niega si hay recursos cuyo archivo está en R2: sin la columna, la
-- aplicación los buscaría en Supabase Storage y no estarían. Antes hay que
-- copiarlos de vuelta (o borrarlos).

do $$
begin
  if exists (select 1 from public.media_assets where storage_backend = 'r2') then
    raise exception 'Hay recursos con el archivo en R2: cópialos a Supabase Storage antes de deshacer esta migración';
  end if;
end $$;

drop function if exists public.media_storage_forget_paths(text[]);
drop function if exists public.media_storage_register_upload(uuid, text);
drop trigger if exists media_assets_storage_backend on public.media_assets;
drop function if exists private.media_assets_storage_backend();
drop table if exists private.media_object_locations;

-- La cola de limpieza vuelve a como estaba en 20261122010000.
create or replace function private.queue_storage_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.source = 'google_drive' then
    return old;
  end if;
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path)
  values (old.organization_id, old.brand_id, old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end $$;

alter table public.storage_cleanup_queue drop column if exists storage_backend;
drop index if exists public.media_assets_r2_idx;
alter table public.media_assets drop constraint if exists media_assets_backend_storage_only;
alter table public.media_assets drop column if exists storage_backend;

do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets vs
    where vs.id in (
      select s.vault_secret_id from private.integration_settings s
      join private.integration_setting_keys k on k.setting_key = s.setting_key
      where s.vault_secret_id is not null and k.integration = 'r2'
    );
  end if;
end $$;

-- Los valores caen en cascada con su ajuste del catálogo.
delete from private.integration_setting_keys where integration = 'r2';
delete from private.integration_tests where integration = 'r2';

alter table private.integration_setting_keys
  drop constraint integration_setting_keys_integration_check,
  add constraint integration_setting_keys_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive'));

alter table private.integration_tests
  drop constraint integration_tests_integration_check,
  add constraint integration_tests_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive'));

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
