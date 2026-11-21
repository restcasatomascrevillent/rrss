-- Vuelta atrás de 20261119113000_request_notifications.sql.
-- DESTRUCTIVA: elimina los avisos de encargos (leídos y sin leer).
drop function if exists public.mark_request_notifications_read(uuid, uuid);
drop trigger if exists content_requests_notify on public.content_requests;
drop function if exists private.content_requests_notify();
drop function if exists private.brand_editor_ids(uuid);
drop table if exists public.request_notifications;
