-- Trabajador de medios en Fly.io (docs/alojamiento.md): integración en
-- Plataforma → Integraciones y despertador desde la base de datos.
--
-- El trabajador (`worker/`) corre en una máquina de Fly bajo demanda en modo
-- `drain`: arranca, vacía la cola y sale, y la máquina se queda parada (en
-- `worker/fly.toml`, `[[restart]] policy = "never"`).
--
--   · Integración nueva `media_worker` («Trabajador de medios (Fly.io)»):
--     FLY_API_TOKEN (secreto, en Vault), FLY_APP y FLY_MACHINE_ID. Los pega un
--     superadministrador en la pantalla; «Probar conexión» consulta la máquina
--     con la API de Fly (supabase/functions/_shared/integrations/probes.ts).
--     Los mismos nombres están en supabase/functions/_shared/integrations/catalog.ts
--     y en src/features/platform/integrations/catalog.ts; una prueba comprueba
--     que coinciden.
--   · `private.media_worker_wake()`: si hay trabajos del trabajador que se
--     pueden reclamar y ninguno está en curso con la reserva viva, llama con
--     pg_net a la API de máquinas de Fly:
--       POST https://api.machines.dev/v1/apps/{app}/machines/{id}/start
--     Lee el token, la app y la máquina de la integración y, si no están, de
--     los secretos sueltos de Vault `rrss_fly_api_token`, `rrss_fly_app` y
--     `rrss_fly_machine_id` (los que deja el script alternativo
--     worker/scripts/fly-preparar.mjs). Sin ellos, o sin Vault o pg_net, solo
--     avisa y no llama a nada (como los demás despachadores).
--   · Disparador por sentencia al encolar (`AFTER INSERT` en `public.jobs`),
--     solo si entra algún trabajo del trabajador que ya toca ejecutar. Nunca
--     hace fallar el encolado.
--   · `pg_cron` cada 2 minutos de respaldo: pg_net puede perder llamadas, y los
--     reintentos con espera (`run_after` futuro) y los trabajos devueltos con
--     `release_job` no generan ningún INSERT.
--
-- Idempotencia: despertar dos veces no hace daño. Si la máquina ya está
-- arrancada, Fly responde con un error que nadie lee (queda en
-- `net._http_response`) y `claim_jobs` reparte cada trabajo a un solo
-- trabajador. Además, para no repetir llamadas en ráfaga, no se vuelve a
-- llamar antes de 10 s (`private.media_worker_wake_state`), ni mientras un
-- trabajo del trabajador tiene la reserva viva (la máquina está en marcha y
-- el bucle recoge lo nuevo antes de salir).
--
-- Tipos del trabajador: `media.*` y `source.extract` (worker/src/handlers).
-- Vuelta atrás: supabase/rollbacks/20261208010000_media_worker_wake.sql

-- ─────────────────────── Plataforma → Integraciones ───────────────────────

alter table private.integration_setting_keys
  drop constraint integration_setting_keys_integration_check,
  add constraint integration_setting_keys_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2', 'media_worker'));

alter table private.integration_tests
  drop constraint integration_tests_integration_check,
  add constraint integration_tests_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2', 'media_worker'));

insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  ('FLY_API_TOKEN', 'media_worker', true),
  ('FLY_APP', 'media_worker', false),
  ('FLY_MACHINE_ID', 'media_worker', false);

-- Igual que en 20261124010000, admitiendo la integración nueva.
create or replace function public.integration_record_test(p_user_id uuid, p_integration text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_integration is null
     or p_integration not in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2', 'media_worker') then
    raise exception 'Esa integración no existe' using errcode = '22023';
  end if;
  insert into private.integration_tests (integration, ok, message, tested_by, tested_at)
  values (p_integration, coalesce(p_ok, false), left(coalesce(p_message, ''), 500), p_user_id, now())
  on conflict (integration) do update
    set ok = excluded.ok, message = excluded.message, tested_by = excluded.tested_by, tested_at = now();
  insert into private.integration_audit (actor_id, action, integration, data)
  values (p_user_id, 'test', p_integration, jsonb_build_object('ok', coalesce(p_ok, false)));
end $$;

-- ───────────────────────────── Estado ─────────────────────────────

-- Una sola fila: cuándo se pidió el último arranque. Solo la usan las
-- funciones de abajo (SECURITY DEFINER); nadie la ve desde la API.
create table private.media_worker_wake_state (
  id boolean primary key default true check (id),
  last_requested_at timestamptz,
  last_request_id bigint
);
insert into private.media_worker_wake_state (id) values (true);
alter table private.media_worker_wake_state enable row level security;
revoke all on table private.media_worker_wake_state from public, anon, authenticated, service_role;

-- ─────────────────────────── Funciones ───────────────────────────

-- ¿Lo atiende el trabajador de medios? Mismo criterio que sus manejadores.
create function private.is_media_worker_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_kind like 'media.%' or p_kind = 'source.extract', false)
$$;

-- Arranca la máquina de Fly si hay trabajo. Devuelve el identificador de la
-- petición de pg_net, o null si no llama (sin trabajo, máquina en marcha,
-- llamada reciente o faltan Vault, pg_net o la configuración). SQL dinámico
-- para pg_net y los secretos sueltos: existe aunque falten (pruebas y stack
-- sin extensiones).
create function private.media_worker_wake() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_app text;
  v_machine text;
  v_request bigint;
