// Proveedores simulados de imagen y vídeo: SOLO para pruebas. No llaman a
// nadie, no cuestan nada y responden siempre lo mismo ante la misma petición.
//
// No son una «IA de demostración»: no deben configurarse nunca en un entorno
// que usen clientes (solo se cargan si el servidor lo pide a propósito, ver
// config.ts), y su salida se reconoce a simple vista.
import {
  MediaProviderFailure,
  type ImageEditOperation,
  type MediaModel,
  type MediaOutcome,
  type MediaProvider,
  type MediaRequest,
  type MediaStartRequest,
  type MediaStartResult,
  type MediaUsage,
  type ProviderJobRef,
  type WebhookEvent,
  type WebhookRequest,
} from './contract.ts';
import { megapixels } from './models.ts';

export const SIMULATED_IMAGE_PROVIDER_ID = 'simulated-image';
export const SIMULATED_VIDEO_PROVIDER_ID = 'simulated-video';

// ───────────────────────── Imagen de prueba (PNG) ─────────────────────────

/** FNV-1a de 32 bits: una huella estable de la petición, sin dependencias. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
  return [...u32(data.length), ...body, ...u32(crc32(Uint8Array.from(body)))];
}

/**
 * PNG válido de 8×8 de un solo color, que depende solo del texto dado: la
 * misma petición produce exactamente los mismos bytes.
 */
export function simulatedPng(seed: string): Uint8Array {
  return pngOf(seed, 8, false);
}

/**
 * PNG de prueba de una edición: con transparencia alrededor (quitar el fondo)
 * o más grande (ampliar). Igual de determinista que `simulatedPng`.
 */
export function simulatedEditPng(
  seed: string,
  operation: ImageEditOperation,
  source?: { width: number; height: number },
): Uint8Array {
  if (operation === 'remove_background') return pngOf(seed, 16, true);
  // Cambiar el fondo y mejorar conservan la proporción de la foto (como el proveedor real).
  if (
    (operation === 'replace_background' || operation === 'enhance') &&
    source &&
    source.width > 0 &&
    source.height > 0
  ) {
    return pngOf(seed, 32, false, Math.max(1, Math.round((32 * source.height) / source.width)));
  }
  return pngOf(seed, 32, false);
}

function pngOf(seed: string, size: number, cutout: boolean, rows = size): Uint8Array {
  const h = hash(seed);
  const [r, g, b] = [(h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
  const raw: number[] = [];
  for (let y = 0; y < rows; y += 1) {
    raw.push(0); // sin filtro
    for (let x = 0; x < size; x += 1) {
      if (!cutout) {
        raw.push(r, g, b);
        continue;
      }
      // «Recorte»: el centro opaco y un marco transparente, como una figura sin fondo.
      const inside = x >= size / 4 && x < (size * 3) / 4 && y >= size / 4 && y < (size * 3) / 4;
      raw.push(r, g, b, inside ? 255 : 0);
    }
  }
  // zlib con un único bloque sin comprimir.
  const zlib = [
    0x78,
    0x01,
    0x01,
    raw.length & 0xff,
    raw.length >>> 8,
    ~raw.length & 0xff,
    (~raw.length >>> 8) & 0xff,
    ...raw,
    ...u32(adler32(Uint8Array.from(raw))),
  ];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    // Tipo de color 2 (RGB) o 6 (RGB con alfa).
    ...chunk('IHDR', [...u32(size), ...u32(rows), 8, cutout ? 6 : 2, 0, 0, 0]),
    ...chunk('IDAT', zlib),
    ...chunk('IEND', []),
  ]);
}

function fingerprint(request: MediaRequest): string {
  if (request.kind === 'image_edit') {
    return `edit|${request.operation}|${request.source.url ?? ''}|${request.source.width}x${request.source.height}|${request.scale ?? 1}|${request.prompt ?? ''}|${request.subjectMask ? 'mask' : 'sin-mascara'}`;
  }
  if (request.kind === 'image') {
    return `image|${request.prompt}|${request.aspectRatio}|${request.size.width}x${request.size.height}|${request.references?.length ?? 0}`;
  }
  return `video|${request.prompt ?? ''}|${request.aspectRatio}|${request.durationSeconds}`;
}

// ───────────────────────────── Imagen ─────────────────────────────

export interface SimulatedOptions {
  /** Devuelve un fallo para que la llamada falle; `null` para que responda bien. */
  failWith?: (request: MediaStartRequest, callNumber: number) => Error | null;
  /** Retraso de la respuesta, para probar el tiempo máximo. */
  delayMs?: number;
}

export interface SimulatedProvider extends MediaProvider {
  /** Peticiones recibidas, en orden: las pruebas comprueban con esto que no se llamó. */
  readonly calls: MediaStartRequest[];
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new MediaProviderFailure('timeout', 'Petición cancelada', { retryable: true }));
    });
  });
}

