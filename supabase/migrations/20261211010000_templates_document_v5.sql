-- Plantillas de marca: aceptar el documento v5 (ediciones sencillas del editor).
--
-- La versión 5 del documento añade campos opcionales a las capas (ajustes de
-- foto, giro y recorte, fondo, sombras, contorno y fondo del texto, más
-- figuras). Ninguno referencia recursos nuevos: las imágenes y el logotipo
-- siguen siendo los únicos recursos del documento, y esos ya los comprueba
-- `deliver_design_templates` en todas las páginas. Solo hay que dejar que la
-- restricción de la tabla acepte `schemaVersion = 5`; se siguen aceptando las
-- v3 y v4 ya guardadas (la aplicación las migra al leerlas).
--
-- Vuelta atrás: supabase/rollbacks/20261211010000_templates_document_v5.sql.
alter table public.brand_design_templates
  drop constraint if exists brand_design_templates_document_check;
alter table public.brand_design_templates
  add constraint brand_design_templates_document_check
  check (jsonb_typeof(document) = 'object'
         and (document ->> 'schemaVersion') in ('3', '4', '5')
         and pg_column_size(document) <= 262144);
