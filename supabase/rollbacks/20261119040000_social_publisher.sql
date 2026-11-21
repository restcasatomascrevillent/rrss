-- Vuelta atrás de 20261119040000_social_publisher.sql.
-- Quita el reloj del publicador y sus funciones. No borra datos: las
-- publicaciones y sus intentos se quedan (sus tablas son de 20261119030000).
-- Los trabajos `social.publish` que hubiera en la cola quedan sin atender.
do $do$
declare
  v_scheduled boolean;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1)' into v_scheduled using 'rrss-social-publish';
    if v_scheduled then
      execute 'select cron.unschedule($1)' using 'rrss-social-publish';
    end if;
  end if;
end
$do$;

drop function if exists private.social_publish_dispatch();
drop function if exists public.social_publication_defer(uuid, uuid, text, integer, boolean, text, text);
drop function if exists public.social_publication_fail(uuid, uuid, text, text, boolean);
drop function if exists public.social_publication_succeed(uuid, uuid, text, text, boolean);
drop function if exists public.social_publication_container(uuid, uuid, text);
drop function if exists public.social_publication_begin(uuid, uuid, integer);
drop function if exists public.social_enqueue_due_publications(integer);
drop function if exists private.publication_attempt_close(uuid, text, text, text, text, boolean);
drop function if exists private.publication_lock_for_job(uuid, uuid);
