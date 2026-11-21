// Adaptador de VÍDEO generativo: fal.ai (agregador, API de cola).
//
// SIN PROBAR CONTRA EL SERVICIO REAL: solo con respuestas HTTP simuladas.
// Escrito contra la documentación oficial (consultada el 17/11/2026):
//   · Cola (enviar, estado, resultado, cancelar, `fal_webhook`):
//     https://fal.ai/docs/model-apis/model-endpoints/queue
//   · Webhooks (cuerpo, reintentos y firma ED25519 con JWKS):
//     https://fal.ai/docs/documentation/model-apis/inference/webhooks.md
//
//   POST https://queue.fal.run/<modelo>?fal_webhook=<url>   (Authorization: Key <clave>)
//     → { request_id, status_url, response_url, cancel_url }
//   GET  status_url   → { status: IN_QUEUE | IN_PROGRESS | COMPLETED, error?, error_type? }
//   GET  response_url → salida del modelo (en los de vídeo, `video.url`)
//   PUT  cancel_url
//
// El modelo del registro (`ai_media_models.model`) es la ruta del endpoint en
// fal. Los campos de entrada y de salida dependen del modelo (unos piden
// `image_url` y otros `start_image_url`; la duración es número en unos y texto
// en otros), así que van en los ajustes del modelo:
//   settings.fields              nombres de los campos (por defecto image_url,
//                                prompt, duration, aspect_ratio)
//   settings.duration_as_string  enviar la duración como texto
//   settings.static              campos fijos añadidos a la petición
//   settings.output_path         dónde está la URL del resultado (por defecto video.url)
// Hay que contrastarlos con la ficha de cada modelo antes de activarlo.
//
// Aviso: fal no garantiza región UE y, con modelos de terceros, el contenido
// pasa a ese tercero (docs/investigacion-fase2/02-imagen.md, §3).
import {
  MediaProviderFailure,
  type MediaModel,
  type MediaOutcome,
  type MediaProvider,
  type MediaStartRequest,
  type MediaStartResult,
  type MediaUsage,
  type ProviderJobRef,
  type WebhookEvent,
  type WebhookRequest,
} from './contract.ts';
import {
  fromBase64,
  fromHex,
  isRecord,
  isTrustedUrl,
  request,
  requestJson,
  stringAt,
  toHex,
  type FetchLike,
} from './http.ts';

export const FAL_PROVIDER_ID = 'fal';
const PROVIDER_NAME = 'fal.ai';
const QUEUE_URL = 'https://queue.fal.run';
const TRUSTED_HOSTS = ['queue.fal.run'];
const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
/** La documentación pide no guardar las claves públicas más de 24 horas. */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_TOLERANCE_SECONDS = 300;

const DEFAULT_FIELDS: Record<string, string> = {
  image: 'image_url',
  prompt: 'prompt',
  duration: 'duration',
  aspect_ratio: 'aspect_ratio',
};

export interface FalOptions {
  apiKey: string;
  fetch: FetchLike;
  /** Tiempo máximo de cada llamada. Por defecto, 30 s. */
  timeoutMs?: number;
  now?: () => number;
}

function fieldsOf(model: MediaModel): Record<string, string> {
  const custom = model.settings.fields;
  if (!isRecord(custom)) return DEFAULT_FIELDS;
  const fields: Record<string, string> = {};
  for (const [key, name] of Object.entries(custom)) if (typeof name === 'string' && name) fields[key] = name;
  return fields;
}

/** Busca la URL del resultado en la salida del modelo. */
function outputUrl(output: unknown, model: MediaModel | undefined): string | undefined {
  const path = typeof model?.settings.output_path === 'string' ? model.settings.output_path : 'video.url';
  return stringAt(output, ...path.split('.'));
}

function completed(output: unknown, model: MediaModel | undefined): MediaOutcome {
  const url = outputUrl(output, model);
  if (!url)
    return { status: 'failed', code: 'bad_response', message: `${PROVIDER_NAME} terminó sin entregar el vídeo` };
  return { status: 'completed', outputs: [{ url, mimeType: stringAt(output, 'video', 'content_type') ?? '' }] };
}

