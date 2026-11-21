-- Fase 3 · Reels y recortes de imagen encargados desde la aplicación, con el
-- resultado en la biblioteca.
--
-- El trabajador de medios (worker/) ya sabe montar reels y recortar fotos,
-- pero solo se podía encolar con la clave de servicio (`enqueue_job`). Esta
-- migración cierra el circuito:
--
--   1. `request_media_job`: quien edita una marca encarga un trabajo de medios
--      desde la aplicación, sin clave de servicio. Solo dos tipos
--      (`media.reel.template` y `media.image.process`), con la carga
--      restringida campo a campo, y TODAS las rutas de entrada tienen que ser
--      recursos de la biblioteca de esa marca. Las rutas de salida no las
--      elige el cliente: las pone la base de datos, dentro de la marca y con
--      un nombre nuevo (nadie puede sobrescribir un recurso existente).
--      Validar los números (segundos, volúmenes, tamaños) es cosa del
--      trabajador, que rechaza sin reintento una carga inválida.
--   2. Al completarse el trabajo (`complete_job`), un disparador da de alta el
--      resultado en `media_assets` con su procedencia (trabajo, plantilla y
--      fuentes) en la columna común `provenance` (migración
--      20261118120000_media_assets_provenance, `type` = 'media_job') y deja los
--      recursos creados en `jobs.result.assets` (también
--      para los que encole el servidor con `enqueue_job`, si su carga dice
--      dónde dejar el archivo). Va en la
--      misma transacción que el cierre: o el trabajo queda terminado y su
--      recurso existe, o ninguna de las dos cosas.
--   3. La lectura de los trabajos ya la da la RLS de `jobs` (los de una marca
--      los ve quien ve la marca): no hace falta otra función.


-- ───────────────────── Procedencia en la biblioteca ─────────────────────

-- La columna `media_assets.provenance` es la común de la biblioteca (migración
-- 20261118120000_media_assets_provenance: objeto con `type`, máximo 2048 bytes,
-- solo al insertar). Lo que crea un trabajo de medios lleva `type` =
-- 'media_job'. Ese tipo solo lo puede poner la base de datos: quien sube un
-- archivo desde la aplicación no puede hacerlo pasar por el resultado de un
-- trabajo (el enlace fiable trabajo → recurso es `jobs.result.assets`, que el
-- cliente no puede escribir).
create function private.media_assets_guard_job_provenance() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Desde el disparador de jobs (SECURITY DEFINER) el usuario actual es el
  -- dueño de la función, no `authenticated`.
  if new.provenance ->> 'type' = 'media_job' and current_user in ('authenticated', 'anon') then
    raise exception 'La procedencia de un trabajo de medios solo la pone la base de datos' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger media_assets_guard_job_provenance before insert on public.media_assets
  for each row execute function private.media_assets_guard_job_provenance();

-- Recursos creados por un trabajo (para buscarlos desde el trabajo).
create index media_assets_provenance_job_idx on public.media_assets ((provenance ->> 'job_id'))
  where provenance ->> 'type' = 'media_job';

-- Procedencia que cabe en los 2048 bytes de la columna: con las fuentes
-- completas (recurso y ruta) si caben; si no, solo los recursos; y si ni así,
-- sin fuentes (las rutas siguen en `jobs.payload`).
create function private.media_job_provenance(p_base jsonb, p_sources jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb;
begin
  v := p_base || jsonb_build_object('sources', coalesce(p_sources, '[]'::jsonb));
  if octet_length(v::text) <= 2048 then
    return v;
  end if;
  v := p_base || jsonb_build_object(
    'source_asset_ids',
    (select coalesce(jsonb_agg(x.s -> 'asset_id' order by x.o), '[]'::jsonb)
     from jsonb_array_elements(p_sources) with ordinality x(s, o)),
    'sources_truncated', true);
  if octet_length(v::text) <= 2048 then
    return v;
  end if;
  return p_base || jsonb_build_object('sources_truncated', true);
end $$;

-- ───────────────────────────── Ayudantes ─────────────────────────────

-- ¿Es un objeto JSON con solo claves de la lista? (Un campo de más es un error.)
create function private.jsonb_only_keys(p_value jsonb, p_allowed text[]) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_value) = 'object'
    then not exists (select 1 from jsonb_object_keys(p_value) k where k <> all (p_allowed))
    else false
  end;
$$;

