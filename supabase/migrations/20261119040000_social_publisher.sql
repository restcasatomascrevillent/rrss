-- Fase 3 · El publicador: cola, cerrojo, idempotencia y reloj (docs/publicacion.md).
--
--   * Cada minuto, pg_cron llama a private.social_publish_dispatch(), que:
--       1. encola un trabajo `social.publish` por cada publicación armada cuya
--          hora ha llegado. La clave de idempotencia lleva la publicación, su
--          generación (sube con cada reintento manual) y su hora: encolar dos
--          veces no duplica, y moverla de fecha crea otro trabajo (el viejo,
--          al llegar, ve que no es su hora y no hace nada);
--       2. si hay trabajos que atender o cuentas que comprobar, llama a la Edge
--          Function `social-publish` con pg_net (dirección y clave de servicio
--          en Vault, como `ai-media-poll`; sin ellas no llama a nada).
--   * La función reclama los trabajos con claim_jobs y, por cada uno:
--       social_publication_begin    cerrojo (la publicación queda «publishing»
--                                   y a nombre de ESE trabajo) y comprobación
--                                   de la regla de aprobación en la misma
--                                   transacción; registra el intento;
--       social_publication_container guarda el contenedor de la red ANTES de
--                                   publicar (es lo que se mira en un reintento);
--       social_publication_succeed  «published», solo con el identificador;
--       social_publication_fail     fallo (se reintentará o queda «failed»);
--       social_publication_defer    aplaza: la red aún procesa el vídeo (se
--                                   conserva el cerrojo) o se agotó el cupo.
--   * Todo con la clave de servicio. Las personas solo ven el resultado.

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Bloquea la publicación si está «publishing» a nombre de este trabajo.
create function private.publication_lock_for_job(p_publication_id uuid, p_job_id uuid)
returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  select * into v_pub from public.scheduled_publications p
  where p.id = p_publication_id and p.status = 'publishing' and p.locked_by = 'job:' || p_job_id::text
  for update;
  if not found then
    raise exception 'La publicación no está reservada por este trabajo' using errcode = 'P0001';
  end if;
  return v_pub;
end $$;

-- Cierra el último intento de una publicación.
create function private.publication_attempt_close(
  p_publication_id uuid, p_outcome text, p_code text, p_message text, p_external_id text, p_finished boolean
) returns void
language sql security definer set search_path = '' as $$
  update public.publication_attempts a
  set outcome = p_outcome, error_code = left(p_code, 100), error_message = left(p_message, 1000),
      external_id = coalesce(left(p_external_id, 100), a.external_id),
      finished_at = case when p_finished then now() else a.finished_at end
  where a.id = (select x.id from public.publication_attempts x
                where x.publication_id = p_publication_id order by x.attempt_no desc limit 1);
