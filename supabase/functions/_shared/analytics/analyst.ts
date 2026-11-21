// El analista sin IA (Fase 5): de las cifras capturadas saca un resumen que
// separa siempre
//   · DATO: una cifra medida, con su periodo y su comparación (nada más);
//   · HIPÓTESIS: una interpretación posible, con las cifras en que se apoya y
//     dicha como tal («podría…»); nunca una causa demostrada;
//   · LO QUE NO SE PUEDE MEDIR: métricas que la red no da, retiradas, sin
//     cifras, provisionales o de cuentas que hay que volver a conectar.
// Determinista: las mismas cifras dan siempre el mismo resumen. Lo usan el
// panel (navegador), la función del informe (Deno) y las pruebas (Node): por
// eso no importa nada.

export interface MetricDefinition {
  id: string;
  network: string;
  scope: 'account' | 'media';
  label: string;
  description: string;
  unit: 'count' | 'milliseconds';
  aggregation: 'daily' | 'snapshot' | 'lifetime';
  media_types: string[];
  estimated: boolean;
  in_development: boolean;
  status: 'captured' | 'not_captured' | 'retired';
  status_note: string;
  delay_hours: number;
  sort: number;
}

export interface MetricPoint {
  metric_id: string;
  /** AAAA-MM-DD (UTC). */
  date: string;
  value: number;
  provisional: boolean;
}

export interface MediaSummary {
  publication_id: string | null;
  title: string;
  format: string;
  network: string;
  media_product_type: string;
  published_at: string;
  external_url: string | null;
  provisional: boolean;
  metrics: Record<string, number>;
}

export interface UnavailableEntry {
  metric_id: string;
  reason: string;
  message: string;
}

export interface AccountInfo {
  network: string;
  username: string;
  status: string;
}

/** Periodo de días UTC: `from` incluido, `to` excluido (AAAA-MM-DD). */
export interface Period {
  from: string;
  to: string;
}

export interface AnalysisInput {
  definitions: MetricDefinition[];
  /** Cifras de cuenta del periodo y del anterior. */
  points: MetricPoint[];
  /** Publicaciones del periodo. */
  media: MediaSummary[];
  /** Publicaciones del periodo anterior (solo se cuentan). */
  previousMedia: MediaSummary[];
  period: Period;
  previous: Period;
  unavailable: UnavailableEntry[];
  accounts: AccountInfo[];
}

export interface MetricTotal {
  metricId: string;
  label: string;
  aggregation: MetricDefinition['aggregation'];
  /** Suma del periodo (diarias) o último valor (seguidores); null si no hay cifras. */
  value: number | null;
  previous: number | null;
  change: number | null;
  /** Cambio en tanto por ciento; null si no se puede calcular (sin cifra anterior o anterior en 0). */
  changePct: number | null;
  daysWithData: number;
  days: number;
  estimated: boolean;
  provisional: boolean;
}

export interface Fact {
  id: string;
  kind: 'fact';
  text: string;
  metricId?: string;
}

export interface Hypothesis {
  id: string;
  kind: 'hypothesis';
  text: string;
  /** Datos (Fact.id) en que se apoya. */
  basedOn: string[];
  rule: string;
}

export interface Unmeasurable {
  id: string;
  label: string;
  reason: string;
}

export interface RankedPost extends MediaSummary {
  score: number;
  scoreMetric: string;
}

export interface FormatStats {
  format: 'FEED' | 'REELS';
  label: string;
  posts: number;
  avgInteractions: number | null;
  avgReach: number | null;
}

export interface NetworkStats {
  network: string;
  label: string;
  measured: boolean;
  totals: MetricTotal[];
  note: string | null;
}

export interface Analysis {
  period: Period;
  previous: Period;
  totals: MetricTotal[];
  posts: { count: number; previousCount: number; best: RankedPost[]; worst: RankedPost[] };
  byFormat: FormatStats[];
  byNetwork: NetworkStats[];
  facts: Fact[];
  hypotheses: Hypothesis[];
  /** Avisos sobre la solidez de las conclusiones (muestra pequeña, datos parciales…). */
  caveats: string[];
  unmeasurable: Unmeasurable[];
  hasData: boolean;
}

