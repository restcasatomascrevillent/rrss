-- Editor de reels (docs/editor-reels.md).
--
-- Sin tablas nuevas: el montaje se guarda como versión de una pieza de formato
-- `reel` (content_versions, como las imágenes) y los subtítulos automáticos
-- cuentan en `ai_generations` (tarea `transcription`, que el plan cubre con
-- `ai_text`). Lo que cambia es la carga del trabajador:
--
--  * `private.media_reel_payload` admite, además del plan v1, el plan v2 del
--    editor (`"version": 2`: clips con recortes y volumen, transición por
--    elemento, textos con estilo y tipografía propios, subtítulos por clip y
--    música con licencia) y el enlace con la pieza (`content: { id, version }`),
--    que tiene que ser un reel de la misma marca con esa versión guardada.
--    Cada archivo se comprueba contra la biblioteca de la marca y cada
--    tipografía contra `brand_fonts` de la marca (.ttf/.otf): el trabajador usa
--    la clave de servicio y esta es la comprobación que le impide leer de otra
--    marca. La forma fina (números, rangos) la valida el trabajador.
--  * `private.jobs_reel_brand_font` pone la tipografía de la marca también si
--    solo hay subtítulos.
--  * `private.jobs_publish_media_assets` toma las fuentes del plan v2 y deja en
--    la procedencia del vídeo la pieza y la versión de las que sale, la
--    versión del plan y la licencia de la música.

-- ─────────────────── Modelo de transcripción (Integraciones) ───────────────────

-- Subtítulos automáticos: la clave es la de OpenAI de la IA de texto; aquí solo
-- se puede elegir otro modelo (por defecto, gpt-transcribe). Mismo nombre en
-- supabase/functions/_shared/integrations/catalog.ts y en la pantalla.
insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  ('AI_TRANSCRIPTION_MODEL', 'ai_text', false);

-- ─────────────────────────── Ayudantes ───────────────────────────

