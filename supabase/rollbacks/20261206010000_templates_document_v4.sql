-- Vuelta atrás de 20261206010000: solo documentos v3 (falla si ya hay plantillas v4).
alter table public.brand_design_templates
  drop constraint if exists brand_design_templates_document_check;
alter table public.brand_design_templates
  add constraint brand_design_templates_document_check
  check (jsonb_typeof(document) = 'object'
         and (document ->> 'schemaVersion') = '3'
         and pg_column_size(document) <= 262144);
