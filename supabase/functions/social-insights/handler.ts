// Lógica de la Edge Function `social-insights` (Fase 5): reclama de la cola
// los trabajos de analítica y los atiende:
//   analytics.capture  mide una cuenta (../_shared/analytics/capture.ts);
//   analytics.report   prepara el informe mensual de una marca y encola su
//                      PDF para el trabajador de medios (../_shared/analytics/report.ts).
//
// La dispara pg_cron cada hora (migración 20261119630000), solo si hay algo
// que hacer. SOLO con la clave de servicio: cualquier otra llamada recibe 401
// sin tocar la cola. El navegador no la llama nunca.
import type { RpcClient } from '../_shared/ai/contract.ts';
import { ANALYTICS_CAPTURE_JOB_KIND, processCaptureJob, type CaptureDeps } from '../_shared/analytics/capture.ts';
import { ANALYTICS_REPORT_JOB_KIND, processReportJob } from '../_shared/analytics/report.ts';
import { hasServiceKey } from '../ai-media-poll/handler.ts';

interface ClaimedJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface SocialInsightsDeps {
  serviceKeys: string[];
  rpc: RpcClient;
  /** Lo que el capturador necesita, salvo la cola (null si falta configuración: no se reclaman capturas). */
  capture(): Omit<CaptureDeps, 'rpc' | 'workerName'> | null;
  workerName: string;
  /** Trabajos por llamada. Por defecto, 5. */
  batchSize?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export function createSocialInsightsHandler(deps: SocialInsightsDeps): (request: Request) => Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

  return async (request) => {
    if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
    if (!hasServiceKey(request, deps.serviceKeys)) return json(401, { error: { code: 'unauthorized' } });

    const capture = deps.capture();
    if (!capture) deps.log?.('capture_not_configured', {});
    // Sin configuración de Meta no se reclaman capturas (se quedan en la cola); los informes sí.
    const kinds = capture ? [ANALYTICS_CAPTURE_JOB_KIND, ANALYTICS_REPORT_JOB_KIND] : [ANALYTICS_REPORT_JOB_KIND];
    const claimed = await deps.rpc('claim_jobs', {
      p_worker: deps.workerName,
      p_kinds: kinds,
      p_limit: deps.batchSize ?? 5,
      p_lease_seconds: 600,
    });
    if (claimed.error) {
      deps.log?.('claim_failed', { message: claimed.error.message });
      return json(500, { error: { code: 'internal' } });
    }
    const jobs = (Array.isArray(claimed.data) ? claimed.data : []) as ClaimedJob[];
    const results: Array<{ jobId: string; kind: string; outcome: string }> = [];
    for (const job of jobs) {
      try {
        if (job.kind === ANALYTICS_CAPTURE_JOB_KIND && capture) {
          const r = await processCaptureJob(job, { ...capture, rpc: deps.rpc, workerName: deps.workerName });
          results.push({ jobId: job.id, kind: job.kind, outcome: r.outcome });
        } else if (job.kind === ANALYTICS_REPORT_JOB_KIND) {
          const r = await processReportJob(job, {
            rpc: deps.rpc,
            workerName: deps.workerName,
            now: deps.now,
            log: deps.log,
          });
          results.push({ jobId: job.id, kind: job.kind, outcome: r.outcome });
        }
      } catch {
        // Un fallo inesperado no tumba el lote: la reserva caduca y se reintenta.
        deps.log?.('process_failed', { jobId: job.id, kind: job.kind });
        results.push({ jobId: job.id, kind: job.kind, outcome: 'error' });
      }
    }
    deps.log?.('processed', { count: results.length });
    return json(200, { processed: results.length, results });
  };
}
