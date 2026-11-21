-- Trabajador de medios SIN la clave de servicio (docs/alojamiento.md, §5).
--
-- El dueño no quiere poner SUPABASE_SERVICE_ROLE_KEY en Fly.io. El trabajador
-- habla ahora con la Edge Function `worker-gateway`, que guarda la clave de
-- servicio dentro de Supabase y solo expone lo que el trabajador necesita.
-- Estas funciones son las que la función llama; toda la comprobación de
-- permisos está aquí, en la base de datos:
--
--   · Token propio del trabajador (`rrss_wgt_…`, 32 bytes aleatorios). Lo
--     genera un superadministrador con «Generar token» en Plataforma →
--     Integraciones → Trabajador de medios y lo pega en Fly. En la base de
--     datos NUNCA se guarda el token: solo su huella SHA-256
--     («sha256:<64 hex>»), y además cifrada en Vault como cualquier secreto de
--     las integraciones (ajuste WORKER_GATEWAY_TOKEN). Revocar = borrar el
--     ajuste; rotar = generar otro (el anterior deja de valer en el acto).
--   · La función recibe la huella (no el token) y cada RPC la compara con la
--     guardada. Sin token configurado, o con otro, no se hace nada.
--   · Cola: el trabajador solo reclama tipos suyos (`media.*`,
--     `source.extract`), como mucho 16 a la vez, y queda registrado como
--     «gw:<huella corta>:<nombre>». Terminar, fallar, devolver y renovar solo
--     valen para trabajos reservados con ESE token y ese nombre.
--   · Archivos: antes de firmar una lectura o una subida, la ruta tiene que
--     ser de la organización y la marca del trabajo, y el trabajo tiene que
--     estar en curso y reservado por ese trabajador. La lectura dice en qué
--     almacén está (Supabase, R2 o Drive); en Drive no se escribe.
--   · Frecuencia: como mucho 1.200 llamadas por minuto entre todas (un reel
--     hace unas pocas decenas). Pasado el tope, se rechaza hasta el minuto
--     siguiente.
--
-- Solo la clave de servicio ejecuta estas funciones (la función
-- `worker-gateway`); el token del trabajador no sirve para nada más: no es un
-- JWT, la API de Supabase lo rechaza y ninguna otra función lo acepta.
--
-- Vuelta atrás: supabase/rollbacks/20261210010000_worker_gateway.sql

-- ─────────────────────── Plataforma → Integraciones ───────────────────────

insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  ('WORKER_GATEWAY_TOKEN', 'media_worker', true);

-- Lo guardado en WORKER_GATEWAY_TOKEN tiene que ser una huella, nunca el token
-- (ni una clave cualquiera pegada a mano): la función solo guarda huellas.
create function private.worker_gateway_setting_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.setting_key = 'WORKER_GATEWAY_TOKEN'
     and coalesce(private.integration_secret_value(new.vault_secret_id), '') !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'El token del trabajador solo se genera con «Generar token»' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger integration_settings_worker_gateway_guard
  before insert or update on private.integration_settings
  for each row when (new.setting_key = 'WORKER_GATEWAY_TOKEN')
  execute function private.worker_gateway_setting_guard();

-- ───────────────────────────── Estado ─────────────────────────────

