// El capturador de métricas (Fase 5): atiende un trabajo `analytics.capture`
// de la cola y guarda las cifras de una cuenta de Instagram y de las
// publicaciones que hizo la plataforma.
//
//   * Cuenta: seguidores (valor del momento) y, por cada día UTC de la ventana,
//     las métricas diarias del catálogo con metric_type=total_value. La
//     ventana repasa los 3 últimos días completos (Meta corrige las cifras
//     hasta 48 h después) y, la primera vez, recupera hasta 28 días.
//   * Publicaciones: el acumulado de cada métrica de las publicaciones de los
//     últimos 60 días, un valor por día de captura.
//   * Nunca se duplica: la base de datos guarda una fila por cuenta (o
//     publicación), métrica y día, y una captura nueva del mismo día la
//     actualiza (`analytics_record_capture`).
//   * Lo que la red no da (lista vacía) NO es un cero: no se guarda y queda
//     anotado en la pasada como «no se pudo medir». Una métrica que la red
//     rechaza se pide por separado para no perder las demás.
//   * Límites: si Meta declara un uso alto del límite de llamadas
//     (X-Business-Use-Case-Usage) o responde con un error de límite, se guarda
//     lo capturado y el trabajo se aplaza sin gastar intento. Token caducado:
//     la cuenta pasa a «hay que volver a conectarla» y no se reintenta.
import type { RpcClient } from '../ai/contract.ts';
import { SocialApiError } from '../social/contract.ts';
import { decryptToken, tokenBinding, TokenKeyError, type TokenKeyRing } from '../social/crypto.ts';
import type { ApiUsage, InstagramInsightsApi } from './insights-graph.ts';

export const ANALYTICS_CAPTURE_JOB_KIND = 'analytics.capture';
/** Días que se recuperan la primera vez que se mide una cuenta. */
export const CAPTURE_BACKFILL_DAYS = 28;
/** Días completos que se vuelven a pedir en cada pasada (Meta corrige hasta 48 h después). */
export const CAPTURE_REFRESH_DAYS = 3;
/** Publicaciones como mucho por pasada (las más recientes). */
export const MAX_MEDIA_PER_RUN = 50;
/** Uso del límite de llamadas (en %) a partir del cual se para y se deja para luego. */
export const USAGE_STOP_PERCENT = 80;
/** Espera tras un error de límite de llamadas sin plazo declarado. */
export const RATE_LIMIT_WAIT_SECONDS = 900;

export interface CaptureJob {
  id: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface CaptureDeps {
  rpc: RpcClient;
  api: InstagramInsightsApi;
  keyRing: TokenKeyRing;
  workerName: string;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type CaptureOutcome = 'succeeded' | 'partial' | 'failed' | 'skipped' | 'deferred' | 'error';

export interface CaptureResult {
  outcome: CaptureOutcome;
  accountId: string | null;
  accountRows: number;
  mediaRows: number;
  apiCalls: number;
  errorCode?: string;
}

interface MetricSpec {
  id: string;
  scope: 'account' | 'media';
  api_name: string;
  api_source: 'insights' | 'field';
  media_types: string[];
}

interface BeginReady {
  outcome: 'ready';
  account: { id: string; brand_id: string; network: string; external_id: string; token_expires_at: string | null };
  last_metric_date: string | null;
  media: Array<{ publication_id: string; external_id: string; format: string; published_at: string }>;
  metrics: MetricSpec[];
}

export interface Unavailable {
  metric_id: string;
  reason: 'no_data' | 'some_days_missing' | 'unsupported' | 'stopped';
  message: string;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Días (UTC, AAAA-MM-DD) que toca pedir, del más antiguo al más reciente. */
export function captureWindow(lastMetricDate: string | null, nowMs: number): string[] {
  const today = dayStart(isoDay(nowMs));
  const earliest = today - CAPTURE_BACKFILL_DAYS * DAY_MS;
  const refresh = today - CAPTURE_REFRESH_DAYS * DAY_MS;
  const last = lastMetricDate ? dayStart(lastMetricDate) : NaN;
  const from = Number.isFinite(last) ? Math.max(earliest, Math.min(last, refresh)) : earliest;
  const days: string[] = [];
  for (let t = from; t < today; t += DAY_MS) days.push(isoDay(t));
  return days;
}

class StopCapture extends Error {
  constructor(
    readonly seconds: number,
    message: string,
  ) {
    super(message);
  }
}

export async function processCaptureJob(job: CaptureJob, deps: CaptureDeps): Promise<CaptureResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const accountId = typeof job.payload.account_id === 'string' ? job.payload.account_id : '';
  const startedAt = new Date(now()).toISOString();
  let apiCalls = 0;

  async function rpcOk<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await deps.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }
  const completeJob = (result: Record<string, unknown>) =>
    rpcOk('complete_job', { p_job_id: job.id, p_worker: deps.workerName, p_result: result }).catch((e) =>
      log('complete_job_failed', { jobId: job.id, message: (e as Error).message }),
    );
  const failJob = (message: string, retry: boolean) =>
    rpcOk('fail_job', { p_job_id: job.id, p_worker: deps.workerName, p_error: message, p_retry: retry }).catch((e) =>
      log('fail_job_failed', { jobId: job.id, message: (e as Error).message }),
    );

  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    await failJob('Trabajo sin cuenta', false);
    return { outcome: 'error', accountId: null, accountRows: 0, mediaRows: 0, apiCalls };
  }

