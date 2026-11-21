// Llamada HTTP común a los adaptadores de texto: `fetch` puro, sin SDK.
//
// Traduce lo que puede pasar (sin red, tiempo agotado, error del proveedor,
// límite de uso, respuesta ilegible) a `AiProviderFailure`, que es lo único que
// el servicio registra. Los mensajes nunca llevan claves ni cabeceras.
import { AiProviderFailure } from '../contract.ts';

/** Forma mínima de `fetch` que usan los adaptadores; en las pruebas se sustituye. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export interface PostJsonOptions {
  fetch: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  /** Nombre del proveedor para los mensajes («Anthropic», «Mistral»…). */
  providerName: string;
  /** Valores secretos que no pueden aparecer en ningún mensaje de error. */
  secrets: string[];
  /** Extrae del cuerpo de error del proveedor un texto corto y sin datos del cliente. */
  describeError: (body: unknown) => string | undefined;
}

export interface PostJsonResult {
  body: unknown;
  headers: Headers;
}

const MAX_ERROR_DETAIL = 200;

function redact(text: string, secrets: string[]): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret) clean = clean.split(secret).join('[oculto]');
  }
  return clean.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function postJson(options: PostJsonOptions): Promise<PostJsonResult> {
  const { providerName: name, secrets } = options;
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    // No se copia el mensaje del error de red: puede llevar la URL firmada.
    if (options.signal.aborted) {
      throw new AiProviderFailure('timeout', `${name} no respondió a tiempo`, { retryable: true });
    }
    throw new AiProviderFailure('network', `No se pudo conectar con ${name}`, { retryable: true });
  }

  if (!response.ok) {
    const status = response.status;
    let detail: string | undefined;
    try {
      detail = options.describeError(await readJson(response));
    } catch {
      detail = undefined;
    }
    const suffix = detail ? `: ${redact(detail, secrets)}` : '';
    if (status === 429) {
      throw new AiProviderFailure('rate_limited', `${name} ha limitado el uso (429)${suffix}`, { retryable: true });
    }
    if (status === 401 || status === 403) {
      // Sin detalle a propósito: es el único error que habla de credenciales.
      throw new AiProviderFailure('auth', `${name} ha rechazado las credenciales (${status})`);
    }
    if (status === 408 || status === 504) {
      throw new AiProviderFailure('timeout', `${name} no respondió a tiempo (${status})`, { retryable: true });
    }
    if (status === 529 || status === 503) {
      throw new AiProviderFailure('overloaded', `${name} está saturado (${status})${suffix}`, { retryable: true });
    }
    if (status >= 500) {
      throw new AiProviderFailure('provider_error', `${name} ha fallado (${status})${suffix}`, { retryable: true });
    }
    throw new AiProviderFailure('invalid_request', `${name} ha rechazado la petición (${status})${suffix}`);
  }

  const body = await readJson(response).catch(() => undefined);
  if (typeof body !== 'object' || body === null) {
    throw new AiProviderFailure('bad_response', `${name} ha devuelto una respuesta que no es JSON`);
  }
  return { body, headers: response.headers };
}

/** Lectura segura de campos de una respuesta que no controlamos. */
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** Entero no negativo, o `null` si el proveedor no lo ha dado bien. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
