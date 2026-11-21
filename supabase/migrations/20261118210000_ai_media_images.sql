-- Fase 2 · Imágenes generadas con IA, de punta a punta.
--
-- 1. Procedencia en la biblioteca. Una imagen generada es un recurso más de
--    `media_assets` (origin = 'generated') y su procedencia va en la columna
--    `provenance` que creó la exportación (20261118120000), con su propio tipo:
--      {"type": "ai_generation", "generation_id": "<uuid>", "provider": "…",
--       "model": "…", "purpose": "post.visual", "prompt": "<encargo recortado>",
--       "data_region": "eu", "trains_on_inputs": "no", "untested_adapter": true}
--    Esa columna se puede escribir al insertar desde el cliente (la exportación
--    lo necesita), así que aquí se impide que alguien que no sea el servidor
--    declare un recurso como generado con IA. La clave de servicio puede
--    escribirla: tiene todos los privilegios de la tabla (20261115120000).
-- 2. Modelo `comfyui` · FLUX.2 Klein 4B (servidor ComfyUI propio, modelos
--    abiertos). Nace INACTIVO y con el precio SIN VERIFICAR: su coste es el de
--    la GPU donde corra, que se fija al elegirla (0 en pruebas con Colab).
-- 3. Seguimiento de los trabajos asíncronos: pg_cron llama cada 30 s a la
--    función `ai-media-poll` con pg_net, solo si hay trabajos `ai.media.poll`
--    que toque mirar. La dirección del proyecto y la clave de servicio se leen
--    de Vault (`rrss_project_url`, `rrss_service_role_key`), que se rellena a
--    mano en cada entorno (docs/ia-medios.md, §8): sin ellas no se llama a nada.
--    Donde no existen pg_cron o pg_net (las pruebas con PGlite) no se programa.

-- ─────────────────────────── 1. Procedencia ───────────────────────────

-- Solo el servidor (clave de servicio) puede dar un recurso por generado con IA.
-- Al actualizar solo se mira si cambia la procedencia: renombrar, mover o
-- etiquetar una imagen generada (columnas que el cliente sí puede cambiar)
-- conserva la procedencia que puso el servidor y tiene que poder hacerse.
create function private.media_assets_ai_provenance_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.provenance ->> 'type') = 'ai_generation'
     and (tg_op = 'INSERT' or new.provenance is distinct from old.provenance)
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Solo el servidor puede registrar un recurso generado con IA' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function private.media_assets_ai_provenance_guard() from public, anon, authenticated;

-- Sin lista de columnas ni índice sobre `provenance` a propósito: así esta
-- migración no ata la columna y la vuelta atrás de 20261118120000 sigue
-- pudiendo quitarla. El recurso de una generación se encuentra por
-- `ai_generations.output.assets[].asset_id`, que escribe el servicio.
create trigger media_assets_ai_provenance_guard before insert or update on public.media_assets
  for each row execute function private.media_assets_ai_provenance_guard();

-- ─────────────────────── 2. Modelo de ComfyUI propio ───────────────────────

insert into public.ai_media_models
  (provider, model, task, display_name, billing_unit, price_micros, price_details, price_checked_on, price_source,
   price_verified, data_region, trains_on_inputs, delivery, settings, notes)
values
  ('comfyui', 'flux-2-klein-4b', 'image', 'FLUX.2 Klein 4B (servidor ComfyUI propio)', 'image', 0, '{}',
   '2026-11-18', 'Sin tarifa de proveedor: el coste es el de la GPU donde corra el servidor. Fijarlo al elegirla (0 en pruebas con Colab gratuito).',
   false, 'unknown', 'no', 'async',
   '{"unet_name": "flux-2-klein-4b-fp8.safetensors", "clip_name": "qwen_3_4b_fp8_mixed.safetensors", "clip_type": "flux2", "vae_name": "flux2-vae.safetensors", "steps": 4, "max_pixels": 1572864}',
   'Modelo abierto (Apache-2.0). Región: la del servidor que se configure (COMFYUI_DATA_REGION). Nadie entrena con lo que se envía. Adaptador sin probar contra un ComfyUI real.');

-- ───────────────────── 3. Seguimiento de los asíncronos ─────────────────────

-- Llama a `ai-media-poll` si hay trabajos de imagen pendientes. Devuelve el
-- identificador de la petición de pg_net, o null si no había nada que hacer o
-- falta configuración. SQL dinámico a propósito: así la función existe aunque
-- Vault o pg_net no estén (pruebas), y en ese caso no hace nada.
create function private.ai_media_poll_dispatch() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  if not exists (
    select 1 from public.jobs j
    where j.kind = 'ai.media.poll'
      and ((j.status = 'queued' and j.run_after <= now()) or (j.status = 'running' and j.locked_until < now()))
  ) then
    return null;
  end if;

  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    raise warning 'ai_media_poll_dispatch: faltan Vault o pg_net; no se llama a ai-media-poll';
    return null;
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'rrss_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'rrss_service_role_key';
  if v_url is null or v_key is null then
    raise warning 'ai_media_poll_dispatch: faltan los secretos rrss_project_url o rrss_service_role_key en Vault';
    return null;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_request
    using rtrim(v_url, '/') || '/functions/v1/ai-media-poll',
          jsonb_build_object('source', 'pg_cron'),
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
          60000;
  return v_request;
end $$;

revoke all on function private.ai_media_poll_dispatch() from public, anon, authenticated, service_role;

-- Programar la llamada, solo donde existen pg_cron y pg_net (Supabase, también
-- en el plan gratuito y en el stack local de la CLI). pg_cron en pg_catalog y
-- pg_net en extensions, como indica la documentación de Supabase.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    -- Mismo nombre = se actualiza la tarea, no se duplica.
    perform cron.schedule('rrss-ai-media-poll', '30 seconds', 'select private.ai_media_poll_dispatch()');
  else
    raise notice 'pg_cron o pg_net no están disponibles: no se programa el seguimiento de ai-media-poll';
  end if;
end
$do$;
