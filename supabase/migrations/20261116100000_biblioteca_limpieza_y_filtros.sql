-- Biblioteca de recursos: limpieza de archivos huérfanos y filtros completos.
--
-- 1. Cola de limpieza de Storage. Al borrar una fila de media_assets (a mano o
--    en cascada al borrar la marca), un disparador anota la ruta de su archivo.
--    El cliente borra el objeto y después la anotación; si el borrado del
--    objeto falla, la anotación se queda y se reintenta en la siguiente visita
--    a la biblioteca. Así un fallo puntual no deja un archivo huérfano para siempre.
--    Sin claves foráneas a propósito: la cola debe sobrevivir al borrado de la
--    marca (las filas de marcas ya borradas solo las puede barrer el servidor).

create table public.storage_cleanup_queue (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  brand_id uuid not null,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index storage_cleanup_queue_brand_idx on public.storage_cleanup_queue (brand_id, created_at);

alter table public.storage_cleanup_queue enable row level security;

create policy storage_cleanup_queue_select on public.storage_cleanup_queue for select to authenticated
  using (brand_id in (select private.brand_ids_with('edit')));
create policy storage_cleanup_queue_delete on public.storage_cleanup_queue for delete to authenticated
  using (brand_id in (select private.brand_ids_with('edit')));

-- Solo se lee y se borra desde el cliente; las altas las hace el disparador.
revoke all on public.storage_cleanup_queue from anon, authenticated, public;
grant select, delete on public.storage_cleanup_queue to authenticated;
grant all on public.storage_cleanup_queue to service_role;

create function private.queue_storage_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path)
  values (old.organization_id, old.brand_id, old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end $$;

revoke all on function private.queue_storage_cleanup() from public, anon, authenticated;

create trigger media_assets_queue_cleanup after delete on public.media_assets
  for each row execute function private.queue_storage_cleanup();

-- 2. Filtros de la biblioteca: todas las etiquetas y carpetas de una marca, no
--    las de los 1.000 recursos más recientes. SECURITY INVOKER a propósito: la
--    RLS de media_assets decide qué marcas puede ver quien pregunta.

create function public.asset_facets(p_brand_id uuid)
returns table (tags text[], folders text[])
language sql stable security invoker set search_path = '' as $$
  select
    coalesce((select array_agg(distinct t) from public.media_assets a, unnest(a.tags) t
              where a.brand_id = p_brand_id), '{}'::text[]),
    coalesce((select array_agg(distinct a.folder) from public.media_assets a
              where a.brand_id = p_brand_id and a.folder <> ''), '{}'::text[]);
$$;

revoke all on function public.asset_facets(uuid) from public, anon;
grant execute on function public.asset_facets(uuid) to authenticated, service_role;
