// Lógica de la Edge Function `social-publish`: reclama de la cola los trabajos
// `social.publish` y los publica (../_shared/social/publisher.ts); después
// comprueba, una vez al día por cuenta, que los tokens siguen valiendo.
//
// La dispara pg_cron cada minuto (migración 20261119040000), solo si hay algo
// que hacer. SOLO con la clave de servicio: cualquier otra llamada recibe 401
// sin tocar la cola.
//
// Excepción: `POST …/social-publish/now` («Publicar ahora», migración
// 20261130010000). La llama el navegador con la SESIÓN de la persona: la base de
// datos comprueba que edita la marca de esa publicación (publication_publish_kick),
// la vuelve a encolar (misma clave de idempotencia que el reloj) y entonces se
// procesa la cola al momento, sin esperar al minuto. El cerrojo de
// social_publication_begin hace que el reloj y esta llamada no la publiquen dos
// veces. Esta ruta no adelanta nada: solo procesa lo que ya está vencido.
//
// Por qué una Edge Function y no el trabajador de medios: publicar es hablar
// con la API de Meta (segundos, sin CPU), necesita los secretos de Meta y la
// clave de cifrado de los tokens, que viven en las funciones, y el reloj ya es
// pg_cron → función, como el sondeo de imagen. El vídeo de un reel no se
// espera en la función: si Instagram aún lo procesa, el trabajo se aplaza un
// minuto sin gastar intento.
import type { RpcClient } from '../_shared/ai/contract.ts';
import { SOCIAL_PUBLISH_JOB_KIND, type ClaimedSocialJob } from '../_shared/social/contract.ts';
import { processPublishJob, type PublisherDeps, type PublishResult } from '../_shared/social/publisher.ts';
import { hasServiceKey } from '../ai-media-poll/handler.ts';

export interface SocialPublishDeps {
  serviceKeys: string[];
  rpc: RpcClient;
  /** Lo que el publicador necesita, salvo la cola (null si falta configuración). */
  publisher(): Omit<PublisherDeps, 'rpc' | 'workerName'> | null;
  /** Cuentas vivas cuyo token no se ha comprobado en 24 h. */
  accountsToCheck(): Promise<Array<{ id: string; brand_id: string; network: string; external_id: string }>>;
  checkTokens(accounts: Array<{ id: string; brand_id: string; network: string; external_id: string }>): Promise<number>;
  workerName: string;
  /** RPC con la sesión de la persona (su JWT), para la ruta `/now`. Sin ella, la ruta no existe. */
  userRpc?(accessToken: string): RpcClient;
  /** Origen permitido para CORS en `/now` (por defecto, cualquiera: la sesión va en cabecera, no en cookie). */
  allowedOrigin?: string;
  /** Trabajos por llamada. Por defecto, 5. */
  batchSize?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

type BatchResult = Pick<PublishResult, 'outcome' | 'publicationId' | 'errorCode'> & { jobId: string };

export function createSocialPublishHandler(deps: SocialPublishDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });

  /** Reclama de la cola y publica un lote. `failed`: no se pudo ni reclamar. */
  async function processBatch(): Promise<{ results: BatchResult[]; failed: boolean }> {
    const results: BatchResult[] = [];
    const publisher = deps.publisher();
    if (!publisher) {
      deps.log?.('not_configured', {});
      return { results, failed: false };
    }
    const claimed = await deps.rpc('claim_jobs', {
      p_worker: deps.workerName,
      p_kinds: [SOCIAL_PUBLISH_JOB_KIND],
      p_limit: deps.batchSize ?? 5,
      p_lease_seconds: 300,
    });
    if (claimed.error) {
      deps.log?.('claim_failed', { message: claimed.error.message });
      return { results, failed: true };
    }
    const jobs = (Array.isArray(claimed.data) ? claimed.data : []) as ClaimedSocialJob[];
    for (const job of jobs) {
      try {
        const r = await processPublishJob(job, { ...publisher, rpc: deps.rpc, workerName: deps.workerName });
        results.push({ jobId: job.id, outcome: r.outcome, publicationId: r.publicationId, errorCode: r.errorCode });
      } catch {
        // Un fallo inesperado no tumba el lote: la reserva caduca y se reintenta.
        deps.log?.('process_failed', { jobId: job.id });
        results.push({ jobId: job.id, outcome: 'error', publicationId: null });
      }
    }
    return { results, failed: false };
  }

  /** «Publicar ahora»: con la sesión de la persona, encola lo suyo y procesa la cola al momento. */
  async function publishNow(request: Request): Promise<Response> {
    if (!deps.userRpc) return json(404, { error: { code: 'not_found' } });
    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
    if (!token) return json(401, { error: { code: 'unauthorized', message: 'Hace falta iniciar sesión.' } });
    let publicationId: unknown;
    try {
      publicationId = ((await request.json()) as { publicationId?: unknown } | null)?.publicationId;
    } catch {
      return json(400, { error: { code: 'bad_request', message: 'Cuerpo no válido.' } });
    }
    if (typeof publicationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(publicationId)) {
      return json(400, { error: { code: 'bad_request', message: 'Falta la publicación.' } });
    }
    const kick = await deps.userRpc(token)('publication_publish_kick', { p_publication_id: publicationId });
    if (kick.error) {
      const denied = kick.error.code === '42501' || kick.error.code === '28000';
      deps.log?.('now_rejected', { code: kick.error.code ?? null });
      return json(denied ? 403 : 400, {
        error: { code: denied ? 'forbidden' : 'rejected', message: 'No tienes permiso para publicar esto.' },
      });
    }
    const batch = await processBatch();
    if (batch.failed) return json(500, { error: { code: 'internal' } });
    deps.log?.('now_processed', { count: batch.results.length });
    return json(200, { status: kick.data, processed: batch.results.length, results: batch.results });
  }

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.endsWith('/now')) {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    if (url.pathname.endsWith('/now')) return publishNow(request);
    if (!hasServiceKey(request, deps.serviceKeys)) return json(401, { error: { code: 'unauthorized' } });

    const batch = await processBatch();
    if (batch.failed) return json(500, { error: { code: 'internal' } });
    const results = batch.results;

    let checked = 0;
    try {
      checked = await deps.checkTokens(await deps.accountsToCheck());
    } catch {
      deps.log?.('token_check_failed', {});
    }
    deps.log?.('processed', { count: results.length, checked });
    return json(200, { processed: results.length, results, tokensChecked: checked });
  };
}
