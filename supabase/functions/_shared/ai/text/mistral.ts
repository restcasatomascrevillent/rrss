// Adaptador de texto: Mistral (La Plateforme).
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL (no hay cuenta ni clave). Probado solo
// con respuestas HTTP simuladas. Fuentes (consultadas el 17/11/2026):
//   https://docs.mistral.ai/api/endpoint/chat
//   https://docs.mistral.ai/openapi.yaml  (esquemas JsonSchema, UsageInfo, ChatCompletionChoice)
//   https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching
//
// Lo que dice la documentación y aquí se aplica:
//   * `POST https://api.mistral.ai/v1/chat/completions` con `Authorization: Bearer`.
//   * Salida estructurada: `response_format: { type: "json_schema", json_schema:
//     { name, schema, strict } }`; el JSON llega como texto en
//     `choices[0].message.content`.
//   * Caché de prompts: no hay marcas en el contenido. Se orienta con
//     `prompt_cache_key` (aumenta la probabilidad de acierto, no lo garantiza) y
//     funciona por prefijo en bloques de 64 tokens: por eso el material estable
//     va primero. Los tokens leídos de caché vienen en
//     `usage.prompt_tokens_details.cached_tokens`, están INCLUIDOS en
//     `prompt_tokens` y se facturan al 10 % de la entrada. No hay recargo por
//     escribir en la caché.
//
// Sin confirmar en la documentación consultada: la forma del cuerpo de los
// errores que no son 422, qué modelos admiten `strict`, la duración de la
// caché y dónde se procesan los datos (ver docs/ia-texto.md).
import {
  AiProviderFailure,
  type AiFinishReason,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResult,
  type AiUsage,
} from '../contract.ts';
import { toProviderSchema } from '../schema.ts';
import { field, postJson, tokenCount, type FetchLike } from './http.ts';
import { estimateTextUsage, maxOutputTokens, orderedContext, renderContextPart, TEXT_UNITS } from './prompt.ts';

export const MISTRAL_PROVIDER_ID = 'mistral';
const NAME = 'Mistral';
const DEFAULT_BASE_URL = 'https://api.mistral.ai';

export interface MistralProviderOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export function buildChatBody(request: Omit<AiProviderRequest, 'signal'>): Record<string, unknown> {
  const { input } = request;
  const { cacheable, volatile } = orderedContext(input);
  const user = [...cacheable, ...volatile].map(renderContextPart).concat(input.prompt).join('\n\n');

  const messages: { role: string; content: string }[] = [];
  if (input.instructions) messages.push({ role: 'system', content: input.instructions });
  messages.push({ role: 'user', content: user });

  const body: Record<string, unknown> = { model: request.model, messages, max_tokens: maxOutputTokens(input) };
  if (input.outputSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: input.outputSchema.name,
        schema: toProviderSchema(input.outputSchema.schema),
        strict: true,
      },
    };
  }
  if (input.cacheKey && cacheable.length > 0) body.prompt_cache_key = input.cacheKey;
  return body;
}

function finishReason(value: unknown): AiFinishReason {
  if (value === 'stop') return 'stop';
  if (value === 'length' || value === 'model_length') return 'length';
  return 'other';
}

/** `content` puede ser texto o una lista de fragmentos `{ type: "text", text }`. */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((chunk) => field(chunk, 'type') === 'text' && typeof field(chunk, 'text') === 'string')
    .map((chunk) => field(chunk, 'text') as string)
    .join('');
}

export function parseChatResponse(body: unknown): AiProviderResult {
  const choices = field(body, 'choices');
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const text = messageText(field(field(choice, 'message'), 'content'));
  const usage = field(body, 'usage');
  const prompt = tokenCount(field(usage, 'prompt_tokens'));
  const completion = tokenCount(field(usage, 'completion_tokens'));
  if (text === null || prompt === null || completion === null) {
    throw new AiProviderFailure('bad_response', `${NAME} ha devuelto una respuesta sin contenido o sin consumo`);
  }
  if (field(choice, 'finish_reason') === 'error') {
    throw new AiProviderFailure('provider_error', `${NAME} ha terminado la respuesta con un error`, { retryable: true });
  }

  const cached = Math.min(tokenCount(field(field(usage, 'prompt_tokens_details'), 'cached_tokens')) ?? 0, prompt);
  const result: AiProviderResult = {
    output: { text, finish_reason: finishReason(field(choice, 'finish_reason')) },
    usage: {
      [TEXT_UNITS.input]: prompt - cached,
      [TEXT_UNITS.output]: completion,
      [TEXT_UNITS.cacheRead]: cached,
    },
  };
  const id = field(body, 'id');
  if (typeof id === 'string' && id) result.providerRequestId = id;
  return result;
}

/** 422: `{ detail: [{ loc, msg, type }] }` (sin `input`, que repite lo enviado). Otros: `message`. */
export function describeMistralError(body: unknown): string | undefined {
  const detail = field(body, 'detail');
  if (Array.isArray(detail)) {
    const first: unknown = detail[0];
    const loc = field(first, 'loc');
    const msg = field(first, 'msg');
    const where = Array.isArray(loc) ? loc.filter((part) => typeof part !== 'object').join('.') : '';
    if (typeof msg === 'string') return where ? `${where}: ${msg}` : msg;
  }
  if (typeof detail === 'string') return detail;
  const message = field(body, 'message') ?? field(field(body, 'error'), 'message');
  return typeof message === 'string' ? message : undefined;
}

export function createMistralProvider(options: MistralProviderOptions): AiProvider {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    id: MISTRAL_PROVIDER_ID,

    estimateUsage(request): AiUsage {
      return estimateTextUsage(request.input, { cacheWrites: false });
    },

    async generate(request): Promise<AiProviderResult> {
      if (request.task !== 'text') {
        throw new AiProviderFailure('unsupported_task', `El adaptador de ${NAME} solo sirve la tarea de texto`);
      }
      const response = await postJson({
        fetch: fetchFn,
        url: `${baseUrl}/v1/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: buildChatBody(request),
        signal: request.signal,
        providerName: NAME,
        secrets: [options.apiKey],
        describeError: describeMistralError,
      });
      return parseChatResponse(response.body);
    },
  };
}
