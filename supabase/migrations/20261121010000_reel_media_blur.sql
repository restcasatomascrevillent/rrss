-- Desenfoque de fotos y clips en los reels (copiloto por voz, docs/copiloto-voz.md).
--
-- El documento de contenidos pasa a la versión 3 con `blur` (0 a 100) en las
-- capas de imagen. Para que un reel pueda llevar el mismo fondo desenfocado,
-- el plan del reel admite `blur` en cada pieza de `media` y el trabajador lo
-- aplica con FFmpeg (worker/src/reel/build.ts, mismo radio que el editor).
--
-- Solo cambia la validación de la carga (`private.media_reel_payload`): se
-- admite la clave `blur` y debe ser un número de 0 a 100. Lo demás es igual
-- que en 20261118220000_media_jobs_library.sql. Sin tablas nuevas.
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

revoke all on function private.media_reel_payload(uuid, uuid, jsonb, text) from public, anon, authenticated;