function imageUsage(request: MediaRequest, model: MediaModel): MediaUsage {
  if (request.kind !== 'image') return {};
  if (model.billingUnit === 'megapixel') {
    return { megapixels: megapixels(request.size.width, request.size.height) };
  }
  return { images: 1 };
}

/** Imagen simulada, síncrona: devuelve un PNG de prueba determinista. */
export function createSimulatedImageProvider(options: SimulatedOptions = {}): SimulatedProvider {
  const calls: MediaStartRequest[] = [];
  return {
    id: SIMULATED_IMAGE_PROVIDER_ID,
    kinds: ['image'],
    testedAgainstRealService: false,
    calls,
    estimateUsage: imageUsage,

    async start(start): Promise<MediaStartResult> {
      calls.push(start);
      if (start.request.kind !== 'image') {
        throw new MediaProviderFailure('invalid_request', 'El proveedor simulado de imagen solo genera imágenes');
      }
      if (options.delayMs) await wait(options.delayMs, start.signal);
      const failure = options.failWith?.(start, calls.length);
      if (failure) throw failure;
      return {
        status: 'completed',
        outputs: [{ mimeType: 'image/png', bytes: simulatedPng(fingerprint(start.request)) }],
        usage: imageUsage(start.request, start.model),
        providerRequestId: `sim-image-${calls.length}`,
      };
    },
  };
}

// ───────────────────────────── Vídeo ─────────────────────────────

export interface SimulatedVideoOptions extends SimulatedOptions {
  /** Sondeos que responde «en curso» antes de terminar. `Infinity`: no termina nunca. Por defecto, 1. */
  pollsUntilDone?: number;
  /** Cómo acaba el trabajo. Por defecto, bien. */
  finishWith?: 'completed' | 'failed';
  /** Segundos que dice haber generado (por defecto, los pedidos). */
  reportSeconds?: number;
  /** Secreto con el que se «firman» sus webhooks de prueba. */
  webhookSecret?: string;
}

export interface SimulatedVideoProvider extends SimulatedProvider {
  /** Sondeos recibidos por cada trabajo. */
  readonly polls: Map<string, number>;
  readonly cancelled: string[];
  /** Webhook de prueba para un trabajo, listo para pasárselo al servicio. */
  webhookFor(jobId: string, status: 'completed' | 'failed'): WebhookRequest;
}

/**
 * Vídeo simulado, asíncrono: lanzar devuelve un identificador; sondear dice
 * «en curso» las veces configuradas y luego entrega un archivo de prueba (no
 * es un vídeo reproducible: son bytes deterministas con tipo genérico).
 */
export function createSimulatedVideoProvider(options: SimulatedVideoOptions = {}): SimulatedVideoProvider {
  const calls: MediaStartRequest[] = [];
  const polls = new Map<string, number>();
  const cancelled: string[] = [];
  const requests = new Map<string, MediaRequest>();
  const secret = options.webhookSecret ?? 'secreto-simulado';

  const finished = (jobId: string): MediaOutcome => {
    if (options.finishWith === 'failed') {
      return { status: 'failed', code: 'provider_error', message: 'El proveedor simulado ha fallado a propósito' };
    }
    const request = requests.get(jobId);
    const seconds = request?.kind === 'video' ? request.durationSeconds : 0;
    return {
      status: 'completed',
      outputs: [
        {
          mimeType: 'application/octet-stream',
          bytes: new TextEncoder().encode(`VIDEO SIMULADO ${request ? fingerprint(request) : jobId}`),
        },
      ],
      usage: { seconds: options.reportSeconds ?? seconds },
    };
  };

  return {
    id: SIMULATED_VIDEO_PROVIDER_ID,
    kinds: ['video'],
    testedAgainstRealService: false,
    calls,
    polls,
    cancelled,

    estimateUsage(request): MediaUsage {
      return request.kind === 'video' ? { seconds: request.durationSeconds } : {};
    },

    async start(start): Promise<MediaStartResult> {
      calls.push(start);
      if (start.request.kind !== 'video') {
        throw new MediaProviderFailure('invalid_request', 'El proveedor simulado de vídeo solo genera vídeo');
      }
      if (options.delayMs) await wait(options.delayMs, start.signal);
      const failure = options.failWith?.(start, calls.length);
      if (failure) throw failure;
      const id = `sim-video-${calls.length}`;
      requests.set(id, start.request);
      polls.set(id, 0);
      return { status: 'pending', job: { id } };
    },

    async poll(job: ProviderJobRef): Promise<MediaOutcome> {
      const count = (polls.get(job.id) ?? 0) + 1;
      polls.set(job.id, count);
      return count > (options.pollsUntilDone ?? 1) ? finished(job.id) : { status: 'pending' };
    },

    async cancel(job: ProviderJobRef): Promise<void> {
      cancelled.push(job.id);
    },

    async parseWebhook(request: WebhookRequest): Promise<WebhookEvent> {
      if (request.headers['x-simulated-signature'] !== secret) {
        throw new MediaProviderFailure('invalid_webhook', 'La firma del webhook simulado no es válida');
      }
      let body: { job_id?: unknown; status?: unknown };
      try {
        body = JSON.parse(request.rawBody) as typeof body;
      } catch {
        throw new MediaProviderFailure('invalid_webhook', 'El webhook simulado no es JSON');
      }
      if (typeof body.job_id !== 'string') {
        throw new MediaProviderFailure('invalid_webhook', 'El webhook simulado no dice de qué trabajo es');
      }
      const outcome: MediaOutcome =
        body.status === 'failed'
          ? { status: 'failed', code: 'provider_error', message: 'El proveedor simulado avisa de un fallo' }
          : body.status === 'completed'
            ? finished(body.job_id)
            : { status: 'pending' };
      return { providerJobId: body.job_id, outcome };
    },

    webhookFor(jobId, status): WebhookRequest {
      return {
        headers: { 'x-simulated-signature': secret },
        rawBody: JSON.stringify({ job_id: jobId, status }),
      };
    },
  };
}

