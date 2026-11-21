-- Archivos huérfanos en R2: objetos que se subieron con una URL firmada y a
-- los que nunca llegó a apuntar un recurso (el alta de la fila falló, o se
-- cerró la pestaña a medias). `private.media_object_locations` apunta cada
-- subida firmada a R2; un huérfano es una ruta apuntada sin recurso.
--
--   · `media_storage_orphans(p_user_id, p_paths, ...)`: con persona, las rutas
--     suyas que pide descartar ahora mismo (borrado compensatorio tras un
--     alta fallida); sin persona (el servidor), las más antiguas que
--     `p_min_age`, para la tarea programada.
--   · `private.media_storage_orphans_dispatch()`: llama cada hora a la función
--     `media-storage/purge-orphans` si hay huérfanos de más de 24 h.
--
-- Supabase Storage no tiene este problema: el cliente borra el objeto si falla
-- el alta de la fila (src/features/library/api.ts).
-- Vuelta atrás: supabase/rollbacks/20261129010000_media_storage_orphans.sql

create function public.media_storage_orphans(
  p_user_id uuid,
  p_paths text[] default null,
  p_min_age interval default interval '24 hours',
  p_limit integer default 200
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rows jsonb;
begin
  if p_user_id is not null then
    -- Solo lo que la propia persona apuntó y sigue pudiendo editar.
    select coalesce(jsonb_agg(jsonb_build_object('storage_path', x.storage_path, 'backend', x.backend)), '[]'::jsonb)
    into v_rows
    from (
      select l.storage_path, l.backend
      from private.media_object_locations l
      where l.storage_path = any (coalesce(p_paths, '{}'))
        and l.registered_by = p_user_id
        and private.user_has_brand_capability(p_user_id, l.brand_id, 'edit')
        and not exists (select 1 from public.media_assets ma where ma.storage_path = l.storage_path)
      limit greatest(coalesce(p_limit, 200), 1)
    ) x;
  else
    select coalesce(jsonb_agg(jsonb_build_object('storage_path', x.storage_path, 'backend', x.backend)), '[]'::jsonb)
    into v_rows
    from (
      select l.storage_path, l.backend
      from private.media_object_locations l
      where l.created_at < now() - coalesce(p_min_age, interval '24 hours')
        and not exists (select 1 from public.media_assets ma where ma.storage_path = l.storage_path)
      order by l.created_at
      limit greatest(coalesce(p_limit, 200), 1)
    ) x;
  end if;
  return v_rows;
end $$;

revoke all on function public.media_storage_orphans(uuid, text[], interval, integer) from public, anon, authenticated;
grant execute on function public.media_storage_orphans(uuid, text[], interval, integer) to service_role;

create function private.media_storage_orphans_dispatch() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  if not exists (
    select 1 from private.media_object_locations l
    where l.created_at < now() - interval '24 hours'
      and not exists (select 1 from public.media_assets ma where ma.storage_path = l.storage_path)
  ) then
    return null;
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    raise warning 'media_storage_orphans_dispatch: faltan Vault o pg_net; no se llama a media-storage';
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'rrss_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'rrss_service_role_key';
  if v_url is null or v_key is null then
    raise warning 'media_storage_orphans_dispatch: faltan los secretos rrss_project_url o rrss_service_role_key en Vault';
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_request
    using rtrim(v_url, '/') || '/functions/v1/media-storage/purge-orphans',
          jsonb_build_object('source', 'pg_cron'),
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
          60000;
  return v_request;
end $$;

revoke all on function private.media_storage_orphans_dispatch() from public, anon, authenticated, service_role;

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('rrss-media-orphans', '41 * * * *', 'select private.media_storage_orphans_dispatch()');
  else
    raise notice 'pg_cron o pg_net no están disponibles: no se programa la limpieza de huérfanos de R2';
  end if;
end
$do$;
