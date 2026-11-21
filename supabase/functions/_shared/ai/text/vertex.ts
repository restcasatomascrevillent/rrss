// Adaptador de texto: Claude (Anthropic) por Google Cloud Vertex AI, en la
// multirregión de la UE.
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL (no hay cuenta de Google Cloud). Probado
// solo con respuestas HTTP simuladas. Fuentes (consultadas el 17/11/2026):
//   https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai
//   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude
//
// Lo que dice la documentación y aquí se aplica:
//   * Multirregión UE: host `aiplatform.eu.rep.googleapis.com` y `locations/eu`
//     («las peticiones van a cualquier región de la Unión Europea»). Una región
//     suelta usa `{región}-aiplatform.googleapis.com`, pero los puntos
//     regionales solo sirven Claude Sonnet 4.6 y anteriores: para los modelos
//     actuales, la multirregión. Multirregión y regional cuestan un 10 % más
//     que el punto global (tenerlo en cuenta en la tabla de precios).
//   * Ruta `/v1/projects/{proyecto}/locations/{ubicación}/publishers/anthropic/models/{modelo}:rawPredict`.
//   * El cuerpo es el de la API de mensajes de Anthropic con dos diferencias:
//     el modelo va en la URL (no en el cuerpo) y la versión va en el cuerpo
//     como `anthropic_version` (`vertex-2023-10-16` o `2026-10-21`).
//   * Los modelos actuales usan su identificador sin prefijo ni fecha; los
//     anteriores a 4.6 llevan `@fecha`. El nombre exacto es configuración.
//   * Salida estructurada y caché de prompts figuran como admitidas.
//   * Autenticación `Authorization: Bearer <token OAuth>`. Aquí el token sale
//     de una cuenta de servicio (google-auth.ts), sin SDK ni `gcloud`.
//
// Sin confirmar en la documentación consultada: la forma exacta del cuerpo de
// los errores (se leen tanto la de Google como la de Anthropic) y la cabecera
// con el identificador de la petición.
import {
  AiProviderFailure,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResult,
  type AiUsage,
} from '../contract.ts';
import { ANTHROPIC_API_VERSION, buildMessagesBody, parseMessagesResponse } from './anthropic-messages.ts';
import { createGoogleTokenSource, type ServiceAccountKey } from './google-auth.ts';
import { field, postJson, type FetchLike } from './http.ts';
import { estimateTextUsage } from './prompt.ts';

export const VERTEX_PROVIDER_ID = 'anthropic-vertex';
const NAME = 'Vertex AI';

export interface VertexProviderOptions {
  projectId: string;
  /** `eu` (multirregión de la UE, lo recomendado) o una región `europe-…`. */
  location: string;
  serviceAccount: ServiceAccountKey;
  fetch?: FetchLike;
  now?: () => Date;
  /** Permite ubicaciones fuera de la UE (`global`, `us`, otras regiones). Por defecto, no. */
  allowOutsideEu?: boolean;
}

/** Motivo por el que una ubicación sacaría los datos de la UE, o `null`. */
export function vertexEuProblem(location: string): string | null {
  if (location === 'eu' || /^europe-[a-z]+\d+$/.test(location)) return null;
  return `la ubicación «${location}» no está en la UE (usa «eu» o una región «europe-…»)`;
}

/** Host del punto de entrada según la ubicación (global, multirregión o región). */
export function vertexHost(location: string): string {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (location === 'eu' || location === 'us') return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

/** Google: `{ error: { code, message, status } }`. Anthropic: `{ error: { type, message } }`. */
export function describeVertexError(body: unknown): string | undefined {
  const error = field(body, 'error');
  const kind = field(error, 'status') ?? field(error, 'type');
  const message = field(error, 'message');
  const parts = [kind, message].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join(': ') : undefined;
}

export function createVertexProvider(options: VertexProviderOptions): AiProvider {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const accessToken = createGoogleTokenSource({ key: options.serviceAccount, fetch: fetchFn, now: options.now });
  const base = `https://${vertexHost(options.location)}/v1/projects/${encodeURIComponent(options.projectId)}/locations/${encodeURIComponent(options.location)}/publishers/anthropic/models`;

  return {
    id: VERTEX_PROVIDER_ID,

    estimateUsage(request): AiUsage {
      return estimateTextUsage(request.input, { cacheWrites: true });
    },

    async generate(request: AiProviderRequest): Promise<AiProviderResult> {
      if (request.task !== 'text') {
        throw new AiProviderFailure('unsupported_task', `El adaptador de ${NAME} solo sirve la tarea de texto`);
      }
      if (!options.allowOutsideEu) {
        const problem = vertexEuProblem(options.location);
        if (problem) throw new AiProviderFailure('eu_residency', `${NAME} no se usa: ${problem}`);
      }

      // Mismo cuerpo que la API de Anthropic, sin `model` y con la versión dentro.
      const messages = buildMessagesBody(request);
      delete messages.model;
      const body = { anthropic_version: ANTHROPIC_API_VERSION, ...messages };
      const token = await accessToken(request.signal);

      const response = await postJson({
        fetch: fetchFn,
        url: `${base}/${encodeURIComponent(request.model)}:rawPredict`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
        signal: request.signal,
        providerName: NAME,
        secrets: [token],
        describeError: describeVertexError,
      });
      return parseMessagesResponse(response.body, response.headers, NAME);
    },
  };
}
