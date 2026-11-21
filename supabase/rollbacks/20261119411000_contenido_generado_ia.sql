-- Vuelta atrás de 20261119411000_contenido_generado_ia.sql.
-- Quita la marca de contenido generado con IA de piezas y versiones. Se puede
-- volver a calcular aplicando de nuevo la migración (recorre lo existente).
drop trigger if exists content_versions_ai_label_item on public.content_versions;
drop trigger if exists content_versions_ai_label on public.content_versions;

drop function if exists private.content_items_ai_label();
drop function if exists private.content_versions_ai_label();
drop function if exists private.content_document_ai_generated(uuid, jsonb);
drop function if exists private.media_assets_ai_generated(uuid, uuid[]);

alter table if exists public.content_items drop column if exists ai_generated;
alter table if exists public.content_versions drop column if exists ai_generated;
