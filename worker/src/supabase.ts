// Adaptadores de Supabase para la cola y el almacenamiento, con `fetch` y sin
// dependencias. Son los únicos archivos que saben que detrás hay Supabase:
// PostgREST para las funciones de la cola y la API de Storage para los archivos.
//
// Los archivos viajan en flujo (de la red al disco y al revés): un vídeo de
// cientos de megas nunca se carga entero en memoria.
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { LeaseLostError, PermanentError } from './errors.ts';
import type { Job, JobQueue } from './queue.ts';
import type { MediaStorage } from './storage.ts';

export interface SupabaseOptions {
  /** URL del proyecto, sin barra final. */
  url: string;
  /** Clave de servicio. Solo vive en el entorno del trabajador. */
  serviceKey: string;
  fetch?: typeof fetch;
}

const authHeaders = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}` });

async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? body;
  } catch {
    return body.slice(0, 300);
  }
}

export function createSupabaseQueue(options: SupabaseOptions): JobQueue {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await doFetch(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...authHeaders(options.serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      const message = await errorText(response);
      if (/no está reservado por este trabajador/.test(message)) throw new LeaseLostError(message);
      throw new Error(`La cola respondió ${response.status} a ${name}: ${message}`);
    }
    return (await response.json()) as T;
  }

  return {
    claim: ({ worker, kinds, limit, leaseSeconds }) =>
      rpc<Job[]>('claim_jobs', { p_worker: worker, p_kinds: kinds, p_limit: limit, p_lease_seconds: leaseSeconds }),
    async complete(jobId, worker, result) {
      await rpc('complete_job', { p_job_id: jobId, p_worker: worker, p_result: result });
    },
    async fail(jobId, worker, error, retry) {
      await rpc('fail_job', { p_job_id: jobId, p_worker: worker, p_error: error, p_retry: retry });
    },
    async release(jobId, worker) {
      await rpc('release_job', { p_job_id: jobId, p_worker: worker });
    },
    async extendLease(jobId, worker, leaseSeconds) {
      await rpc('extend_job_lease', { p_job_id: jobId, p_worker: worker, p_lease_seconds: leaseSeconds });
    },
  };
}

/** Tope de subida estándar de Supabase y del cubo `brand-media` (50 MB en el plan gratuito). */
export const DEFAULT_MAX_OBJECT_BYTES = 50 * 1024 * 1024;

/** Ruta virtual de un recurso de la biblioteca que vive en Google Drive. */
export const DRIVE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/drive\/[A-Za-z0-9_-]{10,200}$/i;

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Tope de una subida a R2 de una sola vez (supabase/functions/_shared/storage/s3.ts). */
export const R2_MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
/** Si `media-storage` no está desplegada, se vuelve a preguntar pasado este tiempo. */
const MEDIA_STORAGE_RETRY_MS = 5 * 60_000;

export function createSupabaseStorage(
  options: SupabaseOptions & {
    bucket: string;
    /**
     * Tamaño máximo de un archivo subido. Por encima, Storage lo rechazaría:
     * se avisa antes de subir y sin reintento (otro intento pesaría lo mismo).
     */
    maxObjectBytes?: number;
    /**
     * Preguntar a la función `media-storage` dónde está cada archivo y dónde
     * subir los resultados (Cloudflare R2 o Supabase Storage,
     * docs/almacenamiento-r2.md). Si la función no está desplegada, se usa
     * Supabase Storage como siempre.
     */
    mediaStorage?: boolean;
    now?: () => number;
  },
): MediaStorage {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const base = options.url.replace(/\/+$/, '');
  let mediaStorageMissingUntil = 0;

  /** Llama a `media-storage` con la clave de servicio; null si no está desplegada (o no se usa). */
  async function mediaStorage<T>(route: 'sign' | 'upload', body: unknown, signal?: AbortSignal): Promise<T | null> {
    if (!options.mediaStorage || now() < mediaStorageMissingUntil) return null;
    const response = await doFetch(`${base}/functions/v1/media-storage/${route}`, {
      method: 'POST',
      headers: { ...authHeaders(options.serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 404) {
      await response.arrayBuffer().catch(() => undefined);
      mediaStorageMissingUntil = now() + MEDIA_STORAGE_RETRY_MS;
      return null;
    }
    if (!response.ok) {
      const message = `El almacenamiento respondió ${response.status}: ${await errorText(response)}`;
      if (response.status === 400 || response.status === 403 || response.status === 413) {
        throw new PermanentError(message);
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }
  const objectUrl = (objectPath: string) =>
    `${base}/storage/v1/object/${encodeURIComponent(options.bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;

  // Recursos que viven en Google Drive (ruta virtual `<org>/<marca>/drive/<id>`,
  // migración 20261122010000): no están en Storage. Se piden a la función
  // `drive-media`, que con la clave de servicio firma su dirección.
  async function driveUrl(objectPath: string, signal?: AbortSignal): Promise<string> {
    const response = await doFetch(`${base}/functions/v1/drive-media/sign`, {
      method: 'POST',
      headers: { ...authHeaders(options.serviceKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [objectPath] }),
      signal,
    });
    if (!response.ok)
      throw new Error(`Google Drive no firmó «${objectPath}»: ${response.status} ${await errorText(response)}`);
    const body = (await response.json()) as { tickets?: Record<string, { full?: string }> };
    const ticket = body.tickets?.[objectPath]?.full;
    if (!ticket) throw new PermanentError(`No existe el recurso de Google Drive «${objectPath}»`);
    return `${base}/functions/v1/drive-media/file/${encodeURIComponent(ticket)}`;
  }

  return {
    async download(objectPath, destinationFile, signal) {
      const fromDrive = DRIVE_PATH.test(objectPath);
      const signed = fromDrive
        ? null
        : await mediaStorage<{ urls?: Record<string, { backend?: string; url?: string }> }>(
            'sign',
            { paths: [objectPath] },
            signal,
          );
      // Solo lo que está en R2 va por la URL firmada; lo de Supabase se baja como
      // siempre (la URL que firma la función usa su dirección interna).
      const entry = signed?.urls?.[objectPath];
      const signedUrl = entry?.backend === 'r2' ? entry.url : undefined;
      const response = fromDrive
        ? await doFetch(await driveUrl(objectPath, signal), { signal })
        : signedUrl
          ? await doFetch(signedUrl, { signal })
          : await doFetch(objectUrl(objectPath), { headers: authHeaders(options.serviceKey), signal });
      if (!response.ok || !response.body) {
        const message = await errorText(response);
        // Storage responde 400 o 404 cuando el objeto no existe: reintentar no lo arregla.
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
      const target =
        size > 0 && size <= R2_MAX_OBJECT_BYTES
          ? await mediaStorage<{ backend?: string; url?: string; headers?: Record<string, string> }>(
              'upload',
              { path: objectPath, contentType, bytes: size },
              signal,
            )
          : null;
      if (target?.backend === 'r2' && target.url) {
        // R2: PUT a la URL firmada (tipo y tamaño firmados). Reintentar sobrescribe.
        const response = await doFetch(target.url, {
          method: 'PUT',
          headers: { ...(target.headers ?? {}), 'Content-Type': contentType, 'Content-Length': String(size) },
          body: Readable.toWeb(createReadStream(sourceFile)) as unknown as RequestInit['body'],
          duplex: 'half',
          signal,
        } as RequestInit);
        if (!response.ok) {
          const message = `No se pudo subir «${objectPath}» a R2: ${response.status} ${await errorText(response)}`;
          if (response.status === 400 || response.status === 403) throw new PermanentError(message);
          throw new Error(message);
        }
        await response.arrayBuffer().catch(() => undefined);
        return;
      }
      if (size > maxObjectBytes) {
        throw new PermanentError(
          `El archivo resultante pesa ${megabytes(size)} y el almacenamiento admite ${megabytes(maxObjectBytes)} como máximo. ` +
            'Prueba con menos piezas, piezas más cortas o una plantilla más ligera.',
        );
      }
      const response = await doFetch(objectUrl(objectPath), {
        method: 'POST',
        headers: {
          ...authHeaders(options.serviceKey),
          'Content-Type': contentType,
          'Content-Length': String(size),
          // Reintentar un trabajo vuelve a escribir el mismo resultado: se sobrescribe.
          'x-upsert': 'true',
        },
        body: Readable.toWeb(createReadStream(sourceFile)) as unknown as RequestInit['body'],
        duplex: 'half',
        signal,
      } as RequestInit);
      if (!response.ok) {
        const message = `No se pudo subir «${objectPath}»: ${response.status} ${await errorText(response)}`;
        // 413: el cubo tiene un tope menor que el configurado aquí. Reintentar no lo arregla.
        if (response.status === 413) throw new PermanentError(message);
        throw new Error(message);
      }
      await response.arrayBuffer().catch(() => undefined);
    },
  };
}
