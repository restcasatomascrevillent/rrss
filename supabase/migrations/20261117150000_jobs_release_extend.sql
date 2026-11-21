-- Cola de trabajos: devolver un trabajo sin gastar intento y renovar la reserva.
--
-- Las pidió el trabajador de medios (worker/):
--   * release_job: al apagarse de forma ordenada, el trabajador devuelve lo que
--     tenía a medias. No es un fallo del trabajo, así que no debe gastar un
--     intento ni esperar el retraso de un reintento (con fail_job, un trabajo
--     de 3 intentos interrumpido 3 veces por despliegues quedaba fallido).
--   * extend_job_lease: un trabajo largo (vídeo) renueva su reserva mientras
--     avanza, en vez de pedir de entrada una reserva enorme que, si el
--     trabajador muere, deja el trabajo bloqueado hasta que caduque.
--
-- Igual que el resto de la cola: solo la clave de servicio, y solo quien tiene
-- la reserva. El error de «no está reservado» es el mismo texto que el de
-- complete_job y fail_job, que el trabajador reconoce como reserva perdida.

-- Devuelve a la cola un trabajo en curso sin contar el intento: vuelve a estar
-- disponible ya, con los intentos que tenía antes de reclamarlo. El último
-- error no cambia (una devolución no es un error).
create function public.release_job(p_job_id uuid, p_worker text)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  update public.jobs j
  set status = 'queued', attempts = greatest(j.attempts - 1, 0), locked_by = null, locked_until = null,
      run_after = now()
  where j.id = p_job_id and j.status = 'running' and j.locked_by = p_worker
  returning * into v_job;
  if not found then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;
  return v_job;
end $$;

-- Renueva la reserva: caduca dentro de p_lease_seconds contados desde ahora
-- (5 s a 1 h, como al reclamar). Solo si el trabajo sigue en curso y reservado
-- por este trabajador; si la reserva ya caducó pero nadie lo ha reclamado,
-- sigue siendo suyo y se puede renovar.
create function public.extend_job_lease(p_job_id uuid, p_worker text, p_lease_seconds integer default 300)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if p_lease_seconds is null or p_lease_seconds not between 5 and 3600 then
    raise exception 'La reserva debe durar entre 5 segundos y una hora' using errcode = '22023';
  end if;
  update public.jobs j
  set locked_until = now() + make_interval(secs => p_lease_seconds)
  where j.id = p_job_id and j.status = 'running' and j.locked_by = p_worker
  returning * into v_job;
  if not found then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;
  return v_job;
end $$;

revoke all on function public.release_job(uuid, text) from public, anon, authenticated;
revoke all on function public.extend_job_lease(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.release_job(uuid, text) to service_role;
grant execute on function public.extend_job_lease(uuid, text, integer) to service_role;
