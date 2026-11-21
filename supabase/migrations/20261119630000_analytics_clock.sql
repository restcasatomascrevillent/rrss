-- Fase 5 · Analítica: el reloj (docs/analitica.md).
--
-- Cada hora, pg_cron llama a private.analytics_dispatch(), que:
--   1. encola la captura del día de cada cuenta viva de Instagram (una por
--      cuenta y día: la clave de idempotencia lleva el día, así que repetirlo
--      cada hora no duplica nada);
--   2. a partir del día 3 de cada mes, encola el informe del mes anterior de
--      cada marca con alguna cuenta social que aún no lo tenga;
--   3. si hay trabajos de analítica que atender, llama a la Edge Function
--      `social-insights` con pg_net (dirección y clave de servicio en Vault,
--      como el publicador; sin ellas no llama a nada y lo deja en el registro).
-- El PDF (`media.report.pdf`) lo dibuja el trabajador de medios, que vacía la
-- cola por su cuenta (worker/README.md).

create function private.analytics_dispatch() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_key text;
  v_request bigint;
begin
  perform public.analytics_enqueue_captures(null);
  if extract(day from now() at time zone 'UTC') >= 3 then
    perform public.analytics_enqueue_monthly_reports(null);
  end if;

  if not exists (
    select 1 from public.jobs j
    where j.kind in ('analytics.capture', 'analytics.report')
      and ((j.status = 'queued' and j.run_after <= now()) or (j.status = 'running' and j.locked_until < now()))
  ) then
    return null;
  end if;

  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    raise warning 'analytics_dispatch: faltan Vault o pg_net; no se llama a social-insights';
    return null;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'rrss_project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'rrss_service_role_key';
  if v_url is null or v_key is null then
    raise warning 'analytics_dispatch: faltan los secretos rrss_project_url o rrss_service_role_key en Vault';
    return null;
  end if;

  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
    into v_request
    using rtrim(v_url, '/') || '/functions/v1/social-insights',
          jsonb_build_object('source', 'pg_cron'),
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
          150000;
  return v_request;
end $$;

revoke all on function private.analytics_dispatch() from public, anon, authenticated, service_role;

-- Programar el reloj solo donde existen pg_cron y pg_net (Supabase y su stack
-- local). Mismo nombre = se actualiza la tarea, no se duplica. Minuto 17 de
-- cada hora, para no coincidir con otros relojes en punto.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('rrss-analytics', '17 * * * *', 'select private.analytics_dispatch()');
  else
    raise notice 'pg_cron o pg_net no están disponibles: no se programa la analítica';
  end if;
end
$do$;
