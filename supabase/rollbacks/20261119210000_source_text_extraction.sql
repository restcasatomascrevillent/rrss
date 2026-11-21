-- Vuelta atrás de 20261119210000_source_text_extraction.sql.
-- Se pierde el texto extraído de las fuentes (los archivos y enlaces siguen).
-- Los trabajos `source.extract` que queden en la cola ya no cambian nada al
-- terminar; el trabajador los seguiría reclamando si tiene el manejador.
drop trigger if exists jobs_sync_source_extraction on public.jobs;
drop function if exists private.jobs_sync_source_extraction();
drop function if exists public.request_source_extraction(uuid);
drop trigger if exists brand_knowledge_sources_enqueue on public.brand_knowledge_sources;
drop function if exists private.brand_knowledge_sources_enqueue();
drop function if exists private.enqueue_source_extraction(uuid);
drop function if exists private.source_extract_format(public.source_kind, text);

alter table public.brand_knowledge_sources
  drop column if exists extraction_job_id,
  drop column if exists extracted_at,
  drop column if exists extraction,
  drop column if exists extracted_chars,
  drop column if exists extracted_text;
