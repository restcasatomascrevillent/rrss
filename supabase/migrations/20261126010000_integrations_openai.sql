-- Plataforma → Integraciones: OpenAI como proveedor de la IA de texto.
--
--   * OPENAI_API_KEY (secreto, en Vault), OPENAI_BASE_URL (para la residencia en
--     la UE: https://eu.api.openai.com), y, opcionales, OPENAI_ORGANIZATION y
--     OPENAI_PROJECT. Pertenecen a la integración `ai_text`; los proveedores y
--     modelos por tarea (AI_TEXT_*_PROVIDER / _MODEL) ya existen y admiten
--     «openai» como valor (la validación del valor vive en las funciones).
--   * El catálogo `private.integration_setting_keys` es el que manda: lo que no
--     está aquí no se puede guardar. No hay restricción nueva que ampliar en las
--     tablas: la integración no cambia, solo se añaden ajustes.
--
-- Los mismos nombres están en supabase/functions/_shared/integrations/catalog.ts
-- y en la pantalla (src/features/platform/integrations/catalog.ts); una prueba
-- comprueba que coinciden. Vuelta atrás en supabase/rollbacks/.

insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  ('OPENAI_API_KEY', 'ai_text', true),
  ('OPENAI_BASE_URL', 'ai_text', false),
  ('OPENAI_ORGANIZATION', 'ai_text', false),
  ('OPENAI_PROJECT', 'ai_text', false);
