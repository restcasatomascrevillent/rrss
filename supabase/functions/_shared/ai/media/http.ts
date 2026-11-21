// Utilidades HTTP comunes a los adaptadores: `fetch` puro, con tiempo máximo y
// con los errores de cada proveedor traducidos a `MediaProviderFailure`.
//
// Regla: el mensaje de un fallo se guarda en el registro de generaciones, así
// que NUNCA lleva la URL (puede ir firmada), cabeceras ni el cuerpo enviado.
import { MediaProviderFailure } from './contract.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch: FetchLike;
  /** Nombre del proveedor para los mensajes («Higgsfield», «Vertex AI»…). */
  provider: string;
  /** Tiempo máximo de esta llamada. */
  timeoutMs: number;
  /** Señal de quien llama (tiempo máximo global o cancelación). */
  signal?: AbortSignal;
}

const MAX_DETAIL = 200;

/** Texto corto y sin saltos de línea para un mensaje de error. */
function brief(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
}

/** Saca el motivo de un cuerpo de error: `detail`, `error`, `message` o `error.message`. */
function errorDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Record<string, unknown>;
  for (const key of ['detail', 'message', 'error']) {
    const value = record[key];
    if (typeof value === 'string') return brief(value);
    if (typeof value === 'object' && value !== null && 'message' in value) {
      return brief((value as { message: unknown }).message);
    }
  }
  return '';
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Traduce una respuesta que no es 2xx. Cada adaptador puede afinar códigos concretos antes. */
export function failureFromResponse(provider: string, response: Response, body: unknown): MediaProviderFailure {
  const detail = errorDetail(body);
  const suffix = detail ? `: ${detail}` : '';
  const status = response.status;
  if (status === 429) {
    return new MediaProviderFailure('rate_limited', `${provider} ha alcanzado su límite de uso (HTTP 429)${suffix}`, {
      retryable: true,
      retryAfterSeconds: retryAfterSeconds(response),
    });
  }
  if (status === 401 || status === 403) {
    return new MediaProviderFailure('auth', `${provider} ha rechazado las credenciales (HTTP ${status})${suffix}`);
  }
  if (status === 402) {
    return new MediaProviderFailure('insufficient_credits', `${provider} no tiene saldo (HTTP 402)${suffix}`);
  }
  if (status === 408 || status >= 500) {
    return new MediaProviderFailure(
      'provider_unavailable',
      `${provider} no está disponible (HTTP ${status})${suffix}`,
      {
        retryable: true,
        retryAfterSeconds: retryAfterSeconds(response),
      },
    );
  }
  return new MediaProviderFailure('invalid_request', `${provider} ha rechazado la petición (HTTP ${status})${suffix}`);
}

async function withTimeout<T>(options: HttpOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof MediaProviderFailure) throw error;
    if (timedOut) {
      throw new MediaProviderFailure('timeout', `${options.provider} no respondió a tiempo`, { retryable: true });
    }
    if (options.signal?.aborted) {
      throw new MediaProviderFailure('timeout', `La petición a ${options.provider} se canceló`, { retryable: true });
    }
    // Error de red: no se copia su texto (puede llevar la URL).
    throw new MediaProviderFailure('network', `No se ha podido conectar con ${options.provider}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export interface HttpResult {
  response: Response;
  /** Cuerpo interpretado como JSON, o `null` si no lo era. */
  body: unknown;
}

/** Hace una petición y devuelve la respuesta con su cuerpo JSON, sea cual sea el estado. */
export function request(url: string, init: RequestInit, options: HttpOptions): Promise<HttpResult> {
  return withTimeout(options, async (signal) => {
    const response = await options.fetch(url, { ...init, signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { response, body };
  });
}

/** Como `request`, pero cualquier estado que no sea 2xx es un fallo. Devuelve el cuerpo JSON. */
export async function requestJson(url: string, init: RequestInit, options: HttpOptions): Promise<unknown> {
  const { response, body } = await request(url, init, options);
  if (!response.ok) throw failureFromResponse(options.provider, response, body);
  if (body === null) {
    throw new MediaProviderFailure('bad_response', `${options.provider} ha devuelto una respuesta que no se entiende`);
  }
  return body;
}

/** Descarga un archivo con un tamaño máximo. */
export function download(
  url: string,
  options: HttpOptions & { maxBytes: number },
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  return withTimeout(options, async (signal) => {
    if (!/^https:\/\//i.test(url)) {
      throw new MediaProviderFailure(
        'bad_response',
        `${options.provider} ha devuelto una dirección de descarga no válida`,
      );
    }
    const response = await options.fetch(url, { signal });
    if (!response.ok) {
      throw new MediaProviderFailure(
        'download_failed',
        `No se ha podido descargar el resultado de ${options.provider} (HTTP ${response.status})`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new MediaProviderFailure('too_large', `El resultado de ${options.provider} supera el tamaño máximo`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > options.maxBytes) {
      throw new MediaProviderFailure('too_large', `El resultado de ${options.provider} supera el tamaño máximo`);
    }
    return { bytes, contentType: response.headers.get('content-type') };
  });
}

/** `true` si la URL es https y de uno de los dominios (o subdominios) indicados. */
export function isTrustedUrl(url: string | undefined, hosts: string[]): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && hosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

// ─────────────────────────── Codificación ───────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return null;
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Comparación en tiempo constante. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ─────────────────────── Lectura de respuestas JSON ───────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

export function numberAt(value: unknown, ...path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}
