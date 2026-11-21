-- Carruseles de verdad: varias páginas en UNA versión (documento v4,
-- src/features/content/document/schema.ts; docs/publicacion.md §«Carruseles»).
--
--   1. `private.content_version_page_count`: páginas del documento de una
--      versión (un documento anterior a la v4, sin `pages`, tiene una).
--   2. La regla dura de publicación se amplía a varias exportaciones EN ORDEN:
--      un carrusel se arma solo con una exportación JPEG de cada página de la
--      versión aprobada, y en el orden de las páginas: el recurso n.º i dice en
--      su procedencia `page = i` y `page_count = páginas de la versión`. Un post
--      se arma con una exportación de un documento de UNA página. El publicador
--      ya envía los recursos en el orden de `media_asset_ids` (con ordinalidad),
--      así que el carrusel sale en el orden de las páginas.
--      Antes: un carrusel valía con 2 a 10 exportaciones cualesquiera de la
--      versión (el documento tenía un solo lienzo: eran la misma imagen o de
--      versiones distintas, que no se podían publicar).
--   3. La marca «Generado con IA» y la entrega de plantillas miran las capas de
--      todas las páginas (y las de un documento antiguo, sin páginas).
--   4. Se reevalúa lo que está en el calendario con la regla nueva.
--
-- Procedencia de una exportación de una página (la valida la aplicación,
-- src/features/content/export/options.ts):
--   {"type": "export", "content_id": "<uuid>", "version": 3, "unsaved_changes": false,
--    "format": "jpeg", "width": 1080, "height": 1350, "pixel_ratio": 1,
--    "exported_at": "<ISO 8601>", "page": 2, "page_count": 4}
-- En un documento de una página, `page` y `page_count` no están.

-- ─────────────────────── 1. Páginas de una versión ───────────────────────

create function private.content_version_page_count(p_content_id uuid, p_version integer)
returns integer
language sql stable security definer set search_path = '' as $$
  select case when jsonb_typeof(v.data -> 'pages') = 'array' then jsonb_array_length(v.data -> 'pages') else 1 end
  from public.content_versions v
  where v.content_id = p_content_id and v.version = p_version;
$$;

revoke all on function private.content_version_page_count(uuid, integer) from public, anon, authenticated;

-- ─────────────────────── 2. Regla de publicación ───────────────────────

