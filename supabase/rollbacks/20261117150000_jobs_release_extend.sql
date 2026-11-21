-- Vuelta atrás de 20261117150000_jobs_release_extend.sql.
-- No toca datos. Antes, parar a los trabajadores que usen estas funciones (si
-- no, al apagarse o en trabajos largos fallarán al llamarlas).
drop function if exists public.extend_job_lease(uuid, text, integer);
drop function if exists public.release_job(uuid, text);
