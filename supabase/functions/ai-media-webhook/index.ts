// Edge Function `ai-media-webhook`: avisos firmados de los proveedores de
// imagen y vídeo asíncronos. Sin sesión: la autentica la firma de cada
// proveedor (handler.ts). En config.toml lleva `verify_jwt = false`: los
// proveedores no mandan un JWT de Supabase.
//
// Su dirección pública es la que se pone en AI_MEDIA_WEBHOOK_BASE_URL:
//   https://<proyecto>.supabase.co/functions/v1/ai-media-webhook
import { createAiMediaWebhookHandler } from './handler.ts';
import { checkConfiguration, loadRuntime } from '../ai-media/setup.ts';

checkConfiguration('ai-media-webhook');

const handler = createAiMediaWebhookHandler({
  service: async () => (await loadRuntime()).serviceFor(),
  log: (event, data) => console.error(`[ai-media-webhook] ${event}`, JSON.stringify(data)),
});

Deno.serve(handler);
