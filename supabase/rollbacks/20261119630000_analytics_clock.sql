-- Vuelta atrás de 20261119630000_analytics_clock.sql.
-- Quita el reloj de la analítica. No borra datos. Los trabajos de analítica que
-- hubiera en la cola quedan sin atender.
do $do$
declare
  v_scheduled boolean;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_scheduled using 'rrss-analytics';
    if v_scheduled then
      execute 'select cron.unschedule($1)' using 'rrss-analytics';
    end if;
  end if;
end
$do$;

drop function if exists private.analytics_dispatch();
