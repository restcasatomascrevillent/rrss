// Cola y almacenamiento por la Edge Function `worker-gateway` (modo por
// defecto; docs/alojamiento.md, §5). El trabajador NO tiene ninguna clave de
// Supabase: se autentica con su token propio (WORKER_GATEWAY_TOKEN) y el
// intermediario, que guarda la clave de servicio dentro de Supabase, solo le
// deja reclamar sus trabajos, cerrarlos y pedir URL firmadas de UNA ruta de la
// marca del trabajo que tiene reservado.
//
// Los archivos viajan en flujo, igual que en supabase.ts: la URL firmada se
// pide al intermediario y el archivo va directo entre el disco y el almacén
// (Supabase Storage, R2 o Drive), sin pasar por la función.
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { LeaseLostError, PermanentError } from './errors.ts';
import type { Job, JobQueue } from './queue.ts';
import type { MediaStorage } from './storage.ts';
import { DEFAULT_MAX_OBJECT_BYTES } from './supabase.ts';

export interface GatewayOptions {
  /** URL del proyecto de Supabase, sin barra final (la pública). */
  supabaseUrl: string;
  /** Token del trabajador (`rrss_wgt_…`). Solo sirve para el intermediario. */
  token: string;
  /** Dirección del intermediario; por defecto, `<supabaseUrl>/functions/v1/worker-gateway`. */
  gatewayUrl?: string;
  /** Tope de un archivo subido a Supabase Storage (el del cubo); en R2, 2 GiB. */
  maxObjectBytes?: number;
  fetch?: typeof fetch;
}

/** Respuesta de error del intermediario: `{ error: { code, message } }`. */
class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function errorOf(response: Response, operation: string): Promise<GatewayError> {
  const text = await response.text().catch(() => '');
  let code = 'unknown';
  let message = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = parsed.error?.code ?? code;
    message = parsed.error?.message ?? message;
  } catch {
    // Cuerpo que no es JSON (p. ej., la función no está desplegada): queda el texto.
  }
  return new GatewayError(
    response.status,
    code,
    `El intermediario respondió ${response.status} a ${operation}: ${message}`,
  );
}

function createGatewayClient(options: GatewayOptions) {
  const doFetch = options.fetch ?? fetch;
  const supabase = options.supabaseUrl.replace(/\/+$/, '');
  const gateway = (options.gatewayUrl ?? `${supabase}/functions/v1/worker-gateway`).replace(/\/+$/, '');

  async function post<T>(operation: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await doFetch(`${gateway}/${operation}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const error = await errorOf(response, operation);
      if (error.code === 'lease_lost') throw new LeaseLostError(error.message);
      // Ruta ajena, ruta no válida o archivo demasiado grande: reintentar no lo arregla.
      if (['forbidden', 'refused', 'bad_request', 'too_large', 'not_found'].includes(error.code)) {
        throw new PermanentError(error.message);
      }
      throw error;
    }
    return (await response.json()) as T;
  }

  /** Las URL de Supabase y de Drive llegan relativas: van contra la SUPABASE_URL pública. */
  const absolute = (url: string) => (url.startsWith('/') ? `${supabase}${url}` : url);

  return { post, absolute };
}

export function createGatewayQueue(options: GatewayOptions): JobQueue {
  const { post } = createGatewayClient(options);
  return {
    async claim({ worker, kinds, limit, leaseSeconds }) {
      const body = await post<{ jobs: Job[] }>('claim', { worker, kinds, limit, leaseSeconds });
      return body.jobs ?? [];
    },
    async complete(jobId, worker, result) {
      await post('complete', { worker, jobId, result });
    },
    async fail(jobId, worker, error, retry) {
      await post('fail', { worker, jobId, error: error.slice(0, 4000) || 'Error sin descripción', retry });
    },
    async release(jobId, worker) {
      await post('release', { worker, jobId });
    },
    async extendLease(jobId, worker, leaseSeconds) {
      await post('extend', { worker, jobId, leaseSeconds });
    },
  };
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/**
 * Almacenamiento por el intermediario. Cada lectura y subida va ligada al
 * trabajo (el intermediario comprueba que está reservado por este trabajador
 * y que la ruta es de su marca), así que el bucle crea uno por trabajo con
 * `forJob`. Sin trabajo no se puede tocar ningún archivo.
 */
export function createGatewayStorage(options: GatewayOptions): MediaStorage {
  const { post, absolute } = createGatewayClient(options);
  const doFetch = options.fetch ?? fetch;
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;

  const withoutJob = async (): Promise<never> => {
    throw new PermanentError('El almacenamiento por el intermediario solo se usa dentro de un trabajo');
  };

  function forJob(job: Job, worker: string): MediaStorage {
    return {
      async download(objectPath, destinationFile, signal) {
        const { url } = await post<{ backend: string; url: string }>(
          'read-url',
          { worker, jobId: job.id, path: objectPath },
          signal,
        );
        const response = await doFetch(absolute(url), { signal });
        if (!response.ok || !response.body) {
          const message = (await response.text().catch(() => '')).slice(0, 300);
          // El almacén responde 400 o 404 cuando el objeto no existe: reintentar no lo arregla.
          if (response.status === 400 || response.status === 404) {
            throw new PermanentError(`No existe el archivo «${objectPath}» (${message})`);
          }
          throw new Error(`No se pudo bajar «${objectPath}»: ${response.status} ${message}`);
        }
        await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(destinationFile), {
          signal,
        });
      },
      async upload(sourceFile, objectPath, { contentType, signal }) {
        const { size } = await stat(sourceFile);
        if (size === 0) throw new PermanentError(`El archivo resultante «${objectPath}» está vacío`);
        const target = await post<{
          backend: 'supabase' | 'r2';
          url: string;
          method?: 'PUT' | 'POST';
          headers?: Record<string, string>;
        }>('write-url', { worker, jobId: job.id, path: objectPath, contentType, bytes: size }, signal);
        if (target.backend === 'supabase' && size > maxObjectBytes) {
          throw new PermanentError(
            `El archivo resultante pesa ${megabytes(size)} y el almacenamiento admite ${megabytes(maxObjectBytes)} como máximo. ` +
              'Prueba con menos piezas, piezas más cortas o una plantilla más ligera.',
          );
        }
        const response = await doFetch(absolute(target.url), {
          method: target.method ?? 'PUT',
          headers: { ...(target.headers ?? {}), 'Content-Type': contentType, 'Content-Length': String(size) },
          body: Readable.toWeb(createReadStream(sourceFile)) as unknown as RequestInit['body'],
          duplex: 'half',
          signal,
        } as RequestInit);
        if (!response.ok) {
          const message = `No se pudo subir «${objectPath}»: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`;
          if (response.status === 400 || response.status === 403 || response.status === 413) {
            throw new PermanentError(message);
          }
          throw new Error(message);
        }
        await response.arrayBuffer().catch(() => undefined);
      },
    };
  }

  return { download: withoutJob, upload: withoutJob, forJob };
}
