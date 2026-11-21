-- «Publicar ahora» (docs/publicacion.md): publicar sin esperar a la hora ni al
-- minuto del reloj. Sin tablas ni columnas nuevas; solo dos funciones para
-- personas y una interna:
--
--   publish_publication_now   pone la pieza en el calendario con la hora actual
--                             (o adelanta la que ya estaba), con las mismas
--                             garantías de siempre —aprobada, su versión, su
--                             exportación o vídeo, cuenta viva— porque pasa por
--                             save_publication y por la regla dura; si no se
--                             cumple, se niega (PB003, con el motivo) y NO deja
--                             nada guardado. Encola el trabajo con la MISMA
--                             clave de idempotencia que el reloj. Repetirla con
--                             algo ya en curso o publicado no cambia nada.
--   publication_publish_kick  para la Edge Function social-publish/now: con la
--                             sesión de la persona comprueba el permiso y vuelve
--                             a encolar (idempotente) lo que ya toca; no cambia
--                             estados ni adelanta lo que está programado.
--
-- El cerrojo y la idempotencia son los de siempre (migración 20261119040000): el
-- reloj y la llamada directa reclaman trabajos con FOR UPDATE SKIP LOCKED y
-- social_publication_begin toma la publicación con el cerrojo de fila; el que
-- llega segundo la encuentra «busy» o «already_published» y no publica.

-- Encola el trabajo de una publicación armada y vencida. Misma clave que
-- social_enqueue_due_publications: encolar por las dos vías no duplica.
create function private.publication_enqueue_now(p_pub public.scheduled_publications)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.enqueue_job(
    p_pub.organization_id,
    'social.publish',
    jsonb_build_object('publication_id', p_pub.id, 'generation', p_pub.generation),
    'social.publish:' || p_pub.id || ':' || p_pub.generation || ':'
      || floor(extract(epoch from p_pub.scheduled_at))::bigint,
    p_pub.brand_id,
    10,
    5
  );
end $$;

create function public.publish_publication_now(
  p_content_id uuid,
  p_social_account_id uuid,
  p_media_asset_ids uuid[],
  p_content_version integer,
  p_publication_id uuid default null
) returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.content_items;
  v_pub public.scheduled_publications;
begin
  select * into v_item from public.content_items c
  where c.id = p_content_id and c.brand_id in (select private.brand_ids_with('edit'));
  if not found then
    raise exception 'No tienes permiso para publicar este contenido' using errcode = '42501';
  end if;

  -- Una pieza tiene una sola publicación viva: si ya la tiene, se usa esa.
  select * into v_pub from public.scheduled_publications p
  where p.content_id = v_item.id and p.status <> 'cancelled'
  for update;
  if found then
    if p_publication_id is not null and p_publication_id <> v_pub.id then
      raise exception 'Esa publicación no es de esta pieza' using errcode = '22023';
    end if;
    -- Doble clic o dos personas a la vez: no se toca lo que ya está en curso o salió.
    if v_pub.status in ('publishing', 'published') then
      return v_pub;
    end if;
    if v_pub.status = 'failed' then
      update public.scheduled_publications p
      set status = 'planned', hold_reason = 'not_approved', generation = p.generation + 1
      where p.id = v_pub.id;
    end if;
  elsif p_publication_id is not null then
    raise exception 'No tienes permiso para publicar este contenido' using errcode = '42501';
  end if;

  -- La misma comprobación que al programar (permiso, cuenta de la marca y la
  -- red, recursos de la marca, versión que existe), con la hora de ahora.
  v_pub := public.save_publication(v_pub.id, v_item.id, now(), p_social_account_id,
                                   coalesce(p_media_asset_ids, '{}'), p_content_version);

  if v_pub.status <> 'scheduled' then
    -- Al lanzar la excepción se deshace todo lo anterior: no queda nada programado.
    raise exception 'No se puede publicar ahora' using errcode = 'PB003', detail = v_pub.hold_reason;
  end if;

  perform private.publication_enqueue_now(v_pub);
  return v_pub;
end $$;

create function public.publication_publish_kick(p_publication_id uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  v_pub := private.publication_lock_for_edit(p_publication_id);
  if v_pub.status = 'scheduled' and v_pub.scheduled_at <= now() then
    perform private.publication_enqueue_now(v_pub);
  end if;
  return v_pub.status::text;
end $$;

revoke all on function private.publication_enqueue_now(public.scheduled_publications) from public, anon, authenticated;
revoke all on function public.publish_publication_now(uuid, uuid, uuid[], integer, uuid) from public, anon, authenticated;
revoke all on function public.publication_publish_kick(uuid) from public, anon, authenticated;
grant execute on function public.publish_publication_now(uuid, uuid, uuid[], integer, uuid) to authenticated;
grant execute on function public.publication_publish_kick(uuid) to authenticated;
