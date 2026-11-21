// Adaptador de texto: Anthropic por su API directa.
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL (no hay cuenta ni clave). Probado solo
// con respuestas HTTP simuladas. Fuente: documentación oficial consultada el
// 17/11/2026 (ver anthropic-messages.ts).
//
// ⚠ DATOS: la API directa NO procesa en la UE (`inference_geo` solo admite
// `us` o `global`). Por eso la configuración no la carga salvo que se acepte
// expresamente (ver text/config.ts).
import {
  AiProviderFailure,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResult,
  type AiUsage,
} from '../contract.ts';
import {
  ANTHROPIC_API_VERSION,
  buildMessagesBody,
  describeAnthropicError,
  parseMessagesResponse,
} from './anthropic-messages.ts';
import { field, postJson, tokenCount, type FetchLike } from './http.ts';
import { estimateTextUsage } from './prompt.ts';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';
const NAME = 'Anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export interface AnthropicProviderOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export interface AnthropicProvider extends AiProvider {
  /**
   * Recuento exacto de la entrada con el punto `count_tokens` del proveedor
   * (una llamada de red, sin coste de generación). El servicio no lo usa para
   * reservar: reserva con la cota local, que no depende de la red.
   */
  countInputTokens(request: AiProviderRequest): Promise<number>;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): AnthropicProvider {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = () => ({
    'content-type': 'application/json',
    'x-api-key': options.apiKey,
    'anthropic-version': ANTHROPIC_API_VERSION,
  });
  const call = (path: string, body: unknown, signal: AbortSignal) =>
    postJson({
      fetch: fetchFn,
      url: `${baseUrl}${path}`,
      headers: headers(),
      body,
      signal,
      providerName: NAME,
      secrets: [options.apiKey],
      describeError: describeAnthropicError,
    });

  return {
    id: ANTHROPIC_PROVIDER_ID,

    estimateUsage(request): AiUsage {
      return estimateTextUsage(request.input, { cacheWrites: true });
    },

    async generate(request): Promise<AiProviderResult> {
      if (request.task !== 'text') {
        throw new AiProviderFailure('unsupported_task', `El adaptador de ${NAME} solo sirve la tarea de texto`);
      }
      const response = await call('/v1/messages', buildMessagesBody(request), request.signal);
      return parseMessagesResponse(response.body, response.headers, NAME);
    },

    async countInputTokens(request): Promise<number> {
      const body = buildMessagesBody(request);
      delete body.max_tokens;
      const response = await call('/v1/messages/count_tokens', body, request.signal);
      const count = tokenCount(field(response.body, 'input_tokens'));
      if (count === null) throw new AiProviderFailure('bad_response', `${NAME} no ha devuelto el recuento de tokens`);
      return count;
    },
  };
}
