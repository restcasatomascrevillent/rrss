-- Miniaturas ligeras de las fotos de la biblioteca.
--
-- La biblioteca, los selectores, el calendario, Campañas y la tira del carrusel
-- cargaban el archivo original (hasta 1,2 MB por foto) para pintarlo a 24-200 px.
-- Ahora, al subir una imagen, el navegador genera una miniatura WebP de unos
-- 400 px y la sube junto al original por el mismo camino (`media-storage` o
-- Supabase Storage); su ruta se guarda en `media_assets.thumb_path`.
--
--   * `thumb_path`: ruta de la miniatura, siempre en `<org>/<marca>/thumbs/…`
--     (nunca la ruta de otro recurso: al borrar el recurso se borra la
--     miniatura, y no puede ser el original de otro). Única. Vive en el mismo
--     almacén que el original (`storage_backend`). Null: sin miniatura (se usa
--     el original). El cliente puede fijarla solo al crear el recurso; después,
--     solo el servidor (scripts/miniaturas-biblioteca.ts).
--   * El borrado de un recurso anota también su miniatura en la cola de limpieza.
--   * Una miniatura no es un huérfano de R2 aunque no sea `storage_path` de nada.
--   * El borrado y la exportación de una organización la incluyen.
--
-- Vuelta atrás: supabase/rollbacks/20261209010000_media_thumbnails.sql

alter table public.media_assets add column thumb_path text;

alter table public.media_assets add constraint media_assets_thumb_path_check check (
  thumb_path is null
  or (
    source = 'storage'
    and char_length(thumb_path) <= 1024
    and thumb_path like organization_id::text || '/' || brand_id::text || '/thumbs/%'
  )
);

create unique index media_assets_thumb_path_key on public.media_assets (thumb_path) where thumb_path is not null;

-- Solo al crear el recurso; después no hay privilegio de UPDATE para el cliente.
grant insert (thumb_path) on public.media_assets to authenticated;

-- ─────────────── Cola de limpieza: el original y su miniatura ───────────────

create or replace function private.queue_storage_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.source = 'google_drive' then
    return old;
  end if;
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path, storage_backend)
  values (old.organization_id, old.brand_id, old.storage_path, old.storage_backend)
  on conflict (storage_path) do update set storage_backend = excluded.storage_backend;
  if old.thumb_path is not null then
    insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path, storage_backend)
    values (old.organization_id, old.brand_id, old.thumb_path, old.storage_backend)
    on conflict (storage_path) do update set storage_backend = excluded.storage_backend;
  end if;
  return old;
end $$;

-- ─────────────── Huérfanos de R2: una miniatura sí tiene recurso ───────────────

create or replace function public.media_storage_orphans(
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
        and not exists (
          select 1 from public.media_assets ma
          where ma.storage_path = l.storage_path or ma.thumb_path = l.storage_path
        )
      limit greatest(coalesce(p_limit, 200), 1)
    ) x;
  else
    select coalesce(jsonb_agg(jsonb_build_object('storage_path', x.storage_path, 'backend', x.backend)), '[]'::jsonb)
    into v_rows
    from (
      select l.storage_path, l.backend
      from private.media_object_locations l
      where l.created_at < now() - coalesce(p_min_age, interval '24 hours')
        and not exists (
          select 1 from public.media_assets ma
          where ma.storage_path = l.storage_path or ma.thumb_path = l.storage_path
        )
      order by l.created_at
      limit greatest(coalesce(p_limit, 200), 1)
    ) x;
  end if;
  return v_rows;
end $$;

create or replace function private.media_storage_orphans_dispatch() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  if not exists (
    select 1 from private.media_object_locations l
    where l.created_at < now() - interval '24 hours'
      and not exists (
        select 1 from public.media_assets ma
        where ma.storage_path = l.storage_path or ma.thumb_path = l.storage_path
      )
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

-- ─────────────── Borrado y exportación de la organización ───────────────

create or replace function private.organization_storage_paths(p_organization_id uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct p order by p), '{}'::text[])
  from (
    select a.storage_path as p from public.media_assets a where a.organization_id = p_organization_id
    union all
    select a.thumb_path from public.media_assets a
    where a.organization_id = p_organization_id and a.thumb_path is not null
    union all
    select s.storage_path from public.brand_knowledge_sources s
    where s.organization_id = p_organization_id and s.storage_path is not null
    union all
    select f.storage_path from public.brand_fonts f where f.organization_id = p_organization_id
    union all
    select q.storage_path from public.storage_cleanup_queue q where q.organization_id = p_organization_id
    union all
    select o.name from storage.objects o
    where o.bucket_id = 'brand-media' and o.name like p_organization_id::text || '/%'
  ) paths;
$$;