-- Estilo de un texto o de los subtítulos. Solo las claves conocidas y, si trae
-- tipografía, que sea un .ttf/.otf de la marca.
create function private.media_reel_text_style(p_brand_id uuid, p_style jsonb, p_label text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.jsonb_only_keys(p_style, array['fontPath', 'fontFamily', 'sizeRatio', 'color', 'marginRatio',
                                                 'maxWidthRatio', 'lineHeight', 'box', 'outline', 'fadeSeconds']) then
    raise exception '%: estilo con campos no admitidos', p_label using errcode = '22023';
  end if;
  if p_style ? 'fontPath' and not exists (
    select 1 from public.brand_fonts f
    where f.brand_id = p_brand_id and f.storage_path = p_style ->> 'fontPath' and f.format in ('ttf', 'otf')
  ) then
    raise exception '%: la tipografía no es un .ttf u .otf de esta marca', p_label using errcode = '22023';
  end if;
end $$;

-- Plan v2 del editor. Devuelve el plan tal cual (lo valida a fondo el trabajador).
create function private.media_reel_plan_v2(p_brand_id uuid, p_plan jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_cue jsonb;
  v_index integer := 0;
begin
  -- Sin `fontPath`: la tipografía por defecto la pone la base de datos (jobs_reel_brand_font).
  if not private.jsonb_only_keys(p_plan, array['version', 'clips', 'texts', 'subtitles', 'music']) then
    raise exception 'El plan del reel solo admite clips, textos, subtítulos y música' using errcode = '22023';
  end if;
  if jsonb_typeof(p_plan -> 'clips') is distinct from 'array'
     or jsonb_array_length(p_plan -> 'clips') not between 1 and 30 then
    raise exception 'Elige entre 1 y 30 fotos o clips' using errcode = '22023';
  end if;

  for v_item in select e.value from jsonb_array_elements(p_plan -> 'clips') e loop
    v_index := v_index + 1;
    if v_item ? 'blur' and (jsonb_typeof(v_item -> 'blur') is distinct from 'number'
                            or (v_item ->> 'blur')::numeric not between 0 and 100) then
      raise exception 'Pieza %: el desenfoque va de 0 a 100', v_index using errcode = '22023';
    end if;
    if v_item ->> 'type' = 'photo' then
      if not private.jsonb_only_keys(v_item, array['id', 'type', 'path', 'focalPoint', 'blur', 'transition',
                                                   'seconds', 'motion']) then
        raise exception 'Pieza %: campos no admitidos', v_index using errcode = '22023';
      end if;
      perform private.media_job_input(p_brand_id, v_item -> 'path', array['image', 'logo']::public.asset_kind[],
                                      format('Pieza %s', v_index));
    elsif v_item ->> 'type' = 'video' then
      if not private.jsonb_only_keys(v_item, array['id', 'type', 'path', 'focalPoint', 'blur', 'transition',
                                                   'in', 'out', 'volume', 'subtitles']) then
        raise exception 'Pieza %: campos no admitidos', v_index using errcode = '22023';
      end if;
      perform private.media_job_input(p_brand_id, v_item -> 'path', array['video']::public.asset_kind[],
                                      format('Pieza %s', v_index));
      if v_item ? 'subtitles' then
        if jsonb_typeof(v_item -> 'subtitles') is distinct from 'array'
           or jsonb_array_length(v_item -> 'subtitles') > 200 then
          raise exception 'Pieza %: como mucho 200 subtítulos', v_index using errcode = '22023';
        end if;
        for v_cue in select c.value from jsonb_array_elements(v_item -> 'subtitles') c loop
          if not private.jsonb_only_keys(v_cue, array['start', 'end', 'text'])
             or jsonb_typeof(v_cue -> 'text') is distinct from 'string'
             or char_length(v_cue ->> 'text') not between 1 and 200 then
            raise exception 'Pieza %: subtítulo no válido', v_index using errcode = '22023';
          end if;
        end loop;
      end if;
    else
      raise exception 'Pieza %: solo se admiten fotos y clips', v_index using errcode = '22023';
    end if;
  end loop;

  if p_plan ? 'texts' then
    if jsonb_typeof(p_plan -> 'texts') is distinct from 'array' or jsonb_array_length(p_plan -> 'texts') > 30 then
      raise exception 'Como mucho 30 textos' using errcode = '22023';
    end if;
    v_index := 0;
    for v_item in select e.value from jsonb_array_elements(p_plan -> 'texts') e loop
      v_index := v_index + 1;
      if not private.jsonb_only_keys(v_item, array['id', 'text', 'start', 'end', 'position', 'style'])
         or jsonb_typeof(v_item -> 'text') is distinct from 'string' then
        raise exception 'Texto %: campos no admitidos', v_index using errcode = '22023';
      end if;
      perform private.media_reel_text_style(p_brand_id, v_item -> 'style', format('Texto %s', v_index));
    end loop;
  end if;

  if p_plan ? 'subtitles' then
    if not private.jsonb_only_keys(p_plan -> 'subtitles', array['enabled', 'position', 'style']) then
      raise exception 'Subtítulos: campos no admitidos' using errcode = '22023';
    end if;
    perform private.media_reel_text_style(p_brand_id, p_plan #> '{subtitles,style}', 'Subtítulos');
  end if;

  if p_plan ? 'music' then
    if not private.jsonb_only_keys(p_plan -> 'music', array['path', 'startAt', 'volume', 'fadeInSeconds',
                                                            'fadeOutSeconds', 'license']) then
      raise exception 'Música: campos no admitidos' using errcode = '22023';
    end if;
    -- La licencia es responsabilidad de la marca: sin confirmarla no se monta.
    if (p_plan #> '{music,license,confirmed}') is distinct from 'true'::jsonb then
      raise exception 'Confirma que la marca tiene licencia para usar la música' using errcode = '22023';
    end if;
    perform private.media_job_input(p_brand_id, p_plan #> '{music,path}', array['audio']::public.asset_kind[], 'Música');
  end if;

  return p_plan;
end $$;

-- ─────────────────────────── Carga del reel ───────────────────────────

-- Igual que en 20261121010000_reel_media_blur.sql para el plan v1; además, el
-- plan v2 (`"version": 2`) y el enlace con la pieza (`content`).
create or replace function private.media_reel_payload(p_org uuid, p_brand_id uuid, p_input jsonb, p_file text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_template jsonb := p_input -> 'template';
  v_plan jsonb := p_input -> 'plan';
  v_content jsonb := p_input -> 'content';
  v_item jsonb;
  v_index integer := 0;
  v_payload jsonb;
begin
  if not private.jsonb_only_keys(p_input, array['template', 'plan', 'content']) then
    raise exception 'El encargo del reel solo admite la plantilla, el plan y la pieza' using errcode = '22023';
  end if;
  if not private.jsonb_only_keys(v_template, array['id'])
     or jsonb_typeof(v_template -> 'id') is distinct from 'string'
     or (v_template ->> 'id') !~ '^[a-z][a-z0-9-]{1,40}$' then
    raise exception 'Elige una de las plantillas disponibles' using errcode = '22023';
  end if;

  -- La pieza: un reel vivo de ESTA marca, con esa versión guardada.
  if v_content is not null then
    if not private.jsonb_only_keys(v_content, array['id', 'version'])
       or jsonb_typeof(v_content -> 'id') is distinct from 'string'
       or (v_content ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_content -> 'version') is distinct from 'number'
       or not exists (
         select 1
         from public.content_items c
         join public.content_versions v on v.content_id = c.id and v.version = (v_content ->> 'version')::numeric
         where c.id = (v_content ->> 'id')::uuid and c.brand_id = p_brand_id and c.format = 'reel'
           and c.archived_at is null
       ) then
      raise exception 'La pieza del montaje no es un reel de esta marca con esa versión' using errcode = '22023';
    end if;
  end if;

  if jsonb_typeof(v_plan) = 'object' and v_plan -> 'version' = '2'::jsonb then
    v_plan := private.media_reel_plan_v2(p_brand_id, v_plan);
  else
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
  end if;

  v_payload := jsonb_build_object(
    'template', v_template,
    'plan', v_plan,
    'output', jsonb_build_object('path', format('%s/%s/reels/%s.mp4', p_org, p_brand_id, p_file))
  );
  if v_content is not null then
    v_payload := v_payload || jsonb_build_object('content', v_content);
  end if;
  return v_payload;
end $$;

-- ─────────────────── Tipografía de la marca (también para subtítulos) ───────────────────

create or replace function private.jobs_reel_brand_font() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_font public.brand_fonts;
  v_needs boolean;
begin
  if new.brand_id is null
     or jsonb_typeof(new.payload -> 'plan') is distinct from 'object'
     or new.payload #> '{plan,fontPath}' is not null then
    return new;
  end if;
  v_needs := coalesce(jsonb_typeof(new.payload #> '{plan,texts}') = 'array'
                      and jsonb_array_length(new.payload #> '{plan,texts}') > 0, false)
             or (new.payload #> '{plan,subtitles,enabled}' = 'true'::jsonb
                 and exists (select 1 from jsonb_array_elements(
                               case when jsonb_typeof(new.payload #> '{plan,clips}') = 'array'
                                    then new.payload #> '{plan,clips}' else '[]'::jsonb end) c
                             where jsonb_typeof(c.value -> 'subtitles') = 'array'
                               and jsonb_array_length(c.value -> 'subtitles') > 0));
  if not v_needs then
    return new;
  end if;
  v_font := private.brand_reel_font(new.brand_id);
  if v_font.id is not null then
    new.payload := jsonb_set(new.payload, '{plan,fontPath}', to_jsonb(v_font.storage_path));
  end if;
  return new;
end $$;

-- ─────────────────── Resultado a la biblioteca ───────────────────

-- Igual que en 20261118220000_media_jobs_library.sql; en un reel, las fuentes
-- salen de `plan.clips` (v2) o `plan.media` (v1), y la procedencia lleva la
-- pieza, la versión del plan y la licencia de la música:
--   {"type": "media_job", "kind": "media.reel.template", "job_id": "…",
--    "template_id": "…", "template_schema_version": 1, "plan_version": 2,
--    "content_id": "…", "content_version": 3,
--    "music_asset_id": "…", "music_license": {"confirmed": true, "note": "…"},
--    "sources": [{"type": "photo", "asset_id": "…", "path": "…"}, …]}
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
    from jsonb_array_elements(coalesce(new.payload #> '{plan,clips}', new.payload #> '{plan,media}', '[]'::jsonb))
         with ordinality m
    left join public.media_assets a on a.brand_id = new.brand_id and a.storage_path = m.value ->> 'path';

    v_provenance := private.media_job_provenance(
      jsonb_strip_nulls(jsonb_build_object(
        'type', 'media_job',
        'kind', new.kind,
        'job_id', new.id,
        'template_id', new.payload #>> '{template,id}',
        'template_schema_version', new.result #> '{template,schemaVersion}',
        -- Solo en v2: la procedencia de un reel v1 no cambia.
        'plan_version', new.payload #> '{plan,version}',
        'content_id', new.payload #>> '{content,id}',
        'content_version', new.payload #> '{content,version}',
        'music_asset_id', (select a.id from public.media_assets a
                           where a.brand_id = new.brand_id and a.storage_path = new.payload #>> '{plan,music,path}'),
        'music_license', new.payload #> '{plan,music,license}'
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

-- Los montajes de una pieza se buscan por `provenance ->> 'content_id'`, que ya
-- tiene índice (media_assets_provenance_content_idx, 20261118120000).

revoke all on function private.media_reel_text_style(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.media_reel_plan_v2(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.media_reel_payload(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.jobs_reel_brand_font() from public, anon, authenticated;
revoke all on function private.jobs_publish_media_assets() from public, anon, authenticated;