  let begin: { outcome: string; reason?: string } & Partial<BeginReady>;
  try {
    begin = await rpcOk('analytics_capture_begin', { p_account_id: accountId });
  } catch (e) {
    log('begin_failed', { accountId, message: (e as Error).message });
    await failJob('No se pudo preparar la captura', true);
    return { outcome: 'error', accountId, accountRows: 0, mediaRows: 0, apiCalls };
  }
  if (begin.outcome !== 'ready') {
    // Desconectada, pendiente de volver a conectar o red sin capturador: nada que medir.
    await completeJob({ outcome: 'skipped', reason: begin.reason ?? null });
    return { outcome: 'skipped', accountId, accountRows: 0, mediaRows: 0, apiCalls };
  }
  const ready = begin as BeginReady;
  const account = ready.account;
  const days = captureWindow(ready.last_metric_date, now());
  const today = isoDay(now());

  const accountRows: Array<{ metric_id: string; date: string; value: number }> = [];
  const mediaRows: Array<{ external_id: string; metric_id: string; date: string; value: number }> = [];
  const unavailable: Unavailable[] = [];

  async function record(status: 'succeeded' | 'partial' | 'failed', errorCode?: string, errorMessage?: string) {
    return rpcOk<{ account_rows: number; media_rows: number }>('analytics_record_capture', {
      p_account_id: account.id,
      p_job_id: job.id,
      p_status: status,
      p_started_at: startedAt,
      p_window_from: days[0] ?? null,
      p_window_to: days[days.length - 1] ?? null,
      p_account_rows: accountRows,
      p_media_rows: mediaRows,
      p_unavailable: unavailable,
      p_api_calls: apiCalls,
      p_error_code: errorCode ?? null,
      p_error_message: errorMessage ?? null,
    });
  }

  const checkUsage = (usage: ApiUsage | null) => {
    if (!usage) return;
    const top = Math.max(usage.callCount, usage.totalCputime, usage.totalTime);
    if (top >= USAGE_STOP_PERCENT) {
      throw new StopCapture(
        Math.max(RATE_LIMIT_WAIT_SECONDS, usage.regainMinutes * 60),
        `Meta declara un uso del ${Math.round(top)} % de su límite de llamadas: se sigue más tarde.`,
      );
    }
  };

