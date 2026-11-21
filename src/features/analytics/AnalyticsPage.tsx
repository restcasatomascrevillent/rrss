import { cleanText } from '@/lib/texts';
import { BarChart3, Download, FileText, Lightbulb, Link2, Ruler, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LinkButton,
  Notice,
  PageHeader,
  Select,
  Skeleton,
} from '@/components/ui';
import { AiErrorNotice } from '@/features/ai/AiErrorNotice';
import { summarizeAnalytics, type AnalyticsSummaryResult } from '@/features/ai/api';
import { useBrand, useOrg } from '@/features/orgs/context';
import { connectedAccountsPath } from '@/features/social/links';
import type { AnalyticsReportStatus } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import {
  analyze,
  dailySeries,
  formatNumber,
  formatPct,
  lastDays,
  monthPeriod,
  previousPeriod,
  type Analysis,
  type MetricTotal,
  type Period,
  type RankedPost,
} from '../../../supabase/functions/_shared/analytics/analyst';
import {
  latestUnavailable,
  reportDownloadUrl,
  useAccountPoints,
  useAnalyticsAccounts,
  useCaptureRuns,
  useMediaSummary,
  useMetricDefinitions,
  useReports,
  useRequestReport,
} from './api';
import { BarChart } from './BarChart';
import { useFeature } from '@/features/platform/integrations/useFeature';

type RangeKey = 'last7' | 'last28' | 'thisMonth' | 'lastMonth';
const RANGES: Record<RangeKey, string> = {
  last7: 'Últimos 7 días',
  last28: 'Últimos 28 días',
  thisMonth: 'Este mes',
  lastMonth: 'Mes anterior',
};

const isoToday = () => new Date().toISOString().slice(0, 10);

function periodFor(key: RangeKey): Period {
  if (key === 'last7') return lastDays(7);
  if (key === 'last28') return lastDays(28);
  const thisMonth = monthPeriod(isoToday());
  return key === 'thisMonth' ? thisMonth : previousPeriod(thisMonth);
}

