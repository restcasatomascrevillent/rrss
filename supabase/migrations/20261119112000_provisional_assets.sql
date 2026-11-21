-- Biblioteca: recursos provisionales y su limpieza programada.
--
-- Problema: un logotipo subido en el editor del perfil de marca entra en la
-- biblioteca al momento (hace falta su id para enseñarlo y enlazarlo), pero
-- solo queda enlazado al guardar el perfil. Si la persona cierra o recarga la
-- pestaña sin guardar, la interfaz no llega a borrarlo y se queda huérfano.
-- Desde el navegador no hay forma fiable de arreglarlo (al cerrar la pestaña
-- no se puede esperar a una petición), así que lo arregla el servidor:
--
--   1. `media_assets.provisional_until`: quien sube desde el perfil marca el
--      recurso como provisional (en el alta manda cualquier valor no nulo; el
--      plazo lo fija la base de datos: 48 horas). El cliente no puede
--      cambiarlo después (no tiene permiso de UPDATE sobre la columna).
--   2. Deja de ser provisional en cuanto cuenta para alguien:
--        * al guardarse una versión del perfil que lo enlaza
--          (`data.visual.logoAssetIds`), en el mismo INSERT de la versión;
--        * al moverlo, renombrarlo, cambiar su tipo, sus etiquetas o sus
--          derechos en la biblioteca: si alguien lo ha tocado, lo quiere.
--   3. `private.purge_provisional_assets()` borra los provisionales caducados
--      que NO estén enlazados en ningún sitio que conozca la base de datos:
--      cualquier versión del perfil de su marca (también las archivadas, que se
--      pueden restaurar), contenidos (`content_versions.data`), encargos
--      (`reference_asset_ids`), procedencia de otros recursos y trabajos de
--      medios en marcha. Lo que no se puede asegurar, no se borra.
--      El borrado de la fila anota el archivo en `storage_cleanup_queue` (el
--      disparador que ya existía) y el archivo lo quita el barrido de la
--      biblioteca; desde SQL no se borran objetos de Storage.
--   4. pg_cron la ejecuta cada hora donde existe (Supabase, también en el plan
--      gratuito); en las pruebas con PGlite no se programa.
--
-- Por qué 48 horas: más que cualquier sesión normal de edición del perfil
-- (si se pasara, el logotipo desaparecería del borrador) y lo bastante corto
-- para que la biblioteca no acumule restos.

alter table public.media_assets add column provisional_until timestamptz;

create index media_assets_provisional_idx on public.media_assets (provisional_until)
  where provisional_until is not null;

-- Se puede dar en el alta (el valor lo normaliza el disparador); no se puede cambiar después.
grant insert (provisional_until) on public.media_assets to authenticated;

create function private.media_assets_provisional() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.provisional_until is not null then
      -- El plazo (48 horas) lo decide el servidor, no quien sube.
      new.provisional_until := now() + interval '48 hours';
    end if;
  elsif new.provisional_until is not null
        and (new.file_name is distinct from old.file_name
             or new.folder is distinct from old.folder
             or new.tags is distinct from old.tags
             or new.kind is distinct from old.kind
             or new.rights is distinct from old.rights) then
    -- Alguien lo ha organizado a mano: deja de ser provisional.
    new.provisional_until := null;
  end if;
  return new;
end $$;

create trigger media_assets_provisional before insert or update on public.media_assets
  for each row execute function private.media_assets_provisional();

-- Al guardar una versión del perfil, sus logotipos dejan de ser provisionales.
create function private.brand_profiles_settle_logos() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(new.data #> '{visual,logoAssetIds}') = 'array' then
    update public.media_assets a
    set provisional_until = null
    where a.brand_id = new.brand_id
      and a.provisional_until is not null
      and a.id::text in (select jsonb_array_elements_text(new.data #> '{visual,logoAssetIds}'));
  end if;
  return null;
end $$;

create trigger brand_profiles_settle_logos after insert on public.brand_profiles
  for each row execute function private.brand_profiles_settle_logos();

-- Borra los provisionales caducados y sin enlazar. Devuelve cuántos ha borrado.
create function private.purge_provisional_assets(p_limit integer default 500)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with doomed as (
    select a.id from public.media_assets a
    where a.provisional_until is not null
      and a.provisional_until < now()
      -- Cualquier versión del perfil de la marca (también archivadas).
      and not exists (
        select 1 from public.brand_profiles p
        where p.brand_id = a.brand_id and (p.data #> '{visual,logoAssetIds}') ? a.id::text)
      -- Encargos que lo citan como referencia.
      and not exists (
        select 1 from public.content_requests r
        where r.brand_id = a.brand_id and a.id = any (r.reference_asset_ids))
      -- Contenidos: el documento guarda el id del recurso.
      and not exists (
        select 1 from public.content_versions v
        where v.brand_id = a.brand_id and strpos(v.data::text, a.id::text) > 0)
      -- Otros recursos que salieron de él (recortes, reels, exportaciones…).
      and not exists (
        select 1 from public.media_assets o
        where o.brand_id = a.brand_id and o.id <> a.id and strpos(o.provenance::text, a.id::text) > 0)
      -- Trabajos de medios en marcha que lo usan.
      and not exists (
        select 1 from public.jobs j
        where j.brand_id = a.brand_id and j.status in ('queued', 'running')
          and strpos(j.payload::text, a.storage_path) > 0)
    order by a.provisional_until
    limit greatest(coalesce(p_limit, 500), 1)
    for update of a skip locked
  )
  delete from public.media_assets a using doomed d where a.id = d.id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function private.media_assets_provisional() from public, anon, authenticated;
revoke all on function private.brand_profiles_settle_logos() from public, anon, authenticated;
revoke all on function private.purge_provisional_assets(integer) from public, anon, authenticated;
grant execute on function private.purge_provisional_assets(integer) to service_role;

-- Programar la limpieza cada hora, solo donde existe pg_cron.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    -- Mismo nombre = se actualiza la tarea, no se duplica.
    perform cron.schedule('rrss-purge-provisional-assets', '17 * * * *',
                          'select private.purge_provisional_assets()');
  else
    raise notice 'pg_cron no está disponible: no se programa la limpieza de recursos provisionales';
  end if;
end
$do$;
