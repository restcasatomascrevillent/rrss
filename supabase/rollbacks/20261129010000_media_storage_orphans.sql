-- Vuelta atrás de 20261129010000_media_storage_orphans.sql.
do $do$
declare
  v_scheduled boolean;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_scheduled using 'rrss-media-orphans';
    if v_scheduled then
      execute 'select cron.unschedule($1)' using 'rrss-media-orphans';
    end if;
  end if;
end
$do$;

drop function if exists private.media_storage_orphans_dispatch();
drop function if exists public.media_storage_orphans(uuid, text[], interval, integer);
