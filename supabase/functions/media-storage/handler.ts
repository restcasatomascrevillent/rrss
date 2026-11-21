// Lógica de la Edge Function `media-storage` (docs/almacenamiento-r2.md):
//
//   POST …/media-storage/sign    sesión (RLS: solo recursos que ve) → URL de lectura
//                                de sus archivos en R2; clave de servicio → URL de
//                                cualquier ruta, en el almacén que sea
//   POST …/media-storage/upload  sesión de quien edita la marca o clave de servicio →
//                                almacén de la subida y, si es R2, la URL firmada
//   POST …/media-storage/delete  sesión de quien edita la marca → borra los archivos
//                                de la cola de limpieza que ve, en su almacén
//   POST …/media-storage/discard sesión de quien edita la marca → borra de R2 lo que
//                                subió y se quedó sin recurso (el alta falló)
//   POST …/media-storage/purge-orphans  solo clave de servicio (tarea programada) →
//                                borra de R2 lo apuntado sin recurso tras 24 h
//
// Las credenciales de R2 nunca salen de aquí: hacia fuera solo van URL firmadas
// de corta duración, y solo después de que la base de datos haya dicho que la
// persona ve (o edita) la marca.
import type { RpcClient } from '../_shared/ai/contract.ts';
import { isMediaKey, StorageError, type ObjectStorage, type StorageBackend } from '../_shared/storage/contract.ts';
import type { MediaStorageConfig } from '../_shared/storage/config.ts';
import { S3_MAX_PUT_BYTES } from '../_shared/storage/s3.ts';

/** Fila de `media_assets` tal como la ve quien pregunta (RLS) o el servidor. */
export interface AssetLocation {
  storage_path: string;
  storage_backend: StorageBackend;
}

export interface MediaStorageDeps {
  config: MediaStorageConfig;
  /** Cubo de R2 (o MinIO); null si no está configurado. */
  r2: ObjectStorage | null;
  /** Supabase Storage con la clave de servicio. */
  supabase: ObjectStorage;
  /** RPC con la clave de servicio. */
  rpc: RpcClient;
  /** Usuario del token de sesión, o null si no vale. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  isServiceToken(token: string): boolean;
  /** Recursos de Storage con esas rutas que VE quien llama (RLS), o todos si es el servidor (token null). */
  assetsForPaths(accessToken: string | null, paths: string[]): Promise<AssetLocation[]>;
  /** Anotaciones de la cola de limpieza con esas rutas que VE quien llama (RLS: quien edita la marca). */
  cleanupForPaths(accessToken: string, paths: string[]): Promise<AssetLocation[]>;
  allowedOrigin?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Lectura: una hora, como las URL firmadas de Supabase de la biblioteca. */
export const READ_URL_SECONDS = 3600;
/** El servidor (publicación en Instagram, trabajador) puede pedir hasta 6 horas. */
export const MAX_SERVICE_READ_SECONDS = 6 * 3600;
/** Subida: 15 minutos para empezarla. */
export const UPLOAD_URL_SECONDS = 15 * 60;
const MAX_PATHS = 500;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function pathsOf(body: unknown): string[] {
  const raw = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PATHS || raw.some((p) => typeof p !== 'string')) {
    throw new HttpError(400, 'bad_request', `Hace falta una lista de 1 a ${MAX_PATHS} rutas.`);
  }
  return [...new Set(raw as string[])].filter(isMediaKey);
}

const fileNameOf = (path: string) =>
  path
    .split('/')
    .pop()
    ?.replace(/^[0-9a-f-]{36}-/i, '') || 'archivo';

