-- Edición de fotos bajo demanda (docs/edicion-fotos.md).
--
-- Lo que se hace SIN IA (recortes por red, luz, color, nitidez, poner un fondo
-- liso o de la biblioteca) lo hace el navegador y lo guarda como un recurso
-- nuevo con procedencia `type: 'photo_edit'`. Lo que necesita IA (quitar el
-- fondo, ampliar) va por `ai-media` con los modelos del registro, el cupo y el
-- coste de siempre, y el resultado es un recurso nuevo con `type: 'ai_edit'`.
-- En los dos casos la foto original NO se toca nunca.
--
--   1. `ai_media_models.operation`: qué hace cada modelo (generar o una
--      edición). Un modelo de edición nunca se elige para generar.
--   2. Dos modelos de ComfyUI propio, INACTIVOS y con el precio sin verificar:
--      quitar el fondo (BiRefNet) y ampliar (Real-ESRGAN ×4).
--   3. Procedencia de las ediciones: `ai_edit` solo la escribe el servidor; en
--      las dos, el original (`source_asset_id`) tiene que ser un recurso de la
--      misma marca. Índice para listar las ediciones de una foto.
--
-- Sin tablas nuevas: el registro de cada edición con IA es su fila de
-- `ai_generations` (cupo y coste por organización, como cualquier imagen) y la
-- relación con el original vive en la procedencia del recurso.

-- ─────────────────────── 1. Qué hace cada modelo ───────────────────────

alter table public.ai_media_models
  add column operation text not null default 'generate',
  add constraint ai_media_models_operation_check
    check (operation in ('generate', 'remove_background', 'upscale')),
  -- Las ediciones de foto producen imágenes.
  add constraint ai_media_models_edit_is_image check (operation = 'generate' or task = 'image');

comment on column public.ai_media_models.operation is
  'generate (crear una imagen o un vídeo) o una edición de foto: remove_background, upscale.';

grant update (operation) on public.ai_media_models to authenticated;

-- ─────────────────── 2. Modelos de ComfyUI propio (inactivos) ───────────────────

insert into public.ai_media_models
  (provider, model, task, operation, display_name, billing_unit, price_micros, price_details, price_checked_on,
   price_source, price_verified, data_region, trains_on_inputs, delivery, settings, notes)
values
  ('comfyui', 'birefnet-general', 'image', 'remove_background', 'Quitar el fondo · BiRefNet (servidor ComfyUI propio)',
   'image', 0, '{}', '2026-11-20',
   'Sin tarifa de proveedor: el coste es el de la GPU donde corra el servidor. Fijarlo al elegirla.',
   false, 'unknown', 'no', 'async',
   '{"rmbg_class_type": "BiRefNetRMBG", "rmbg_inputs": {"model": "BiRefNet-general"}, "rmbg_image_input": "image", "rmbg_mask_output": 1, "rmbg_mask_is_foreground": true, "max_input_pixels": 36000000}',
   'Modelo abierto BiRefNet (MIT) con el nodo personalizado de ComfyUI-RMBG (GPL-3.0, se ejecuta en el servidor de ComfyUI). Nombres del nodo sin contrastar: comprobar con /object_info. Nadie entrena con lo que se envía.'),
  ('comfyui', 'realesrgan-x4plus', 'image', 'upscale', 'Ampliar · Real-ESRGAN ×4 (servidor ComfyUI propio)',
   'image', 0, '{}', '2026-11-20',
   'Sin tarifa de proveedor: el coste es el de la GPU donde corra el servidor. Fijarlo al elegirla.',
   false, 'unknown', 'no', 'async',
   '{"upscale_model_name": "RealESRGAN_x4plus.pth", "max_output_side": 4096, "max_input_pixels": 36000000}',
   'Real-ESRGAN x4plus (BSD-3-Clause) con nodos del núcleo de ComfyUI. Adaptador sin probar contra un ComfyUI real. Nadie entrena con lo que se envía.');

-- ─────────────────────── 3. Procedencia de las ediciones ───────────────────────

-- `ai_edit`: solo el servidor (como `ai_generation`): nadie hace pasar una foto
-- suya por editada con IA. En `ai_edit` y `photo_edit`, el original tiene que
-- ser un recurso de la misma marca: no se puede decir que una foto sale de la
-- de otra marca u organización. No es clave foránea a propósito: si el
-- original se borra, la edición conserva de dónde salió.
--
-- Sin SECURITY DEFINER a propósito: `current_user` tiene que ser quien inserta
-- (no el dueño de la función), y el original se busca con su RLS, así que una
-- foto que esa persona no ve tampoco vale como original.
create function private.media_assets_edit_provenance_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_type text := new.provenance ->> 'type';
  v_source text := new.provenance ->> 'source_asset_id';
begin
  if v_type is null or v_type not in ('ai_edit', 'photo_edit') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.provenance is not distinct from old.provenance then
    return new;
  end if;
  if v_type = 'ai_edit' and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'Solo el servidor puede registrar una foto editada con IA' using errcode = '42501';
  end if;
  if v_source is null
     or v_source !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (
       select 1 from public.media_assets a where a.id = v_source::uuid and a.brand_id = new.brand_id
     ) then
    raise exception 'La foto original no existe o no es de esta marca' using errcode = '23503';
  end if;
  if v_source::uuid = new.id then
    raise exception 'Una edición no puede salir de sí misma' using errcode = '23514';
  end if;
  return new;
end $$;

revoke all on function private.media_assets_edit_provenance_guard() from public, anon, authenticated;

create trigger media_assets_edit_provenance_guard before insert or update on public.media_assets
  for each row execute function private.media_assets_edit_provenance_guard();

-- Ediciones de una foto (para listarlas desde su ficha).
create index media_assets_provenance_source_idx on public.media_assets ((provenance ->> 'source_asset_id'))
  where provenance ? 'source_asset_id';