  /** Pide un lote de métricas; si la red rechaza el lote, las pide de una en una y aparta las rechazadas. */
  async function fetchBatch(
    names: string[],
    call: (metrics: string[]) => Promise<{ values: Record<string, number | null>; usage: ApiUsage | null }>,
    rejected: Map<string, string>,
  ): Promise<Record<string, number | null>> {
    const wanted = names.filter((n) => !rejected.has(n));
    if (!wanted.length) return {};
    try {
      apiCalls += 1;
      const r = await call(wanted);
      checkUsage(r.usage);
      return r.values;
    } catch (e) {
      if (!(e instanceof SocialApiError) || e.kind !== 'rejected' || wanted.length === 1) {
        if (e instanceof SocialApiError && e.kind === 'rejected' && wanted.length === 1) {
          rejected.set(wanted[0]!, e.message);
          return {};
        }
        throw e;
      }
    }
    const values: Record<string, number | null> = {};
    for (const name of wanted) {
      try {
        apiCalls += 1;
        const r = await call([name]);
        checkUsage(r.usage);
        values[name] = r.values[name] ?? null;
      } catch (e) {
        if (e instanceof SocialApiError && e.kind === 'rejected') rejected.set(name, e.message);
        else throw e;
      }
    }
    return values;
  }

  try {
    if (account.token_expires_at && Date.parse(account.token_expires_at) <= now()) {
      throw new SocialApiError({ kind: 'token', message: 'El token de la cuenta ha caducado' });
    }
    const secret = await rpcOk<{ key_id: string; access_token_ciphertext: string } | null>('social_account_token', {
      p_account_id: account.id,
    });
    if (!secret) throw new SocialApiError({ kind: 'token', message: 'La cuenta no tiene token' });
    const token = await decryptToken(
      deps.keyRing,
      secret.key_id,
      secret.access_token_ciphertext,
      tokenBinding({ brandId: account.brand_id, network: account.network, externalId: account.external_id }),
    );
    const ig = account.external_id;

    // 1. Seguidores (valor del momento).
    const followers = ready.metrics.find((m) => m.scope === 'account' && m.api_source === 'field');
    if (followers) {
      apiCalls += 1;
      const r = await deps.api.accountFields(ig, token);
      if (r.followersCount === null) {
        unavailable.push({
          metric_id: followers.id,
          reason: 'no_data',
          message: 'Meta no dio el número de seguidores.',
        });
      } else {
        accountRows.push({ metric_id: followers.id, date: today, value: r.followersCount });
      }
      checkUsage(r.usage);
    }

    // 2. Métricas diarias de la cuenta, día a día.
    const daily = ready.metrics.filter((m) => m.scope === 'account' && m.api_source === 'insights');
    const idOf = new Map(daily.map((m) => [m.api_name, m.id]));
    const rejectedAccount = new Map<string, string>();
    const got = new Map<string, number>();
    for (const day of days) {
      const since = dayStart(day) / 1000;
      const values = await fetchBatch(
        daily.map((m) => m.api_name),
        (metrics) => deps.api.accountInsights(ig, token, metrics, since, since + 86_400),
        rejectedAccount,
      );
      for (const [name, value] of Object.entries(values)) {
        const id = idOf.get(name);
        if (!id || value === null) continue;
        accountRows.push({ metric_id: id, date: day, value });
        got.set(id, (got.get(id) ?? 0) + 1);
      }
    }
    for (const m of daily) {
      const rejection = rejectedAccount.get(m.api_name);
      if (rejection) {
        unavailable.push({ metric_id: m.id, reason: 'unsupported', message: `Meta rechazó la métrica: ${rejection}` });
      } else if (days.length && !got.get(m.id)) {
        unavailable.push({ metric_id: m.id, reason: 'no_data', message: 'Meta no dio cifras para estos días.' });
      } else if (days.length && (got.get(m.id) ?? 0) < days.length) {
        unavailable.push({
          metric_id: m.id,
          reason: 'some_days_missing',
          message: `Sin cifra en ${days.length - (got.get(m.id) ?? 0)} de ${days.length} días.`,
        });
      }
    }

    // 3. Publicaciones de la plataforma (acumulado de cada una, un valor por día de captura).
    const mediaMetrics = ready.metrics.filter((m) => m.scope === 'media' && m.api_source === 'insights');
    const rejectedMedia = { FEED: new Map<string, string>(), REELS: new Map<string, string>() };
    for (const media of ready.media.slice(0, MAX_MEDIA_PER_RUN)) {
      const kind = media.format === 'reel' ? 'REELS' : 'FEED';
      const specs = mediaMetrics.filter((m) => m.media_types.includes(kind));
      const ids = new Map(specs.map((m) => [m.api_name, m.id]));
      const values = await fetchBatch(
        specs.map((m) => m.api_name),
        (metrics) => deps.api.mediaInsights(media.external_id, token, metrics),
        rejectedMedia[kind],
      );
      for (const [name, value] of Object.entries(values)) {
        const id = ids.get(name);
        if (id && value !== null) mediaRows.push({ external_id: media.external_id, metric_id: id, date: today, value });
      }
    }
    for (const kind of ['FEED', 'REELS'] as const) {
      for (const [name, message] of rejectedMedia[kind]) {
        const spec = mediaMetrics.find((m) => m.api_name === name);
        if (spec)
          unavailable.push({
            metric_id: spec.id,
            reason: 'unsupported',
            message: `Meta rechazó la métrica: ${message}`,
          });
      }
    }

    const saved = await record('succeeded');
    await completeJob({ outcome: 'succeeded', ...saved });
    return {
      outcome: 'succeeded',
      accountId: account.id,
      accountRows: saved.account_rows,
      mediaRows: saved.media_rows,
      apiCalls,
    };
  } catch (e) {
    return handleFailure(e);
  }