begin
  -- 1. ¿Hay algo que el trabajador pueda reclamar ya? (mismo criterio que claim_jobs)
  if not exists (
    select 1 from public.jobs j
    where private.is_media_worker_kind(j.kind)
      and j.attempts < j.max_attempts
      and ((j.status = 'queued' and j.run_after <= now()) or (j.status = 'running' and j.locked_until < now()))
  ) then
    return null;
  end if;

  -- 2. Si un trabajo del trabajador tiene la reserva viva, la máquina está en
  --    marcha: su bucle recoge lo nuevo antes de salir.
  if exists (
    select 1 from public.jobs j
    where private.is_media_worker_kind(j.kind) and j.status = 'running' and j.locked_until >= now()
  ) then
    return null;
  end if;

  -- 3. Configuración: primero Plataforma → Integraciones; si falta, los
  --    secretos sueltos de Vault.
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    raise warning 'media_worker_wake: faltan Vault o pg_net; no se despierta al trabajador';
    return null;
  end if;
  select nullif(btrim(private.integration_secret_value(s.vault_secret_id)), '') into v_token
  from private.integration_settings s where s.setting_key = 'FLY_API_TOKEN';
  select nullif(btrim(s.plain_value), '') into v_app
  from private.integration_settings s where s.setting_key = 'FLY_APP';
  select nullif(btrim(s.plain_value), '') into v_machine
  from private.integration_settings s where s.setting_key = 'FLY_MACHINE_ID';
  if v_token is null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_token using 'rrss_fly_api_token';
    v_token := nullif(btrim(v_token), '');
  end if;
  if v_app is null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_app using 'rrss_fly_app';
    v_app := nullif(btrim(v_app), '');
  end if;
  if v_machine is null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_machine using 'rrss_fly_machine_id';
    v_machine := nullif(btrim(v_machine), '');
  end if;
  if v_token is null or v_app is null or v_machine is null then
    raise warning 'media_worker_wake: faltan el token, la app o la máquina de Fly (Plataforma → Integraciones → Trabajador de medios)';
    return null;
  end if;
  -- Van en la URL: solo lo que Fly admite (nada de barras ni parámetros).
  if v_app !~ '^[a-z0-9][a-z0-9-]{0,62}$' or v_machine !~ '^[a-z0-9]{6,32}$' then
    raise warning 'media_worker_wake: la app o la máquina de Fly no tienen un formato válido';
    return null;
  end if;

  -- 4. Sin ráfagas: una llamada cada 10 s como mucho. SKIP LOCKED: si otra
  --    transacción está pidiendo el arranque ahora mismo, esta no repite.
  perform 1 from private.media_worker_wake_state s
  where s.id and (s.last_requested_at is null or s.last_requested_at < now() - interval '10 seconds')
  for update skip locked;
  if not found then
    return null;
  end if;

  -- 5. Arrancar. pg_net envía tras el commit (si se deshace, no sale nada).
  --    Los tokens de Fly («FlyV1 fm2_…») van tal cual en la cabecera; cualquier
  --    otro, como «Bearer …».
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_request
    using 'https://api.machines.dev/v1/apps/' || v_app || '/machines/' || v_machine || '/start',
          '{}'::jsonb,
          jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', case when v_token like 'FlyV1 %' then v_token else 'Bearer ' || v_token end
          ),
          15000;

  update private.media_worker_wake_state s
  set last_requested_at = now(), last_request_id = v_request
  where s.id;
  return v_request;
end $$;

-- Disparador: solo si entra algún trabajo del trabajador que ya toca ejecutar.
-- Un fallo al despertar nunca impide encolar (lo recoge el cron de respaldo).
create function private.jobs_wake_media_worker() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from new_jobs n
    where private.is_media_worker_kind(n.kind) and n.status = 'queued' and n.run_after <= now()
  ) then
    begin
      perform private.media_worker_wake();
    exception when others then
      raise warning 'media_worker_wake: no se pudo despertar al trabajador (%)', sqlerrm;
    end;
  end if;
  return null;
end $$;

create trigger jobs_wake_media_worker
  after insert on public.jobs
  referencing new table as new_jobs
  for each statement execute function private.jobs_wake_media_worker();

-- ───────────────────────────── Privilegios ─────────────────────────────

-- Ni las personas ni la clave de servicio: solo el disparador y pg_cron.
revoke all on function private.media_worker_wake() from public, anon, authenticated, service_role;
revoke all on function private.jobs_wake_media_worker() from public, anon, authenticated, service_role;
revoke all on function private.is_media_worker_kind(text) from public, anon, authenticated, service_role;

-- ───────────────────────────── Reloj (pg_cron) ─────────────────────────────

-- Solo donde existen pg_cron y pg_net (Supabase y su stack local). Mismo
-- nombre = se actualiza la tarea, no se duplica.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('rrss-media-worker-wake', '*/2 * * * *', 'select private.media_worker_wake()');
  else
    raise notice 'pg_cron o pg_net no están disponibles: no se programa el despertador del trabajador';
  end if;
end
$do$;
