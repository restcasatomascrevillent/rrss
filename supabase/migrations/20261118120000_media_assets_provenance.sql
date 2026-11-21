-- Procedencia de los recursos de la biblioteca.
--
-- Una imagen exportada desde el editor se guarda en la biblioteca como un
-- recurso más; esta columna dice de dónde sale: de qué pieza y de qué versión
-- (y con qué opciones). Un recurso subido a mano la deja vacía.
--
-- Por qué una columna nueva y no `rights`: `rights` son los derechos de uso, que
-- la persona edita desde la ficha del recurso (y se reescriben enteros al
-- guardarla). La procedencia es un hecho del momento de crear el recurso: se
-- puede escribir al insertar y NO se puede cambiar después (sin privilegio de
-- UPDATE para el cliente).
--
-- Forma de la exportación (la valida la aplicación; aquí solo se exige un objeto
-- con `type`):
--   {"type": "export", "content_id": "<uuid>", "version": 3 | null,
--    "unsaved_changes": false, "format": "png", "width": 1080, "height": 1350,
--    "pixel_ratio": 1, "exported_at": "<ISO 8601>"}
-- `content_id` no es una clave foránea a propósito: la pieza puede borrarse y el
-- recurso debe conservar el dato de dónde salió. No se resuelve en la base de
-- datos, así que quien lo lee ha de comprobar que la pieza es de su marca.

alter table public.media_assets
  add column provenance jsonb not null default '{}'::jsonb,
  add constraint media_assets_provenance_shape check (
    jsonb_typeof(provenance) = 'object'
    and (provenance = '{}'::jsonb or coalesce(jsonb_typeof(provenance -> 'type') = 'string', false))
  );

-- Tamaño acotado: es un dato de procedencia, no un lugar donde guardar documentos.
alter table public.media_assets
  add constraint media_assets_provenance_size check (octet_length(provenance::text) <= 2048);

-- Recursos que salen de una pieza (para listarlos desde la propia pieza).
create index media_assets_provenance_content_idx
  on public.media_assets ((provenance ->> 'content_id'))
  where provenance ? 'content_id';

-- Solo se escribe al insertar (privilegio de columna). Sin UPDATE: inmutable para el cliente.
grant insert (provenance) on public.media_assets to authenticated;
