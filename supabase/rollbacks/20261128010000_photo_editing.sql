-- Vuelta atrás de 20261128010000_photo_editing.sql.
--
-- DESTRUCTIVA en parte: borra los modelos de edición del registro (si se
-- activó alguno o se le puso precio, exportarlo antes). Las fotos editadas se
-- quedan en la biblioteca con su procedencia (`ai_edit` / `photo_edit`); solo
-- desaparecen la guarda y el índice.

drop index if exists public.media_assets_provenance_source_idx;
drop trigger if exists media_assets_edit_provenance_guard on public.media_assets;
drop function if exists private.media_assets_edit_provenance_guard();

delete from public.ai_media_models where operation <> 'generate';

revoke update (operation) on public.ai_media_models from authenticated;
alter table public.ai_media_models drop constraint if exists ai_media_models_edit_is_image;
alter table public.ai_media_models drop constraint if exists ai_media_models_operation_check;
alter table public.ai_media_models drop column if exists operation;
