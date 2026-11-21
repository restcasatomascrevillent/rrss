-- Vuelta atrás de 20261117110000_ai_media_models.sql.
-- DESTRUCTIVA: elimina el registro de modelos de imagen y vídeo y sus precios.
-- No toca las generaciones ya hechas ni su coste (guardan proveedor y modelo
-- como texto). Si hay filas activadas o precios corregidos a mano, exportar la
-- tabla antes de aplicarla.
drop table if exists public.ai_media_models cascade;

drop function if exists private.ai_media_models_stamp();