-- Comprueba que una ruta de entrada es un recurso de la biblioteca de la
-- marca, del tipo esperado, y la devuelve. El trabajador usa la clave de
-- servicio (se salta la RLS): esta comprobación es la que impide encargarle
-- que lea archivos de otra marca.
create function private.media_job_input(p_brand_id uuid, p_path jsonb, p_kinds public.asset_kind[], p_label text)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_path text;
begin
  if jsonb_typeof(p_path) is distinct from 'string' then
    raise exception '%: falta la ruta del archivo', p_label using errcode = '22023';
  end if;
  v_path := p_path #>> '{}';
  -- Ni segmentos vacíos, ni «.», ni «..», ni barras invertidas.
  if v_path ~ '(^|/)\.{0,2}(/|$)' or position(E'\\' in v_path) > 0 then
    raise exception '%: la ruta «%» no es válida', p_label, v_path using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.media_assets a
    where a.brand_id = p_brand_id and a.storage_path = v_path and a.kind = any (p_kinds)
  ) then
    raise exception '%: «%» no es un recurso de esta marca', p_label, v_path using errcode = '22023';
  end if;
  return v_path;
end $$;

-- Carga de `media.reel.template` a partir de lo que pide el cliente:
--   { "template": { "id": "…" },
--     "plan": { "media": [{ "type": "photo"|"video", "path": "…", … }],
--               "texts": [{ "text": "…", "start": 0, "end": 2, "position": "…" }],
--               "music": { "path": "…", "startAt": 0, "volume": 0.3 } } }
-- Sin plantillas completas (solo las incluidas, por su id) ni tipografía de
-- la marca (`fontPath`), que la aplicación todavía no ofrece.
create function private.media_reel_payload(p_org uuid, p_brand_id uuid, p_input jsonb, p_file text)
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
    if not private.jsonb_only_keys(v_item, array['type', 'path', 'focalPoint', 'startAt', 'seconds']) then
      raise exception 'Pieza %: campos no admitidos', v_index using errcode = '22023';
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

