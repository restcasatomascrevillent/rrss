-- OpenAI como proveedor de IMAGEN (GPT Image): generar, cambiar el fondo,
-- mejorar luz y color, y quitar el fondo (docs/ia-medios.md, §OpenAI).
--
--   1. Dos ediciones nuevas de foto: `replace_background` y `enhance`.
--   2. Un mismo modelo puede servir a varias operaciones (el de OpenAI sirve a
--      tres): la unicidad pasa de (proveedor, modelo) a (proveedor, modelo,
--      operación).
--   3. Modelos de OpenAI sembrados. El precio de OpenAI es por TOKENS, no por
--      imagen: aquí es una cota prudente por megapíxel de salida y de entrada
--      (documentada en price_source), y se cobra la cota reservada. Fuente:
--      developers.openai.com/api/docs/pricing, consultada el 20/11/2026
--      (imagen: 8 USD entrada y 30 USD salida por millón de tokens).
--
-- Los modelos nacen INACTIVOS y con el precio sin verificar (como todo el
-- registro): quien administra la plataforma los activa tras contrastar la
-- cota con su panel de OpenAI. Además solo se usan si hay OPENAI_API_KEY en
-- «Plataforma → Integraciones» (sin clave, el adaptador no se carga) y, al
-- procesar fuera de la UE, si se permite con AI_MEDIA_ALLOW_NON_EU=true.

-- ─────────────────────── 1. Operaciones nuevas ───────────────────────

alter table public.ai_media_models drop constraint ai_media_models_operation_check;
alter table public.ai_media_models
  add constraint ai_media_models_operation_check
    check (operation in ('generate', 'remove_background', 'upscale', 'replace_background', 'enhance'));

comment on column public.ai_media_models.operation is
  'generate (crear una imagen o un vídeo) o una edición de foto: remove_background, upscale, replace_background, enhance.';

-- ─────────────────────── 2. Un modelo, varias operaciones ───────────────────────

alter table public.ai_media_models drop constraint ai_media_models_provider_model_key;
alter table public.ai_media_models
  add constraint ai_media_models_provider_model_operation_key unique (provider, model, operation);

-- ─────────────────────── 3. Modelos de OpenAI ───────────────────────

insert into public.ai_media_models
  (provider, model, task, operation, display_name, billing_unit, price_micros, price_details, price_checked_on,
   price_source, price_verified, data_region, trains_on_inputs, delivery, settings, priority, active, notes)
select 'openai', v.model, 'image', v.operation, v.display_name, 'megapixel', 70000,
  '{"first_unit_micros": 73000, "input_megapixel_micros": 14000}'::jsonb, '2026-11-20',
  'COTA por megapíxel derivada de los precios por tokens de developers.openai.com/api/docs/pricing (20/11/2026): imagen 8 USD entrada / 30 USD salida por millón de tokens, calidad media. OpenAI no cobra por imagen: el gasto real sale en su panel de uso.',
  false, 'global', 'no', 'sync',
  '{"quality": "medium", "output_format": "jpeg", "size_mode": "custom", "max_input_megapixels": 4}'::jsonb,
  v.priority, false, v.notes
from (values
  ('gpt-image-2.5-flare', 'generate', 'Generar imagen · GPT Image 2.5 Flare (OpenAI)', 0,
   'Modelo rápido para generar. Procesa fuera de la UE salvo proyecto con región Europa (OPENAI_BASE_URL=https://eu.api.openai.com). Según OpenAI, no entrena con datos de la API por defecto; confirmar en la cuenta. Adaptador sin probar contra OpenAI real.'),
  ('gpt-image-2.5-sunburst', 'replace_background', 'Cambiar el fondo · GPT Image 2.5 Sunburst (OpenAI)', 0,
   'Modelo de mayor precisión de edición. La máscara del sujeto es orientativa: no garantiza que el plato quede intacto. Adaptador sin probar contra OpenAI real.'),
  ('gpt-image-2.5-sunburst', 'enhance', 'Mejorar luz y color · GPT Image 2.5 Sunburst (OpenAI)', 0,
   'Retoca con IA: puede cambiar detalles del plato. Adaptador sin probar contra OpenAI real.'),
  ('gpt-image-2.5-sunburst', 'remove_background', 'Quitar el fondo · GPT Image 2.5 Sunburst (OpenAI)', -10,
   'Fondo transparente (PNG). Prioridad baja: si hay un modelo propio para quitar el fondo, gana ese. Adaptador sin probar contra OpenAI real.')
) as v(model, operation, display_name, priority, notes);
