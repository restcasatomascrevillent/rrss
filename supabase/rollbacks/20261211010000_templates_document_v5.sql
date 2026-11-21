-- Vuelta atrás de 20261211010000: solo documentos v3 y v4 (falla si ya hay plantillas v5).
alter table public.brand_design_templates
  drop constraint if exists brand_design_templates_document_check;
alter table public.brand_design_templates
  add constraint brand_design_templates_document_check
  check (jsonb_typeof(document) = 'object'
         and (document ->> 'schemaVersion') in ('3', '4')
         and pg_column_size(document) <= 262144);