const shortDate = (day: string) => day.split('-').reverse().join('/');
const periodText = (p: Period) => {
  const last = new Date(Date.parse(`${p.to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return `${shortDate(p.from)} – ${shortDate(last)}`;
};
const monthLabel = (day: string) =>
  new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

const REPORT_STATUS: Record<
  AnalyticsReportStatus,
  { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' }
> = {
  queued: { label: 'Preparando las cifras', tone: 'neutral' },
  rendering: { label: 'Dibujando el PDF', tone: 'primary' },
  ready: { label: 'Listo', tone: 'success' },
  failed: { label: 'Falló', tone: 'danger' },
};

/** Panel de analítica de la marca (Fase 5): cifras medidas, comparación, publicaciones, dato frente a hipótesis. */
export function AnalyticsPage() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const aiText = useFeature('aiText');
  const [range, setRange] = useState<RangeKey>('last28');
  const period = useMemo(() => periodFor(range), [range]);
  const previous = useMemo(() => previousPeriod(period), [period]);

  const definitions = useMetricDefinitions();
  const points = useAccountPoints(brand.id, previous.from, period.to);
  const media = useMediaSummary(brand.id, period);
  const previousMedia = useMediaSummary(brand.id, previous);
  const accounts = useAnalyticsAccounts(brand.id);
  const runs = useCaptureRuns(brand.id);
  const queries = [definitions, points, media, previousMedia, accounts, runs];

  const analysis = useMemo<Analysis | null>(() => {
    if (!definitions.data || !points.data || !media.data || !previousMedia.data || !accounts.data || !runs.data)
      return null;
    return analyze({
      definitions: definitions.data,
      points: points.data,
      media: media.data,
      previousMedia: previousMedia.data,
      period,
      previous,
      unavailable: latestUnavailable(runs.data),
      accounts: accounts.data,
    });
  }, [definitions.data, points.data, media.data, previousMedia.data, accounts.data, runs.data, period, previous]);

  const failed = queries.find((q) => q.error);
  // Sin cuenta no hay nada que medir: ni periodo ni informes, solo el botón para conectarla.
  const hasAccount = Boolean(accounts.data?.length);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Analítica"
        description="Cifras medidas en las redes de la marca. Lo que es interpretación se marca como tal, y lo que no se puede medir se dice."
        action={
          hasAccount && (
            <Select
              aria-label="Periodo"
              value={range}
              onChange={(e) => setRange(e.target.value as RangeKey)}
              data-testid="analytics-range"
            >
              {Object.entries(RANGES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          )
        }
      />
      {failed ? (
        <ErrorState error={failed.error} onRetry={() => queries.forEach((q) => void q.refetch())} />
      ) : !analysis ? (
        <Skeleton className="h-64" />
      ) : !accounts.data?.length ? (
        <Card>
          <EmptyState
            icon={BarChart3}
            title="Todavía no hay nada que medir"
            description={
              can('manage')
                ? 'Conecta la cuenta de Instagram de la marca. Las cifras se recogen una vez al día: las primeras llegan al día siguiente.'
                : 'Cuando quien gestiona la marca conecte su cuenta de Instagram, las cifras llegarán al día siguiente.'
            }
            action={
              can('manage') && (
                <LinkButton to={connectedAccountsPath(org.id, brand.id)} size="md" data-testid="analytics-connect">
                  <Link2 className="h-4 w-4" aria-hidden />
                  Conectar Instagram
                </LinkButton>
              )
            }
          />
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted">
            Periodo: <strong className="text-fg">{periodText(period)}</strong> · comparado con {periodText(previous)} ·
            días contados con la hora universal (una o dos horas menos que en España).
          </p>
          <Kpis totals={analysis.totals} />
          <Evolution analysis={analysis} points={points.data ?? []} />
          <Comparison analysis={analysis} />
          <Posts analysis={analysis} />
          <Summary
            analysis={analysis}
            brandId={brand.id}
            period={period}
            aiAvailable={aiText && brand.ai_mode !== 'agency' && can('edit')}
          />
          <Unmeasurable analysis={analysis} />
          <Captures runs={runs.data ?? []} />
        </>
      )}
      {hasAccount && <Reports brandId={brand.id} canEdit={can('edit')} />}
    </div>
  );
}

function Change({ total }: { total: MetricTotal }) {
  if (total.changePct === null) {
    return (
      <span className="text-xs text-muted">{total.previous === null ? 'sin periodo anterior' : 'sin comparación'}</span>
    );
  }
  const tone = total.changePct > 0 ? 'success' : total.changePct < 0 ? 'danger' : 'neutral';
  return <Badge tone={tone}>{formatPct(total.changePct)}</Badge>;
}

function Kpis({ totals }: { totals: MetricTotal[] }) {
  const measured = totals.filter((t) => t.value !== null);
  if (!measured.length) {
    return (
      <Notice>
        Todavía no hay cifras de este periodo. Las capturas son diarias y Meta tarda hasta 48 horas en dar algunas.
      </Notice>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="analytics-kpis">
      {measured.map((t) => (
        <Card key={t.metricId} className="p-4" data-testid={`kpi-${t.metricId}`}>
          <p className="text-xs text-muted">{t.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(t.value!)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Change total={t} />
            {t.estimated && <Badge>Estimación de Meta</Badge>}
            {t.provisional && <Badge tone="warning">Provisional</Badge>}
            {t.aggregation === 'daily' && t.daysWithData < t.days && (
              <span className="text-xs text-muted">
                {t.daysWithData} de {t.days} días
              </span>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function Evolution({ analysis, points }: { analysis: Analysis; points: Parameters<typeof dailySeries>[0] }) {
  const options = analysis.totals.filter((t) => t.value !== null);
  const [metric, setMetric] = useState(
    options.find((t) => t.metricId === 'instagram.account.reach')?.metricId ?? options[0]?.metricId ?? '',
  );
  const selected = options.find((t) => t.metricId === metric) ?? options[0];
  if (!selected) return null;
  return (
    <Card>
      <CardHeader
        title="Evolución"
        description={
          selected.aggregation === 'snapshot' ? 'Valor de cada día en que se capturó.' : 'Cifra de cada día.'
        }
        action={
          <Select aria-label="Métrica" value={selected.metricId} onChange={(e) => setMetric(e.target.value)}>
            {options.map((t) => (
              <option key={t.metricId} value={t.metricId}>
                {t.label}
              </option>
            ))}
          </Select>
        }
      />
      <CardBody>
        <BarChart
          title={selected.label}
          points={dailySeries(points, selected.metricId, analysis.period)}
          testId="analytics-chart"
        />
      </CardBody>
    </Card>
  );
}

function Comparison({ analysis }: { analysis: Analysis }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader
          title="Comparación entre periodos"
          description="Este periodo frente al anterior de la misma duración."
        />
        <CardBody className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="analytics-comparison">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-medium">Métrica</th>
                <th className="py-1 text-right font-medium">Ahora</th>
                <th className="py-1 text-right font-medium">Antes</th>
                <th className="py-1 text-right font-medium">Cambio</th>
              </tr>
            </thead>
            <tbody>
              {analysis.totals.map((t) => (
                <tr key={t.metricId} className="border-t border-border">
                  <td className="py-1.5">{t.label}</td>
                  <td className="py-1.5 text-right tabular-nums">{t.value === null ? '—' : formatNumber(t.value)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {t.previous === null ? '—' : formatNumber(t.previous)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {t.changePct === null ? '—' : formatPct(t.changePct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">«—»: no hay cifra (no se trata como cero).</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Comparación entre redes" />
        <CardBody>
          <ul className="space-y-3" data-testid="analytics-networks">
            {analysis.byNetwork.map((n) => (
              <li key={n.network}>
                <p className="font-medium">{n.label}</p>
                {n.measured ? (
                  <p className="text-sm text-muted">
                    {n.totals
                      .filter((t) => t.value !== null)
                      .slice(0, 4)
                      .map((t) => `${t.label}: ${formatNumber(t.value!)}`)
                      .join(' · ')}
                  </p>
                ) : (
                  <p className="text-sm text-muted">{n.note}</p>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function PostList({ posts, testId }: { posts: RankedPost[]; testId: string }) {
  if (!posts.length) return <p className="text-sm text-muted">No hay publicaciones suficientes para comparar.</p>;
  return (
    <ol className="space-y-2" data-testid={testId}>
      {posts.map((p) => (
        <li key={`${p.publication_id}-${p.title}`} className="flex items-start justify-between gap-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{p.title}</p>
            <p className="text-xs text-muted">
              {p.media_product_type === 'REELS' ? 'Reel' : 'Imagen o carrusel'} ·{' '}
              {shortDate(p.published_at.slice(0, 10))}
              {p.external_url && (
                <>
                  {' · '}
                  <a href={p.external_url} target="_blank" rel="noreferrer" className="underline">
                    Ver en la red
                  </a>
                </>
              )}
            </p>
          </div>
          <span className="shrink-0 tabular-nums">
            {formatNumber(p.score)} {p.scoreMetric.endsWith('total_interactions') ? 'interacciones' : 'de alcance'}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Posts({ analysis }: { analysis: Analysis }) {
  const { posts, byFormat } = analysis;
  return (
    <Card>
      <CardHeader
        title="Publicaciones"
        description={`Hechas con la plataforma en el periodo: ${posts.count} (antes: ${posts.previousCount}). Cifras acumuladas de cada una hasta su última captura.`}
      />
      <CardBody className="grid gap-6 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-sm font-medium">Mejores</h3>
          <PostList posts={posts.best} testId="analytics-best-posts" />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Con menos respuesta</h3>
          <PostList posts={posts.worst} testId="analytics-worst-posts" />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">Por formato</h3>
          <ul className="space-y-1 text-sm">
            {byFormat.map((f) => (
              <li key={f.format}>
                {f.label}: {f.posts}
                {f.avgInteractions !== null && ` · ${formatNumber(f.avgInteractions)} interacciones de media`}
              </li>
            ))}
          </ul>
        </div>
      </CardBody>
    </Card>
  );
}

function Summary({
  analysis,
  brandId,
  period,
  aiAvailable,
}: {
  analysis: Analysis;
  brandId: string;
  period: Period;
  aiAvailable: boolean;
}) {
  const [ai, setAi] = useState<AnalyticsSummaryResult | null>(null);
  const [aiError, setAiError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const factText = new Map(analysis.facts.map((f) => [f.id, f.text]));
  const askAi = async () => {
    setBusy(true);
    setAiError(null);
    try {
      setAi(await summarizeAnalytics(brandId, period));
    } catch (error) {
      setAiError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Resumen del analista"
        description="Sin IA: reglas fijas sobre las cifras medidas. Un dato es una cifra; una interpretación, una explicación posible."
        action={
          aiAvailable && analysis.hasData ? (
            <Button variant="secondary" onClick={() => void askAi()} disabled={busy} data-testid="analytics-ai">
              <Sparkles className="h-4 w-4" aria-hidden />
              {busy ? 'Interpretando…' : 'Interpretar con IA'}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-5">
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Ruler className="h-4 w-4" aria-hidden /> Datos
          </h3>
          <ul className="space-y-1.5 text-sm" data-testid="analytics-facts">
            {analysis.facts.map((f) => (
              <li key={f.id} className="flex gap-2">
                <Badge>Dato</Badge>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Lightbulb className="h-4 w-4" aria-hidden /> Interpretaciones
          </h3>
          <ul className="space-y-1.5 text-sm" data-testid="analytics-hypotheses">
            {analysis.hypotheses.length === 0 && (
              <li className="text-muted">
                Con estas cifras no hay ninguna interpretación que merezca la pena proponer.
              </li>
            )}
            {analysis.hypotheses.map((h) => (
              <li key={h.id} className="flex gap-2">
                <Badge tone="warning">Interpretación</Badge>
                <span>{h.text}</span>
              </li>
            ))}
          </ul>
          <ul className="mt-3 space-y-1 text-xs text-muted" data-testid="analytics-caveats">
            {analysis.caveats.map((c) => (
              <li key={c}>· {c}</li>
            ))}
          </ul>
        </section>
        {aiError ? <AiErrorNotice error={aiError} onRetry={() => void askAi()} /> : null}
        {ai && (
          <section data-testid="analytics-ai-hypotheses">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4" aria-hidden /> Interpretaciones propuestas por la IA
            </h3>
            <p className="mb-2 text-xs text-muted">
              La IA solo ha recibido los datos de arriba. Lo que propone son interpretaciones, no cifras ni
              conclusiones.
              {ai.discarded > 0 && ` Se han descartado ${ai.discarded} por no apoyarse en ningún dato.`}
            </p>
            {ai.hypotheses.length === 0 ? (
              <p className="text-sm text-muted">La IA no ha encontrado ninguna interpretación útil con estos datos.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {ai.hypotheses.map((h) => (
                  <li key={h.id}>
                    <div className="flex gap-2">
                      <Badge tone="warning">Interpretación (IA)</Badge>
                      <span>{h.text}</span>
                    </div>
                    <p className="ml-1 mt-0.5 text-xs text-muted">
                      Se apoya en: {h.basedOn.map((id) => factText.get(id) ?? id).join(' / ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </CardBody>
    </Card>
  );
}

/** Una línea por métrica: si la misma (p. ej. «Impresiones», de la cuenta y de las publicaciones) sale dos veces, se juntan sus motivos. */
function groupUnmeasurable(list: Analysis['unmeasurable']): Array<{ id: string; label: string; reason: string }> {
  const byLabel = new Map<string, { id: string; label: string; reasons: string[] }>();
  for (const u of list) {
    const label = cleanText(u.label);
    const reason = cleanText(u.reason);
    const found = byLabel.get(label);
    if (!found) byLabel.set(label, { id: u.id, label, reasons: reason ? [reason] : [] });
    else if (reason && !found.reasons.includes(reason)) found.reasons.push(reason);
  }
  return [...byLabel.values()].map((g) => ({ id: g.id, label: g.label, reason: g.reasons.join(' ') }));
}

function Unmeasurable({ analysis }: { analysis: Analysis }) {
  return (
    <Card>
      <CardHeader
        title="Lo que no se puede medir"
        description="Métricas que la red no da, que retiró o que todavía no tienen cifra."
      />
      <CardBody>
        <ul className="space-y-1.5 text-sm" data-testid="analytics-unmeasurable">
          {groupUnmeasurable(analysis.unmeasurable).map((u) => (
            <li key={u.id}>
              <strong className="font-medium">{u.label}:</strong> <span className="text-muted">{u.reason}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

const RUN_LABEL = { succeeded: 'Completa', partial: 'Parcial', failed: 'Fallida', skipped: 'Sin medir' } as const;

function Captures({ runs }: { runs: Parameters<typeof latestUnavailable>[0] }) {
  const latest = runs.filter((r, i) => runs.findIndex((x) => x.social_account_id === r.social_account_id) === i);
  return (
    <p className="text-xs text-muted" data-testid="analytics-captures">
      {latest.length === 0
        ? 'Todavía no se ha capturado ninguna cifra: la primera captura llega en la próxima hora en punto y diecisiete.'
        : latest
            .map(
              (r) =>
                `Última captura: ${new Date(r.finished_at).toLocaleString('es-ES')} (${RUN_LABEL[r.status]}${r.error_message ? `: ${r.error_message}` : ''})`,
            )
            .join(' · ')}
    </p>
  );
}

function Reports({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const reports = useReports(brandId);
  const request = useRequestReport(brandId);
  const months = useMemo(() => {
    const out: string[] = [];
    let p = previousPeriod(monthPeriod(isoToday()));
    for (let i = 0; i < 12; i++) {
      out.push(p.from);
      p = previousPeriod(p);
    }
    return out;
  }, []);
  const [month, setMonth] = useState(months[0]!);
  const download = async (path: string) => {
    try {
      window.open(await reportDownloadUrl(path), '_blank', 'noopener');
    } catch (error) {
      toast.error(translateError(error));
    }
  };
  return (
    <Card>
      <CardHeader
        title="Informes mensuales"
        description="Se generan solos el día 3 de cada mes con el mes anterior y quedan en la biblioteca (carpeta «Informes»)."
        action={
          canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Mes del informe" value={month} onChange={(e) => setMonth(e.target.value)}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                disabled={request.isPending}
                data-testid="analytics-request-report"
                onClick={async () => {
                  try {
                    await request.mutateAsync(month);
                    toast.success('Informe pedido: estará en unos minutos.');
                  } catch (error) {
                    toast.error(translateError(error));
                  }
                }}
              >
                <FileText className="h-4 w-4" aria-hidden />
                Generar informe
              </Button>
            </div>
          ) : undefined
        }
      />
      <CardBody>
        {reports.error ? (
          <ErrorState error={reports.error} onRetry={() => void reports.refetch()} />
        ) : !reports.data ? (
          <Skeleton className="h-16" />
        ) : reports.data.length === 0 ? (
          <p className="text-sm text-muted">Todavía no hay informes.</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="analytics-reports">
            {reports.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="font-medium first-letter:uppercase">{monthLabel(r.period_start)}</p>
                  <p className="text-xs text-muted">
                    {r.source === 'schedule' ? 'Automático' : 'Pedido a mano'}
                    {r.revision > 1 && ` · versión ${r.revision}`}
                    {r.error && ` · ${r.error}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={REPORT_STATUS[r.status].tone}>{REPORT_STATUS[r.status].label}</Badge>
                  {r.status === 'ready' && r.asset && (
                    <Button
                      variant="secondary"
                      onClick={() => void download(r.asset!.storage_path)}
                      data-testid="analytics-download"
                    >
                      <Download className="h-4 w-4" aria-hidden />
                      Descargar PDF
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
