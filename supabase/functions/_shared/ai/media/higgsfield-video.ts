// Adaptador de VÍDEO generativo: Higgsfield (API de pago por uso).
//
// SIN PROBAR CONTRA EL SERVICIO REAL: solo con respuestas HTTP simuladas.
// Escrito contra la documentación oficial (consultada el 17/11/2026):
//   · Base, autenticación y envío:        https://docs.higgsfield.ai/
//   · Ciclo de vida, cancelar:            https://docs.higgsfield.ai/docs/concepts/requests.md
//   · Estado de una petición:             https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status.md
//   · Webhooks (Standard Webhooks):       https://docs.higgsfield.ai/docs/how-to/webhooks.md
//   · Errores y reintentos:               https://docs.higgsfield.ai/docs/concepts/errors.md
//   · Límites (429 y `Retry-After`):      https://docs.higgsfield.ai/docs/concepts/rate-limits.md
//   · Un modelo de ejemplo (Kling 3.0 Standard, imagen a vídeo):
//     https://docs.higgsfield.ai/docs/models/kling-3/standard-image-to-video.md
//
//   POST https://api.higgsfield.ai/<endpoint del modelo>?hf_webhook=<url>
//     Authorization: Key <id>:<secreto> · Idempotency-Key: <clave>
//     → { status: "queued", request_id, status_url, cancel_url }
//   GET  status_url → { status: queued | in_progress | completed | failed | nsfw | canceled,
//                       video: { url }, error }
//   POST cancel_url → 202 (solo mientras está en cola)
//
// El modelo del registro (`ai_media_models.model`) es la ruta del endpoint,
// por ejemplo `kling-video/v3.0/std/image-to-video`. Los campos de la petición
// cambian de un modelo a otro («use the exact schema documented on the selected
// model page»): por eso van en los ajustes del modelo (`settings.fields` y
// `settings.static`), no aquí. Los valores por defecto son los de Kling 3.0
// Standard, que no tiene campo de proporción (la toma de la imagen).
//
// Higgsfield solo cobra las generaciones completadas; los archivos se guardan
// «al menos 7 días», así que el servicio los copia a nuestro almacenamiento.
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
  failureFromResponse,
  fromBase64,
  isRecord,
  isTrustedUrl,
  numberAt,
  request,
  stringAt,
  timingSafeEqual,
  type FetchLike,
} from './http.ts';

export const HIGGSFIELD_PROVIDER_ID = 'higgsfield';
const PROVIDER_NAME = 'Higgsfield';
const BASE_URL = 'https://api.higgsfield.ai';
const HOST = 'api.higgsfield.ai';
/** Margen que admite Standard Webhooks entre la firma y la recepción. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

const DEFAULT_FIELDS: Record<string, string> = { image: 'image_url', prompt: 'prompt', duration: 'duration' };

export interface HiggsfieldOptions {
  keyId: string;
  keySecret: string;
  /** Secreto de firma de webhooks (`whsec_…`). Sin él no se piden webhooks: solo sondeo. */
  webhookSecret?: string;
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

/** Traduce el estado de una petición (respuesta del sondeo o cuerpo del webhook). */
function outcomeOf(status: string | undefined, body: unknown, output: unknown): MediaOutcome {
  switch (status) {
    case 'queued':
    case 'in_progress':
      return { status: 'pending' };
    case 'completed': {
      const video = stringAt(output, 'video', 'url');
      if (video) {
        return {
          status: 'completed',
          outputs: [{ url: video, mimeType: stringAt(output, 'video', 'content_type') ?? '' }],
        };
      }
      const images = isRecord(output) && Array.isArray(output.images) ? output.images : [];
      const outputs = images.flatMap((image) => {
        const url = stringAt(image, 'url');
        return url ? [{ url, mimeType: stringAt(image, 'content_type') ?? '' }] : [];
      });
      if (outputs.length > 0) return { status: 'completed', outputs };
      return {
        status: 'failed',
        code: 'bad_response',
        message: `${PROVIDER_NAME} terminó sin entregar ningún archivo`,
      };
    }
    case 'nsfw':
      return {
        status: 'failed',
        code: 'moderated',
        message: `${PROVIDER_NAME} ha rechazado la entrada o el resultado por su moderación de contenido`,
      };
    case 'canceled':
      return { status: 'failed', code: 'canceled', message: `La petición a ${PROVIDER_NAME} se canceló` };
    case 'failed': {
      const detail = (stringAt(body, 'error') ?? '').replace(/\s+/g, ' ').slice(0, 200);
      return {
        status: 'failed',
        code: 'provider_error',
        message: `${PROVIDER_NAME} no ha podido generar el vídeo${detail ? `: ${detail}` : ''}`,
      };
    }
    default:
      // Estado que la documentación no lista: se sigue consultando.
      return { status: 'pending' };
  }
}

