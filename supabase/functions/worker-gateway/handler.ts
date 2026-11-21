// Lógica de la Edge Function `worker-gateway` (docs/alojamiento.md, §5): el
// intermediario entre el trabajador de medios (Fly.io) y Supabase. El
// trabajador NO tiene la clave de servicio: se autentica con su token propio
// (`Authorization: Bearer rrss_wgt_…`) y solo puede hacer esto:
//
//   POST …/worker-gateway/claim       { worker, kinds?, limit, leaseSeconds } → { jobs }
//   POST …/worker-gateway/complete    { worker, jobId, result }
//   POST …/worker-gateway/fail        { worker, jobId, error, retry }
//   POST …/worker-gateway/release     { worker, jobId }
//   POST …/worker-gateway/extend      { worker, jobId, leaseSeconds }
//   POST …/worker-gateway/read-url    { worker, jobId, path } → { backend, url }
//   POST …/worker-gateway/write-url   { worker, jobId, path, contentType, bytes }
//                                     → { backend, url, method, headers }
//
// Toda la autorización la decide la base de datos (migración 20261210010000):
// la función solo calcula la huella SHA-256 del token y llama a las RPC
// `worker_gateway_*` con la clave de servicio, que comprueban la huella, que el
// trabajo está reservado por ese trabajador y que la ruta es de su marca. Las
// URL firmadas duran poco y son de UNA ruta.
//
// Las URL de Supabase Storage y de Drive salen RELATIVAS («/storage/v1/…»,
// «/functions/v1/…»): el trabajador les pone delante su SUPABASE_URL (dentro
// de la función, la dirección de Supabase puede ser la interna).
//
// Sin nada de Deno: las pruebas la ejecutan en Node con la base de datos real.
import type { RpcClient } from '../_shared/ai/contract.ts';
import { WORKER_GATEWAY_TOKEN_PATTERN } from '../_shared/integrations/catalog.ts';
import type { MediaStorageConfig } from '../_shared/storage/config.ts';
import { isMediaKey, StorageError, type ObjectStorage } from '../_shared/storage/contract.ts';
import { S3_MAX_PUT_BYTES } from '../_shared/storage/s3.ts';

export interface WorkerGatewayDeps {
  /** RPC con la clave de servicio (solo las `worker_gateway_*` y el registro de subidas a R2). */
  rpc: RpcClient;
  config: MediaStorageConfig;
  /** Cubo de R2 (o MinIO); null si no está configurado. */
  r2: ObjectStorage | null;
  /** Supabase Storage con la clave de servicio. */
  supabase: ObjectStorage;
  /** Dirección de Supabase que ve la función, para devolver relativas sus URL. */
  supabaseUrl: string;
  /** Dirección (relativa o absoluta) para bajar una imagen de Google Drive. */
  driveUrl(path: string): Promise<string | null>;
  /** Tope de una subida a Supabase Storage (el del cubo). */
  maxSupabaseUploadBytes?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Lecturas: 1 h (un vídeo largo tarda en bajar). Subidas: 15 min para empezar. */
export const GATEWAY_READ_SECONDS = 3600;
export const GATEWAY_UPLOAD_SECONDS = 15 * 60;
/** Cuerpo de una petición: el resultado de un trabajo cabe en 256 KiB (`jobs.result`). */
export const GATEWAY_MAX_BODY_BYTES = 300 * 1024;
/** Tope del cubo `brand-media` en el plan gratuito de Supabase. */
export const DEFAULT_SUPABASE_UPLOAD_BYTES = 50 * 1024 * 1024;

const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/drive\/[A-Za-z0-9_-]{10,200}$/i;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Error de una RPC → respuesta. La base de datos explica el motivo; aquí solo se traduce el código. */
function fromRpcError(error: { code?: string; message: string }): HttpError {
  if (error.code === '42501') return new HttpError(403, 'forbidden', error.message);
  if (error.code === 'P0429') return new HttpError(429, 'rate_limited', error.message);
  if (error.code === 'P0001' && /no está reservado por este trabajador/.test(error.message))
    return new HttpError(409, 'lease_lost', error.message);
  if (error.code === '22023' || error.code === 'P0001') return new HttpError(400, 'refused', error.message);
  return new HttpError(500, 'internal', 'La base de datos no respondió como se esperaba.');
}

export function createWorkerGatewayHandler(deps: WorkerGatewayDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  const base = deps.supabaseUrl.replace(/\/+$/, '');
  const maxSupabaseBytes = deps.maxSupabaseUploadBytes ?? DEFAULT_SUPABASE_UPLOAD_BYTES;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  /** Lo de Supabase sale relativo: el trabajador lo resuelve contra su SUPABASE_URL. */
  const relative = (url: string) => (url.startsWith(`${base}/`) ? url.slice(base.length) : url);

  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await deps.rpc(fn, args);
    if (error) throw fromRpcError(error);
    return data as T;
  }