-- Carga de `media.image.process` a partir de lo que pide el cliente:
--   { "source": { "path": "…" }, "focalPoint": { "x": 0.5, "y": 0.4 },
--     "outputs": [{ "aspect": "9:16", "width": 1080, "format": "jpeg", "quality": 85 }] }
create function private.media_image_payload(p_org uuid, p_brand_id uuid, p_input jsonb, p_file text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_index integer := 0;
  v_outputs jsonb := '[]'::jsonb;
  v_format text;
begin
  if not private.jsonb_only_keys(p_input, array['source', 'focalPoint', 'outputs']) then
    raise exception 'El encargo del recorte solo admite la foto, el punto de interés y las salidas' using errcode = '22023';
  end if;
  if not private.jsonb_only_keys(p_input -> 'source', array['path']) then
    raise exception 'Falta la foto de origen' using errcode = '22023';
  end if;
  perform private.media_job_input(p_brand_id, p_input #> '{source,path}', array['image', 'logo']::public.asset_kind[], 'Foto');

  if jsonb_typeof(p_input -> 'outputs') is distinct from 'array'
     or jsonb_array_length(p_input -> 'outputs') not between 1 and 4 then
    raise exception 'Pide entre 1 y 4 recortes' using errcode = '22023';
  end if;
  for v_item in select e.value from jsonb_array_elements(p_input -> 'outputs') e loop
    v_index := v_index + 1;
    if not private.jsonb_only_keys(v_item, array['aspect', 'width', 'format', 'quality'])
       or coalesce(v_item ->> 'aspect', '') not in ('1:1', '4:5', '9:16', '16:9') then
      raise exception 'Recorte %: proporción no admitida', v_index using errcode = '22023';
    end if;
    v_format := coalesce(v_item ->> 'format', 'jpeg');
    if v_format not in ('jpeg', 'png', 'webp') then
      raise exception 'Recorte %: formato no admitido', v_index using errcode = '22023';
    end if;
    v_outputs := v_outputs || jsonb_build_array(v_item || jsonb_build_object(
      'path', format('%s/%s/recortes/%s-%s-%s.%s', p_org, p_brand_id, p_file, v_index,
                     replace(v_item ->> 'aspect', ':', 'x'), case v_format when 'jpeg' then 'jpg' else v_format end)
    ));
  end loop;

  return (p_input - 'outputs') || jsonb_build_object('outputs', v_outputs);
end $$;

-- ─────────────────────── Encargar desde la aplicación ───────────────────────

-- Trabajos de medios a la vez por marca (en cola o en curso). Frena a quien
-- encarga en bucle: cada reel ocupa minutos de máquina.
create function private.media_jobs_max_active() returns integer
language sql immutable set search_path = '' as $$ select 5 $$;

-- Encarga un trabajo de medios para una marca. Quien llama tiene que poder
-- editar la marca. Repetir la misma clave devuelve el mismo trabajo (doble
-- clic, reintento de red). Devuelve la fila de `jobs`, que se sigue leyendo
-- por la API (la RLS de `jobs` deja verla a quien ve la marca).
create function public.request_media_job(
  p_brand_id uuid,
  p_kind text,
  p_input jsonb,
  p_idempotency_key text
) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_org uuid;
  v_key text;
  v_job public.jobs;
  v_input jsonb;
  v_payload jsonb;
  v_active integer;
begin
  if v_user is null then
    raise exception 'Inicia sesión para encargar trabajos' using errcode = '42501';
  end if;
  if p_brand_id is null or p_brand_id not in (select private.brand_ids_with('edit')) then
    raise exception 'No tienes permiso para crear medios en esta marca' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('media.reel.template', 'media.image.process') then
    raise exception 'Tipo de trabajo no admitido: %', coalesce(p_kind, '(vacío)') using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then
    raise exception 'Falta la clave del encargo (entre 8 y 100 caracteres)' using errcode = '22023';
  end if;

  -- Un encargo a la vez por marca: la cuenta de trabajos activos no se adelanta.
  select b.organization_id into v_org from public.brands b where b.id = p_brand_id for update;
  -- La clave lleva la marca: la misma clave en otra marca de la organización es otro encargo.
  v_key := format('media:%s:%s', p_brand_id, p_idempotency_key);

  select * into v_job from public.jobs j where j.organization_id = v_org and j.idempotency_key = v_key;
  if found then
    if v_job.kind <> p_kind or v_job.brand_id is distinct from p_brand_id then
      raise exception 'Esa clave ya se usó para otro encargo' using errcode = '22023';
    end if;
    return v_job;
  end if;

  select count(*) into v_active from public.jobs j
  where j.brand_id = p_brand_id
    and j.kind in ('media.reel.template', 'media.image.process')
    and j.status in ('queued', 'running');
  if v_active >= private.media_jobs_max_active() then
    raise exception 'Hay % trabajos de medios en marcha en esta marca, el máximo a la vez. Espera a que termine alguno.', v_active
      using errcode = 'P0001';
  end if;

  -- Los nulos de JSON cuentan como «no está» (música opcional, etc.).
  v_input := jsonb_strip_nulls(coalesce(p_input, '{}'::jsonb));
  if p_kind = 'media.reel.template' then
    v_payload := private.media_reel_payload(v_org, p_brand_id, v_input, gen_random_uuid()::text);
  else
    v_payload := private.media_image_payload(v_org, p_brand_id, v_input, gen_random_uuid()::text);
  end if;

  return public.enqueue_job(v_org, p_kind, v_payload, v_key, p_brand_id, 0, 3, null, v_user);
end $$;

-- ─────────────────── Resultado a la biblioteca (al completar) ───────────────────

-- Al pasar a `succeeded` un trabajo de medios de una marca, da de alta cada
-- archivo resultante en `media_assets` (origen `generated`) con su procedencia
-- y anota los recursos creados en `jobs.result.assets`. La ruta sale de la
-- CARGA (la puso `request_media_job`), no del resultado: el resultado solo
-- aporta las medidas, y tiene que corresponder a esa ruta.
--
-- Procedencia de un reel:
--   {"type": "media_job", "kind": "media.reel.template", "job_id": "…",
--    "template_id": "fundido-suave", "template_schema_version": 1,
--    "music_asset_id": "…", "sources": [{"type": "photo", "asset_id": "…", "path": "…"}, …]}
-- De un recorte: "aspect" y "focal_point" en lugar de plantilla y música.
create function private.jobs_publish_media_assets() returns trigger
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

create trigger jobs_publish_media_assets before update of status on public.jobs
  for each row
  when (new.status = 'succeeded' and old.status is distinct from new.status and new.brand_id is not null
        and new.kind in ('media.reel.template', 'media.image.process'))
  execute function private.jobs_publish_media_assets();

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on function private.jsonb_only_keys(jsonb, text[]) from public, anon, authenticated;
revoke all on function private.media_job_input(uuid, jsonb, public.asset_kind[], text) from public, anon, authenticated;
revoke all on function private.media_reel_payload(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.media_image_payload(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.media_jobs_max_active() from public, anon, authenticated;
revoke all on function private.jobs_publish_media_assets() from public, anon, authenticated;
revoke all on function private.media_job_provenance(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.media_assets_guard_job_provenance() from public, anon, authenticated;

revoke all on function public.request_media_job(uuid, text, jsonb, text) from public, anon;
grant execute on function public.request_media_job(uuid, text, jsonb, text) to authenticated;
