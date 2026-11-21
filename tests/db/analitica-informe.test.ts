// Informe mensual (Fase 5) de principio a fin contra las migraciones reales:
// reloj → trabajo `analytics.report` → función (analista sin IA) → trabajo
// `media.report.pdf` → trabajador (pdf-lib de verdad) → biblioteca con
// procedencia → informe listo. Sin intervención de nadie.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYTICS_CAPTURE_JOB_KIND, processCaptureJob } from '../../supabase/functions/_shared/analytics/capture.ts';
import { createInsightsGraph } from '../../supabase/functions/_shared/analytics/insights-graph.ts';
import { ANALYTICS_REPORT_JOB_KIND, processReportJob } from '../../supabase/functions/_shared/analytics/report.ts';
import { createSimulatedGraph, type SimulatedGraph } from '../../supabase/functions/_shared/social/simulated-graph.ts';
import { createSocialInsightsHandler } from '../../supabase/functions/social-insights/handler.ts';
import { createReportPdfHandler, REPORT_PDF_KIND, reportPdfPayloadSchema } from '../../worker/src/handlers/report-pdf';
import { createMemoryLogger } from '../../worker/src/logger';
import { createFolderStorage } from '../../worker/src/storage';
import { KEYS, socialKit } from './apoyo-analitica';
import { as, createBrand, createDb, createOrg, createUser, denied, join, type Db, type TestUser } from './helpers';

let db: Db;
let kit: ReturnType<typeof socialKit>;
let ana: TestUser, editor: TestUser, lector: TestUser, ajena: TestUser;
let org: string, marca: string, marcaAjena: string, cuenta: string, logoId: string;
let graph: SimulatedGraph;
let bucketDir: string;

const WORKER = 'pruebas:informe';
/** PNG de 1×1 píxel, válido. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SERVICE_KEY = 'clave-de-servicio-de-pruebas';
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

type Job = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  organization_id: string;
  brand_id: string | null;
};
type Report = {
  id: string;
  status: string;
  revision: number;
  media_asset_id: string | null;
  summary: Record<string, unknown>;
  error: string | null;
};

const claim = async (kinds: string[]) =>
  (await kit.serviceCall('claim_jobs', {
    p_worker: WORKER,
    p_kinds: kinds,
    p_limit: 20,
    p_lease_seconds: 300,
  })) as Job[];
const reportOf = async (brand = marca) =>
  (
    await db.query<Report>(`select * from public.analytics_reports where brand_id = $1 and period_start = $2`, [
      brand,
      monthStart(),
    ])
  )[0]!;

/** El trabajador de medios: reclama el PDF, lo dibuja en la carpeta-cubo y cierra el trabajo. */
async function renderPdfJobs() {
  const out = [];
  for (const job of await claim([REPORT_PDF_KIND])) {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'rrss-informe-'));
    try {
      const result = await createReportPdfHandler().run({
        job,
        signal: new AbortController().signal,
        storage: createFolderStorage(bucketDir),
        workDir,
        log: createMemoryLogger(),
      });
      await kit.serviceCall('complete_job', { p_job_id: job.id, p_worker: WORKER, p_result: result });
      out.push(result as { output: { path: string; bytes: number; pages: number } });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return out;
}

