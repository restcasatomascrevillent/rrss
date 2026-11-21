-- Vuelta atrás de 20261203010000_carousel_pages.sql.
--
-- Vuelven la regla de publicación de antes (un carrusel con 2 a 10
-- exportaciones cualesquiera de la versión), la marca «Generado con IA» y la
-- entrega de plantillas que solo miran `layers` (documento v3). Las
-- exportaciones con número de página se quedan en la biblioteca. OJO: con esta
-- vuelta atrás, la aplicación con documentos v4 deja de marcar bien lo
-- generado con IA de las páginas; hay que volver también a la versión de la
-- aplicación anterior al documento v4.

create or replace function private.publication_media_problem(
  p_brand_id uuid, p_content_id uuid, p_version integer, p_format text, p_asset_ids uuid[]
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_count integer := coalesce(cardinality(p_asset_ids), 0);
  v_found integer;
  v_ok integer;
begin
  if v_count = 0 then
    return 'no_media';
  end if;
  select count(*),
         count(*) filter (where
           case when p_format = 'reel' then
             a.kind = 'video' and a.mime_type in ('video/mp4', 'video/quicktime')
           else
             a.kind = 'image' and a.mime_type = 'image/jpeg'
             and a.provenance ->> 'type' = 'export'
             and a.provenance ->> 'content_id' = p_content_id::text
             and coalesce(a.provenance ->> 'version', '') = coalesce(p_version::text, '-')
             -- Exportada con cambios sin guardar: no es la versión aprobada.
             and coalesce(a.provenance ->> 'unsaved_changes', 'false') = 'false'
           end)
  into v_found, v_ok
  from public.media_assets a
  where a.id = any (p_asset_ids) and a.brand_id = p_brand_id;

  if v_found <> v_count or v_ok <> v_count then
    return 'invalid_media';
  end if;
  if (p_format = 'post' and v_count <> 1) or (p_format = 'reel' and v_count <> 1)
     or (p_format = 'carousel' and v_count not between 2 and 10) then
    return 'invalid_media';
  end if;
  return null;
end $$;

create or replace function private.content_document_ai_generated(p_brand_id uuid, p_data jsonb)
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
    -- Los recursos del documento (imágenes y logotipo) son de esta marca.
    for v_layer in select * from jsonb_array_elements(coalesce(v_item #> '{document,layers}', '[]'::jsonb)) loop
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

drop function if exists private.content_document_layers(jsonb);
drop function if exists private.content_version_page_count(uuid, integer);

select private.publication_refresh();
