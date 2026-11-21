// Informe mensual (Fase 5): atiende un trabajo `analytics.report`. Lee las
// cifras del mes y del anterior (`analytics_report_source`), las pasa por el
// analista sin IA y deja el documento listo para que el trabajador de medios
// dibuje el PDF (`analytics_report_render` encola `media.report.pdf`).
//
// El documento es la única entrada del dibujo: textos ya redactados, cifras ya
// formateadas y series de los gráficos. El trabajador no decide nada.
import type { RpcClient } from '../ai/contract.ts';
import {
  analyze,
  dailySeries,
  formatNumber,
  formatPct,
  type Analysis,
  type MediaSummary,
  type MetricDefinition,
  type MetricPoint,
  type Period,
  type UnavailableEntry,
} from './analyst.ts';

export const ANALYTICS_REPORT_JOB_KIND = 'analytics.report';
/** Versión del documento que entiende el trabajador (worker/src/handlers/report-pdf.ts). */
export const REPORT_DOCUMENT_VERSION = 1;

export interface ReportSource {
  report: { id: string; revision: number; status: string; source: string };
  brand: { id: string; name: string; timezone: string };
  period: { start: string; end: string; previous_start: string };
  visual: {
    colors: Array<{ name?: string; hex?: string; role?: string }>;
    logo: { path: string; mime_type: string } | null;
  };
  accounts: Array<{ id: string; network: string; username: string; status: string }>;
  definitions: MetricDefinition[];
  account_metrics: Array<{
    account_id: string;
    metric_id: string;
    date: string;
    value: number | string;
    provisional: boolean;
  }>;
  media: Array<Omit<MediaSummary, 'metrics'> & { metrics: Record<string, number | string> }>;
  unavailable: Array<UnavailableEntry & { times: number }>;
  capture_errors: Array<{ error_code: string; message: string; times: number }>;
}

