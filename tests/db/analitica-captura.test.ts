// Analítica (Fase 5): captura de métricas contra las migraciones reales y la
// Graph API SIMULADA. Las cifras guardadas tienen que ser exactamente las que
// da la red (la simulada es determinista), sin duplicar, con la fecha de
// captura y su definición; lo que la red no da no se convierte en un cero.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANALYTICS_CAPTURE_JOB_KIND,
  CAPTURE_BACKFILL_DAYS,
  captureWindow,
  processCaptureJob,
  type CaptureDeps,
} from '../../supabase/functions/_shared/analytics/capture.ts';
import { createInsightsGraph, parseUsageHeader } from '../../supabase/functions/_shared/analytics/insights-graph.ts';
import {
  simulatedAccountValue,
  simulatedFollowers,
  simulatedMediaValue,
} from '../../supabase/functions/_shared/analytics/simulated-insights.ts';
import {
  createSimulatedGraph,
  SIMULATED_IG_USER_ID,
  type SimulatedGraph,
} from '../../supabase/functions/_shared/social/simulated-graph.ts';
import { KEYS, socialKit } from './apoyo-analitica';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  type Db,
  type TestUser,
} from './helpers';

let db: Db;
let kit: ReturnType<typeof socialKit>;
let ana: TestUser, editor: TestUser, lector: TestUser, ajena: TestUser;
let org: string, marca: string, cuenta: string;
let post: string, reel: string;
// Una sola Graph API simulada para publicar y medir: lo publicado es lo que se mide.
let graph: SimulatedGraph;

const WORKER = 'pruebas:social-insights';
const TOKEN = 'sim-page-analitica-1';
const today = () => new Date().toISOString().slice(0, 10);

type Job = { id: string; payload: Record<string, unknown>; attempts: number; max_attempts: number };

function deps(extra: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    rpc: kit.rpc,
    api: createInsightsGraph({ fetch: graph.fetch }),
    keyRing: KEYS,
    workerName: WORKER,
    ...extra,
  };
}

/** Encola (idempotente por día) y atiende las capturas pendientes. */
async function capture(day?: string, extra: Partial<CaptureDeps> = {}) {
  await kit.serviceCall('analytics_enqueue_captures', { p_day: day });
  const jobs = (await kit.serviceCall('claim_jobs', {
    p_worker: WORKER,
    p_kinds: [ANALYTICS_CAPTURE_JOB_KIND],
    p_limit: 20,
    p_lease_seconds: 300,
  })) as Job[];
  const results = [];
  for (const job of jobs) results.push(await processCaptureJob(job, deps(extra)));
  return results;
}

const accountRows = async (metric?: string) =>
  db.query<{ metric_id: string; metric_date: string; value: string; capture_count: number; provisional: boolean }>(
    `select metric_id, metric_date::text, value::text, capture_count, provisional from public.account_metrics_daily
     where social_account_id = $1 ${metric ? 'and metric_id = $2' : ''} order by metric_date, metric_id`,
    metric ? [cuenta, metric] : [cuenta],
  );

beforeAll(async () => {
  db = await createDb();
  kit = socialKit(db);
  ana = await createUser(db, 'ana@analitica.test', 'Ana');
  editor = await createUser(db, 'editor@analitica.test', 'Editor');
  lector = await createUser(db, 'lector@analitica.test', 'Lector');
  ajena = await createUser(db, 'ajena@otra.test', 'Ajena');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
  const otra = await createOrg(db, ajena, 'Otra');
  await createBrand(db, ajena, otra, 'Marca ajena');

  graph = createSimulatedGraph();
  cuenta = await kit.connect(ana, marca, TOKEN);
  const p = { owner: ana, editor, org, brand: marca, account: cuenta };
  const pubPost = await kit.schedulePiece(p, { title: 'Pan de otoño' });
  const pubReel = await kit.schedulePiece(p, { format: 'reel', title: 'Reel del horno' });
  const published = await kit.publishDue(graph);
  expect(published.map((r) => r.outcome)).toEqual(['published', 'published']);
  const ext = await db.query<{ id: string; external_id: string }>(
    `select id, external_id from public.scheduled_publications where id = any($1::uuid[])`,
    [[pubPost, pubReel]],
  );
  post = ext.find((r) => r.id === pubPost)!.external_id;
  reel = ext.find((r) => r.id === pubReel)!.external_id;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  graph.setInsights({});
});