const DAY = 86_400_000;
const NETWORK_LABELS: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook' };
export const INTERACTIONS_METRIC = 'instagram.media.total_interactions';
export const MEDIA_REACH_METRIC = 'instagram.media.reach';
const ACCOUNT_REACH = 'instagram.account.reach';
const FOLLOWERS = 'instagram.account.followers';

const fmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
export const formatNumber = (n: number) => fmt.format(n);
export const formatPct = (n: number) => `${n > 0 ? '+' : ''}${fmt.format(n)} %`;

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const daysIn = (p: Period) => Math.max(0, Math.round((dayMs(p.to) - dayMs(p.from)) / DAY));

/** Mes natural (UTC) que contiene el día dado. */
export function monthPeriod(day: string): Period {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return { from: isoDay(Date.UTC(y, m - 1, 1)), to: isoDay(Date.UTC(y, m, 1)) };
}

/** Periodo anterior de la misma duración; si es un mes natural, el mes anterior. */
export function previousPeriod(p: Period): Period {
  const from = new Date(dayMs(p.from));
  const isMonth = from.getUTCDate() === 1 && monthPeriod(p.from).to === p.to;
  if (isMonth) {
    return { from: isoDay(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1)), to: p.from };
  }
  return { from: isoDay(dayMs(p.from) - daysIn(p) * DAY), to: p.from };
}

/** Los últimos `days` días completos (sin hoy). */
export function lastDays(days: number, now = Date.now()): Period {
  const today = dayMs(isoDay(now));
  return { from: isoDay(today - days * DAY), to: isoDay(today) };
}

const inPeriod = (day: string, p: Period) => day >= p.from && day < p.to;

function total(
  def: MetricDefinition,
  points: MetricPoint[],
  p: Period,
): { value: number | null; days: number; provisional: boolean } {
  const rows = points
    .filter((x) => x.metric_id === def.id && inPeriod(x.date, p))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return { value: null, days: 0, provisional: false };
  const provisional = rows.some((r) => r.provisional);
  if (def.aggregation === 'snapshot') return { value: rows[rows.length - 1]!.value, days: rows.length, provisional };
  return { value: rows.reduce((s, r) => s + r.value, 0), days: new Set(rows.map((r) => r.date)).size, provisional };
}

