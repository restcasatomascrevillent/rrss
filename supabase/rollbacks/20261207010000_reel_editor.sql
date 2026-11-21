-- Vuelta atrás de 20261207010000_reel_editor.sql.
--
-- Devuelve la carga del reel a la de 20261121010000 (solo plan v1), la
-- tipografía por defecto a la de 20261119211000 (solo con textos) y el alta del
-- resultado a la de 20261118220000. No borra nada: los vídeos ya montados se
-- quedan en la biblioteca con su procedencia, y los montajes guardados en las
-- piezas siguen ahí (sin poder encargarse hasta volver a aplicar la migración).


create or replace function private.media_reel_payload(p_org uuid, p_brand_id uuid, p_input jsonb, p_file text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_template jsonb := p_input -> 'template';
  v_plan jsonb := p_input -> 'plan';
  v_item jsonb;
  v_index integer := 0;
begin
  if not private.jsonb_only_keys(p_input, array['template', 'plan']) then
    raise exception 'El encargo del reel solo admite la plantilla y el plan' using errcode = '22023';
  end if;
  if not private.jsonb_only_keys(v_template, array['id'])
     or jsonb_typeof(v_template -> 'id') is distinct from 'string'
     or (v_template ->> 'id') !~ '^[a-z][a-z0-9-]{1,40}$' then
    raise exception 'Elige una de las plantillas disponibles' using errcode = '22023';
  end if;
  if not private.jsonb_only_keys(v_plan, array['media', 'texts', 'music']) then
    raise exception 'El plan del reel solo admite fotos y clips, textos y música' using errcode = '22023';
  end if;

  if jsonb_typeof(v_plan -> 'media') is distinct from 'array'
     or jsonb_array_length(v_plan -> 'media') not between 1 and 20 then
    raise exception 'Elige entre 1 y 20 fotos o clips' using errcode = '22023';
  end if;
  for v_item in select e.value from jsonb_array_elements(v_plan -> 'media') e loop
    v_index := v_index + 1;
    if not private.jsonb_only_keys(v_item, array['type', 'path', 'focalPoint', 'startAt', 'seconds', 'blur']) then
      raise exception 'Pieza %: campos no admitidos', v_index using errcode = '22023';
    end if;
    -- Desenfoque (0 a 100, como `blur` de las imágenes del documento v3).
    if v_item ? 'blur' and (jsonb_typeof(v_item -> 'blur') is distinct from 'number'
                            or (v_item ->> 'blur')::numeric not between 0 and 100) then
      raise exception 'Pieza %: el desenfoque va de 0 a 100', v_index using errcode = '22023';
    end if;
    if v_item ->> 'type' = 'photo' then
      perform private.media_job_input(p_brand_id, v_item -> 'path', array['image', 'logo']::public.asset_kind[],
                                      format('Pieza %s', v_index));
    elsif v_item ->> 'type' = 'video' then
      perform private.media_job_input(p_brand_id, v_item -> 'path', array['video']::public.asset_kind[],
                                      format('Pieza %s', v_index));
    else
      raise exception 'Pieza %: solo se admiten fotos y clips', v_index using errcode = '22023';
    end if;
  end loop;

  if v_plan ? 'texts' then
    if jsonb_typeof(v_plan -> 'texts') is distinct from 'array' or jsonb_array_length(v_plan -> 'texts') > 20 then
      raise exception 'Como mucho 20 textos' using errcode = '22023';
    end if;
    v_index := 0;
    for v_item in select e.value from jsonb_array_elements(v_plan -> 'texts') e loop
      v_index := v_index + 1;
      if not private.jsonb_only_keys(v_item, array['text', 'start', 'end', 'position'])
         or jsonb_typeof(v_item -> 'text') is distinct from 'string' then
        raise exception 'Texto %: campos no admitidos', v_index using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_plan ? 'music' then
    if not private.jsonb_only_keys(v_plan -> 'music', array['path', 'startAt', 'volume']) then
      raise exception 'Música: campos no admitidos' using errcode = '22023';
    end if;
    perform private.media_job_input(p_brand_id, v_plan #> '{music,path}', array['audio']::public.asset_kind[], 'Música');
  end if;

  return jsonb_build_object(
    'template', v_template,
    'plan', v_plan,
    'output', jsonb_build_object('path', format('%s/%s/reels/%s.mp4', p_org, p_brand_id, p_file))
  );
end $$;

create or replace function private.jobs_reel_brand_font() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_font public.brand_fonts;
begin
  if new.brand_id is null
     or jsonb_typeof(new.payload -> 'plan') is distinct from 'object'
     or new.payload #> '{plan,fontPath}' is not null
     or jsonb_typeof(new.payload #> '{plan,texts}') is distinct from 'array'
     or jsonb_array_length(new.payload #> '{plan,texts}') = 0 then
    return new;
  end if;
  v_font := private.brand_reel_font(new.brand_id);
  if v_font.id is not null then
    new.payload := jsonb_set(new.payload, '{plan,fontPath}', to_jsonb(v_font.storage_path));
  end if;
  return new;
end $$;

create or replace function private.jobs_publish_media_assets() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_assets jsonb := '[]'::jsonb;
  v_asset uuid;
  v_path text;
  v_out jsonb;
  v_item record;
  v_sources jsonb;
  v_provenance jsonb;
  v_source_name text;
  v_format text;
begin
  -- Una carga que no dice dónde dejar el archivo no produce nada que dar de
  -- alta (el trabajador la rechazaría igualmente).
  if (new.kind = 'media.reel.template' and new.payload #>> '{output,path}' is null)
     or (new.kind = 'media.image.process' and jsonb_typeof(new.payload -> 'outputs') is distinct from 'array') then
    return new;
  end if;

  if new.kind = 'media.reel.template' then
    v_path := new.payload #>> '{output,path}';
    v_out := new.result -> 'output';
    if jsonb_typeof(v_out) is distinct from 'object' or v_out ->> 'path' is distinct from v_path then
      raise exception 'El resultado del reel no corresponde a su encargo' using errcode = '22023';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('type', m.value ->> 'type', 'asset_id', a.id,
                                                 'path', m.value ->> 'path')
                              order by m.ordinality), '[]'::jsonb)
      into v_sources
    from jsonb_array_elements(new.payload #> '{plan,media}') with ordinality m
    left join public.media_assets a on a.brand_id = new.brand_id and a.storage_path = m.value ->> 'path';

    v_provenance := private.media_job_provenance(
      jsonb_strip_nulls(jsonb_build_object(
        'type', 'media_job',
        'kind', new.kind,
        'job_id', new.id,
        'template_id', new.payload #>> '{template,id}',
        'template_schema_version', new.result #> '{template,schemaVersion}',
        'music_asset_id', (select a.id from public.media_assets a
                           where a.brand_id = new.brand_id and a.storage_path = new.payload #>> '{plan,music,path}')
      )),
      v_sources);

    insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type,
                                     bytes, width, height, duration_ms, folder, created_by, provenance)
    values (
      new.brand_id, new.organization_id, 'video', 'generated', v_path,
      format('reel-%s-%s.mp4', new.payload #>> '{template,id}', to_char(now() at time zone 'utc', 'YYYYMMDD-HH24MISS')),
      'video/mp4',
      (v_out ->> 'bytes')::bigint,
      (v_out ->> 'width')::integer,
      (v_out ->> 'height')::integer,
      round((v_out ->> 'durationSeconds')::numeric * 1000)::integer,
      'Reels',
      new.created_by,
      v_provenance
    )
    on conflict (storage_path) do nothing
    returning id into v_asset;
    if v_asset is null then
      select a.id into v_asset from public.media_assets a where a.storage_path = v_path;
    end if;
    v_assets := jsonb_build_array(jsonb_build_object('id', v_asset, 'path', v_path, 'kind', 'video'));

  elsif new.kind = 'media.image.process' then
    v_sources := jsonb_build_array(jsonb_build_object(
      'type', 'photo',
      'asset_id', (select a.id from public.media_assets a
                   where a.brand_id = new.brand_id and a.storage_path = new.payload #>> '{source,path}'),
      'path', new.payload #>> '{source,path}'
    ));
    -- Nombre legible: el de la foto de origen sin extensión.
    v_source_name := regexp_replace(
      coalesce((select a.file_name from public.media_assets a
                where a.brand_id = new.brand_id and a.storage_path = new.payload #>> '{source,path}'), 'foto'),
      '\.[^.]*$', '');

    for v_item in select e.value as output from jsonb_array_elements(new.payload -> 'outputs') e loop
      v_path := v_item.output ->> 'path';
      select r.value into v_out from jsonb_array_elements(new.result -> 'outputs') r where r.value ->> 'path' = v_path;
      if v_out is null then
        raise exception 'Al resultado del recorte le falta «%»', v_path using errcode = '22023';
      end if;
      v_format := coalesce(v_item.output ->> 'format', 'jpeg');
      insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type,
                                       bytes, width, height, folder, created_by, provenance)
      values (
        new.brand_id, new.organization_id, 'image', 'generated', v_path,
        left(format('%s-%s.%s', v_source_name, replace(v_item.output ->> 'aspect', ':', 'x'),
                    case v_format when 'jpeg' then 'jpg' else v_format end), 255),
        'image/' || v_format,
        (v_out ->> 'bytes')::bigint,
        (v_out ->> 'width')::integer,
        (v_out ->> 'height')::integer,
        'Recortes',
        new.created_by,
        private.media_job_provenance(
          jsonb_strip_nulls(jsonb_build_object(
            'type', 'media_job',
            'kind', new.kind,
            'job_id', new.id,
            'aspect', v_item.output ->> 'aspect',
            'focal_point', new.payload -> 'focalPoint'
          )),
          v_sources)
      )
      on conflict (storage_path) do nothing
      returning id into v_asset;
      if v_asset is null then
        select a.id into v_asset from public.media_assets a where a.storage_path = v_path;
      end if;
      v_assets := v_assets || jsonb_build_array(jsonb_build_object('id', v_asset, 'path', v_path, 'kind', 'image'));
      v_out := null;
    end loop;
  end if;

  new.result := coalesce(new.result, '{}'::jsonb) || jsonb_build_object('assets', v_assets);
  return new;
end $$;


-- El modelo de transcripción guardado en Integraciones cae en cascada con su ajuste.
delete from private.integration_setting_keys where setting_key = 'AI_TRANSCRIPTION_MODEL';

drop function if exists private.media_reel_plan_v2(uuid, jsonb);
drop function if exists private.media_reel_text_style(uuid, jsonb, text);

revoke all on function private.media_reel_payload(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.jobs_reel_brand_font() from public, anon, authenticated;
revoke all on function private.jobs_publish_media_assets() from public, anon, authenticated;
