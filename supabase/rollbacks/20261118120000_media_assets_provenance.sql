-- Vuelta atrás de 20261118120000_media_assets_provenance.sql.
-- DESTRUCTIVA: se pierde la procedencia (de qué pieza y versión sale cada imagen
-- exportada). Los recursos y sus archivos no se tocan.
drop index if exists public.media_assets_provenance_content_idx;

alter table public.media_assets
  drop constraint if exists media_assets_provenance_size,
  drop constraint if exists media_assets_provenance_shape,
  drop column if exists provenance;
