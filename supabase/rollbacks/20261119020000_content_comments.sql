-- Vuelta atrás de 20261119020000_content_comments.sql.
-- DESTRUCTIVA: borra los comentarios de las piezas y el registro de sus
-- aprobaciones (exportar antes `content_comments` si hay datos). Las piezas y
-- su estado no cambian.
drop function if exists public.approve_content_items(jsonb);
drop function if exists public.request_content_changes(uuid, text);
drop function if exists public.comment_content_item(uuid, text, integer);

drop trigger if exists content_items_approval_log on public.content_items;
drop function if exists private.content_items_approval_log();

drop table if exists public.content_comments cascade;