export interface ReportDocument {
  version: typeof REPORT_DOCUMENT_VERSION;
  brandName: string;
  colors: { primary: string; secondary: string };
  title: string;
  periodLabel: string;
  previousLabel: string;
  generatedAt: string;
  kpis: Array<{ label: string; value: string; change: string | null; note: string | null }>;
  charts: Array<{ title: string; points: Array<{ label: string; value: number | null }> }>;
  posts: { title: string; columns: string[]; rows: string[][] }[];
  sections: Array<{ title: string; kind: 'facts' | 'hypotheses' | 'caveats' | 'unmeasurable'; items: string[] }>;
  footer: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const NEUTRAL = { primary: '#1F2937', secondary: '#6B7280' };

/** Colores del informe: el que el perfil marca como principal (o el primero) y el siguiente. */
export function reportColors(colors: ReportSource['visual']['colors']): { primary: string; secondary: string } {
  const valid = colors.filter((c) => typeof c.hex === 'string' && HEX.test(c.hex.trim()));
  if (!valid.length) return NEUTRAL;
  const main = valid.find((c) => /princip|primar|primary|main/i.test(c.role ?? '')) ?? valid[0]!;
  const second = valid.find((c) => c !== main);
  return {
    primary: main.hex!.trim().toUpperCase(),
    secondary: (second?.hex ?? NEUTRAL.secondary).trim().toUpperCase(),
  };
}

const monthName = (day: string) =>
  new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const shortDay = (day: string) => `${Number(day.slice(8, 10))}`;

/** Convierte lo que da la base de datos (numeric llega como texto) en la entrada del analista. */
export function analysisFromSource(source: ReportSource): Analysis {
  const period: Period = { from: source.period.start, to: source.period.end };
  const previous: Period = { from: source.period.previous_start, to: source.period.start };
  const points: MetricPoint[] = source.account_metrics.map((p) => ({
    metric_id: p.metric_id,
    date: String(p.date).slice(0, 10),
    value: Number(p.value),
    provisional: Boolean(p.provisional),
  }));
  const media: MediaSummary[] = source.media.map((m) => ({
    ...m,
    published_at: String(m.published_at),
    metrics: Object.fromEntries(Object.entries(m.metrics).map(([k, v]) => [k, Number(v)])),
  }));
  const day = (iso: string) => iso.slice(0, 10);
  return analyze({
    definitions: source.definitions,
    points,
    media: media.filter((m) => day(m.published_at) >= period.from && day(m.published_at) < period.to),
    previousMedia: media.filter((m) => day(m.published_at) >= previous.from && day(m.published_at) < previous.to),
    period,
    previous,
    unavailable: source.unavailable,
    accounts: source.accounts,
  });
}

export function buildReportDocument(source: ReportSource, analysis: Analysis, now: number): ReportDocument {
  const period = analysis.period;
  const points: MetricPoint[] = source.account_metrics.map((p) => ({
    metric_id: p.metric_id,
    date: String(p.date).slice(0, 10),
    value: Number(p.value),
    provisional: Boolean(p.provisional),
  }));
  const chart = (metricId: string, title: string) => ({
    title,
    points: dailySeries(points, metricId, period).map((x) => ({ label: shortDay(x.date), value: x.value })),
  });
  const kpis = analysis.totals
    .filter((t) => t.value !== null)
    .slice(0, 8)
    .map((t) => ({
      label: t.label,
      value: formatNumber(t.value!),
      change:
        t.changePct !== null
          ? `${formatPct(t.changePct)} frente al mes anterior`
          : t.previous === null
            ? 'sin mes anterior'
            : null,
      note:
        [
          t.estimated ? 'estimación de Meta' : null,
          t.daysWithData < t.days && t.aggregation === 'daily' ? `${t.daysWithData} de ${t.days} días` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
    }));
  const postRows = (list: Analysis['posts']['best']) =>
    list.map((p) => [
      p.title.slice(0, 60),
      p.media_product_type === 'REELS' ? 'Reel' : 'Imagen',
      p.published_at.slice(0, 10).split('-').reverse().join('/'),
      formatNumber(p.metrics['instagram.media.reach'] ?? 0),
      formatNumber(p.metrics['instagram.media.total_interactions'] ?? 0),
    ]);
  const columns = ['Pieza', 'Formato', 'Fecha', 'Alcance', 'Interacciones'];
  return {
    version: REPORT_DOCUMENT_VERSION,
    brandName: source.brand.name,
    colors: reportColors(source.visual.colors),
    title: 'Informe de redes sociales',
    periodLabel: monthName(period.from),
    previousLabel: monthName(analysis.previous.from),
    generatedAt: new Date(now).toISOString(),
    kpis,
    charts: [
      chart('instagram.account.reach', 'Alcance diario (Instagram)'),
      chart('instagram.account.total_interactions', 'Interacciones diarias (Instagram)'),
    ],
    posts: [
      { title: 'Mejores publicaciones del mes', columns, rows: postRows(analysis.posts.best) },
      { title: 'Publicaciones con menos respuesta', columns, rows: postRows(analysis.posts.worst) },
    ].filter((t) => t.rows.length > 0),
    sections: [
      { title: 'Datos (cifras medidas)', kind: 'facts' as const, items: analysis.facts.map((f) => f.text) },
      {
        title: 'Hipótesis (interpretaciones posibles, no demostradas)',
        kind: 'hypotheses' as const,
        items: analysis.hypotheses.length
          ? analysis.hypotheses.map((h) => h.text)
          : ['Con estas cifras no hay ninguna interpretación que merezca la pena proponer.'],
      },
      { title: 'Antes de sacar conclusiones', kind: 'caveats' as const, items: analysis.caveats },
      {
        title: 'Lo que no se puede medir',
        kind: 'unmeasurable' as const,
        items: [
          ...analysis.unmeasurable.map((u) => `${u.label}: ${u.reason}`),
          ...source.capture_errors.map((e) => `Capturas con problemas (${e.times}): ${e.message}`),
        ],
      },
    ].filter((s) => s.items.length > 0),
    footer: `${source.brand.name} · ${monthName(period.from)} · Generado automáticamente el ${new Date(now).toISOString().slice(0, 10).split('-').reverse().join('/')} con cifras de la API de Meta.`,
  };
}

export interface ReportJob {
  id: string;
  payload: Record<string, unknown>;
}

export interface ReportDeps {
  rpc: RpcClient;
  workerName: string;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type ReportOutcome = 'rendering' | 'stale' | 'error';

export async function processReportJob(
  job: ReportJob,
  deps: ReportDeps,
): Promise<{ outcome: ReportOutcome; reportId: string | null }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const reportId = typeof job.payload.report_id === 'string' ? job.payload.report_id : '';
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await deps.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
  const failJob = (message: string, retry: boolean) =>
    call('fail_job', { p_job_id: job.id, p_worker: deps.workerName, p_error: message, p_retry: retry }).catch((e) =>
      log('fail_job_failed', { jobId: job.id, message: (e as Error).message }),
    );
  try {
    const source = await call<ReportSource>('analytics_report_source', { p_report_id: reportId });
    if (source.report.status !== 'queued' || source.report.revision !== Number(job.payload.revision)) {
      await call('complete_job', { p_job_id: job.id, p_worker: deps.workerName, p_result: { outcome: 'stale' } });
      return { outcome: 'stale', reportId };
    }
    const analysis = analysisFromSource(source);
    const document = buildReportDocument(source, analysis, now());
    await call('analytics_report_render', {
      p_report_id: reportId,
      p_job_id: job.id,
      p_document: document,
      p_summary: {
        facts: analysis.facts,
        hypotheses: analysis.hypotheses,
        caveats: analysis.caveats,
        unmeasurable: analysis.unmeasurable,
      },
    });
    await call('complete_job', { p_job_id: job.id, p_worker: deps.workerName, p_result: { outcome: 'rendering' } });
    return { outcome: 'rendering', reportId };
  } catch (e) {
    log('report_failed', { reportId, message: (e as Error).message });
    await failJob(`No se pudo preparar el informe: ${(e as Error).message}`.slice(0, 900), true);
    return { outcome: 'error', reportId };
  }
}
