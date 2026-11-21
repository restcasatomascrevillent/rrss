-- Vuelta atrás de 20261130010000_publish_now.sql. No toca datos: lo que se
-- publicó o se programó con «Publicar ahora» queda como cualquier otra
-- publicación (el reloj sigue procesándola).
drop function if exists public.publication_publish_kick(uuid);
drop function if exists public.publish_publication_now(uuid, uuid, uuid[], integer, uuid);
drop function if exists private.publication_enqueue_now(public.scheduled_publications);