  async function handleFailure(e: unknown): Promise<CaptureResult> {
    const base = { accountId: account.id, apiCalls };
    const wrote = accountRows.length + mediaRows.length > 0;
    try {
      if (e instanceof StopCapture || (e instanceof SocialApiError && e.kind === 'rate_limited')) {
        const seconds = e instanceof StopCapture ? e.seconds : RATE_LIMIT_WAIT_SECONDS;
        const message =
          e instanceof StopCapture ? e.message : 'Meta pide esperar (límite de llamadas). Se sigue más tarde.';
        const saved = await record(wrote ? 'partial' : 'failed', 'rate_limited', message);
        await rpcOk('analytics_defer_job', {
          p_job_id: job.id,
          p_worker: deps.workerName,
          p_seconds: Math.min(86_400, seconds),
          p_message: message,
        });
        return {
          ...base,
          outcome: 'deferred',
          accountRows: saved.account_rows,
          mediaRows: saved.media_rows,
          errorCode: 'rate_limited',
        };
      }
      if (e instanceof SocialApiError && e.kind === 'token') {
        await rpcOk('social_account_report', {
          p_account_id: account.id,
          p_status: 'needs_reauth',
          p_last_error: e.message,
        }).catch(() => undefined);
        const message =
          'El acceso a la cuenta ha caducado o se ha retirado: vuelve a conectarla en Marca → Cuentas conectadas.';
        const saved = await record(wrote ? 'partial' : 'failed', 'token_expired', message);
        await failJob(message, false);
        return {
          ...base,
          outcome: wrote ? 'partial' : 'failed',
          accountRows: saved.account_rows,
          mediaRows: saved.media_rows,
          errorCode: 'token_expired',
        };
      }
      if (e instanceof TokenKeyError) {
        const saved = await record(
          'failed',
          'token_unreadable',
          `No se puede leer el token de la cuenta: ${e.message}`,
        );
        await failJob('No se puede leer el token de la cuenta', false);
        return {
          ...base,
          outcome: 'failed',
          accountRows: saved.account_rows,
          mediaRows: saved.media_rows,
          errorCode: 'token_unreadable',
        };
      }
      const code = e instanceof SocialApiError ? e.kind : 'unexpected';
      const message = e instanceof SocialApiError ? `No se pudo medir: ${e.message}` : 'Error inesperado al medir.';
      log('capture_failed', { accountId: account.id, code });
      const saved = await record(wrote ? 'partial' : 'failed', code, message);
      // Lo transitorio se reintenta con la espera creciente de la cola.
      await failJob(message, code === 'transient' || code === 'unexpected');
      return {
        ...base,
        outcome: wrote ? 'partial' : 'failed',
        accountRows: saved.account_rows,
        mediaRows: saved.media_rows,
        errorCode: code,
      };
    } catch (inner) {
      log('failure_handling_failed', { accountId: account.id, message: (inner as Error)?.message });
      await failJob('No se pudo registrar la captura', true);
      return { ...base, outcome: 'error', accountRows: 0, mediaRows: 0 };
    }
  }
}