$$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Encola las publicaciones armadas cuya hora ha llegado. Devuelve cuántas.
create function public.social_enqueue_due_publications(p_limit integer default 100)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_count integer := 0;
begin
  for v_pub in
    select * from public.scheduled_publications p
    where p.status = 'scheduled' and p.scheduled_at <= now()
    order by p.scheduled_at
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    perform public.enqueue_job(
      v_pub.organization_id,
      'social.publish',
      jsonb_build_object('publication_id', v_pub.id, 'generation', v_pub.generation),
      'social.publish:' || v_pub.id || ':' || v_pub.generation || ':'
        || floor(extract(epoch from v_pub.scheduled_at))::bigint,
      v_pub.brand_id,
      10,
      5
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Toma una publicación para publicarla. Devuelve {"outcome": …}:
--   ready             cerrojo tomado; trae la publicación, el intento, la cuenta
--                     (sin token), el texto de la versión y los recursos
--   already_published ya se publicó: no hay nada que hacer (idempotencia)
--   busy              otro trabajo la tiene con el cerrojo vigente
--   not_due           todavía no es su hora (se movió de fecha)
--   not_ready         no cumple la regla de aprobación: no se publica
--   gone              cancelada, fallida o borrada
create function public.social_publication_begin(
  p_publication_id uuid, p_job_id uuid, p_lease_seconds integer default 300
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_owner text := 'job:' || p_job_id::text;
  v_reason text;
  v_account public.social_accounts;
  v_copy jsonb;
  v_assets jsonb;
begin
  if p_job_id is null then
    raise exception 'Hace falta el trabajo' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 30 and 3600 then
    raise exception 'La reserva debe durar entre 30 segundos y una hora' using errcode = '22023';
  end if;

  select * into v_pub from public.scheduled_publications p where p.id = p_publication_id for update;
  if not found then
    return jsonb_build_object('outcome', 'gone');
  end if;
  if v_pub.status = 'published' then
    return jsonb_build_object('outcome', 'already_published', 'publication', to_jsonb(v_pub));
  end if;
  if v_pub.status in ('cancelled', 'failed') then
    return jsonb_build_object('outcome', 'gone', 'status', v_pub.status);
  end if;
  if v_pub.status = 'publishing' and v_pub.locked_by <> v_owner and v_pub.locked_until > now() then
    return jsonb_build_object('outcome', 'busy');
  end if;
  if v_pub.status = 'scheduled' and v_pub.scheduled_at > now() + interval '1 minute' then
    return jsonb_build_object('outcome', 'not_due', 'scheduled_at', v_pub.scheduled_at);
  end if;

  v_reason := case when v_pub.status = 'planned' then v_pub.hold_reason else private.publication_hold_reason(v_pub) end;
  if v_reason is not null then
    -- Lo que no cumple la regla no se publica: se detiene y queda anotado.
    update public.scheduled_publications p
    set status = 'planned', hold_reason = v_reason, locked_by = null, locked_until = null
    where p.id = v_pub.id
    returning * into v_pub;
    insert into public.publication_attempts (publication_id, brand_id, organization_id, attempt_no, job_id, outcome,
                                             error_code, error_message, finished_at)
    values (v_pub.id, v_pub.brand_id, v_pub.organization_id, v_pub.attempt_count + 1, p_job_id, 'not_ready',
            v_reason, 'No se publica: no cumple la regla de aprobación en la versión programada', now());
    update public.scheduled_publications p set attempt_count = p.attempt_count + 1 where p.id = v_pub.id;
    return jsonb_build_object('outcome', 'not_ready', 'reason', v_reason);
  end if;

  -- El disparador de guarda vuelve a comprobar la regla al pasar a «publishing».
  update public.scheduled_publications p
  set status = 'publishing', locked_by = v_owner, locked_until = now() + make_interval(secs => p_lease_seconds),
      attempt_count = p.attempt_count + 1
  where p.id = v_pub.id
  returning * into v_pub;

  insert into public.publication_attempts (publication_id, brand_id, organization_id, attempt_no, job_id, outcome,
                                           container_id)
  values (v_pub.id, v_pub.brand_id, v_pub.organization_id, v_pub.attempt_count, p_job_id, 'started',
          v_pub.container_id);

  select * into v_account from public.social_accounts a where a.id = v_pub.social_account_id;
  select coalesce(v.data -> 'copy', '{}'::jsonb) into v_copy
  from public.content_versions v where v.content_id = v_pub.content_id and v.version = v_pub.content_version;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'storage_path', a.storage_path, 'mime_type', a.mime_type,
                                               'kind', a.kind, 'width', a.width, 'height', a.height)
                            order by u.ord), '[]'::jsonb)
  into v_assets
  from unnest(v_pub.media_asset_ids) with ordinality u(id, ord)
  join public.media_assets a on a.id = u.id;

  return jsonb_build_object(
    'outcome', 'ready',
    'publication', to_jsonb(v_pub),
    'attempt_no', v_pub.attempt_count,
    'account', jsonb_build_object('id', v_account.id, 'network', v_account.network,
                                  'external_id', v_account.external_id, 'username', v_account.username,
                                  'status', v_account.status, 'token_expires_at', v_account.token_expires_at),
    'copy', v_copy,
    'assets', v_assets
  );
end $$;

