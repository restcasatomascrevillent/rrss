// Adaptador de IMAGEN: modelos de imagen de Google (Gemini) por Vertex AI.
//
// SIN PROBAR CONTRA EL SERVICIO REAL: solo con respuestas HTTP simuladas.
// Escrito contra la documentación oficial (consultada el 17/11/2026):
//   · Generación de imágenes (petición REST, modelos, `responseModalities`,
//     `imageConfig.aspectRatio`):
//     https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/image-generation
//   · Referencia de generateContent (`contents[].parts[].inlineData`,
//     `finishReason`, `usageMetadata`):
//     https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
//   · Regiones y multirregión UE (`https://aiplatform.eu.rep.googleapis.com`,
//     `locations/eu`):
//     https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations
//
// Síncrono: una petición, una imagen en la respuesta (en base64).
//
// Pendiente de confirmar con una llamada real:
//   · Que la respuesta REST trae la imagen en `inlineData` (la página solo lo
//     enseña en los ejemplos de SDK; en REST enseña la entrega a Cloud Storage).
//   · `imageConfig.imageSize`: no aparece en la página de Vertex. Solo se envía
//     si el modelo lo trae en sus ajustes del registro (`settings.image_size`).
//   · Qué modelos de imagen están de verdad en la multirregión UE.
import {
  MediaProviderFailure,
  type DataRegion,
  type MediaInput,
  type MediaOutputRef,
  type MediaProvider,
  type MediaStartRequest,
  type MediaStartResult,
  type MediaUsage,
} from './contract.ts';
import { download, fromBase64, isRecord, requestJson, stringAt, toBase64, type FetchLike } from './http.ts';

export const VERTEX_IMAGE_PROVIDER_ID = 'google-vertex';
const PROVIDER_NAME = 'Vertex AI';
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

export interface VertexImageOptions {
  projectId: string;
  /** `eu` (multirregión UE, por defecto), `us`, `global` o una región (`europe-west4`…). */
  location?: string;
  /** Token de acceso de Google Cloud (ver google-auth.ts). */
  getAccessToken: (signal?: AbortSignal) => Promise<string>;
  fetch: FetchLike;
  /** Tiempo máximo de la llamada. Por defecto, 120 s. */
  timeoutMs?: number;
}

/** Host de Vertex AI para cada ubicación, según la página de regiones. */
export function vertexHost(location: string): string {
  if (location === 'global') return 'https://aiplatform.googleapis.com';
  if (location === 'eu' || location === 'us') return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

function regionOfLocation(location: string): DataRegion {
  if (location === 'eu' || location.startsWith('europe-')) return 'eu';
  if (location === 'us' || location.startsWith('us-')) return 'us';
  if (location === 'global') return 'global';
  return 'unknown';
}

/** Motivos de fin que significan «bloqueado por las políticas de contenido». */
const BLOCKED = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/;

export function createVertexImageProvider(options: VertexImageOptions): MediaProvider {
  const location = options.location ?? 'eu';
  if (!/^[a-z0-9-]+$/.test(location) || !/^[a-z0-9:.-]+$/i.test(options.projectId)) {
    throw new Error('Configuración de Vertex AI no válida: revisa el proyecto y la ubicación');
  }
  const http = { fetch: options.fetch, provider: PROVIDER_NAME, timeoutMs: options.timeoutMs ?? 120_000 };

  async function inlinePart(input: MediaInput, signal: AbortSignal) {
    let bytes = input.bytes;
    if (!bytes) {
      if (!input.url) throw new MediaProviderFailure('invalid_request', 'Una imagen de referencia no tiene contenido');
      bytes = (await download(input.url, { ...http, timeoutMs: 30_000, signal, maxBytes: MAX_REFERENCE_BYTES })).bytes;
    }
    return { inlineData: { mimeType: input.mimeType, data: toBase64(bytes) } };
  }

  return {
    id: VERTEX_IMAGE_PROVIDER_ID,
    kinds: ['image'],
    testedAgainstRealService: false,
    dataRegion: regionOfLocation(location),

    estimateUsage(): MediaUsage {
      return { images: 1 };
    },

    async start({ request, model, signal }: MediaStartRequest): Promise<MediaStartResult> {
      if (request.kind !== 'image') {
        throw new MediaProviderFailure('invalid_request', `${PROVIDER_NAME} solo está preparado para imagen`);
      }
      if (!/^[a-z0-9][a-z0-9.-]*$/i.test(model.model)) {
        throw new MediaProviderFailure('invalid_request', 'El nombre del modelo de Vertex AI no es válido');
      }
      const parts: unknown[] = [];
      for (const reference of request.references ?? []) parts.push(await inlinePart(reference, signal));
      parts.push({ text: request.prompt });

      const imageConfig: Record<string, string> = { aspectRatio: request.aspectRatio };
      if (typeof model.settings.image_size === 'string') imageConfig.imageSize = model.settings.image_size;

      const token = await options.getAccessToken(signal);
      const url =
        `${vertexHost(location)}/v1/projects/${options.projectId}/locations/${location}` +
        `/publishers/google/models/${model.model}:generateContent`;
      const body = await requestJson(
        url,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
          }),
        },
        { ...http, signal },
      );

      const candidates = isRecord(body) && Array.isArray(body.candidates) ? body.candidates : [];
      const outputs: MediaOutputRef[] = [];
      let finishReason = '';
      for (const candidate of candidates) {
        finishReason ||= stringAt(candidate, 'finishReason') ?? '';
        const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : {};
        for (const part of Array.isArray(content.parts) ? content.parts : []) {
          const data = stringAt(part, 'inlineData', 'data');
          if (data) {
            outputs.push({
              mimeType: stringAt(part, 'inlineData', 'mimeType') ?? 'image/png',
              bytes: fromBase64(data),
            });
          }
        }
      }

      if (outputs.length === 0) {
        const reason = finishReason || stringAt(body, 'promptFeedback', 'blockReason') || '';
        if (BLOCKED.test(reason)) {
          throw new MediaProviderFailure(
            'moderated',
            `${PROVIDER_NAME} ha bloqueado la petición por su política de contenido`,
          );
        }
        throw new MediaProviderFailure(
          'bad_response',
          `${PROVIDER_NAME} no ha devuelto ninguna imagen${reason ? ` (${reason.slice(0, 60)})` : ''}`,
        );
      }
      return {
        status: 'completed',
        outputs,
        usage: { images: outputs.length },
        providerRequestId: stringAt(body, 'responseId'),
      };
    },
  };
}
