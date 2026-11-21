-- Vuelta atrás de 20261116100000_biblioteca_limpieza_y_filtros.sql.
-- Las anotaciones pendientes de la cola se pierden: antes de deshacer, conviene
-- vaciarla desde la aplicación o borrar a mano los archivos que indique.
drop function if exists public.asset_facets(uuid);
drop trigger if exists media_assets_queue_cleanup on public.media_assets;
drop function if exists private.queue_storage_cleanup();
drop table if exists public.storage_cleanup_queue;
