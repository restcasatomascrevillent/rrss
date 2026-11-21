// El analista sin IA: totales, comparación, dato frente a hipótesis y lo que
// no se puede medir. Determinista: mismas cifras, mismo resumen.
import { describe, expect, it } from 'vitest';
import {
  analyze,
  dailySeries,
  monthPeriod,
  previousPeriod,
  rankPosts,
  type AnalysisInput,
  type MediaSummary,
  type MetricDefinition,
} from '../../../supabase/functions/_shared/analytics/analyst';

const def = (id: string, label: string, patch: Partial<MetricDefinition> = {}): MetricDefinition => ({
  id,
  network: id.split('.')[0]!,
  scope: id.includes('.media.') ? 'media' : 'account',
  label,
  description: '',
  unit: 'count',
  aggregation: 'daily',
  media_types: [],
  estimated: false,
  in_development: false,
  status: 'captured',
  status_note: '',
  delay_hours: 48,
  sort: 10,
  ...patch,
});

const DEFS = [
  def('instagram.account.followers', 'Seguidores', { aggregation: 'snapshot', sort: 1 }),
  def('instagram.account.reach', 'Alcance', { estimated: true, sort: 2 }),
  def('instagram.account.total_interactions', 'Interacciones', { sort: 3 }),
  def('instagram.account.impressions', 'Impresiones', {
    status: 'retired',
    status_note: 'Retirada por Meta.',
    sort: 9,
  }),
  def('facebook.account.all', 'Facebook', { status: 'not_captured', status_note: 'No se conecta todavía.', sort: 99 }),
];

const post = (title: string, kind: 'FEED' | 'REELS', interactions: number, reach = 100): MediaSummary => ({
  publication_id: title,
  title,
  format: kind === 'REELS' ? 'reel' : 'post',
  network: 'instagram',
  media_product_type: kind,
  published_at: '2026-11-05T10:00:00Z',
  external_url: null,
  provisional: false,
  metrics: { 'instagram.media.total_interactions': interactions, 'instagram.media.reach': reach },
});

function input(patch: Partial<AnalysisInput> = {}): AnalysisInput {
  const period = monthPeriod('2026-11-10');
  const previous = previousPeriod(period);
  const points = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    points.push({ metric_id: 'instagram.account.reach', date: day, value: 200, provisional: d >= 29 });
    points.push({
      metric_id: 'instagram.account.reach',
      date: `2026-10-${String(d).padStart(2, '0')}`,
      value: 100,
      provisional: false,
    });
  }
  points.push({ metric_id: 'instagram.account.followers', date: '2026-10-31', value: 1000, provisional: false });
  points.push({ metric_id: 'instagram.account.followers', date: '2026-11-30', value: 990, provisional: false });
  return {
    definitions: DEFS,
    points,
    media: [
      post('A', 'FEED', 10),
      post('B', 'FEED', 12),
      post('C', 'REELS', 40),
      post('D', 'REELS', 44),
      post('E', 'REELS', 200),
    ],
    previousMedia: [post('X', 'FEED', 5)],
    period,
    previous,
    unavailable: [
      { metric_id: 'instagram.account.total_interactions', reason: 'no_data', message: 'Meta no dio cifras.' },
    ],
    accounts: [{ network: 'instagram', username: 'marca', status: 'active' }],
    ...patch,
  };
}

describe('periodos', () => {
  it('mes natural y el anterior; periodo libre y el anterior de la misma duración', () => {
    expect(monthPeriod('2026-03-15')).toEqual({ from: '2026-03-01', to: '2026-04-01' });
    expect(previousPeriod({ from: '2026-03-01', to: '2026-04-01' })).toEqual({ from: '2026-02-01', to: '2026-03-01' });
    expect(previousPeriod({ from: '2026-01-01', to: '2026-02-01' })).toEqual({ from: '2025-12-01', to: '2026-01-01' });
    expect(previousPeriod({ from: '2026-03-10', to: '2026-03-17' })).toEqual({ from: '2026-03-03', to: '2026-03-10' });
  });

  it('la serie diaria deja en null los días sin cifra (no los convierte en cero)', () => {
    const s = dailySeries([{ metric_id: 'm', date: '2026-03-02', value: 5, provisional: false }], 'm', {
      from: '2026-03-01',
      to: '2026-03-04',
    });
    expect(s).toEqual([
      { date: '2026-03-01', value: null },
      { date: '2026-03-02', value: 5 },
      { date: '2026-03-03', value: null },
    ]);
  });
});

