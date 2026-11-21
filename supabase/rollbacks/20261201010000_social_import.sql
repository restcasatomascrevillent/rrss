-- Vuelta atrás de 20261201010000_social_import.sql. Borra las publicaciones
-- importadas, las importaciones y las plantillas de diseño de las marcas. Los
-- recursos que se copiaron a la biblioteca NO se tocan (son recursos normales,
-- con su procedencia); se borran desde la biblioteca como cualquier otro.
drop function if exists public.social_import_end_step(uuid, text, integer, boolean);
drop function if exists public.social_import_mark_copy(uuid, uuid, text, text);
drop function if exists public.social_import_register_copy(uuid, uuid, uuid, jsonb);
drop function if exists public.social_import_check_space(uuid, bigint);
drop function if exists public.social_import_pending_copies(uuid, integer);
drop function if exists public.social_import_save_page(uuid, jsonb, text, text);
drop function if exists public.social_import_claim(uuid, uuid, integer);
drop function if exists public.deliver_design_templates(uuid, jsonb);
drop function if exists public.delete_design_template(uuid);
drop function if exists public.social_import_pause(uuid);
drop function if exists public.social_import_begin(uuid, boolean);
drop table if exists public.brand_design_templates;
drop table if exists public.social_imported_media;
drop table if exists public.social_import_runs;