beforeAll(async () => {
  db = await createDb();
  kit = socialKit(db);
  bucketDir = await mkdtemp(path.join(os.tmpdir(), 'rrss-cubo-'));
  ana = await createUser(db, 'ana@informe.test', 'Ana');
  editor = await createUser(db, 'editor@informe.test', 'Editor');
  lector = await createUser(db, 'lector@informe.test', 'Lector');
  ajena = await createUser(db, 'ajena@otra.test', 'Ajena');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Horno de Prueba');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
  const otra = await createOrg(db, ajena, 'Otra');
  marcaAjena = await createBrand(db, ajena, otra, 'Marca ajena');

  // Perfil con colores y un logotipo PNG de la biblioteca (el archivo existe en el cubo).
  const logoPath = `${org}/${marca}/logos/logo.png`;
  const [logo] = await as<{ id: string }>(
    db,
    ana,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
     values ($1, $2, 'logo', $3, 'logo.png', 'image/png', 100) returning id`,
    [marca, org, logoPath],
  );
  logoId = logo!.id;
  await mkdir(path.join(bucketDir, org, marca, 'logos'), { recursive: true });
  await writeFile(path.join(bucketDir, logoPath), PNG_1x1);
  await as(db, ana, `select public.save_brand_profile($1, $2::jsonb)`, [
    marca,
    JSON.stringify({
      business: { description: 'Panadería' },
      visual: {
        colors: [
          { name: 'Verde', hex: '#0f766e', role: 'principal' },
          { name: 'Ocre', hex: '#B45309', role: '' },
        ],
        logoAssetIds: [logoId],
      },
    }),
  ]);

  graph = createSimulatedGraph();
  cuenta = await kit.connect(ana, marca, 'sim-page-informe-1');
  const p = { owner: ana, editor, org, brand: marca, account: cuenta };
  await kit.schedulePiece(p, { title: 'Pan de otoño' });
  await kit.schedulePiece(p, { title: 'Reel del horno', format: 'reel' });
  await kit.publishDue(graph);
  await kit.serviceCall('analytics_enqueue_captures', {});
  for (const job of await claim([ANALYTICS_CAPTURE_JOB_KIND])) {
    await processCaptureJob(job, {
      rpc: kit.rpc,
      api: createInsightsGraph({ fetch: graph.fetch }),
      keyRing: KEYS,
      workerName: WORKER,
    });
  }
});

afterAll(async () => {
  await db?.close();
  if (bucketDir) await rm(bucketDir, { recursive: true, force: true });
});

describe('informe mensual sin intervención', () => {
  it('reloj → cifras → documento → PDF → biblioteca, y queda listo', async () => {
    // El reloj encola el informe de cada marca con cuenta social (uno por marca y mes).
    expect(await kit.serviceCall('analytics_enqueue_monthly_reports', { p_period_start: monthStart() })).toBe(1);
    expect(await kit.serviceCall('analytics_enqueue_monthly_reports', { p_period_start: monthStart() })).toBe(0);
    expect(await reportOf()).toMatchObject({ status: 'queued', revision: 1 });

    // La función prepara el documento con el analista y encola el PDF.
    const handler = createSocialInsightsHandler({
      serviceKeys: [SERVICE_KEY],
      rpc: kit.rpc,
      workerName: WORKER,
      capture: () => null,
    });
    const response = await handler(
      new Request('http://local/social-insights', { method: 'POST', headers: { apikey: SERVICE_KEY } }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { results: Array<{ kind: string; outcome: string }> }).results).toEqual([
      expect.objectContaining({ kind: ANALYTICS_REPORT_JOB_KIND, outcome: 'rendering' }),
    ]);
    const rendering = await reportOf();
    expect(rendering.status).toBe('rendering');
    expect((rendering.summary as { facts: unknown[] }).facts.length).toBeGreaterThan(3);

    // La carga del PDF: salida dentro de la marca, logotipo del perfil, documento válido para el trabajador.
    const [pdfJob] = await db.query<Job>(`select * from public.jobs where kind = 'media.report.pdf'`);
    const payload = reportPdfPayloadSchema.parse(pdfJob!.payload);
    expect(payload.output.path).toMatch(new RegExp(`^${org}/${marca}/informes/[0-9a-f-]{36}\\.pdf$`));
    expect(payload.logo).toEqual({ path: `${org}/${marca}/logos/logo.png`, mime_type: 'image/png' });
    expect(payload.document.brandName).toBe('Horno de Prueba');
    expect(payload.document.colors).toEqual({ primary: '#0F766E', secondary: '#B45309' });
    const titles = payload.document.sections.map((s) => s.kind);
    expect(titles).toEqual(expect.arrayContaining(['facts', 'hypotheses', 'unmeasurable']));
    const unmeasurable = payload.document.sections.find((s) => s.kind === 'unmeasurable')!.items.join('\n');
    expect(unmeasurable).toMatch(/Impresiones/);
    expect(unmeasurable).toMatch(/Facebook/);

    // El trabajador lo dibuja; al completarse, entra en la biblioteca y el informe queda listo.
    const [result] = await renderPdfJobs();
    const pdf = await readFile(path.join(bucketDir, result!.output.path));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const ready = await reportOf();
    expect(ready.status).toBe('ready');
    const [asset] = await db.query<{
      kind: string;
      mime_type: string;
      folder: string;
      bytes: string;
      provenance: Record<string, unknown>;
      storage_path: string;
    }>(`select kind, mime_type, folder, bytes::text, provenance, storage_path from public.media_assets where id = $1`, [
      ready.media_asset_id,
    ]);
    expect(asset).toMatchObject({
      kind: 'document',
      mime_type: 'application/pdf',
      folder: 'Informes',
      storage_path: result!.output.path,
    });
    expect(Number(asset!.bytes)).toBe(pdf.length);
    expect(asset!.provenance).toMatchObject({
      type: 'analytics_report',
      report_id: ready.id,
      source: 'schedule',
      revision: 1,
    });
  });

  it('quien edita lo vuelve a pedir (nueva revisión); quien solo ve, no; meses sin terminar, no', async () => {
    const lastMonth = new Date();
    lastMonth.setUTCDate(1);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const pasado = lastMonth.toISOString().slice(0, 10);
    const [pedido] = await as<{ status: string; source: string }>(
      db,
      editor,
      `select * from public.request_analytics_report($1, $2)`,
      [marca, pasado],
    );
    expect(pedido).toMatchObject({ status: 'queued', source: 'manual' });
    // Pedirlo otra vez mientras se prepara no duplica.
    const [otra] = await as<{ id: string }>(db, editor, `select * from public.request_analytics_report($1, $2)`, [
      marca,
      pasado,
    ]);
    expect(
      (
        await db.query(`select 1 from public.jobs where kind = 'analytics.report' and payload ->> 'report_id' = $1`, [
          otra!.id,
        ])
      ).length,
    ).toBe(1);
    await denied(db, lector, `select public.request_analytics_report($1, $2)`, [marca, pasado], /edita/);
    await denied(db, ajena, `select public.request_analytics_report($1, $2)`, [marca, pasado], /edita/);
    await expect(
      as(db, editor, `select public.request_analytics_report($1, $2)`, [marca, monthStart()]),
    ).rejects.toThrow(/terminado/);
  });

  it('si el PDF falla del todo, el informe queda fallido con el motivo', async () => {
    // Regenerar el del mes actual (el reloj no lo haría; aquí se fuerza por la función interna).
    await db.query(`select private.analytics_report_enqueue($1, $2, 'manual', null)`, [marca, monthStart()]);
    for (const job of await claim([ANALYTICS_REPORT_JOB_KIND]))
      await processReportJob(job, { rpc: kit.rpc, workerName: WORKER });
    const actual = await reportOf();
    const pdfJob = (await claim([REPORT_PDF_KIND])).find((j) => j.payload.report_id === actual.id);
    await kit.serviceCall('fail_job', {
      p_job_id: pdfJob!.id,
      p_worker: WORKER,
      p_error: 'Sin espacio en el cubo',
      p_retry: false,
    });
    expect(await reportOf()).toMatchObject({ status: 'failed', error: 'Sin espacio en el cubo', revision: 2 });
  });

  it('nadie hace pasar un PDF por un informe ni escribe la tabla desde la API', async () => {
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'document', $3, 'falso.pdf', 'application/pdf', 1, '{"type":"analytics_report"}')`,
      [marca, org, `${org}/${marca}/informes/falso.pdf`],
      /procedencia/,
    );
    await denied(db, editor, `update public.analytics_reports set status = 'ready'`, [], /permission denied/);
    for (const sql of [
      `select public.analytics_report_source(gen_random_uuid())`,
      `select public.analytics_report_render(gen_random_uuid(), gen_random_uuid(), '{}', '{}')`,
      `select public.analytics_enqueue_monthly_reports()`,
      `select private.analytics_report_enqueue($1, current_date, 'manual', null)`,
      `select private.analytics_dispatch()`,
    ]) {
      await denied(db, ana, sql, sql.includes('$1') ? [marca] : [], /permission denied/);
    }
    expect(await as(db, ajena, `select 1 from public.analytics_reports`)).toEqual([]);
    expect(
      (await as(db, lector, `select 1 from public.analytics_reports where brand_id = $1`, [marca])).length,
    ).toBeGreaterThan(0);
    expect(marcaAjena).toBeTruthy();
  });

  it('sin la clave de servicio la función no toca la cola', async () => {
    const handler = createSocialInsightsHandler({
      serviceKeys: [SERVICE_KEY],
      rpc: kit.rpc,
      workerName: WORKER,
      capture: () => null,
    });
    expect((await handler(new Request('http://local/x', { method: 'POST' }))).status).toBe(401);
    expect(
      (await handler(new Request('http://local/x', { method: 'GET', headers: { apikey: SERVICE_KEY } }))).status,
    ).toBe(405);
  });
});
