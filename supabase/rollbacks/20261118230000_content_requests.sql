-- Vuelta atrás de 20261118230000_content_requests.sql.
-- DESTRUCTIVA: elimina todos los encargos y su conversación, y el modo de IA de
-- cada marca. En un entorno con datos hay que exportar antes `content_requests`,
-- `content_request_comments` y `brands.ai_mode`. Las piezas entregadas se quedan.
drop function if exists public.cancel_content_request(uuid, text);
drop function if exists public.accept_content_request(uuid);
drop function if exists public.request_content_request_changes(uuid, text);
drop function if exists public.deliver_content_request(uuid, jsonb, integer, text, text, text);
drop function if exists public.release_content_request(uuid, text);
drop function if exists public.take_content_request(uuid, text, integer);
drop function if exists public.pending_content_requests();
drop function if exists public.comment_content_request(uuid, text);
drop function if exists public.create_content_request(uuid, text, text, text, text, text, uuid[], date, uuid);

drop function if exists private.content_request_claimed_by_other(public.content_requests, text);
drop function if exists private.content_request_lock(uuid, text, text);
drop function if exists private.content_request_log(public.content_requests, text, public.content_request_status, text);

drop table if exists public.content_request_comments, public.content_requests cascade;

drop type if exists public.content_request_status;

alter table if exists public.brands drop column if exists ai_mode;