function failed(detail: string | undefined): MediaOutcome {
  const brief = (detail ?? '').replace(/\s+/g, ' ').slice(0, 200);
  return {
    status: 'failed',
    code: 'provider_error',
    message: `${PROVIDER_NAME} no ha podido generar el vídeo${brief ? `: ${brief}` : ''}`,
  };
}

export function createFalVideoProvider(options: FalOptions): MediaProvider {
  const now = options.now ?? Date.now;
  const http = { fetch: options.fetch, provider: PROVIDER_NAME, timeoutMs: options.timeoutMs ?? 30_000 };
  const auth = { Authorization: `Key ${options.apiKey}` };
  let jwks: { keys: Uint8Array[]; fetchedAt: number } | null = null;

  async function publicKeys(): Promise<Uint8Array[]> {
    if (jwks && now() - jwks.fetchedAt < JWKS_TTL_MS) return jwks.keys;
    const body = await requestJson(JWKS_URL, { method: 'GET' }, http);
    const keys: Uint8Array[] = [];
    for (const key of isRecord(body) && Array.isArray(body.keys) ? body.keys : []) {
      const x = stringAt(key, 'x');
      if (x) keys.push(fromBase64(x));
    }
    jwks = { keys, fetchedAt: now() };
    return keys;
  }

  return {
    id: FAL_PROVIDER_ID,
    kinds: ['video'],
    testedAgainstRealService: false,

    estimateUsage(mediaRequest): MediaUsage {
      return mediaRequest.kind === 'video' ? { seconds: mediaRequest.durationSeconds } : {};
    },

    async start({ request: media, model, webhookUrl, signal }: MediaStartRequest): Promise<MediaStartResult> {
      if (media.kind !== 'video') {
        throw new MediaProviderFailure(
          'invalid_request',
          `El adaptador de ${PROVIDER_NAME} solo está preparado para vídeo`,
        );
      }
      if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(model.model) || model.model.includes('..')) {
        throw new MediaProviderFailure('invalid_request', `El endpoint del modelo de ${PROVIDER_NAME} no es válido`);
      }
      if (!media.startImage.url) {
        throw new MediaProviderFailure(
          'invalid_request',
          `${PROVIDER_NAME} necesita la imagen inicial como dirección pública (una URL firmada)`,
        );
      }
      const fields = fieldsOf(model);
      const body: Record<string, unknown> = isRecord(model.settings.static) ? { ...model.settings.static } : {};
      if (fields.image) body[fields.image] = media.startImage.url;
      if (fields.prompt && media.prompt) body[fields.prompt] = media.prompt;
      if (fields.duration) {
        body[fields.duration] =
          model.settings.duration_as_string === true ? String(media.durationSeconds) : media.durationSeconds;
      }
      if (fields.aspect_ratio) body[fields.aspect_ratio] = media.aspectRatio;

      const query = webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : '';
      const answer = await requestJson(
        `${QUEUE_URL}/${model.model}${query}`,
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        { ...http, signal },
      );
      const id = stringAt(answer, 'request_id');
      const statusUrl = stringAt(answer, 'status_url');
      const resultUrl = stringAt(answer, 'response_url');
      // Las URL de consulta no llevan la ruta completa del modelo: se usan las devueltas.
      if (!id || !isTrustedUrl(statusUrl, TRUSTED_HOSTS) || !isTrustedUrl(resultUrl, TRUSTED_HOSTS)) {
        throw new MediaProviderFailure('bad_response', `${PROVIDER_NAME} no ha devuelto las direcciones de consulta`);
      }
      return { status: 'pending', job: { id, statusUrl, resultUrl, cancelUrl: stringAt(answer, 'cancel_url') } };
    },

    async poll(job: ProviderJobRef, model, signal): Promise<MediaOutcome> {
      if (!isTrustedUrl(job.statusUrl, TRUSTED_HOSTS) || !isTrustedUrl(job.resultUrl, TRUSTED_HOSTS)) {
        return {
          status: 'failed',
          code: 'bad_response',
          message: `Faltan las direcciones de consulta de ${PROVIDER_NAME}`,
        };
      }
      const status = await requestJson(job.statusUrl, { method: 'GET', headers: auth }, { ...http, signal });
      if (stringAt(status, 'status') !== 'COMPLETED') return { status: 'pending' };
      // «COMPLETED» también cubre los trabajos que terminaron con error.
      const error = stringAt(status, 'error');
      if (error) return failed(stringAt(status, 'error_type') ?? error);

      const result = await request(job.resultUrl, { method: 'GET', headers: auth }, { ...http, signal });
      if (!result.response.ok) {
        if (result.response.status === 429 || result.response.status >= 500) {
          throw new MediaProviderFailure(
            'provider_unavailable',
            `${PROVIDER_NAME} no ha entregado el resultado todavía`,
            {
              retryable: true,
            },
          );
        }
        return failed(`HTTP ${result.response.status}`);
      }
      return completed(result.body, model);
    },

    async cancel(job: ProviderJobRef, signal): Promise<void> {
      if (!isTrustedUrl(job.cancelUrl, TRUSTED_HOSTS)) return;
      await request(job.cancelUrl, { method: 'PUT', headers: auth }, { ...http, signal }).catch(() => undefined);
    },

    /**
     * Firma ED25519: se firma `request-id \n user-id \n timestamp \n sha256(cuerpo)`
     * (el hash en hexadecimal) y la firma llega en hexadecimal. Las claves
     * públicas se publican en un JWKS. Margen de ±300 s.
     */
    async parseWebhook(webhook: WebhookRequest): Promise<WebhookEvent> {
      const invalid = (why: string) =>
        new MediaProviderFailure('invalid_webhook', `Webhook de ${PROVIDER_NAME} no válido: ${why}`);
      const requestId = webhook.headers['x-fal-webhook-request-id'];
      const userId = webhook.headers['x-fal-webhook-user-id'];
      const timestamp = webhook.headers['x-fal-webhook-timestamp'];
      const signature = fromHex(webhook.headers['x-fal-webhook-signature'] ?? '');
      if (!requestId || !userId || !timestamp || !signature) throw invalid('faltan cabeceras de firma');
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(now() / 1000 - seconds) > WEBHOOK_TOLERANCE_SECONDS) {
        throw invalid('la marca de tiempo está fuera del margen');
      }

      const raw = new TextEncoder().encode(webhook.rawBody);
      const bodyHash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
      const message = new TextEncoder().encode([requestId, userId, timestamp, bodyHash].join('\n'));
      let verified = false;
      for (const key of await publicKeys()) {
        try {
          const publicKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
          if (await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, message)) {
            verified = true;
            break;
          }
        } catch {
          // Clave con un formato que no se entiende: se prueba la siguiente.
        }
      }
      if (!verified) throw invalid('la firma no coincide');

      let body: unknown;
      try {
        body = JSON.parse(webhook.rawBody);
      } catch {
        throw invalid('el cuerpo no es JSON');
      }
      const id = stringAt(body, 'request_id');
      if (!id) throw invalid('no dice de qué petición es');
      const status = stringAt(body, 'status');
      if (status === 'ERROR') return { providerJobId: id, outcome: failed(stringAt(body, 'error')) };
      const payload = isRecord(body) ? body.payload : null;
      // Sin `payload` (no se pudo serializar): el resultado se recoge por sondeo.
      if (status !== 'OK' || !isRecord(payload)) return { providerJobId: id, outcome: { status: 'pending' } };
      // El modelo no viaja en el aviso: solo se conoce la ruta de salida por
      // defecto. Si el resultado no está ahí, lo recoge el sondeo, que sí sabe
      // qué modelo es.
      if (!outputUrl(payload, undefined)) return { providerJobId: id, outcome: { status: 'pending' } };
      return { providerJobId: id, outcome: completed(payload, undefined) };
    },
  };
}
