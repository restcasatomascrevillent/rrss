-- Vuelta atrás de 20261202010000_openai_image.sql.
--
-- DESTRUCTIVA en parte: borra los modelos de OpenAI del registro y los de las
-- ediciones nuevas (si se les cambió el precio, exportarlos antes). Las fotos
-- ya editadas se quedan en la biblioteca con su procedencia.

delete from public.ai_media_models where provider = 'openai' or operation in ('replace_background', 'enhance');

alter table public.ai_media_models drop constraint if exists ai_media_models_provider_model_operation_key;
alter table public.ai_media_models add constraint ai_media_models_provider_model_key unique (provider, model);

alter table public.ai_media_models drop constraint if exists ai_media_models_operation_check;
alter table public.ai_media_models
  add constraint ai_media_models_operation_check check (operation in ('generate', 'remove_background', 'upscale'));

comment on column public.ai_media_models.operation is
  'generate (crear una imagen o un vídeo) o una edición de foto: remove_background, upscale.';
