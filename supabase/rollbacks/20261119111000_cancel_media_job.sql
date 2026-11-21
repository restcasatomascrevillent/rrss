-- Vuelta atrás de 20261119111000_cancel_media_job.sql. Los trabajos ya
-- cancelados se quedan como están.
drop function if exists public.cancel_media_job(uuid);
