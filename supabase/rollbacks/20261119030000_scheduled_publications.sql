-- Vuelta atrás de 20261119030000_scheduled_publications.sql.
-- DESTRUCTIVA: borra el calendario (publicaciones programadas, también las ya
-- publicadas con su identificador y enlace de la red) y el registro de intentos.
-- Exportar antes `scheduled_publications` y `publication_attempts` si hay datos.
-- Lo publicado en la red sigue publicado.
drop function if exists public.retry_publication(uuid);
drop function if exists public.cancel_publication(uuid);
drop function if exists public.reschedule_publication(uuid, timestamptz);
drop function if exists public.save_publication(uuid, uuid, timestamptz, uuid, uuid[], integer);

drop trigger if exists media_assets_publications_refresh on public.media_assets;
drop trigger if exists social_accounts_publications_refresh on public.social_accounts;
drop trigger if exists content_items_publications_refresh on public.content_items;

drop table if exists public.publication_attempts cascade;
drop table if exists public.scheduled_publications cascade;

drop function if exists private.publication_lock_for_edit(uuid);
drop function if exists private.media_assets_publications_refresh();
drop function if exists private.social_accounts_publications_refresh();
drop function if exists private.content_items_publications_refresh();
drop function if exists private.scheduled_publications_guard();
drop function if exists private.publication_refresh(uuid, uuid, uuid);
drop function if exists private.publication_media_problem(uuid, uuid, integer, text, uuid[]);
drop function if exists private.publication_format_supported(text, text);

drop type if exists public.publication_status;