-- ¿Valen estos recursos para esta pieza, versión y formato? Null si valen; si
-- no, 'no_media' (faltan) o 'invalid_media'.
--   post: 1 imagen JPEG, exportación de esa pieza y versión, y el documento de
--         la versión tiene una sola página.
--   carousel: una exportación JPEG por página (de 2 a 10 páginas), de esa pieza
--         y versión, y en el orden de las páginas (el recurso i es la página i).
--   reel: 1 vídeo MP4 o MOV de la marca (el trabajador de medios lo monta y no
--         sale del documento).
create or replace function private.publication_media_problem(
  p_brand_id uuid, p_content_id uuid, p_version integer, p_format text, p_asset_ids uuid[]
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_count integer := coalesce(cardinality(p_asset_ids), 0);
  v_pages integer;
  v_found integer;
  v_ok integer;
  v_in_order integer;
begin
  if v_count = 0 then
    return 'no_media';
  end if;
  if p_format = 'reel' then
    select count(*), count(*) filter (where a.kind = 'video' and a.mime_type in ('video/mp4', 'video/quicktime'))
    into v_found, v_ok
    from public.media_assets a
    where a.id = any (p_asset_ids) and a.brand_id = p_brand_id;
    if v_found <> v_count or v_ok <> v_count or v_count <> 1 then
      return 'invalid_media';
    end if;
    return null;
  end if;

  v_pages := coalesce(private.content_version_page_count(p_content_id, p_version), 0);

  -- Cada recurso, en su posición: exportación JPEG de ESA pieza y ESA versión,
  -- sin cambios sin guardar, y (en un documento de varias páginas) de la página
  -- que ocupa esa posición.
  select count(*),
         count(*) filter (where
           a.kind = 'image' and a.mime_type = 'image/jpeg'
           and a.provenance ->> 'type' = 'export'
           and a.provenance ->> 'content_id' = p_content_id::text
           and coalesce(a.provenance ->> 'version', '') = coalesce(p_version::text, '-')
           -- Exportada con cambios sin guardar: no es la versión aprobada.
           and coalesce(a.provenance ->> 'unsaved_changes', 'false') = 'false'),
         count(*) filter (where
           case when v_pages > 1 then
             a.provenance ->> 'page' = u.ord::text and a.provenance ->> 'page_count' = v_pages::text
           else
             coalesce(a.provenance ->> 'page', '1') = '1' and coalesce(a.provenance ->> 'page_count', '1') = '1'
           end)
  into v_found, v_ok, v_in_order
  from unnest(p_asset_ids) with ordinality u(id, ord)
  join public.media_assets a on a.id = u.id and a.brand_id = p_brand_id;

  if v_found <> v_count or v_ok <> v_count or v_in_order <> v_count then
    return 'invalid_media';
  end if;
  if p_format = 'post' and (v_count <> 1 or v_pages <> 1) then
    return 'invalid_media';
  end if;
  if p_format = 'carousel' and (v_pages not between 2 and 10 or v_count <> v_pages) then
    return 'invalid_media';
  end if;
  return null;
end $$;

-- ─────────────────────── 3. Capas de todas las páginas ───────────────────────

-- Capas de un documento: las de cada página (v4) y, en uno anterior, su lista.
create function private.content_document_layers(p_data jsonb)
returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(case when jsonb_typeof(p_data -> 'layers') = 'array' then p_data -> 'layers' end, '[]'::jsonb)
         || coalesce((
              select jsonb_agg(l.value order by p.ordinality, l.ordinality)
              from jsonb_array_elements(case when jsonb_typeof(p_data -> 'pages') = 'array'
                                             then p_data -> 'pages' else '[]'::jsonb end) with ordinality p
              cross join lateral jsonb_array_elements(case when jsonb_typeof(p.value -> 'layers') = 'array'
                                                           then p.value -> 'layers' else '[]'::jsonb end)
                with ordinality l
            ), '[]'::jsonb);
$$;

revoke all on function private.content_document_layers(jsonb) from public, anon, authenticated;

create or replace function private.content_document_ai_generated(p_brand_id uuid, p_data jsonb)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_layers jsonb;
  v_asset_ids uuid[];
begin
  if jsonb_typeof(p_data) <> 'object' then
    return false;
  end if;
  v_layers := private.content_document_layers(p_data);
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

-- Entrega de plantillas de diseño: igual que en 20261201010000, pero los
-- recursos se buscan en las capas de todas las páginas (documento v4).
create or replace function public.deliver_design_templates(p_brand_id uuid, p_templates jsonb)
returns setof public.brand_design_templates
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
  v_item jsonb;
  v_layer jsonb;
  v_example jsonb;
  v_asset text;
  v_row public.brand_design_templates;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  if p_brand_id is null or not private.user_has_brand_capability(v_uid, p_brand_id, 'edit') then
    raise exception 'Solo quien edita la marca puede entregar plantillas' using errcode = '42501';
  end if;
  select b.organization_id into v_org from public.brands b where b.id = p_brand_id;
  if p_templates is null or jsonb_typeof(p_templates) <> 'array'
     or jsonb_array_length(p_templates) not between 1 and 12 then
    raise exception 'Hay que entregar entre 1 y 12 plantillas' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_templates) loop
    if jsonb_typeof(v_item -> 'document') <> 'object' or jsonb_typeof(v_item -> 'analysis') <> 'object' then
      raise exception 'Cada plantilla necesita un documento y un análisis' using errcode = '22023';
    end if;
    -- Los recursos del documento (imágenes y logotipo, en cualquier página) son de esta marca.
    for v_layer in select * from jsonb_array_elements(private.content_document_layers(v_item -> 'document')) loop
      v_asset := case v_layer ->> 'type'
        when 'image' then case when v_layer #>> '{source,kind}' = 'asset' then v_layer #>> '{source,assetId}' end
        when 'logo' then v_layer ->> 'assetId'
      end;
      if v_asset is not null and (v_asset !~ '^[0-9a-f-]{36}$' or not exists (
           select 1 from public.media_assets a where a.id = v_asset::uuid and a.brand_id = p_brand_id)) then
        raise exception 'El documento usa un recurso que no es de la biblioteca de la marca' using errcode = '22023';
      end if;
    end loop;
    -- Los ejemplos son publicaciones importadas de la marca.
    for v_example in select * from jsonb_array_elements(coalesce(v_item #> '{analysis,examples}', '[]'::jsonb)) loop
      if not exists (select 1 from public.social_imported_media m
                     where m.brand_id = p_brand_id and m.permalink = v_example ->> 'permalink') then
        raise exception 'Un ejemplo no es una publicación importada de la marca: %',
          left(coalesce(v_example ->> 'permalink', ''), 120) using errcode = '22023';
      end if;
    end loop;

    insert into public.brand_design_templates (brand_id, organization_id, template_key, name, network, format,
                                               document, analysis, source, created_by)
    values (p_brand_id, v_org, v_item ->> 'key', v_item ->> 'name', v_item ->> 'network', v_item ->> 'format',
            v_item -> 'document', v_item -> 'analysis', 'instagram_import', v_uid)
    on conflict (brand_id, template_key) do update
      set name = excluded.name, network = excluded.network, format = excluded.format,
          document = excluded.document, analysis = excluded.analysis, source = excluded.source
    returning * into v_row;
    return next v_row;
  end loop;
end $$;

-- ─────────────────────── 4. Lo que ya está en el calendario ───────────────────────

-- Con la regla nueva, un carrusel programado con exportaciones sin número de
-- página (de antes) se detiene con «invalid_media» hasta elegir las de cada
-- página; lo demás no cambia.
select private.publication_refresh();