describe('ventana de captura', () => {
  it('la primera vez recupera 28 días; después repasa los 3 últimos días completos', () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    const first = captureWindow(null, now);
    expect(first).toHaveLength(CAPTURE_BACKFILL_DAYS);
    expect(first.at(-1)).toBe('2026-11-17');
    expect(captureWindow('2026-11-17', now)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
    // Tras días sin capturar, recupera desde el último día que tiene.
    expect(captureWindow('2026-11-10', now)[0]).toBe('2026-11-10');
  });

  it('lee el uso del límite de llamadas que declara Meta', () => {
    expect(
      parseUsageHeader(
        JSON.stringify({
          '1': [
            { type: 'instagram', call_count: 12, total_cputime: 30, total_time: 4, estimated_time_to_regain_access: 0 },
          ],
        }),
      ),
    ).toEqual({ callCount: 12, totalCputime: 30, totalTime: 4, regainMinutes: 0 });
    expect(parseUsageHeader('no es json')).toBeNull();
  });
});

describe('captura con la Graph API simulada', () => {
  it('guarda las cifras que da la red, una fila por métrica y día, con su definición', async () => {
    const [r] = await capture();
    expect(r).toMatchObject({ outcome: 'succeeded', accountId: cuenta });

    // Seguidores: el valor del momento, fechado hoy.
    const followers = await accountRows('instagram.account.followers');
    expect(followers).toEqual([
      expect.objectContaining({
        metric_date: today(),
        value: String(simulatedFollowers(SIMULATED_IG_USER_ID, today())),
      }),
    ]);

    // Diarias: 28 días por cada métrica que se captura, con la cifra exacta de la red.
    const reach = await accountRows('instagram.account.reach');
    expect(reach).toHaveLength(CAPTURE_BACKFILL_DAYS);
    for (const row of reach) {
      expect(Number(row.value)).toBe(simulatedAccountValue(SIMULATED_IG_USER_ID, 'reach', row.metric_date));
    }
    const interactions = await accountRows('instagram.account.total_interactions');
    expect(Number(interactions[0]!.value)).toBe(
      simulatedAccountValue(SIMULATED_IG_USER_ID, 'total_interactions', interactions[0]!.metric_date),
    );
    // Los dos últimos días siguen dentro del retraso de 48 h: provisionales.
    expect(reach.at(-1)!.provisional).toBe(true);
    expect(reach[0]!.provisional).toBe(false);

    // Cada fila apunta a una métrica del catálogo que se captura.
    const huérfanas = await db.query(
      `select 1 from public.account_metrics_daily m join public.analytics_metric_definitions d on d.id = m.metric_id
       where d.status <> 'captured'`,
    );
    expect(huérfanas).toEqual([]);

    // Publicaciones: reel con sus métricas propias; la imagen sin ellas.
    const media = await db.query<{
      external_media_id: string;
      metric_id: string;
      value: string;
      media_product_type: string;
    }>(
      `select external_media_id, metric_id, value::text, media_product_type from public.media_metrics_daily
       where social_account_id = $1 order by 1, 2`,
      [cuenta],
    );
    const ofPost = media.filter((m) => m.external_media_id === post);
    const ofReel = media.filter((m) => m.external_media_id === reel);
    expect(ofPost.map((m) => m.metric_id)).toEqual([
      'instagram.media.comments',
      'instagram.media.likes',
      'instagram.media.reach',
      'instagram.media.saved',
      'instagram.media.shares',
      'instagram.media.total_interactions',
      'instagram.media.views',
    ]);
    expect(ofReel.map((m) => m.metric_id)).toContain('instagram.media.ig_reels_avg_watch_time');
    expect(ofReel.every((m) => m.media_product_type === 'REELS')).toBe(true);
    const views = ofReel.find((m) => m.metric_id === 'instagram.media.views')!;
    expect(Number(views.value)).toBe(simulatedMediaValue(reel, 'REELS', 'views', 0));

    // La pasada queda registrada; follows_and_unfollows no está en el catálogo de lo capturado.
    const [run] = await db.query<{ status: string; account_rows: number; media_rows: number; api_calls: number }>(
      `select status, account_rows, media_rows, api_calls from public.analytics_capture_runs where social_account_id = $1
       order by started_at desc limit 1`,
      [cuenta],
    );
    expect(run).toMatchObject({ status: 'succeeded', media_rows: ofPost.length + ofReel.length });
    expect(run!.api_calls).toBe(1 + CAPTURE_BACKFILL_DAYS + 2);
  });

  it('capturar otra vez no duplica: actualiza la fila y cuenta las capturas', async () => {
    const antes = await accountRows();
    // El mismo día: la cola devuelve el mismo trabajo (ya terminado) y no hay nada que hacer.
    expect(await capture()).toEqual([]);
    // Otro trabajo (otro día de encargo): repasa los tres últimos días completos.
    const [r] = await capture('2099-01-01');
    expect(r!.outcome).toBe('succeeded');
    const después = await accountRows();
    expect(después).toHaveLength(antes.length);
    const ultimo = antes.filter((d) => d.metric_id === 'instagram.account.reach').at(-1)!;
    const repasada = después.find((d) => d.metric_id === ultimo.metric_id && d.metric_date === ultimo.metric_date);
    expect(repasada!.capture_count).toBe(2);
    const media = await db.query<{ n: string; max: number }>(
      `select count(*)::text as n, max(capture_count) as max from public.media_metrics_daily where social_account_id = $1`,
      [cuenta],
    );
    expect(media[0]).toEqual({ n: '16', max: 2 });
  });

  it('lo que la red no da no se guarda como cero: queda en «no se pudo medir»', async () => {
    graph.setInsights({ missingAccountMetrics: ['views'], unsupportedAccountMetrics: ['profile_links_taps'] });
    await db.query(`delete from public.account_metrics_daily where social_account_id = $1`, [cuenta]);
    const [r] = await capture('2099-01-02');
    expect(r!.outcome).toBe('succeeded');
    expect(await accountRows('instagram.account.views')).toEqual([]);
    expect(await accountRows('instagram.account.profile_links_taps')).toEqual([]);
    // El resto sí: rechazar una métrica no hace perder las demás.
    expect((await accountRows('instagram.account.likes')).length).toBe(CAPTURE_BACKFILL_DAYS);
    const [run] = await db.query<{ unavailable: Array<{ metric_id: string; reason: string }> }>(
      `select unavailable from public.analytics_capture_runs where social_account_id = $1 order by started_at desc limit 1`,
      [cuenta],
    );
    expect(run!.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric_id: 'instagram.account.views', reason: 'no_data' }),
        expect.objectContaining({ metric_id: 'instagram.account.profile_links_taps', reason: 'unsupported' }),
      ]),
    );
  });

  it('límite de llamadas: guarda lo capturado y aplaza sin gastar intento', async () => {
    graph.setInsights({ usageCallCount: 95 });
    const [r] = await capture('2099-01-03');
    expect(r).toMatchObject({ outcome: 'deferred', errorCode: 'rate_limited' });
    const [job] = await db.query<{ status: string; attempts: number; ahead: boolean }>(
      `select status, attempts, run_after > now() + interval '10 minutes' as ahead from public.jobs
       where idempotency_key = $1`,
      [`analytics.capture:${cuenta}:2099-01-03`],
    );
    expect(job).toEqual({ status: 'queued', attempts: 0, ahead: true });
    const [run] = await db.query<{ status: string; error_code: string }>(
      `select status, error_code from public.analytics_capture_runs where social_account_id = $1 order by started_at desc limit 1`,
      [cuenta],
    );
    // Los seguidores se pidieron antes de parar: es una captura parcial.
    expect(run).toEqual({ status: 'partial', error_code: 'rate_limited' });
    await db.query(`update public.jobs set status = 'cancelled', finished_at = now() where idempotency_key = $1`, [
      `analytics.capture:${cuenta}:2099-01-03`,
    ]);
  });

  it('token caducado: no se reintenta y la cuenta pide volver a conectarla', async () => {
    graph.expireToken(TOKEN);
    const [r] = await capture('2099-01-04');
    expect(r).toMatchObject({ outcome: 'failed', errorCode: 'token_expired' });
    const [acc] = await db.query<{ status: string }>(`select status from public.social_accounts where id = $1`, [
      cuenta,
    ]);
    expect(acc!.status).toBe('needs_reauth');
    const [job] = await db.query<{ status: string }>(`select status from public.jobs where idempotency_key = $1`, [
      `analytics.capture:${cuenta}:2099-01-04`,
    ]);
    expect(job!.status).toBe('failed');
    // Mientras no se vuelva a conectar, no se encolan capturas de esa cuenta.
    expect(await kit.serviceCall('analytics_enqueue_captures', { p_day: '2099-01-05' })).toBe(0);
    // Volver a conectar la misma cuenta la rearma.
    await kit.connect(ana, marca, 'sim-page-analitica-2');
  });
});

