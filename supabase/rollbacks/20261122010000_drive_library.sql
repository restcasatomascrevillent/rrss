-- Vuelta atrás de 20261122010000_drive_library.sql.
-- DESTRUCTIVA: borra de la biblioteca los recursos que viven en Google Drive
-- (los archivos de Drive no se tocan), las conexiones de Drive y sus tokens
-- cifrados (habría que volver a conectarlas).
drop function if exists public.drive_asset_source(text);
drop function if exists public.drive_assets_import(uuid, uuid, uuid, jsonb, text, text[]);
drop function if exists public.drive_connection_report(uuid, text, text);
drop function if exists public.drive_connection_token(uuid);
drop function if exists public.drive_connection_save(uuid, uuid, text, text, text[], text, text);
drop function if exists public.drive_oauth_consume(text);
drop function if exists public.drive_connection_for_brand(uuid, uuid);
drop function if exists public.disconnect_drive(uuid);
drop function if exists public.drive_oauth_begin(uuid);

-- Se borran sin pasar por la cola de limpieza (no tienen archivo en Storage).
alter table public.media_assets disable trigger media_assets_queue_cleanup;
delete from public.media_assets where source = 'google_drive';
alter table public.media_assets enable trigger media_assets_queue_cleanup;

drop trigger if exists media_assets_drive_guard on public.media_assets;
drop function if exists private.media_assets_drive_guard();
alter table public.media_assets drop constraint if exists media_assets_drive_shape;
drop index if exists public.media_assets_drive_connection_idx;
alter table public.media_assets
  drop column if exists drive_file_id,
  drop column if exists drive_connection_id,
  drop column if exists source;

-- Las dos funciones como las dejó 20261116100000 y 20261119710000.
create or replace function private.queue_storage_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path)
  values (old.organization_id, old.brand_id, old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end $$;

create or replace function private.org_storage_bytes(p_organization_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(ma.bytes) from public.media_assets ma where ma.organization_id = p_organization_id), 0)
        + coalesce((select sum(ks.bytes) from public.brand_knowledge_sources ks
                    where ks.organization_id = p_organization_id), 0)
        + coalesce((select sum(bf.bytes) from public.brand_fonts bf where bf.organization_id = p_organization_id), 0)
         )::bigint;
$$;

drop table if exists private.drive_oauth_states;
drop table if exists private.drive_connection_secrets;
drop table if exists public.drive_connections cascade;