export function createHiggsfieldVideoProvider(options: HiggsfieldOptions): MediaProvider {
  const now = options.now ?? Date.now;
  const http = { fetch: options.fetch, provider: PROVIDER_NAME, timeoutMs: options.timeoutMs ?? 30_000 };
  const auth = { Authorization: `Key ${options.keyId}:${options.keySecret}` };

  /** Errores con significado propio en Higgsfield antes de la traducción genérica. */
  function failure(response: Response, body: unknown): MediaProviderFailure {
    if (response.status === 403) {
      return new MediaProviderFailure('insufficient_credits', `${PROVIDER_NAME} no tiene saldo suficiente (HTTP 403)`);
    }
    if (response.status === 423) {
      return new MediaProviderFailure(
        'provider_unavailable',
        `${PROVIDER_NAME} tiene el modelo bloqueado temporalmente`,
        {
          retryable: true,
        },
      );
    }
    const generic = failureFromResponse(PROVIDER_NAME, response, body);
    if (response.status === 429 && generic.retryAfterSeconds === undefined) {
      const seconds = numberAt(body, 'retry_after_seconds') ?? numberAt(body, 'detail', 'retry_after_seconds');
      if (seconds !== undefined) {
        return new MediaProviderFailure('rate_limited', generic.message, {
          retryable: true,
          retryAfterSeconds: seconds,
        });
      }
    }
    return generic;
  }

  const provider: MediaProvider = {
    id: HIGGSFIELD_PROVIDER_ID,
    kinds: ['video'],
    testedAgainstRealService: false,

    estimateUsage(mediaRequest): MediaUsage {
      return mediaRequest.kind === 'video' ? { seconds: mediaRequest.durationSeconds } : {};
    },

    async start({
      request: media,
      model,
      idempotencyKey,
      webhookUrl,
      signal,
    }: MediaStartRequest): Promise<MediaStartResult> {
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
      if (fields.duration) body[fields.duration] = media.durationSeconds;
      if (fields.aspect_ratio) body[fields.aspect_ratio] = media.aspectRatio;

      // Solo se pide webhook si se va a poder comprobar su firma.
      const query = webhookUrl && options.webhookSecret ? `?hf_webhook=${encodeURIComponent(webhookUrl)}` : '';
      const { response, body: answer } = await request(
        `${BASE_URL}/${model.model}${query}`,
        {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(body),
        },
        { ...http, signal },
      );
      if (!response.ok) throw failure(response, answer);

      const id = stringAt(answer, 'request_id');
      if (!id)
        throw new MediaProviderFailure(
          'bad_response',
          `${PROVIDER_NAME} no ha devuelto el identificador de la petición`,
        );
      return {
        status: 'pending',
        job: { id, statusUrl: stringAt(answer, 'status_url'), cancelUrl: stringAt(answer, 'cancel_url') },
      };
    },

    async poll(job: ProviderJobRef, _model, signal): Promise<MediaOutcome> {
      // La documentación pide usar la URL devuelta; solo se usa si es de su dominio
      // (la clave no se envía a ningún otro sitio).
      const url = isTrustedUrl(job.statusUrl, [HOST])
        ? job.statusUrl
        : `${BASE_URL}/requests/${encodeURIComponent(job.id)}/status`;
      const { response, body } = await request(url, { method: 'GET', headers: auth }, { ...http, signal });
      if (!response.ok) throw failure(response, body);
      return outcomeOf(stringAt(body, 'status'), body, body);
    },

    async cancel(job: ProviderJobRef, signal): Promise<void> {
      const url = isTrustedUrl(job.cancelUrl, [HOST])
        ? job.cancelUrl
        : `${BASE_URL}/requests/${encodeURIComponent(job.id)}/cancel`;
      // 202 si estaba en cola; 400 si ya había empezado. En ambos casos no hay nada más que hacer.
      await request(url, { method: 'POST', headers: auth }, { ...http, signal }).catch(() => undefined);
    },
  };

  if (!options.webhookSecret) return provider;
  const secret = options.webhookSecret;

  return {
    ...provider,

    /**
     * Standard Webhooks: cabeceras `webhook-id`, `webhook-timestamp` y
     * `webhook-signature` (una o varias `v1,<base64>`); se firma
     * `<id>.<timestamp>.<cuerpo>` con HMAC-SHA256 y el secreto sin `whsec_`.
     */
    async parseWebhook(webhook: WebhookRequest): Promise<WebhookEvent> {
      const invalid = (why: string) =>
        new MediaProviderFailure('invalid_webhook', `Webhook de ${PROVIDER_NAME} no válido: ${why}`);
      const id = webhook.headers['webhook-id'];
      const timestamp = webhook.headers['webhook-timestamp'];
      const signatures = webhook.headers['webhook-signature'];
      if (!id || !timestamp || !signatures) throw invalid('faltan cabeceras de firma');
      const seconds = Number(timestamp);
      if (!Number.isFinite(seconds) || Math.abs(now() / 1000 - seconds) > WEBHOOK_TOLERANCE_SECONDS) {
        throw invalid('la marca de tiempo está fuera del margen');
      }

      let keyBytes: Uint8Array;
      try {
        keyBytes = fromBase64(secret.replace(/^whsec_/, ''));
      } catch {
        throw invalid('el secreto configurado no tiene el formato esperado');
      }
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const expected = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${webhook.rawBody}`)),
      );
      const matches = signatures.split(' ').some((entry) => {
        const [version, value] = entry.split(',');
        if (version !== 'v1' || !value) return false;
        try {
          return timingSafeEqual(fromBase64(value), expected);
        } catch {
          return false;
        }
      });
      if (!matches) throw invalid('la firma no coincide');

      let body: unknown;
      try {
        body = JSON.parse(webhook.rawBody);
      } catch {
        throw invalid('el cuerpo no es JSON');
      }
      const requestId = stringAt(body, 'request_id');
      if (!requestId) throw invalid('no dice de qué petición es');
      return {
        providerJobId: requestId,
        outcome: outcomeOf(stringAt(body, 'status'), body, isRecord(body) ? body.payload : null),
      };
    },
  };
}
