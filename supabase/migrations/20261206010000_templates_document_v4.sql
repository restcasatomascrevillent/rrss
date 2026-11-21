-- Plantillas de marca: aceptar el documento v4 (páginas, carruseles).
--
-- 20261201010000 fijó `document ->> 'schemaVersion' = '3'`, y desde
-- 20261203010000 la aplicación y la herramienta de la agencia guardan
-- documentos v4. Sin este cambio no se puede guardar ninguna plantilla nueva.
-- Se siguen aceptando las v3 ya guardadas (la aplicación las migra al leerlas).
alter table public.brand_design_templates
  drop constraint if exists brand_design_templates_document_check;
alter table public.brand_design_templates
  add constraint brand_design_templates_document_check
  check (jsonb_typeof(document) = 'object'
         and (document ->> 'schemaVersion') in ('3', '4')
         and pg_column_size(document) <= 262144);
