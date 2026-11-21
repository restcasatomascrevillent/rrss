-- Fase 3 · Texto de las fuentes de conocimiento de la marca, sin IA.
--
-- Hasta ahora `brand_knowledge_sources` solo guardaba el archivo o el enlace,
-- y la propuesta de perfil con IA solo sabía leer los .txt. Esta migración
-- encarga al trabajador de medios (worker/, trabajo `source.extract`) sacar el
-- texto de los PDF, los Word (.docx), los .txt/.json y las páginas web, de forma
-- determinista (bibliotecas de Node, sin IA), y lo guarda junto a la fuente.
--
-- Por qué en el trabajador y no en una Edge Function: leer un PDF de decenas de
-- páginas con pdf.js pasa con holgura de los 2 s de CPU por petición del plan
-- gratuito de Supabase, y descargar una web con protección contra SSRF exige
-- controlar la resolución de nombres al conectar (lo que hace Node con
-- `lookup`). El trabajador ya tiene cola con reintentos, almacenamiento y
-- carpeta temporal.
--
--   1. Al dar de alta una fuente, un disparador encola su extracción (o la
--      marca como fallida con el motivo si de ese tipo no se extrae texto:
--      imágenes, presentaciones).
--   2. Un disparador sobre `jobs` lleva el estado del trabajo a la fuente:
--      pendiente → extrayendo → lista (con el texto) o falló (con el motivo).
--      El texto viaja en el resultado del trabajo (`complete_job`) y el
--      disparador lo MUEVE a la fuente antes de guardar el trabajo: no se
--      queda duplicado en `jobs.result`.
--   3. `request_source_extraction`: quien gestiona la marca puede volver a
--      pedir la extracción (por ejemplo, tras un fallo o si la web cambió).
--
-- El cliente nunca escribe el texto: no tiene permiso de UPDATE sobre la
-- tabla. Solo lo pone el disparador, con lo que devuelve el trabajador.

alter table public.brand_knowledge_sources
  -- Texto extraído, ya normalizado. El trabajador lo recorta a 100 000 caracteres.
  add column extracted_text text check (extracted_text is null or char_length(extracted_text) <= 200000),
  add column extracted_chars integer check (extracted_chars is null or extracted_chars >= 0),
  -- Detalle de la extracción: páginas del PDF, páginas web leídas u omitidas y por qué, si se recortó…
  add column extraction jsonb check (extraction is null or (jsonb_typeof(extraction) = 'object' and pg_column_size(extraction) <= 16384)),
  add column extracted_at timestamptz,
  -- Último trabajo de extracción: solo ese puede cambiar el estado de la fuente.
  add column extraction_job_id uuid references public.jobs (id) on delete set null;

-- ─────────────────────────────── Encolar ───────────────────────────────

-- Tipo de extracción que entiende el trabajador, o null si de esa fuente no se
-- saca texto.
create function private.source_extract_format(p_kind public.source_kind, p_mime text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'pdf' then 'pdf'
    when p_kind = 'website' then 'website'
    when p_kind in ('text', 'json') then 'text'
    when p_kind = 'document'
         and p_mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'docx'
  end;
$$;

-- Encola la extracción de una fuente y la deja pendiente. Si de ese tipo no se
-- extrae texto, la deja fallida con el motivo (no se simula nada).
create function private.enqueue_source_extraction(p_source_id uuid) returns public.brand_knowledge_sources
language plpgsql security definer set search_path = '' as $$
declare
  v_source public.brand_knowledge_sources;
  v_format text;
  v_job public.jobs;
begin
  select * into v_source from public.brand_knowledge_sources s where s.id = p_source_id for update;
  if not found then
    raise exception 'La fuente no existe' using errcode = 'P0002';
  end if;

  v_format := private.source_extract_format(v_source.kind, v_source.mime_type);
  if v_format is null then
    update public.brand_knowledge_sources s
    set status = 'failed', extraction_job_id = null,
        error = case
          when v_source.kind = 'image' then 'De las imágenes no se extrae texto (no se hace reconocimiento de caracteres).'
          else 'De este tipo de archivo no se extrae texto. Se admiten PDF, Word (.docx), texto y páginas web.'
        end
    where s.id = v_source.id
    returning * into v_source;
    return v_source;
  end if;

  v_job := public.enqueue_job(
    v_source.organization_id,
    'source.extract',
    jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'format', v_format,
      'path', v_source.storage_path,
      'url', v_source.url
    )),
    format('source:%s:%s', v_source.id, gen_random_uuid()),
    v_source.brand_id,
    0,
    3,
    null,
    coalesce((select auth.uid()), v_source.created_by)
  );

  update public.brand_knowledge_sources s
  set status = 'pending', error = null, extraction_job_id = v_job.id
  where s.id = v_source.id
  returning * into v_source;
  return v_source;
end $$;

create function private.brand_knowledge_sources_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.enqueue_source_extraction(new.id);
  return null;
end $$;

create trigger brand_knowledge_sources_enqueue after insert on public.brand_knowledge_sources
  for each row execute function private.brand_knowledge_sources_enqueue();

