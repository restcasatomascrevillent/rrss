-- Vuelta atrás de 20261210010000_worker_gateway.sql.
-- Quita las funciones de `worker-gateway`, el contador de llamadas y el ajuste
-- WORKER_GATEWAY_TOKEN (con su secreto de Vault). Después de deshacerla, el
-- trabajador solo puede funcionar con la clave de servicio
-- (WORKER_SUPABASE_ACCESS=service-key), que en Fly no arranca: hay que
-- desplegar antes una versión del trabajador sin el gateway o pararlo. Los
-- trabajos que estuvieran en curso con el gateway caducan y se vuelven a
-- reclamar.
drop function if exists public.worker_gateway_authorize_path(text, text, uuid, text, boolean);
drop function if exists public.worker_gateway_extend(text, text, uuid, integer);
drop function if exists public.worker_gateway_release(text, text, uuid);
drop function if exists public.worker_gateway_fail(text, text, uuid, text, boolean);
drop function if exists public.worker_gateway_complete(text, text, uuid, jsonb);
drop function if exists public.worker_gateway_claim(text, text, text[], integer, integer);
drop function if exists private.worker_gateway_identity(text, text);
drop table if exists private.worker_gateway_calls;

drop trigger if exists integration_settings_worker_gateway_guard on private.integration_settings;
drop function if exists private.worker_gateway_setting_guard();

do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets vs
    where vs.id in (
      select s.vault_secret_id from private.integration_settings s
      where s.setting_key = 'WORKER_GATEWAY_TOKEN' and s.vault_secret_id is not null
    );
  end if;
end $$;

-- El ajuste cae en cascada con su clave del catálogo.
delete from private.integration_setting_keys where setting_key = 'WORKER_GATEWAY_TOKEN';
