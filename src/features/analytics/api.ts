import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnalyticsCaptureRunRow,
  AnalyticsMediaSummaryRow,
  AnalyticsMetricDefinitionRow,
  AnalyticsReportRow,
  SocialAccountRow,
} from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { signStoragePaths } from '@/features/storage/api';
import type {
  AccountInfo,
  MediaSummary,
  MetricDefinition,
  MetricPoint,
  Period,
  UnavailableEntry,
} from '../../../supabase/functions/_shared/analytics/analyst';

// Acceso a datos de la analítica (Fase 5). Las cifras las captura el servidor
// (`social-insights`, migraciones 20261119610000 a 20261119630000): aquí solo
// se leen, con la RLS de la marca. Nada se calcula en la base de datos para el
// panel salvo el resumen de publicaciones (`analytics_media_summary`).

export const analyticsKeys = {
  definitions: () => ['analytics', 'definitions'] as const,
  points: (brandId: string, from: string, to: string) => ['brand', brandId, 'analytics', 'points', from, to] as const,
  media: (brandId: string, from: string, to: string) => ['brand', brandId, 'analytics', 'media', from, to] as const,
  runs: (brandId: string) => ['brand', brandId, 'analytics', 'runs'] as const,
  accounts: (brandId: string) => ['brand', brandId, 'analytics', 'accounts'] as const,
  reports: (brandId: string) => ['brand', brandId, 'analytics', 'reports'] as const,
};

/** La base de datos devuelve `numeric` como texto o como número: se pasa a número. */
const num = (v: number | string) => (typeof v === 'number' ? v : Number(v));

export function useMetricDefinitions() {
  return useQuery({
    queryKey: analyticsKeys.definitions(),
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<MetricDefinition[]> =>
      (
        unwrap(
          await supabase.from('analytics_metric_definitions').select('*').order('sort', { ascending: true }),
        ) as AnalyticsMetricDefinitionRow[]
      ).map((d) => ({ ...d, media_types: d.media_types ?? [] })),
  });
}

/** Cifras diarias de las cuentas de la marca entre dos días (AAAA-MM-DD, `to` excluido). */
export function useAccountPoints(brandId: string, from: string, to: string) {
  return useQuery({
    queryKey: analyticsKeys.points(brandId, from, to),
    queryFn: async (): Promise<MetricPoint[]> => {
      const rows = unwrap(
        await supabase
          .from('account_metrics_daily')
          .select('metric_id, metric_date, value, provisional')
          .eq('brand_id', brandId)
          .gte('metric_date', from)
          .lt('metric_date', to)
          .order('metric_date', { ascending: true }),
      ) as Array<{ metric_id: string; metric_date: string; value: number | string; provisional: boolean }>;
      return rows.map((r) => ({
        metric_id: r.metric_id,
        date: r.metric_date,
        value: num(r.value),
        provisional: r.provisional,
      }));
    },
  });
}

/** Publicaciones de la plataforma salidas en el periodo, con su última cifra de cada métrica. */
export function useMediaSummary(brandId: string, period: Period) {
  return useQuery({
    queryKey: analyticsKeys.media(brandId, period.from, period.to),
    queryFn: async (): Promise<MediaSummary[]> => {
      const rows = unwrap(
        await supabase.rpc('analytics_media_summary', {
          p_brand_id: brandId,
          p_from: `${period.from}T00:00:00Z`,
          p_to: `${period.to}T00:00:00Z`,
        }),
      ) as AnalyticsMediaSummaryRow[];
      return rows.map((r) => ({
        publication_id: r.publication_id,
        title: r.title,
        format: r.format,
        network: r.network,
        media_product_type: r.media_product_type,
        published_at: r.published_at,
        external_url: r.external_url,
        provisional: r.provisional,
        metrics: Object.fromEntries(Object.entries(r.metrics ?? {}).map(([k, v]) => [k, num(v)])),
      }));
    },
  });
}

export function useAnalyticsAccounts(brandId: string) {
  return useQuery({
    queryKey: analyticsKeys.accounts(brandId),
    queryFn: async (): Promise<AccountInfo[]> =>
      (
        unwrap(
          await supabase
            .from('social_accounts')
            .select('id, network, username, status')
            .eq('brand_id', brandId)
            .order('created_at', { ascending: true }),
        ) as Pick<SocialAccountRow, 'network' | 'username' | 'status'>[]
      ).map((a) => ({ network: a.network, username: a.username, status: a.status })),
  });
}

/** Últimas pasadas del capturador en la marca (para «última captura» y lo que no se pudo medir). */
export function useCaptureRuns(brandId: string) {
  return useQuery({
    queryKey: analyticsKeys.runs(brandId),
    queryFn: async (): Promise<AnalyticsCaptureRunRow[]> =>
      unwrap(
        await supabase
          .from('analytics_capture_runs')
          .select('*')
          .eq('brand_id', brandId)
          .order('started_at', { ascending: false })
          .limit(30),
      ) as AnalyticsCaptureRunRow[],
  });
}

/** Lo que no se pudo medir según la última pasada de cada cuenta. */
export function latestUnavailable(runs: AnalyticsCaptureRunRow[]): UnavailableEntry[] {
  const seen = new Set<string>();
  const out: UnavailableEntry[] = [];
  for (const run of runs) {
    if (seen.has(run.social_account_id)) continue;
    seen.add(run.social_account_id);
    out.push(...(Array.isArray(run.unavailable) ? run.unavailable : []));
  }
  return out;
}

// ── Informes ─────────────────────────────────────────────────────────────

export type ReportWithAsset = AnalyticsReportRow & { asset: { storage_path: string; file_name: string } | null };

export function useReports(brandId: string) {
  return useQuery({
    queryKey: analyticsKeys.reports(brandId),
    // Mientras se prepara alguno, se vuelve a mirar cada 15 s.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => r.status === 'queued' || r.status === 'rendering') ? 15_000 : false,
    queryFn: async (): Promise<ReportWithAsset[]> => {
      const reports = unwrap(
        await supabase
          .from('analytics_reports')
          .select('*')
          .eq('brand_id', brandId)
          .order('period_start', { ascending: false })
          .limit(24),
      ) as AnalyticsReportRow[];
      const ids = reports.flatMap((r) => (r.media_asset_id ? [r.media_asset_id] : []));
      const assets = ids.length
        ? (unwrap(await supabase.from('media_assets').select('id, storage_path, file_name').in('id', ids)) as Array<{
            id: string;
            storage_path: string;
            file_name: string;
          }>)
        : [];
      return reports.map((r) => ({ ...r, asset: assets.find((a) => a.id === r.media_asset_id) ?? null }));
    },
  });
}

export function useRequestReport(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (periodStart: string) =>
      unwrap(await supabase.rpc('request_analytics_report', { p_brand_id: brandId, p_period_start: periodStart })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: analyticsKeys.reports(brandId) }),
  });
}

/** Dirección temporal (1 h) para descargar el PDF del informe. */
export async function reportDownloadUrl(storagePath: string): Promise<string> {
  // En Supabase Storage o en Cloudflare R2, según dónde lo guardó el trabajador.
  const url = await signStoragePaths([storagePath], 3600, { download: true })
    .then((map) => map.get(storagePath))
    .catch(() => undefined);
  if (!url) throw new Error('No se pudo preparar la descarga. Inténtalo de nuevo.');
  return url;
}