-- Volver a pedir la extracción. Solo quien gestiona la marca. Si ya hay una en
-- marcha para esa fuente, la devuelve tal cual (doble clic, reintento de red).
create function public.request_source_extraction(p_source_id uuid) returns public.brand_knowledge_sources
language plpgsql security definer set search_path = '' as $$
declare
  v_source public.brand_knowledge_sources;
  v_active integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Inicia sesión para analizar fuentes' using errcode = '42501';
  end if;
  select * into v_source from public.brand_knowledge_sources s
  where s.id = p_source_id and s.brand_id in (select private.brand_ids_with('manage'))
  for update;
  if not found then
    raise exception 'No tienes permiso para analizar esta fuente' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.jobs j
    where j.id = v_source.extraction_job_id and j.status in ('queued', 'running')
  ) then
    return v_source;
  end if;

  -- Freno contra quien encarga en bucle: cada web son varias descargas.
  select count(*) into v_active from public.jobs j
  where j.brand_id = v_source.brand_id and j.kind = 'source.extract' and j.status in ('queued', 'running');
  if v_active >= 20 then
    raise exception 'Hay % fuentes de esta marca analizándose. Espera a que terminen.', v_active using errcode = 'P0001';
  end if;

  return private.enqueue_source_extraction(v_source.id);
end $$;

-- ─────────────────────── Del trabajo a la fuente ───────────────────────

-- Lleva el estado del trabajo `source.extract` a su fuente y mueve el texto
-- del resultado a la fuente. Va ANTES de guardar el trabajo: así el texto no
-- se queda también en `jobs.result` (ni cuenta para su tope de tamaño).
create function private.jobs_sync_source_extraction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_source_id uuid;
  v_text text;
  v_meta jsonb;
begin
  if coalesce(new.payload ->> 'source_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    -- Solo la fuente de la misma marca y cuyo último trabajo es este: un
    -- trabajo antiguo (ya sustituido) no pisa el estado.
    select s.id into v_source_id from public.brand_knowledge_sources s
    where s.id = (new.payload ->> 'source_id')::uuid
      and s.brand_id = new.brand_id
      and s.organization_id = new.organization_id
      and s.extraction_job_id = new.id
    for update;
  end if;

  if new.status = 'succeeded' then
    if jsonb_typeof(new.result -> 'text') = 'string' then
      v_text := left(new.result ->> 'text', 200000);
    end if;
    v_meta := case when jsonb_typeof(new.result -> 'meta') = 'object' then new.result -> 'meta' else '{}'::jsonb end;
    if pg_column_size(v_meta) > 16384 then
      v_meta := jsonb_build_object('meta_truncated', true);
    end if;
    -- El resultado se queda con el resumen, sin el texto.
    new.result := (coalesce(new.result, '{}'::jsonb) - 'text')
      || jsonb_build_object('chars', coalesce(char_length(v_text), 0));
  end if;

  if v_source_id is null then
    return new;
  end if;

  if new.status = 'running' then
    update public.brand_knowledge_sources s set status = 'processing', error = null where s.id = v_source_id;
  elsif new.status = 'queued' then
    -- Vuelve a la cola tras un fallo pasajero: se reintentará sola.
    update public.brand_knowledge_sources s
    set status = 'pending', error = left('Se reintentará: ' || coalesce(new.last_error, 'fallo pasajero'), 1000)
    where s.id = v_source_id;
  elsif new.status = 'succeeded' then
    if v_text is null or btrim(v_text) = '' then
      update public.brand_knowledge_sources s
      set status = 'failed', error = 'El trabajador no ha devuelto texto.'
      where s.id = v_source_id;
    else
      update public.brand_knowledge_sources s
      set status = 'ready', error = null, extracted_text = v_text, extracted_chars = char_length(v_text),
          extraction = v_meta, extracted_at = now()
      where s.id = v_source_id;
    end if;
  elsif new.status = 'failed' then
    update public.brand_knowledge_sources s
    set status = 'failed', error = left(coalesce(new.last_error, 'Error sin descripción'), 1000)
    where s.id = v_source_id;
  elsif new.status = 'cancelled' then
    update public.brand_knowledge_sources s
    set status = 'failed', error = 'Se canceló la extracción.'
    where s.id = v_source_id;
  end if;
  return new;
end $$;

create trigger jobs_sync_source_extraction before update of status on public.jobs
  for each row when (new.kind = 'source.extract' and old.status is distinct from new.status)
  execute function private.jobs_sync_source_extraction();

-- ─────────────────────────────── Permisos ───────────────────────────────

revoke all on function private.source_extract_format(public.source_kind, text) from public, anon, authenticated;
revoke all on function private.enqueue_source_extraction(uuid) from public, anon, authenticated;
revoke all on function private.brand_knowledge_sources_enqueue() from public, anon, authenticated;
revoke all on function private.jobs_sync_source_extraction() from public, anon, authenticated;

revoke all on function public.request_source_extraction(uuid) from public, anon;
grant execute on function public.request_source_extraction(uuid) to authenticated;
