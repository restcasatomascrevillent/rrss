-- Vuelta atrás de 20261117100000_content_items_versions.sql.
-- DESTRUCTIVA: elimina todos los contenidos y todas sus versiones. En un
-- entorno con datos hay que exportar antes `content_items` y `content_versions`.
drop function if exists public.archive_content_item(uuid, boolean);
drop function if exists public.set_content_status(uuid, public.content_status, integer);
drop function if exists public.restore_content_version(uuid, integer, text, integer);
drop function if exists public.save_content_version(uuid, jsonb, integer, text, integer);

drop table if exists public.content_versions, public.content_items cascade;

drop function if exists private.content_write_version(uuid, jsonb, integer, text, integer, integer);
drop function if exists private.content_items_retarget();

drop type if exists public.content_status;
