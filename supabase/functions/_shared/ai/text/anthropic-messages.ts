// Formato de la API de mensajes de Anthropic (`POST …/v1/messages`), común a la
// API directa (anthropic.ts) y a Amazon Bedrock (bedrock.ts), que la sirve con
// el mismo cuerpo.
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL. Escrito contra la documentación oficial
// consultada el 17/11/2026 y probado solo con respuestas HTTP simuladas:
//   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
//
// Decisiones:
//   * Las instrucciones del producto van en `system`; el material del cliente,
//     delimitado, en el turno de usuario. Nunca se mezclan.
//   * Caché de prompts: el material estable (perfil de marca) va primero y su
//     último bloque lleva `cache_control`. El prefijo que se guarda es
//     instrucciones + perfil; lo que cambia (el encargo) va detrás. Si el
//     prefijo no llega al mínimo del modelo, el proveedor no lo guarda y no
//     avisa: se ve en `cache_write_input_tokens = 0`.
//   * Salida estructurada con `output_config.format` (JSON Schema). Un rechazo
//     (`stop_reason: "refusal"`) o un corte (`max_tokens`) no garantizan el
//     esquema: se devuelven tal cual y el servicio valida.
//   * No se envían `temperature`, `top_p` ni `top_k`: la versión de API
//     2026-10-21 los rechaza. Tampoco `thinking`: cada modelo usa su valor por
//     defecto, y el razonamiento se factura como salida dentro de `max_tokens`.
import { AiProviderFailure, type AiFinishReason, type AiProviderRequest, type AiProviderResult } from '../contract.ts';
import { toProviderSchema } from '../schema.ts';
import { field, tokenCount } from './http.ts';
import { maxOutputTokens, orderedContext, renderContextPart, TEXT_UNITS } from './prompt.ts';

/** Versión de la API que se declara en la cabecera `anthropic-version`. */
export const ANTHROPIC_API_VERSION = '2026-10-21';

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export function buildMessagesBody(request: Omit<AiProviderRequest, 'signal'>): Record<string, unknown> {
  const { input } = request;
  const { cacheable, volatile } = orderedContext(input);

  const content: TextBlock[] = cacheable.map((part) => ({ type: 'text', text: renderContextPart(part) }));
  const lastStable = content[content.length - 1];
  if (lastStable) lastStable.cache_control = { type: 'ephemeral' };
  for (const part of volatile) content.push({ type: 'text', text: renderContextPart(part) });
  content.push({ type: 'text', text: input.prompt });

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: maxOutputTokens(input),
    messages: [{ role: 'user', content }],
  };
  if (input.instructions) body.system = [{ type: 'text', text: input.instructions }];

  const outputConfig: Record<string, unknown> = {};
  if (input.outputSchema) {
    outputConfig.format = { type: 'json_schema', schema: toProviderSchema(input.outputSchema.schema) };
  }
  const effort = input.params?.effort;
  if (typeof effort === 'string' && EFFORT_LEVELS.has(effort)) outputConfig.effort = effort;
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

  return body;
}

function finishReason(stopReason: unknown): AiFinishReason {
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'refusal') return 'refusal';
  return 'other';
}

/** Convierte la respuesta 200 de la API de mensajes en el resultado del contrato. */
export function parseMessagesResponse(body: unknown, headers: Headers, providerName: string): AiProviderResult {
  const blocks = field(body, 'content');
  const usage = field(body, 'usage');
  const input = tokenCount(field(usage, 'input_tokens'));
  const output = tokenCount(field(usage, 'output_tokens'));
  if (!Array.isArray(blocks) || input === null || output === null) {
    throw new AiProviderFailure('bad_response', `${providerName} ha devuelto una respuesta sin contenido o sin consumo`);
  }

  // El razonamiento (`thinking`) y cualquier otro bloque se ignoran: solo texto.
  const text = blocks
    .filter((block) => field(block, 'type') === 'text' && typeof field(block, 'text') === 'string')
    .map((block) => field(block, 'text') as string)
    .join('');

  const result: AiProviderResult = {
    output: { text, finish_reason: finishReason(field(body, 'stop_reason')) },
    usage: {
      [TEXT_UNITS.input]: input,
      [TEXT_UNITS.output]: output,
      // Ausentes = 0: la entrada sin caché ya viene aparte en `input_tokens`.
      [TEXT_UNITS.cacheWrite]: tokenCount(field(usage, 'cache_creation_input_tokens')) ?? 0,
      [TEXT_UNITS.cacheRead]: tokenCount(field(usage, 'cache_read_input_tokens')) ?? 0,
    },
  };
  const requestId = headers.get('request-id') ?? field(body, 'id');
  if (typeof requestId === 'string' && requestId) result.providerRequestId = requestId;
  return result;
}

/** `{"type":"error","error":{"type":"…","message":"…"}}` → «tipo: mensaje». */
export function describeAnthropicError(body: unknown): string | undefined {
  const error = field(body, 'error');
  const type = field(error, 'type');
  const message = field(error, 'message');
  const parts = [type, message].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join(': ') : undefined;
}
