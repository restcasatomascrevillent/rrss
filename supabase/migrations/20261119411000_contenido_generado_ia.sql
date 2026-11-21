-- Etiquetado de contenido generado con IA (Reglamento europeo de IA, art. 50;
-- ver docs/06-decisiones-fase-2.md, apartado 5, y docs/rgpd.md).
--
-- `content_versions.ai_generated` dice si el documento de ESA versión lleva
-- algo generado con IA; `content_items.ai_generated` copia el de la versión
-- vigente. Los calcula la base de datos al guardar cada versión (nadie los
-- escribe desde el cliente), a partir de la procedencia:
--
--   * una capa de imagen cuyo origen es una generación (`source.kind =
--     'generation'`);
--   * una capa de imagen o un logotipo que usa un recurso de la biblioteca de
--     la MISMA marca con procedencia `ai_generation` (solo la puede escribir el
--     servidor), o un recurso que sale de algo que lo llevaba: un reel o un
--     recorte (`media_job`) hecho con fotos generadas con IA, o una imagen
--     exportada (`export`) de una versión marcada (un nivel; si la exportación
--     no dice la versión, se usa la marca de la pieza);
--   * texto marcado como generado con IA en el documento: `copy.aiGenerated`
--     (el editor lo pone al aplicar un texto redactado con IA) o
--     `aiGenerated` en cualquier capa.
--
-- El criterio es conservador: un texto redactado con IA y retocado después
-- sigue marcado. La publicación (Fase 3) leerá `content_versions.ai_generated`
-- de la versión exacta que publique para enviar el aviso de cada red (en
-- TikTok, `is_aigc`) y para la marca legible por máquina. Qué etiqueta exige la
-- ley en cada caso es una consulta pendiente al abogado.

alter table public.content_versions add column ai_generated boolean not null default false;
alter table public.content_items add column ai_generated boolean not null default false;

-- ¿Alguno de estos recursos de la marca es (o sale de) contenido generado con IA?
create function private.media_assets_ai_generated(p_brand_id uuid, p_asset_ids uuid[])
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.media_assets a
    where a.brand_id = p_brand_id
      and a.id = any (coalesce(p_asset_ids, '{}'))
      and (
        a.provenance ->> 'type' = 'ai_generation'
        -- Reel o recorte: alguna de sus fuentes es una imagen generada con IA.
        or (a.provenance ->> 'type' = 'media_job' and exists (
              select 1
              from jsonb_array_elements(
                     case when jsonb_typeof(a.provenance -> 'sources') = 'array' then a.provenance -> 'sources'
                          when jsonb_typeof(a.provenance -> 'source_asset_ids') = 'array' then a.provenance -> 'source_asset_ids'
                          else '[]'::jsonb end) s
              join public.media_assets src
                on src.brand_id = p_brand_id
               and src.id::text = coalesce(s ->> 'asset_id', case when jsonb_typeof(s) = 'string' then s #>> '{}' end)
              where src.provenance ->> 'type' = 'ai_generation'))
        -- Imagen exportada de una pieza: la marca de la versión exportada.
        or (a.provenance ->> 'type' = 'export' and (
              exists (
                select 1 from public.content_versions v
                where v.brand_id = p_brand_id
                  and v.content_id::text = a.provenance ->> 'content_id'
                  and v.version::text = a.provenance ->> 'version'
                  and v.ai_generated)
              or (a.provenance ->> 'version' is null and exists (
                select 1 from public.content_items c
                where c.brand_id = p_brand_id and c.id::text = a.provenance ->> 'content_id' and c.ai_generated))))
      )
  );
$$;

-- Función que calcula la marca de un documento (formato de
-- src/features/content/document/schema.ts). Solo mira recursos de la marca
-- indicada: un documento que apunte a un recurso de otra marca no averigua
-- nada de él.
create function private.content_document_ai_generated(p_brand_id uuid, p_data jsonb)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_layers jsonb := case when jsonb_typeof(p_data -> 'layers') = 'array' then p_data -> 'layers' else '[]'::jsonb end;
  v_asset_ids uuid[];
begin
  if jsonb_typeof(p_data) <> 'object' then
    return false;
  end if;
  if p_data -> 'copy' ->> 'aiGenerated' = 'true' then
    return true;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_layers) l
    where jsonb_typeof(l) = 'object'
      and (l ->> 'aiGenerated' = 'true' or (l ->> 'type' = 'image' and l -> 'source' ->> 'kind' = 'generation'))
  ) then
    return true;
  end if;

  select array_agg(distinct x.id::uuid) into v_asset_ids
  from (
    select case when l ->> 'type' = 'logo' then l ->> 'assetId' else l -> 'source' ->> 'assetId' end as id
    from jsonb_array_elements(v_layers) l
    where jsonb_typeof(l) = 'object'
      and ((l ->> 'type' = 'image' and l -> 'source' ->> 'kind' = 'asset') or l ->> 'type' = 'logo')
  ) x
  where x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  return v_asset_ids is not null and private.media_assets_ai_generated(p_brand_id, v_asset_ids);
end $$;

-- Cada versión nueva se marca al insertarla (también las que entrega la agencia
-- o restaura una persona), y la pieza toma la marca de su versión nueva, que
-- siempre pasa a ser la vigente.
create function private.content_versions_ai_label() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.ai_generated := private.content_document_ai_generated(new.brand_id, new.data);
  return new;
end $$;

create function private.content_items_ai_label() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.content_items c set ai_generated = new.ai_generated
  where c.id = new.content_id and c.ai_generated is distinct from new.ai_generated;
  return null;
end $$;

create trigger content_versions_ai_label before insert on public.content_versions
  for each row execute function private.content_versions_ai_label();
create trigger content_versions_ai_label_item after insert on public.content_versions
  for each row execute function private.content_items_ai_label();

-- Lo que ya existe: primero las versiones (en orden, por las exportaciones de
-- versiones anteriores) y después las piezas.
do $$
declare
  v record;
begin
  for v in select cv.id, cv.brand_id, cv.data from public.content_versions cv order by cv.created_at, cv.version loop
    update public.content_versions cv2 set ai_generated = private.content_document_ai_generated(v.brand_id, v.data)
    where cv2.id = v.id;
  end loop;
end $$;
update public.content_items c set ai_generated = v.ai_generated
from public.content_versions v
where v.content_id = c.id and v.version = c.current_version and c.ai_generated is distinct from v.ai_generated;

revoke all on function private.media_assets_ai_generated(uuid, uuid[]) from public, anon, authenticated;
revoke all on function private.content_document_ai_generated(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.content_versions_ai_label() from public, anon, authenticated;
revoke all on function private.content_items_ai_label() from public, anon, authenticated;