-- Guarda (o borra, con null) el contenedor de la red. El publicador la llama
-- JUSTO ANTES de publicar (también con un contenedor que ya tenía), y aquí se
-- vuelve a comprobar la regla de aprobación: si la pieza cambió mientras se
-- preparaba el medio, falla (PB001) y no se publica.
create function public.social_publication_container(p_publication_id uuid, p_job_id uuid, p_container_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_reason text;
begin
  v_pub := private.publication_lock_for_job(p_publication_id, p_job_id);
  v_reason := private.publication_hold_reason(v_pub);
  if nullif(btrim(p_container_id), '') is not null and v_reason is not null then
    raise exception 'Lo que no está aprobado (en la versión programada) no se publica'
      using errcode = 'PB001', detail = v_reason;
  end if;
  update public.scheduled_publications p
  set container_id = nullif(btrim(p_container_id), ''),
      container_created_at = case when nullif(btrim(p_container_id), '') is null then null else now() end
  where p.id = v_pub.id
  returning * into v_pub;
  update public.publication_attempts a set container_id = v_pub.container_id
  where a.publication_id = v_pub.id and a.attempt_no = v_pub.attempt_count;
  return to_jsonb(v_pub);
end $$;

-- Publicada: guarda el identificador y el enlace que da la red. Repetirla con
-- el mismo identificador no cambia nada.
create function public.social_publication_succeed(
  p_publication_id uuid, p_job_id uuid, p_external_id text, p_external_url text default null,
  p_recovered boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  if p_external_id is null or btrim(p_external_id) = '' then
    raise exception 'Sin el identificador de la red no se da nada por publicado' using errcode = '22023';
  end if;
  select * into v_pub from public.scheduled_publications p where p.id = p_publication_id for update;
  if found and v_pub.status = 'published' and v_pub.external_id = btrim(p_external_id) then
    return to_jsonb(v_pub);
  end if;
  v_pub := private.publication_lock_for_job(p_publication_id, p_job_id);
  update public.scheduled_publications p
  set status = 'published', external_id = btrim(p_external_id),
      external_url = case when p_external_url ~* '^https?://' then left(p_external_url, 2000) end,
      published_at = now(), locked_by = null, locked_until = null, last_error = null, last_error_code = null
  where p.id = v_pub.id
  returning * into v_pub;
  perform private.publication_attempt_close(v_pub.id, case when coalesce(p_recovered, false) then 'recovered'
                                                           else 'published' end,
                                            null, null, v_pub.external_id, true);
  return to_jsonb(v_pub);
end $$;

-- Falló. Con p_final queda «failed» (se puede reintentar a mano); si no, vuelve
-- al calendario (armada, o detenida si entretanto dejó de cumplir la regla) y
-- la cola la reintentará con espera creciente.
create function public.social_publication_fail(
  p_publication_id uuid, p_job_id uuid, p_code text, p_message text, p_final boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_reason text;
begin
  v_pub := private.publication_lock_for_job(p_publication_id, p_job_id);
  v_reason := private.publication_hold_reason(v_pub);
  update public.scheduled_publications p
  set status = case when coalesce(p_final, false) then 'failed'::public.publication_status
                    when v_reason is null then 'scheduled' else 'planned' end,
      hold_reason = case when coalesce(p_final, false) then null else v_reason end,
      locked_by = null, locked_until = null,
      last_error_code = left(coalesce(p_code, 'unknown'), 100),
      last_error = left(coalesce(nullif(btrim(p_message), ''), 'Error sin descripción'), 1000)
  where p.id = v_pub.id
  returning * into v_pub;
  perform private.publication_attempt_close(v_pub.id, case when coalesce(p_final, false) then 'failed'
                                                           else 'retrying' end,
                                            v_pub.last_error_code, v_pub.last_error, null, true);
  return to_jsonb(v_pub);
end $$;

-- Aplaza el trabajo sin gastar intento:
--   p_keep_lock = true: la red aún procesa el medio (vídeo); la publicación
--     sigue «publishing» a nombre de este trabajo hasta que vuelva.
--   p_keep_lock = false: no se puede publicar todavía (cupo de la red agotado);
--     la publicación vuelve al calendario con el motivo.
create function public.social_publication_defer(
  p_publication_id uuid, p_job_id uuid, p_worker text, p_seconds integer, p_keep_lock boolean,
  p_code text default null, p_message text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_reason text;
begin
  if p_seconds is null or p_seconds not between 5 and 86400 then
    raise exception 'El aplazamiento debe durar entre 5 segundos y un día' using errcode = '22023';
  end if;
  v_pub := private.publication_lock_for_job(p_publication_id, p_job_id);

  update public.jobs j
  set status = 'queued', locked_by = null, locked_until = null, attempts = greatest(j.attempts - 1, 0),
      run_after = now() + make_interval(secs => p_seconds),
      last_error = coalesce(left(p_message, 1000), j.last_error)
  where j.id = p_job_id and j.status = 'running' and j.locked_by = p_worker;
  if not found then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;

  if coalesce(p_keep_lock, false) then
    update public.scheduled_publications p
    set locked_until = now() + make_interval(secs => p_seconds + 600)
    where p.id = v_pub.id
    returning * into v_pub;
    perform private.publication_attempt_close(v_pub.id, 'waiting', p_code, p_message, null, true);
  else
    v_reason := private.publication_hold_reason(v_pub);
    update public.scheduled_publications p
    set status = case when v_reason is null then 'scheduled'::public.publication_status else 'planned' end,
        hold_reason = v_reason, locked_by = null, locked_until = null,
        last_error_code = left(p_code, 100), last_error = left(p_message, 1000)
    where p.id = v_pub.id
    returning * into v_pub;
    perform private.publication_attempt_close(v_pub.id, 'deferred', p_code, p_message, null, true);
  end if;
  return to_jsonb(v_pub);
end $$;

-- ─────────────────────────── Reloj (pg_cron) ───────────────────────────

-- Encola lo que toca y, si hay trabajo o cuentas que comprobar, llama a la
-- función `social-publish`. Devuelve el identificador de la petición de pg_net
-- o null. SQL dinámico para que exista aunque falten Vault o pg_net (pruebas).
create function private.social_publish_dispatch() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  perform public.social_enqueue_due_publications(100);

  if not exists (
    select 1 from public.jobs j
    where j.kind = 'social.publish'
      and ((j.status = 'queued' and j.run_after <= now()) or (j.status = 'running' and j.locked_until < now()))
  ) and not exists (
    select 1 from public.social_accounts a
    where a.status = 'active' and (a.token_checked_at is null or a.token_checked_at < now() - interval '24 hours')
  ) then
    return null;
  end if;

  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    raise warning 'social_publish_dispatch: faltan Vault o pg_net; no se llama a social-publish';
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'rrss_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'rrss_service_role_key';
  if v_url is null or v_key is null then
    raise warning 'social_publish_dispatch: faltan los secretos rrss_project_url o rrss_service_role_key en Vault';
    return null;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_request
    using rtrim(v_url, '/') || '/functions/v1/social-publish',
          jsonb_build_object('source', 'pg_cron'),
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
          120000;
  return v_request;
end $$;

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on function private.publication_lock_for_job(uuid, uuid) from public, anon, authenticated;
revoke all on function private.publication_attempt_close(uuid, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function private.social_publish_dispatch() from public, anon, authenticated, service_role;

revoke all on function public.social_enqueue_due_publications(integer) from public, anon, authenticated;
revoke all on function public.social_publication_begin(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.social_publication_container(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.social_publication_succeed(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.social_publication_fail(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.social_publication_defer(uuid, uuid, text, integer, boolean, text, text)
  from public, anon, authenticated;

grant execute on function public.social_enqueue_due_publications(integer) to service_role;
grant execute on function public.social_publication_begin(uuid, uuid, integer) to service_role;
grant execute on function public.social_publication_container(uuid, uuid, text) to service_role;
grant execute on function public.social_publication_succeed(uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.social_publication_fail(uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.social_publication_defer(uuid, uuid, text, integer, boolean, text, text) to service_role;

-- Programar el reloj solo donde existen pg_cron y pg_net (Supabase y su stack
-- local). Mismo nombre = se actualiza la tarea, no se duplica.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('rrss-social-publish', '* * * * *', 'select private.social_publish_dispatch()');
  else
    raise notice 'pg_cron o pg_net no están disponibles: no se programa el publicador';
  end if;
end
$do$;