describe('analizar', () => {
  it('totales: suma de los días medidos, último valor de los seguidores, y su cambio', () => {
    const a = analyze(input());
    const reach = a.totals.find((t) => t.metricId === 'instagram.account.reach')!;
    expect(reach).toMatchObject({
      value: 6000,
      previous: 3000,
      change: 3000,
      changePct: 100,
      daysWithData: 30,
      days: 30,
      provisional: true,
    });
    const followers = a.totals.find((t) => t.metricId === 'instagram.account.followers')!;
    expect(followers).toMatchObject({ value: 990, previous: 1000, change: -10 });
    // Sin cifras: null, nunca cero.
    expect(a.totals.find((t) => t.metricId === 'instagram.account.total_interactions')!.value).toBeNull();
  });

  it('los datos son cifras; las hipótesis citan los datos en que se apoyan', () => {
    const a = analyze(input());
    expect(a.facts.every((f) => f.kind === 'fact')).toBe(true);
    expect(a.facts.map((f) => f.text)).toContain('Alcance: 6000 (periodo anterior: 3000, +100 %).');
    const ids = new Set(a.facts.map((f) => f.id));
    expect(a.hypotheses.length).toBeGreaterThan(0);
    for (const h of a.hypotheses) {
      expect(h.kind).toBe('hypothesis');
      expect(h.basedOn.every((id) => ids.has(id))).toBe(true);
      expect(h.text).toMatch(/podría|puede|no se puede saber|no dicen/i);
    }
    expect(a.hypotheses.map((h) => h.rule).sort()).toEqual([
      'followers_down',
      'format_gap',
      'reach_up',
      'standout_post',
    ]);
  });

  it('dice lo que no se puede medir: retiradas, no capturadas, sin cifras, provisionales y lo que Meta no dio', () => {
    const a = analyze(input());
    const reasons = a.unmeasurable.map((u) => `${u.label}: ${u.reason}`).join('\n');
    expect(reasons).toMatch(/Impresiones: Retirada por Meta/);
    expect(reasons).toMatch(/Facebook: No se conecta todavía/);
    expect(reasons).toMatch(/Interacciones: No hay cifras de este periodo/);
    expect(reasons).toMatch(/provisionales/);
    expect(a.byNetwork.find((n) => n.network === 'facebook')).toMatchObject({ measured: false });
  });

  it('con pocas publicaciones lo avisa y no propone hipótesis sobre formatos', () => {
    const a = analyze(input({ media: [post('A', 'REELS', 50)] }));
    expect(a.caveats[0]).toMatch(/1 publicación.*no hay base/);
    expect(a.hypotheses.find((h) => h.rule === 'format_gap')).toBeUndefined();
  });

  it('sin cuentas ni cifras no inventa nada', () => {
    const a = analyze(input({ points: [], media: [], previousMedia: [], accounts: [], unavailable: [] }));
    expect(a.hasData).toBe(false);
    expect(a.hypotheses).toEqual([]);
    expect(a.unmeasurable[0]).toMatchObject({ id: 'no_accounts' });
  });

  it('es determinista', () => {
    expect(analyze(input())).toEqual(analyze(input()));
  });
});

describe('mejores y peores publicaciones', () => {
  it('ordena por interacciones y no repite la misma en las dos listas', () => {
    const { best, worst } = rankPosts([
      post('A', 'FEED', 1),
      post('B', 'FEED', 9),
      post('C', 'FEED', 5),
      post('D', 'FEED', 3),
    ]);
    expect(best.map((p) => p.title)).toEqual(['B', 'C']);
    expect(worst.map((p) => p.title)).toEqual(['A', 'D']);
    expect(rankPosts([post('A', 'FEED', 1)])).toEqual({ best: [expect.objectContaining({ title: 'A' })], worst: [] });
  });
});