export function createMediaStorageHandler(deps: MediaStorageDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  const bearer = (request: Request) =>
    /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? null;

  const store = (backend: StorageBackend): ObjectStorage => {
    if (backend === 'supabase') return deps.supabase;
    if (!deps.r2) throw new HttpError(503, 'not_configured', 'Cloudflare R2 no está configurado en este entorno.');
    return deps.r2;
  };

  /** ¿Quién llama? El servidor (clave de servicio) o una persona con sesión. */
  async function caller(
    request: Request,
  ): Promise<{ service: true; token: null; userId: null } | { service: false; token: string; userId: string }> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Hace falta iniciar sesión.');
    if (deps.isServiceToken(token)) return { service: true, token: null, userId: null };
    const user = await deps.authenticate(token);
    if (!user) throw new HttpError(401, 'unauthorized', 'La sesión ha caducado. Vuelve a iniciar sesión.');
    return { service: false, token, userId: user.userId };
  }

  async function sign(request: Request): Promise<Response> {
    const who = await caller(request);
    const body = (await request.json().catch(() => null)) as { seconds?: unknown; download?: unknown } | null;
    const paths = pathsOf(body);
    const download = body?.download === true;
    if (who.service) {
      const seconds = Math.max(60, Math.min(MAX_SERVICE_READ_SECONDS, Number(body?.seconds) || READ_URL_SECONDS));
      const rows = paths.length ? await deps.assetsForPaths(null, paths) : [];
      const backendOf = new Map(rows.map((r) => [r.storage_path, r.storage_backend]));
      const urls: Record<string, { backend: StorageBackend; url: string }> = {};
      for (const path of paths) {
        // Lo que no es un recurso (fuentes de marca, tipografías) está en Supabase.
        const backend = backendOf.get(path) ?? 'supabase';
        try {
          urls[path] = {
            backend,
            url: await store(backend).signGet(path, seconds, download ? { download: fileNameOf(path) } : {}),
          };
        } catch (e) {
          if (e instanceof HttpError) throw e;
          log('sign_failed', { backend });
        }
      }
      return json(200, { urls, expiresIn: seconds });
    }
    // Con sesión: solo los de R2 que la RLS deja ver; los de Supabase los firma el navegador.
    const rows = paths.length ? await deps.assetsForPaths(who.token, paths) : [];
    const urls: Record<string, string> = {};
    for (const row of rows) {
      if (row.storage_backend !== 'r2') continue;
      urls[row.storage_path] = await store('r2').signGet(
        row.storage_path,
        READ_URL_SECONDS,
        download ? { download: fileNameOf(row.storage_path) } : {},
      );
    }
    return json(200, { urls, expiresIn: READ_URL_SECONDS });
  }

  async function upload(request: Request): Promise<Response> {
    const who = await caller(request);
    const body = (await request.json().catch(() => null)) as {
      path?: unknown;
      contentType?: unknown;
      bytes?: unknown;
    } | null;
    const path = body?.path;
    const contentType = typeof body?.contentType === 'string' ? body.contentType.toLowerCase() : '';
    const bytes = Number(body?.bytes);
    if (typeof path !== 'string' || !isMediaKey(path)) throw new HttpError(400, 'bad_request', 'Ruta no válida.');
    if (!CONTENT_TYPE.test(contentType)) throw new HttpError(400, 'bad_request', 'Tipo de archivo no válido.');
    if (!Number.isInteger(bytes) || bytes <= 0) throw new HttpError(400, 'bad_request', 'Tamaño no válido.');

    if (deps.config.uploadBackend !== 'r2' || !deps.r2) return json(200, { backend: 'supabase' });
    if (bytes > S3_MAX_PUT_BYTES) {
      throw new HttpError(413, 'too_large', 'El archivo es demasiado grande para subirlo de una vez (máximo 2 GiB).');
    }
    // La base de datos decide si quien sube edita la marca de la ruta, y lo apunta.
    const { error } = await deps.rpc('media_storage_register_upload', {
      p_user_id: who.userId,
      p_path: path,
    });
    if (error) {
      if (error.code === '42501') throw new HttpError(403, 'forbidden', error.message);
      throw new HttpError(400, 'refused', error.message);
    }
    const signed = await deps.r2.signPut(path, contentType, bytes, UPLOAD_URL_SECONDS);
    return json(200, { backend: 'r2', ...signed, maxBytes: S3_MAX_PUT_BYTES });
  }

  async function remove(request: Request): Promise<Response> {
    const who = await caller(request);
    if (who.service) throw new HttpError(403, 'forbidden', 'Solo para personas con sesión.');
    const paths = pathsOf(await request.json().catch(() => null));
    const rows = paths.length ? await deps.cleanupForPaths(who.token, paths) : [];
    const removed: string[] = [];
    const failed: string[] = [];
    for (const backend of ['supabase', 'r2'] as const) {
      const keys = rows.filter((r) => r.storage_backend === backend).map((r) => r.storage_path);
      if (keys.length === 0) continue;
      let result: { failed: string[] };
      try {
        result = await store(backend).remove(keys);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        result = { failed: keys };
      }
      for (const key of keys) (result.failed.includes(key) ? failed : removed).push(key);
    }
    if (removed.length > 0) {
      const { error } = await deps.rpc('media_storage_forget_paths', { p_paths: removed });
      if (error) log('forget_failed', { code: error.code });
    }
    return json(200, { removed, failed });
  }

  /** Borra del almacén las rutas huérfanas que da la base de datos y las olvida. */
  async function removeOrphans(rows: { storage_path: string; backend: StorageBackend }[]) {
    const removed: string[] = [];
    const failed: string[] = [];
    for (const backend of ['r2'] as const) {
      const keys = rows.filter((r) => r.backend === backend).map((r) => r.storage_path);
      if (keys.length === 0) continue;
      let result: { failed: string[] };
      try {
        result = await store(backend).remove(keys);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        result = { failed: keys };
      }
      for (const key of keys) (result.failed.includes(key) ? failed : removed).push(key);
    }
    if (removed.length > 0) {
      const { error } = await deps.rpc('media_storage_forget_paths', { p_paths: removed });
      if (error) log('forget_failed', { code: error.code });
    }
    return { removed, failed };
  }

  async function orphans(args: Record<string, unknown>): Promise<{ storage_path: string; backend: StorageBackend }[]> {
    const { data, error } = await deps.rpc('media_storage_orphans', args);
    if (error) throw new HttpError(400, 'refused', error.message);
    return (data ?? []) as { storage_path: string; backend: StorageBackend }[];
  }

  async function discard(request: Request): Promise<Response> {
    const who = await caller(request);
    if (who.service) throw new HttpError(403, 'forbidden', 'Solo para personas con sesión.');
    const paths = pathsOf(await request.json().catch(() => null));
    // La base de datos solo devuelve lo que la persona subió y no tiene recurso.
    const rows = paths.length ? await orphans({ p_user_id: who.userId, p_paths: paths }) : [];
    return json(200, await removeOrphans(rows));
  }

  async function purgeOrphans(request: Request): Promise<Response> {
    const who = await caller(request);
    if (!who.service) throw new HttpError(403, 'forbidden', 'Solo para el servidor.');
    const rows = await orphans({ p_user_id: null, p_min_age: '24 hours', p_limit: 200 });
    return json(200, await removeOrphans(rows));
  }

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const route = url.pathname.replace(/\/+$/, '').split('/media-storage')[1] ?? '';
    try {
      if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
      if (route === '/sign') return await sign(request);
      if (route === '/upload') return await upload(request);
      if (route === '/delete') return await remove(request);
      if (route === '/discard') return await discard(request);
      if (route === '/purge-orphans') return await purgeOrphans(request);
      return json(404, { error: { code: 'not_found' } });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message } });
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
