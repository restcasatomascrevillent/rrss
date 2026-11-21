-- Reels y recortes: cancelar un encargo desde la aplicación.
--
-- `cancel_job` (migración 20261116111000_jobs) solo lo puede llamar el servidor
-- con la clave de servicio, y cancela cualquier trabajo. Esta función es la
-- puerta para personas:
--
--   * solo trabajos de medios (`media.reel.template`, `media.image.process`)
--     de una marca que quien llama puede editar (el mismo permiso que hace
--     falta para encargarlos con `request_media_job`);
--   * solo en cola o montándose; si ya terminó, lo dice;
--   * sin permiso, o si el trabajo no existe o no es de medios, el mismo 42501,
--     para no revelar trabajos de otras marcas.
--
-- Si estaba montándose, el trabajador lo descubre al renovar su reserva
-- (`extend_job_lease` falla) y aborta; tampoco podrá cerrarlo con
-- `complete_job`, así que no llega nada a la biblioteca.

create function public.cancel_media_job(p_job_id uuid)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if (select auth.uid()) is null then
    raise exception 'Inicia sesión para cancelar trabajos' using errcode = '42501';
  end if;
  select * into v_job from public.jobs j
  where j.id = p_job_id
    and j.kind in ('media.reel.template', 'media.image.process')
    and j.brand_id is not null
    and j.brand_id in (select private.brand_ids_with('edit'))
  for update;
  if not found then
    raise exception 'No tienes permiso para cancelar este trabajo' using errcode = '42501';
  end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'Este trabajo ya ha terminado: no se puede cancelar' using errcode = 'P0001';
  end if;
  return public.cancel_job(v_job.id);
end $$;

revoke all on function public.cancel_media_job(uuid) from public, anon, authenticated;
grant execute on function public.cancel_media_job(uuid) to authenticated;
