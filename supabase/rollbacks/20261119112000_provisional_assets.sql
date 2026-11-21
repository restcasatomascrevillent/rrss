-- Vuelta atrás de 20261119112000_provisional_assets.sql. Los recursos que
-- estuvieran marcados como provisionales se quedan como recursos normales.

do $do$
declare
  v_scheduled boolean;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_scheduled
      using 'rrss-purge-provisional-assets';
    if v_scheduled then
      execute 'select cron.unschedule($1)' using 'rrss-purge-provisional-assets';
    end if;
  end if;
end
$do$;

drop function if exists private.purge_provisional_assets(integer);
drop trigger if exists brand_profiles_settle_logos on public.brand_profiles;
drop function if exists private.brand_profiles_settle_logos();
drop trigger if exists media_assets_provisional on public.media_assets;
drop function if exists private.media_assets_provisional();
drop index if exists public.media_assets_provisional_idx;
alter table public.media_assets drop column if exists provisional_until;