// ───────────────────────── Imagen asíncrona ─────────────────────────

export const SIMULATED_IMAGE_ASYNC_PROVIDER_ID = 'simulated-image-async';

export interface SimulatedAsyncImageOptions {
  /** Tiempo hasta que el trabajo «termina». Por defecto, 2 s. */
  readyAfterMs?: number;
  now?: () => number;
}

/**
 * Imagen simulada ASÍNCRONA y SIN ESTADO: el identificador del trabajo lleva
 * el instante de inicio y la huella de la petición, así que cualquier instancia
 * de la función (la que lanza y la que sondea son distintas) sabe contestar.
 * Sirve para probar de extremo a extremo el seguimiento por sondeo.
 */
export function createSimulatedAsyncImageProvider(options: SimulatedAsyncImageOptions = {}): MediaProvider {
  const now = options.now ?? Date.now;
  const readyAfterMs = options.readyAfterMs ?? 2000;
  return {
    id: SIMULATED_IMAGE_ASYNC_PROVIDER_ID,
    kinds: ['image'],
    testedAgainstRealService: false,
    estimateUsage: imageUsage,

    async start(start): Promise<MediaStartResult> {
      if (start.request.kind !== 'image') {
        throw new MediaProviderFailure('invalid_request', 'El proveedor simulado de imagen solo genera imágenes');
      }
      const seed = hash(fingerprint(start.request)).toString(16);
      return { status: 'pending', job: { id: `simasync.${now()}.${seed}` } };
    },

    async poll(job: ProviderJobRef): Promise<MediaOutcome> {
      const [, startedAt, seed] = job.id.split('.');
      const started = Number(startedAt);
      if (!Number.isFinite(started) || !seed) {
        return { status: 'failed', code: 'bad_response', message: 'Trabajo simulado desconocido' };
      }
      if (now() - started < readyAfterMs) return { status: 'pending' };
      return {
        status: 'completed',
        outputs: [{ mimeType: 'image/png', bytes: simulatedPng(`async|${seed}`) }],
        usage: { images: 1 },
      };
    },

    async cancel(): Promise<void> {},
  };
}

// ───────────────────────── Edición de fotos ─────────────────────────

export const SIMULATED_IMAGE_EDIT_PROVIDER_ID = 'simulated-image-edit';

/**
 * Edición de fotos simulada, síncrona: «quita el fondo» o «amplía» sin mirar
 * la foto (no la descarga) y devuelve un PNG de prueba determinista. Sirve
 * para probar de punta a punta que el resultado es un recurso nuevo y que el
 * original no cambia.
 */
export function createSimulatedImageEditProvider(options: SimulatedOptions = {}): SimulatedProvider {
  const calls: MediaStartRequest[] = [];
  return {
    id: SIMULATED_IMAGE_EDIT_PROVIDER_ID,
    kinds: ['image'],
    edits: ['remove_background', 'upscale', 'replace_background', 'enhance'],
    subjectMaskEdits: ['replace_background'],
    testedAgainstRealService: false,
    calls,
    estimateUsage: (request): MediaUsage => (request.kind === 'image_edit' ? { images: 1 } : {}),

    async start(start): Promise<MediaStartResult> {
      calls.push(start);
      const { request } = start;
      if (request.kind !== 'image_edit') {
        throw new MediaProviderFailure('invalid_request', 'El proveedor simulado de edición solo edita fotos');
      }
      if (options.delayMs) await wait(options.delayMs, start.signal);
      const failure = options.failWith?.(start, calls.length);
      if (failure) throw failure;
      return {
        status: 'completed',
        outputs: [
          { mimeType: 'image/png', bytes: simulatedEditPng(fingerprint(request), request.operation, request.source) },
        ],
        usage: { images: 1 },
        providerRequestId: `sim-edit-${calls.length}`,
      };
    },
  };
}