-- Llamadas por minuto (todas las del trabajador). Se borra lo de hace más de
-- una hora en cada llamada.
create table private.worker_gateway_calls (
  minute timestamptz primary key,
  calls integer not null default 0 check (calls >= 0)
);
alter table private.worker_gateway_calls enable row level security;
-- Sin políticas a propósito: solo lo usan las funciones de abajo.
revoke all on table private.worker_gateway_calls from public, anon, authenticated, service_role;

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Comprueba la huella del token y cuenta la llamada. Devuelve el nombre con el
-- que el trabajador reserva trabajos: «gw:<12 primeros hex>:<nombre>».
create function private.worker_gateway_identity(p_token_hash text, p_worker text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_stored text;
  v_calls integer;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'El token del trabajador no es válido' using errcode = '42501';
  end if;
  select private.integration_secret_value(s.vault_secret_id) into v_stored
  from private.integration_settings s where s.setting_key = 'WORKER_GATEWAY_TOKEN';
  if v_stored is null or v_stored <> 'sha256:' || p_token_hash then
    raise exception 'El token del trabajador no es válido o se ha revocado' using errcode = '42501';
  end if;
  if p_worker is null or p_worker !~ '^[A-Za-z0-9._:@-]{1,150}$' then
    raise exception 'Nombre de trabajador no válido (letras, cifras y . _ : @ -, hasta 150)' using errcode = '22023';
  end if;

  delete from private.worker_gateway_calls c where c.minute < now() - interval '1 hour';
  insert into private.worker_gateway_calls as c (minute, calls)
  values (date_trunc('minute', now()), 1)
  on conflict (minute) do update set calls = c.calls + 1
  returning c.calls into v_calls;
  if v_calls > 1200 then
    raise exception 'Demasiadas llamadas del trabajador: espera un minuto' using errcode = 'P0429';
  end if;

  return 'gw:' || left(p_token_hash, 12) || ':' || p_worker;
end $$;

-- ─────────────────────── RPC de `worker-gateway` (clave de servicio) ───────────────────────

-- Reclama trabajos del trabajador. Sin tipos: todos los suyos; con tipos, solo
-- los suyos de esa lista (nunca otros).
create function public.worker_gateway_claim(
  p_token_hash text,
  p_worker text,
  p_kinds text[] default null,
  p_limit integer default 1,
  p_lease_seconds integer default 300
) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_worker text := private.worker_gateway_identity(p_token_hash, p_worker);
  v_kinds text[];
begin
  if p_limit is null or p_limit not between 1 and 16 then
    raise exception 'Se pueden reclamar entre 1 y 16 trabajos a la vez' using errcode = '22023';
  end if;
  if p_kinds is null then
    -- Los tipos que existen en la cola y son del trabajador.
    select coalesce(array_agg(distinct j.kind), '{}') into v_kinds
    from public.jobs j where private.is_media_worker_kind(j.kind) and j.status in ('queued', 'running');
  else
    select coalesce(array_agg(distinct k), '{}') into v_kinds
    from unnest(p_kinds) k where private.is_media_worker_kind(k);
    if cardinality(v_kinds) = 0 then
      raise exception 'Ninguno de esos tipos de trabajo es del trabajador de medios' using errcode = '22023';
    end if;
  end if;
  if cardinality(v_kinds) = 0 then
    return;
  end if;
  return query select * from public.claim_jobs(v_worker, v_kinds, p_limit, p_lease_seconds);
end $$;

create function public.worker_gateway_complete(p_token_hash text, p_worker text, p_job_id uuid, p_result jsonb default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.complete_job(p_job_id, private.worker_gateway_identity(p_token_hash, p_worker), p_result);
end $$;

create function public.worker_gateway_fail(p_token_hash text, p_worker text, p_job_id uuid, p_error text,
                                           p_retry boolean default true)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.fail_job(p_job_id, private.worker_gateway_identity(p_token_hash, p_worker), p_error, p_retry);
end $$;

create function public.worker_gateway_release(p_token_hash text, p_worker text, p_job_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.release_job(p_job_id, private.worker_gateway_identity(p_token_hash, p_worker));
end $$;

create function public.worker_gateway_extend(p_token_hash text, p_worker text, p_job_id uuid,
                                             p_lease_seconds integer default 300)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.extend_job_lease(p_job_id, private.worker_gateway_identity(p_token_hash, p_worker), p_lease_seconds);
end $$;

-- ¿Puede el trabajador leer (p_write = false) o escribir esta ruta para este
-- trabajo? Devuelve { "backend": "supabase" | "r2" | "drive" } (en escritura,
-- siempre "supabase": dónde se sube lo decide la función según la
-- configuración de R2). Rechaza si el trabajo no está en curso con ese
-- trabajador, si la ruta no es de su organización y marca, o si no es una ruta
-- válida.
create function public.worker_gateway_authorize_path(p_token_hash text, p_worker text, p_job_id uuid, p_path text,
                                                     p_write boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_worker text := private.worker_gateway_identity(p_token_hash, p_worker);
  v_job public.jobs;
  v_backend text;
begin
  select * into v_job from public.jobs j where j.id = p_job_id;
  if not found or v_job.status <> 'running' or v_job.locked_by is distinct from v_worker then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;
  if not private.is_media_worker_kind(v_job.kind) or v_job.brand_id is null then
    raise exception 'Ese trabajo no es del trabajador de medios' using errcode = '42501';
  end if;
  if p_path is null or char_length(p_path) > 1024
     or p_path ~ '(^|/)\.{1,2}(/|$)' or p_path ~ '//' or p_path ~ '/$' or position(E'\\' in p_path) > 0
     or p_path ~ '[[:cntrl:]]' or split_part(p_path, '/', 3) = '' then
    raise exception 'Ruta no válida' using errcode = '22023';
  end if;
  if lower(split_part(p_path, '/', 1)) <> v_job.organization_id::text
     or lower(split_part(p_path, '/', 2)) <> v_job.brand_id::text then
    raise exception 'La ruta no pertenece a la marca del trabajo' using errcode = '42501';
  end if;

  if split_part(p_path, '/', 3) = 'drive' then
    if coalesce(p_write, false) then
      raise exception 'En Google Drive no se escribe' using errcode = '42501';
    end if;
    return jsonb_build_object('backend', 'drive');
  end if;
  if coalesce(p_write, false) then
    return jsonb_build_object('backend', 'supabase');
  end if;

  select ma.storage_backend into v_backend from public.media_assets ma
  where ma.source = 'storage' and (ma.storage_path = p_path or ma.thumb_path = p_path)
  limit 1;
  if v_backend is null then
    select l.backend into v_backend from private.media_object_locations l where l.storage_path = p_path;
  end if;
  return jsonb_build_object('backend', coalesce(v_backend, 'supabase'));
end $$;

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on function private.worker_gateway_setting_guard() from public, anon, authenticated, service_role;
revoke all on function private.worker_gateway_identity(text, text) from public, anon, authenticated, service_role;

revoke all on function public.worker_gateway_claim(text, text, text[], integer, integer) from public, anon, authenticated;
revoke all on function public.worker_gateway_complete(text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.worker_gateway_fail(text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.worker_gateway_release(text, text, uuid) from public, anon, authenticated;
revoke all on function public.worker_gateway_extend(text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.worker_gateway_authorize_path(text, text, uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.worker_gateway_claim(text, text, text[], integer, integer) to service_role;
grant execute on function public.worker_gateway_complete(text, text, uuid, jsonb) to service_role;
grant execute on function public.worker_gateway_fail(text, text, uuid, text, boolean) to service_role;
grant execute on function public.worker_gateway_release(text, text, uuid) to service_role;
grant execute on function public.worker_gateway_extend(text, text, uuid, integer) to service_role;
grant execute on function public.worker_gateway_authorize_path(text, text, uuid, text, boolean) to service_role;
