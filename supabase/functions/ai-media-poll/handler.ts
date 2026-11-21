// Lógica de la Edge Function `ai-media-poll`: reclama de la cola los trabajos
// `ai.media.poll` (generaciones asíncronas de imagen) y los avanza con
// `MediaService.processJob`: consultar al proveedor, guardar el resultado en la
// biblioteca y registrar el coste, o devolverlo a la cola con espera creciente.
//
// La dispara `pg_cron` (migración 20261118210000) cada 30 s, y solo si hay
// trabajos pendientes. SOLO con la clave de servicio: cualquier otra llamada
// recibe 401 sin que se toque la cola. No la llama nunca el navegador.
import {
  MEDIA_JOB_KIND,
  type ClaimedJob,
  type MediaJobResult,
  type MediaService,
} from '../_shared/ai/media/contract.ts';
import { timingSafeEqual } from '../_shared/ai/media/http.ts';
import type { RpcClient } from '../_shared/ai/contract.ts';

export interface AiMediaPollDeps {
  /** Claves que se aceptan: la clave de servicio del proyecto (y nada más). */
  serviceKeys: string[];
  rpc: RpcClient;
  service(): Promise<MediaService>;
  /** Nombre de este trabajador en la cola. */
  workerName: string;
  /** Trabajos por llamada. Por defecto, 5. */
  batchSize?: number;
  /** Lo que dura la reserva de cada trabajo. Por defecto, 120 s. */
  leaseSeconds?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const encoder = new TextEncoder();

/** ¿Trae la petición una de las claves aceptadas (`Authorization: Bearer` o `apikey`)? */
export function hasServiceKey(request: Request, keys: string[]): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
  const candidates = [bearer, request.headers.get('apikey')?.trim()].filter((v): v is string => Boolean(v));
  const valid = keys.filter((k) => k.length >= 20);
  return candidates.some((candidate) =>
    valid.some((key) => timingSafeEqual(encoder.encode(candidate), encoder.encode(key))),
  );
}

export function createAiMediaPollHandler(deps: AiMediaPollDeps): (request: Request) => Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  return async (request) => {
    if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    if (!hasServiceKey(request, deps.serviceKeys)) return json(401, { error: { code: 'unauthorized' } });

    const claimed = await deps.rpc('claim_jobs', {
      p_worker: deps.workerName,
      p_kinds: [MEDIA_JOB_KIND],
      p_limit: deps.batchSize ?? 5,
      p_lease_seconds: deps.leaseSeconds ?? 120,
    });
    if (claimed.error) {
      deps.log?.('claim_failed', { message: claimed.error.message });
      return json(500, { error: { code: 'internal' } });
    }
    const jobs = (Array.isArray(claimed.data) ? claimed.data : []) as ClaimedJob[];
    if (jobs.length === 0) return json(200, { processed: 0, results: [] });

    const service = await deps.service();
    const results: { jobId: string; status: MediaJobResult['status'] | 'error'; generationId?: string }[] = [];
    for (const job of jobs) {
      try {
        const result = await service.processJob(job, deps.workerName);
        results.push({ jobId: job.id, status: result.status, generationId: result.generationId || undefined });
      } catch {
        // Un fallo inesperado no tumba el lote: la reserva del trabajo caduca y
        // se vuelve a reclamar más tarde.
        deps.log?.('process_failed', { jobId: job.id });
        results.push({ jobId: job.id, status: 'error' });
      }
    }
    deps.log?.('processed', { count: jobs.length });
    return json(200, { processed: jobs.length, results });
  };
}
