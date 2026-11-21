-- Vuelta atrás de 20261116111000_jobs.sql.
-- DESTRUCTIVA: elimina la cola y todos sus trabajos, también los pendientes.
-- Antes de aplicarla hay que parar a los trabajadores y dejar que la cola se
-- vacíe (o exportar lo que quede).
drop function if exists public.cancel_job(uuid);
drop function if exists public.fail_job(uuid, text, text, boolean);
drop function if exists public.complete_job(uuid, text, jsonb);
drop function if exists public.claim_jobs(text, text[], integer, integer);
drop function if exists public.enqueue_job(uuid, text, jsonb, text, uuid, integer, integer, timestamptz, uuid);

drop table if exists public.jobs cascade;

drop type if exists public.job_status;