describe('el servidor valida lo que guarda', () => {
  const record = (extra: Record<string, unknown>) =>
    kit.serviceCall('analytics_record_capture', {
      p_account_id: cuenta,
      p_job_id: null,
      p_status: 'succeeded',
      p_started_at: new Date().toISOString(),
      p_window_from: null,
      p_window_to: null,
      p_account_rows: [],
      p_media_rows: [],
      ...extra,
    });

  it('rechaza métricas que no se capturan, fechas futuras, cifras negativas y publicaciones ajenas', async () => {
    await expect(
      record({ p_account_rows: [{ metric_id: 'instagram.account.impressions', date: today(), value: 1 }] }),
    ).rejects.toThrow(/no admitida/);
    await expect(
      record({ p_account_rows: [{ metric_id: 'instagram.account.reach', date: '2999-01-01', value: 1 }] }),
    ).rejects.toThrow(/Fecha/);
    await expect(
      record({ p_account_rows: [{ metric_id: 'instagram.account.reach', date: today(), value: -1 }] }),
    ).rejects.toThrow(/Cifra/);
    await expect(
      record({ p_media_rows: [{ external_id: '999', metric_id: 'instagram.media.reach', date: today(), value: 1 }] }),
    ).rejects.toThrow(/no es de esta cuenta/);
    // Una métrica de reel no se aplica a una imagen.
    await expect(
      record({
        p_media_rows: [
          { external_id: post, metric_id: 'instagram.media.ig_reels_avg_watch_time', date: today(), value: 1 },
        ],
      }),
    ).rejects.toThrow(/no se aplica/);
  });

  it('nadie escribe las cifras desde la API, y el capturador no lo ejecuta una persona', async () => {
    await denied(
      db,
      ana,
      `insert into public.account_metrics_daily (social_account_id, brand_id, organization_id, metric_id, metric_date, value)
       values ($1, $2, $3, 'instagram.account.reach', current_date, 1)`,
      [cuenta, marca, org],
      /permission denied/,
    );
    await denied(db, ana, `update public.account_metrics_daily set value = 0`, [], /permission denied/);
    await denied(db, ana, `select public.analytics_capture_begin($1)`, [cuenta], /permission denied/);
    await denied(db, ana, `select public.analytics_enqueue_captures()`, [], /permission denied/);
    await expect(asService(db, `update public.account_metrics_daily set value = 0`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('lectura para el panel', () => {
  it('quien ve la marca ve las cifras y el resumen de sus publicaciones; otra organización, nada', async () => {
    const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const hasta = new Date(Date.now() + 86_400_000).toISOString();
    const resumen = await as<{ title: string; media_product_type: string; metrics: Record<string, number> }>(
      db,
      lector,
      `select * from public.analytics_media_summary($1, $2, $3)`,
      [marca, desde, hasta],
    );
    expect(resumen.map((r) => r.title).sort()).toEqual(['Pan de otoño', 'Reel del horno']);
    const delReel = resumen.find((r) => r.media_product_type === 'REELS')!;
    expect(delReel.metrics['instagram.media.views']).toBe(simulatedMediaValue(reel, 'REELS', 'views', 0));

    expect(
      await as(db, ajena, `select * from public.analytics_media_summary($1, $2, $3)`, [marca, desde, hasta]),
    ).toEqual([]);
    expect(await as(db, ajena, `select 1 from public.account_metrics_daily`)).toEqual([]);
    const defs = await as<{ n: string }>(
      db,
      ajena,
      `select count(*)::text as n from public.analytics_metric_definitions`,
    );
    expect(Number(defs[0]!.n)).toBeGreaterThan(20);
  });
});
