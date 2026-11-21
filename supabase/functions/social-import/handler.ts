// Lógica de la Edge Function `social-import` (docs/importar-publicaciones.md):
//
//   POST …/social-import/start  { accountId, copyImages? } sesión de quien gestiona la marca →
//                               empieza la importación de la cuenta o REANUDA la abierta
//   POST …/social-import/step   { runId } sesión de quien gestiona la marca → hace UN paso
//                               acotado y devuelve el avance (la interfaz repite mientras haya trabajo)
//   POST …/social-import/pause  { runId } → detiene la importación (nada se pierde)
//
// El token de la cuenta se descifra solo dentro del paso, en el servidor: la
// respuesta lleva únicamente cifras y mensajes. Las funciones de base de datos
// vuelven a comprobar que quien llama gestiona la marca.
import type { RpcClient } from '../_shared/ai/contract.ts';
import type { ImportRun, StepResult } from '../_shared/social/importer.ts';

export interface SocialImportDeps {
  /** Usuario del token de sesión, o null si no vale. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  /** RPC con la sesión de la persona. */
  userRpc(accessToken: string): RpcClient;
  /** Hace un paso con las dependencias del servidor; null si el entorno no tiene la publicación configurada. */
  step(runId: string, userId: string): Promise<StepResult> | null;
  allowedOrigin?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que ve la interfaz de una importación (sin nada interno). */
export function publicRun(run: ImportRun | null) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    copyImages: run.copy_images,
    pages: run.pages,
    itemsSeen: run.items_seen,
    itemsNew: run.items_new,
    copied: run.copied,
    copyFailed: run.copy_failed,
    retryAfter: run.retry_after,
    lastError: run.last_error,
  };
}

export function createSocialImportHandler(deps: SocialImportDeps): (request: Request) => Promise<Response> {
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

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Método no permitido.');
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
      if (!token) throw new HttpError(401, 'unauthorized', 'Hace falta iniciar sesión.');
      const user = await deps.authenticate(token);
      if (!user) throw new HttpError(401, 'unauthorized', 'La sesión ha caducado. Vuelve a iniciar sesión.');
      const route = new URL(request.url).pathname.split('/').filter(Boolean).pop();
      const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const userRpc = deps.userRpc(token);
      const asHttp = (error: { code?: string; message: string }) =>
        new HttpError(error.code === '42501' || error.code === '28000' ? 403 : 400, 'refused', error.message);

      if (route === 'start') {
        if (typeof body.accountId !== 'string' || !UUID.test(body.accountId)) {
          throw new HttpError(400, 'bad_request', 'Falta la cuenta.');
        }
        const { data, error } = await userRpc('social_import_begin', {
          p_account_id: body.accountId,
          p_copy_images: body.copyImages === true,
        });
        if (error) throw asHttp(error);
        return json(200, { run: publicRun(data as ImportRun) });
      }

      if (route === 'step' || route === 'pause') {
        if (typeof body.runId !== 'string' || !UUID.test(body.runId)) {
          throw new HttpError(400, 'bad_request', 'Falta la importación.');
        }
        if (route === 'pause') {
          const { data, error } = await userRpc('social_import_pause', { p_run_id: body.runId });
          if (error) throw asHttp(error);
          return json(200, { run: publicRun(data as ImportRun) });
        }
        const step = deps.step(body.runId, user.userId);
        if (!step) {
          throw new HttpError(503, 'not_configured', 'La conexión con Instagram no está configurada en este entorno.');
        }
        let result: StepResult;
        try {
          result = await step;
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === '42501' || code === '28000') throw new HttpError(403, 'forbidden', (e as Error).message);
          if (code === 'P0001') throw new HttpError(409, 'refused', (e as Error).message);
          throw e;
        }
        return json(200, {
          outcome: result.outcome,
          run: publicRun(result.run),
          message: result.message ?? null,
          retryAfterSeconds: result.retryAfterSeconds ?? null,
        });
      }
      throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message } });
      log('unexpected', { message: e instanceof Error ? e.message.slice(0, 200) : 'desconocido' });
      return json(500, { error: { code: 'internal', message: 'No se pudo completar la operación.' } });
    }
  };
}