/** Totales del periodo frente al anterior, para las métricas de cuenta que se capturan. */
export function metricTotals(
  input: Pick<AnalysisInput, 'definitions' | 'points' | 'period' | 'previous'>,
): MetricTotal[] {
  return input.definitions
    .filter((d) => d.scope === 'account' && d.status === 'captured')
    .sort((a, b) => a.sort - b.sort)
    .map((def) => {
      const now = total(def, input.points, input.period);
      const before = total(def, input.points, input.previous);
      const change = now.value !== null && before.value !== null ? now.value - before.value : null;
      return {
        metricId: def.id,
        label: def.label,
        aggregation: def.aggregation,
        value: now.value,
        previous: before.value,
        change,
        changePct: change !== null && before.value ? (change / before.value) * 100 : null,
        daysWithData: now.days,
        days: daysIn(input.period),
        estimated: def.estimated,
        provisional: now.provisional,
      };
    });
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Puntuación de una publicación: interacciones si las hay; si no, alcance. */
function score(m: MediaSummary): { score: number; metric: string } | null {
  if (typeof m.metrics[INTERACTIONS_METRIC] === 'number')
    return { score: m.metrics[INTERACTIONS_METRIC]!, metric: INTERACTIONS_METRIC };
  if (typeof m.metrics[MEDIA_REACH_METRIC] === 'number')
    return { score: m.metrics[MEDIA_REACH_METRIC]!, metric: MEDIA_REACH_METRIC };
  return null;
}

export function rankPosts(media: MediaSummary[], size = 3): { best: RankedPost[]; worst: RankedPost[] } {
  const ranked = media
    .map((m) => ({ m, s: score(m) }))
    .filter((x): x is { m: MediaSummary; s: { score: number; metric: string } } => x.s !== null)
    .map(({ m, s }) => ({ ...m, score: s.score, scoreMetric: s.metric }))
    .sort((a, b) => b.score - a.score || a.published_at.localeCompare(b.published_at));
  if (ranked.length < 2) return { best: ranked, worst: [] };
  const n = Math.min(size, Math.floor(ranked.length / 2));
  return { best: ranked.slice(0, Math.max(1, n)), worst: ranked.slice(-Math.max(1, n)).reverse() };
}

export function formatStats(media: MediaSummary[]): FormatStats[] {
  return (['FEED', 'REELS'] as const).map((format) => {
    const rows = media.filter((m) => m.media_product_type === format);
    return {
      format,
      label: format === 'REELS' ? 'Reels' : 'Imágenes y carruseles',
      posts: rows.length,
      avgInteractions: avg(
        rows.flatMap((r) =>
          typeof r.metrics[INTERACTIONS_METRIC] === 'number' ? [r.metrics[INTERACTIONS_METRIC]!] : [],
        ),
      ),
      avgReach: avg(
        rows.flatMap((r) =>
          typeof r.metrics[MEDIA_REACH_METRIC] === 'number' ? [r.metrics[MEDIA_REACH_METRIC]!] : [],
        ),
      ),
    };
  });
}

const factText = (t: MetricTotal) => {
  if (t.value === null) return `${t.label}: sin cifras en este periodo.`;
  const what = t.aggregation === 'snapshot' ? `${formatNumber(t.value)} al final del periodo` : formatNumber(t.value);
  const before =
    t.previous === null
      ? 'sin cifra del periodo anterior para comparar'
      : `periodo anterior: ${formatNumber(t.previous)}${t.changePct !== null ? `, ${formatPct(t.changePct)}` : ''}`;
  const coverage =
    t.aggregation === 'daily' && t.daysWithData < t.days ? `; con cifras de ${t.daysWithData} de ${t.days} días` : '';
  return `${t.label}: ${what} (${before}${coverage}).`;
};

export function analyze(input: AnalysisInput): Analysis {
  const totals = metricTotals(input);
  const byId = new Map(totals.map((t) => [t.metricId, t]));
  const { best, worst } = rankPosts(input.media);
  const byFormat = formatStats(input.media);
  const facts: Fact[] = [];
  const hypotheses: Hypothesis[] = [];
  const caveats: string[] = [];

  for (const t of totals) {
    if (t.value === null) continue;
    facts.push({ id: `total:${t.metricId}`, kind: 'fact', text: factText(t), metricId: t.metricId });
  }
  const posts = input.media.length;
  const previousPosts = input.previousMedia.length;
  facts.push({
    id: 'posts:count',
    kind: 'fact',
    text: `Publicaciones hechas con la plataforma: ${posts} (periodo anterior: ${previousPosts}).`,
  });
  for (const f of byFormat) {
    if (!f.posts) continue;
    facts.push({
      id: `format:${f.format}`,
      kind: 'fact',
      text: `${f.label}: ${f.posts} publicación${f.posts === 1 ? '' : 'es'}${
        f.avgInteractions !== null ? `, ${formatNumber(f.avgInteractions)} interacciones de media` : ''
      }${f.avgReach !== null ? `, ${formatNumber(f.avgReach)} de alcance de media` : ''}.`,
    });
  }
  if (best[0]) {
    facts.push({
      id: 'posts:best',
      kind: 'fact',
      text: `La publicación con más ${best[0].scoreMetric === INTERACTIONS_METRIC ? 'interacciones' : 'alcance'} fue «${best[0].title}» (${formatNumber(best[0].score)}).`,
    });
  }
  if (worst[0]) {
    facts.push({
      id: 'posts:worst',
      kind: 'fact',
      text: `La de menos ${worst[0].scoreMetric === INTERACTIONS_METRIC ? 'interacciones' : 'alcance'} fue «${worst[0].title}» (${formatNumber(worst[0].score)}).`,
    });
  }

  // ── Hipótesis (reglas fijas, dichas como posibilidad) ──
  const reach = byId.get(ACCOUNT_REACH);
  if (reach?.changePct != null && Math.abs(reach.changePct) >= 20) {
    const up = reach.changePct > 0;
    const morePosts = posts > previousPosts;
    const fewerPosts = posts < previousPosts;
    hypotheses.push({
      id: 'h:reach',
      kind: 'hypothesis',
      rule: up ? 'reach_up' : 'reach_down',
      basedOn: [`total:${ACCOUNT_REACH}`, 'posts:count'],
      text: up
        ? morePosts
          ? `El alcance subió (${formatPct(reach.changePct)}) en un periodo con más publicaciones (${posts} frente a ${previousPosts}): podría estar relacionado con publicar más.`
          : `El alcance subió (${formatPct(reach.changePct)}) sin publicar más: podría deberse a alguna publicación que circuló más de lo normal o a algo externo (temporada, menciones). Con estas cifras no se puede saber.`
        : fewerPosts
          ? `El alcance bajó (${formatPct(reach.changePct)}) en un periodo con menos publicaciones (${posts} frente a ${previousPosts}): podría estar relacionado con publicar menos.`
          : `El alcance bajó (${formatPct(reach.changePct)}) sin publicar menos: podría deberse a cambios en cómo Instagram reparte el contenido o a la temporada. Con estas cifras no se puede saber.`,
    });
  }
  const feed = byFormat.find((f) => f.format === 'FEED')!;
  const reels = byFormat.find((f) => f.format === 'REELS')!;
  if (feed.posts >= 2 && reels.posts >= 2 && feed.avgInteractions && reels.avgInteractions) {
    const ratio = reels.avgInteractions / feed.avgInteractions;
    if (ratio >= 1.5 || ratio <= 1 / 1.5) {
      const winner = ratio >= 1.5 ? reels : feed;
      const loser = ratio >= 1.5 ? feed : reels;
      hypotheses.push({
        id: 'h:format',
        kind: 'hypothesis',
        rule: 'format_gap',
        basedOn: ['format:FEED', 'format:REELS'],
        text: `${winner.label} tuvieron de media ${formatNumber(winner.avgInteractions!)} interacciones frente a ${formatNumber(loser.avgInteractions!)} de ${loser.label.toLowerCase()}: podría convenir probar más ${winner.label.toLowerCase()}. Con pocos casos puede ser casualidad.`,
      });
    }
  }
  if (posts >= 3 && best[0]) {
    const med = median(input.media.map((m) => score(m)?.score ?? 0));
    if (med > 0 && best[0].score >= 2 * med) {
      hypotheses.push({
        id: 'h:standout',
        kind: 'hypothesis',
        rule: 'standout_post',
        basedOn: ['posts:best'],
        text: `«${best[0].title}» destacó claramente (${formatNumber(best[0].score)} frente a una mediana de ${formatNumber(med)}): podría servir de referencia; conviene mirar qué tenía distinto (tema, formato, hora).`,
      });
    }
  }
  const followers = byId.get(FOLLOWERS);
  if (followers?.change != null && followers.change < 0) {
    hypotheses.push({
      id: 'h:followers',
      kind: 'hypothesis',
      rule: 'followers_down',
      basedOn: [`total:${FOLLOWERS}`],
      text: `La cuenta terminó el periodo con ${formatNumber(-followers.change)} seguidores menos que el anterior. Las cifras no dicen por qué; podría ser una limpieza de cuentas de Instagram o desinterés por algún contenido.`,
    });
  }

  // ── Avisos sobre lo sólido que es esto ──
  if (posts < 3)
    caveats.push(
      `Con ${posts} publicación${posts === 1 ? '' : 'es'} en el periodo no hay base para sacar conclusiones sobre qué funciona mejor.`,
    );
  if (totals.some((t) => t.estimated && t.value !== null)) {
    caveats.push('El alcance y las cuentas que interactuaron son estimaciones de Meta, no recuentos exactos.');
  }
  if (totals.some((t) => t.aggregation === 'daily' && t.value !== null && t.daysWithData < t.days)) {
    caveats.push('Hay días sin cifras en el periodo: los totales solo suman los días medidos.');
  }
  caveats.push(
    'Los días se cuentan con la hora universal (una o dos horas menos que en España); Instagram puede cortar el día a otra hora, así que una cifra diaria puede no coincidir exactamente con la de la aplicación.',
  );

  // ── Lo que no se puede medir ──
  const unmeasurable: Unmeasurable[] = [];
  const seen = new Set<string>();
  const label = (id: string) => input.definitions.find((d) => d.id === id)?.label ?? id;
  const add = (u: Unmeasurable) => {
    if (seen.has(u.id)) return;
    seen.add(u.id);
    unmeasurable.push(u);
  };
  if (!input.accounts.length)
    add({
      id: 'no_accounts',
      label: 'Cuentas',
      reason: 'No hay ninguna cuenta social conectada: no hay nada que medir.',
    });
  for (const a of input.accounts) {
    if (a.status === 'needs_reauth') {
      add({
        id: `account:${a.username}`,
        label: `@${a.username}`,
        reason: 'Hay que volver a conectar la cuenta: desde que caducó su acceso no se mide.',
      });
    } else if (a.status === 'disconnected') {
      add({ id: `account:${a.username}`, label: `@${a.username}`, reason: 'La cuenta está desconectada: no se mide.' });
    }
  }
  const provisional = totals.some((t) => t.provisional) || input.media.some((m) => m.provisional);
  if (provisional) {
    add({
      id: 'provisional',
      label: 'Últimos días',
      reason: 'Las cifras más recientes son provisionales: Meta puede corregirlas hasta 48 horas después.',
    });
  }
  for (const t of totals) {
    if (t.value === null) add({ id: `empty:${t.metricId}`, label: t.label, reason: 'No hay cifras de este periodo.' });
  }
  for (const u of input.unavailable) {
    if (u.reason === 'some_days_missing') continue;
    add({ id: `unavailable:${u.metric_id}`, label: label(u.metric_id), reason: u.message || 'Meta no la dio.' });
  }
  for (const d of [...input.definitions].sort((a, b) => a.sort - b.sort)) {
    if (d.status !== 'captured') add({ id: `definition:${d.id}`, label: d.label, reason: d.status_note });
  }

  // ── Comparación entre redes ──
  const networks = [...new Set(input.definitions.map((d) => d.network))];
  const byNetwork: NetworkStats[] = networks.map((network) => {
    const own = totals.filter((t) => t.metricId.startsWith(`${network}.`));
    const measured = own.some((t) => t.value !== null);
    const connected = input.accounts.some((a) => a.network === network);
    return {
      network,
      label: NETWORK_LABELS[network] ?? network,
      measured,
      totals: own,
      note: measured
        ? null
        : connected
          ? 'Sin cifras en este periodo.'
          : network === 'facebook'
            ? 'Las páginas de Facebook todavía no se conectan.'
            : 'No hay ninguna cuenta conectada de esta red.',
    };
  });

  return {
    period: input.period,
    previous: input.previous,
    totals,
    posts: { count: posts, previousCount: previousPosts, best, worst },
    byFormat,
    byNetwork,
    facts,
    hypotheses,
    caveats,
    unmeasurable,
    hasData: totals.some((t) => t.value !== null) || posts > 0,
  };
}

/** Serie diaria de una métrica de cuenta en el periodo (null en los días sin cifra). */
export function dailySeries(
  points: MetricPoint[],
  metricId: string,
  p: Period,
): Array<{ date: string; value: number | null }> {
  const byDay = new Map(points.filter((x) => x.metric_id === metricId).map((x) => [x.date, x.value]));
  const out: Array<{ date: string; value: number | null }> = [];
  for (let t = dayMs(p.from); t < dayMs(p.to); t += DAY) {
    const d = isoDay(t);
    out.push({ date: d, value: byDay.has(d) ? byDay.get(d)! : null });
  }
  return out;
}