  async function readBody(request: Request): Promise<Record<string, unknown>> {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > GATEWAY_MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'La petición es demasiado grande.');
    const text = await request.text();
    if (new TextEncoder().encode(text).length > GATEWAY_MAX_BODY_BYTES) {
      throw new HttpError(413, 'too_large', 'La petición es demasiado grande.');
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'bad_request', 'La petición no es JSON válido.');
    }
  }

  const str = (body: Record<string, unknown>, name: string, max = 1024): string => {
    const v = body[name];
    if (typeof v !== 'string' || v.length === 0 || v.length > max) {
      throw new HttpError(400, 'bad_request', `Falta «${name}» o no es válido.`);
    }
    return v;
  };
  const jobIdOf = (body: Record<string, unknown>) => {
    const id = str(body, 'jobId', 36);
    if (!UUID.test(id)) throw new HttpError(400, 'bad_request', 'Falta «jobId» o no es válido.');
    return id;
  };
  const intOf = (body: Record<string, unknown>, name: string, min: number, max: number) => {
    const n = body[name];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, 'bad_request', `«${name}» debe ser un entero entre ${min} y ${max}.`);
    }
    return n;
  };

  async function route(name: string, hash: string, body: Record<string, unknown>): Promise<Response> {
    const auth = { p_token_hash: hash, p_worker: str(body, 'worker', 150) };
    switch (name) {
      case '/claim': {
        const kinds = body.kinds;
        if (
          kinds !== undefined &&
          (!Array.isArray(kinds) || kinds.length > 20 || kinds.some((k) => typeof k !== 'string' || k.length > 64))
        ) {
          throw new HttpError(400, 'bad_request', '«kinds» debe ser una lista de tipos de trabajo.');
        }
        const jobs = await call<unknown[] | null>('worker_gateway_claim', {
          ...auth,
          p_kinds: kinds ?? null,
          p_limit: intOf(body, 'limit', 1, 16),
          p_lease_seconds: intOf(body, 'leaseSeconds', 5, 3600),
        });
        return json(200, { jobs: jobs ?? [] });
      }
      case '/complete': {
        const result = body.result ?? null;
        if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
          throw new HttpError(400, 'bad_request', '«result» debe ser un objeto.');
        }
        await call('worker_gateway_complete', { ...auth, p_job_id: jobIdOf(body), p_result: result });
        return json(200, { ok: true });
      }
      case '/fail':
        await call('worker_gateway_fail', {
          ...auth,
          p_job_id: jobIdOf(body),
          p_error: str(body, 'error', 4000),
          p_retry: body.retry !== false,
        });
        return json(200, { ok: true });
      case '/release':
        await call('worker_gateway_release', { ...auth, p_job_id: jobIdOf(body) });
        return json(200, { ok: true });
      case '/extend':
        await call('worker_gateway_extend', {
          ...auth,
          p_job_id: jobIdOf(body),
          p_lease_seconds: intOf(body, 'leaseSeconds', 5, 3600),
        });
        return json(200, { ok: true });
      case '/read-url': {
        const path = str(body, 'path');
        const { backend } = await call<{ backend: 'supabase' | 'r2' | 'drive' }>('worker_gateway_authorize_path', {
          ...auth,
          p_job_id: jobIdOf(body),
          p_path: path,
          p_write: false,
        });
        if (backend === 'drive') {
          if (!DRIVE_KEY.test(path)) throw new HttpError(400, 'refused', 'Ruta de Google Drive no válida.');
          const url = await deps.driveUrl(path);
          if (!url) throw new HttpError(404, 'not_found', `No existe el recurso de Google Drive «${path}».`);
          return json(200, { backend, url: relative(url) });
        }
        if (!isMediaKey(path)) throw new HttpError(400, 'refused', 'Ruta no válida.');
        if (backend === 'r2' && !deps.r2) {
          throw new HttpError(503, 'not_configured', 'Cloudflare R2 no está configurado en este entorno.');
        }
        const store = backend === 'r2' ? deps.r2! : deps.supabase;
        return json(200, { backend, url: relative(await store.signGet(path, GATEWAY_READ_SECONDS)) });
      }
      case '/write-url': {
        const path = str(body, 'path');
        const contentType = str(body, 'contentType', 120).toLowerCase();
        if (!CONTENT_TYPE.test(contentType)) throw new HttpError(400, 'bad_request', 'Tipo de archivo no válido.');
        const bytes = intOf(body, 'bytes', 1, S3_MAX_PUT_BYTES);
        await call('worker_gateway_authorize_path', {
          ...auth,
          p_job_id: jobIdOf(body),
          p_path: path,
          p_write: true,
        });
        if (!isMediaKey(path)) throw new HttpError(400, 'refused', 'Ruta no válida.');
        if (deps.config.uploadBackend === 'r2' && deps.r2) {
          // Igual que media-storage con la clave de servicio: se apunta en R2
          // para que el alta del recurso (disparador de complete_job) lo sepa.
          await call('media_storage_register_upload', { p_user_id: null, p_path: path });
          const signed = await deps.r2.signPut(path, contentType, bytes, GATEWAY_UPLOAD_SECONDS);
          return json(200, { backend: 'r2', ...signed });
        }
        if (bytes > maxSupabaseBytes) {
          throw new HttpError(
            413,
            'too_large',
            `El archivo pesa ${bytes} bytes y el almacenamiento admite ${maxSupabaseBytes} como máximo.`,
          );
        }
        const signed = await deps.supabase.signPut(path, contentType, bytes, GATEWAY_UPLOAD_SECONDS);
        return json(200, { backend: 'supabase', ...signed, url: relative(signed.url) });
      }
      default:
        throw new HttpError(404, 'not_found', 'Esa operación no existe.');
    }
  }

  return async (request) => {
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Solo POST.');
      const name = new URL(request.url).pathname.replace(/\/+$/, '').split('/worker-gateway')[1] ?? '';
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
      // Una clave de Supabase (sb_secret_…, un JWT) o cualquier otra cosa no entra.
      if (!WORKER_GATEWAY_TOKEN_PATTERN.test(token)) {
        throw new HttpError(401, 'unauthorized', 'Falta el token del trabajador o no tiene la forma esperada.');
      }
      const hash = await sha256Hex(token);
      return await route(name, hash, await readBody(request));
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 429) {
          log('refused', { status: e.status, code: e.code });
        }
        return json(e.status, { error: { code: e.code, message: e.message } });
      }
      if (e instanceof StorageError) {
        log('storage_failed', { status: e.status });
        return json(502, {
          error: { code: 'storage_failed', message: 'El almacenamiento no respondió como se esperaba.' },
        });
      }
      log('internal', { name: (e as Error)?.name });
      return json(500, { error: { code: 'internal', message: 'No se pudo completar la operación.' } });
    }
  };
}
