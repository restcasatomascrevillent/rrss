// Lógica de la Edge Function `ai-media-webhook`: recibe los avisos firmados de
// los proveedores de imagen y vídeo asíncronos.
//
//   POST /ai-media-webhook?provider=<adaptador>&generation=<uuid>
//
// No lleva sesión ni clave: lo que la autentica es la FIRMA del proveedor, que
// comprueba su adaptador (`parseWebhook`) antes de creer nada; y, además, el
// aviso tiene que ser del trabajo de esa generación. Aviso repetido o tardío →
// 200 sin hacer nada (el estado de la generación es el árbitro).
//
// Respuestas: 200 aceptado · 400 petición mal formada · 401 firma no válida o
// aviso que no casa · 404 proveedor sin webhooks o sin configurar · 500 no se
// pudo guardar (el proveedor reintenta; el sondeo es la red de seguridad).
import { AiError, AiProviderFailure } from '../_shared/ai/contract.ts';
import type { MediaService } from '../_shared/ai/media/contract.ts';

export interface AiMediaWebhookDeps {
  service(): Promise<MediaService>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BODY_BYTES = 1_000_000;

export function createAiMediaWebhookHandler(deps: AiMediaWebhookDeps): (request: Request) => Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  return async (request) => {
    if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    const url = new URL(request.url);
    const provider = url.searchParams.get('provider') ?? '';
    const generation = url.searchParams.get('generation') ?? '';
    if (!PROVIDER.test(provider) || !UUID.test(generation)) return json(400, { error: { code: 'invalid_request' } });

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: { code: 'too_large' } });
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    try {
      const service = await deps.service();
      const result = await service.handleWebhook(provider, generation, { headers, rawBody });
      deps.log?.('webhook', { provider, generation, status: result.status });
      return json(200, { status: result.status });
    } catch (error) {
      if (error instanceof AiError && error.code === 'not_configured') {
        deps.log?.('webhook_not_configured', { provider });
        return json(404, { error: { code: 'not_configured' } });
      }
      if (error instanceof AiProviderFailure && error.code === 'invalid_webhook') {
        deps.log?.('webhook_rejected', { provider, generation });
        return json(401, { error: { code: 'invalid_webhook' } });
      }
      deps.log?.('webhook_failed', { provider, generation });
      return json(500, { error: { code: 'internal' } });
    }
  };
}
