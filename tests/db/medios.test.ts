// Reels y recortes encargados desde la aplicación (request_media_job) y su
// llegada a la biblioteca al completarse (disparador sobre jobs), contra las
// migraciones reales. Incluye el contrato con el trabajador: su bucle real
// (worker/src/worker.ts) contra la cola SQL, con un manejador que devuelve un
// resultado con la forma del de verdad (aquí no hay FFmpeg).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobQueue } from '../../worker/src/queue';
import { createWorker } from '../../worker/src/worker';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  rpcStatement,
  serviceRpc,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

interface JobRow extends Row {
  id: string;
  kind: string;
  status: string;
  brand_id: string;
  organization_id: string;
  created_by: string | null;
  idempotency_key: string;
  payload: Row & { output?: { path: string }; outputs?: Array<Row & { path: string }> };
  result: (Row & { assets?: Array<{ id: string; path: string; kind: string }> }) | null;
  last_error: string | null;
}

interface AssetRow extends Row {
  id: string;
  kind: string;
  origin: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  folder: string;
  created_by: string | null;
  provenance: Row;
}

let db: Db;
let ana: TestUser, editor: TestUser, cliente: TestUser, lector: TestUser, berta: TestUser;
let orgA: string, orgB: string, marcaA: string, marcaA2: string, marcaB: string;
// Recursos de la marca A, de la A2 y de la B.
let fotoA: string, foto2A: string, clipA: string, musicaA: string, docA: string, fotoA2: string, fotoB: string;
let tmpRoot: string;
let n = 0;

async function asset(user: TestUser, org: string, brand: string, kind: string, name: string, mime: string) {
  const storagePath = `${org}/${brand}/media/${name}`;
  await as(
    db,
    user,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
     values ($1, $2, $3::public.asset_kind, $4, $5, $6, 1000)`,
    [brand, org, kind, storagePath, name, mime],
  );
  return storagePath;
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test');
  editor = await createUser(db, 'editor@a.test');
  cliente = await createUser(db, 'cliente@a.test');
  lector = await createUser(db, 'lector@a.test');
  berta = await createUser(db, 'berta@b.test');
  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  marcaA = await createBrand(db, ana, orgA, 'Marca A');
  marcaA2 = await createBrand(db, ana, orgA, 'Marca A2');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
  await join(db, ana, editor, orgA, 'member', marcaA, 'editor');
  await join(db, ana, cliente, orgA, 'member', marcaA, 'client');
  await join(db, ana, lector, orgA, 'member', marcaA, 'viewer');

  fotoA = await asset(ana, orgA, marcaA, 'image', 'plato.jpg', 'image/jpeg');
  foto2A = await asset(ana, orgA, marcaA, 'image', 'local.png', 'image/png');
  clipA = await asset(ana, orgA, marcaA, 'video', 'cocina.mp4', 'video/mp4');
  musicaA = await asset(ana, orgA, marcaA, 'audio', 'musica.m4a', 'audio/mp4');
  docA = await asset(ana, orgA, marcaA, 'document', 'carta.pdf', 'application/pdf');
  fotoA2 = await asset(ana, orgA, marcaA2, 'image', 'otra.jpg', 'image/jpeg');
  fotoB = await asset(berta, orgB, marcaB, 'image', 'ajena.jpg', 'image/jpeg');
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'rrss-medios-'));
});

afterAll(async () => {
  await db?.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.exec(`delete from public.media_assets where provenance ->> 'type' = 'media_job'; delete from public.jobs;`);
});

const reelInput = (overrides: Row = {}): Row => ({
  template: { id: 'fundido-suave' },
  plan: {
    media: [
      { type: 'photo', path: fotoA, focalPoint: { x: 0.4, y: 0.5 } },
      { type: 'video', path: clipA, startAt: 0.5, seconds: 2 },
      { type: 'photo', path: foto2A },
    ],
    texts: [{ text: 'Menú del día', start: 0.5, end: 3, position: 'bottom' }],
    music: { path: musicaA, startAt: 0, volume: 0.3 },
  },
  ...overrides,
});

const request = async (user: TestUser, brand: string, kind: string, input: Row, key = `encargo-${++n}`) => {
  const { sql, params } = rpcStatement('request_media_job', {
    p_brand_id: brand,
    p_kind: kind,
    p_input: input,
    p_idempotency_key: key,
  });
  const rows = await as<{ data: JobRow }>(db, user, sql, params);
  return rows[0]!.data;
};

const rejected = (user: TestUser, brand: string, kind: string, input: Row, pattern: RegExp) => {
  const { sql, params } = rpcStatement('request_media_job', {
    p_brand_id: brand,
    p_kind: kind,
    p_input: input,
    p_idempotency_key: `rechazo-${++n}`,
  });
  return denied(db, user, sql, params, pattern);
};

const claim = async (worker = 'medios-1') => {
  const { sql, params } = rpcStatement('claim_jobs', { p_worker: worker, p_limit: 10 });
  return (await asService<{ data: JobRow }>(db, sql, params)).map((r) => r.data);
};
const complete = (id: string, result: Row, worker = 'medios-1') =>
  serviceRpc<JobRow>(db, 'complete_job', { p_job_id: id, p_worker: worker, p_result: result });
const jobById = async (id: string) => (await db.query<JobRow>(`select * from public.jobs where id = $1`, [id]))[0]!;
const assetsOf = (jobId: string) =>
  db.query<AssetRow>(`select * from public.media_assets where provenance ->> 'job_id' = $1 order by storage_path`, [
    jobId,
  ]);

/** Resultado con la forma del manejador real del reel (worker/src/handlers/reel-template.ts). */
const reelResult = (outputPath: string, extra: Row = {}): Row => ({
  template: { id: 'fundido-suave', schemaVersion: 1 },
  output: {
    path: outputPath,
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 6.5,
    videoCodec: 'h264',
    audioCodec: 'aac',
    bytes: 2_345_678,
  },
  timeline: [],
  warnings: ['Un texto no cabe en una línea'],
  timings: { downloadMs: 1, renderMs: 2, uploadMs: 3 },
  ...extra,
});

describe('encargar desde la aplicación', () => {
  it('quien edita la marca encarga un reel: la base pone la salida dentro de la marca', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput(), 'reel-unico-1');
    expect(job).toMatchObject({
      kind: 'media.reel.template',
      status: 'queued',
      organization_id: orgA,
      brand_id: marcaA,
      created_by: editor.id,
    });
    expect(job.idempotency_key).toBe(`media:${marcaA}:reel-unico-1`);
    expect(job.payload.output!.path).toMatch(new RegExp(`^${orgA}/${marcaA}/reels/[0-9a-f-]{36}\\.mp4$`));
    // El plan llega tal cual al trabajador.
    expect(job.payload).toMatchObject({ template: { id: 'fundido-suave' }, plan: reelInput().plan });

    // Con desenfoque en una pieza (mismo 0–100 que el editor), también llega tal cual.
    const blurred = await request(
      editor,
      marcaA,
      'media.reel.template',
      { template: { id: 'fundido-suave' }, plan: { media: [{ type: 'photo', path: fotoA, blur: 40 }] } },
      'reel-desenfocado-1',
    );
    expect(blurred.payload).toMatchObject({ plan: { media: [{ type: 'photo', path: fotoA, blur: 40 }] } });

    // Repetir el encargo (doble clic, reintento de red) devuelve el mismo trabajo.
    const again = await request(editor, marcaA, 'media.reel.template', reelInput(), 'reel-unico-1');
    expect(again.id).toBe(job.id);
    expect(again.payload.output!.path).toBe(job.payload.output!.path);
    // La misma clave en otra marca es otro encargo.
    const other = await request(
      ana,
      marcaA2,
      'media.reel.template',
      {
        template: { id: 'corte-ritmico' },
        plan: { media: [{ type: 'photo', path: fotoA2 }] },
      },
      'reel-unico-1',
    );
    expect(other.id).not.toBe(job.id);
  });

  it('los nulos de JSON cuentan como «no está» (música opcional)', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', {
      template: { id: 'pase-lateral' },
      plan: { media: [{ type: 'photo', path: fotoA }], music: null },
    });
    expect(job.payload).toMatchObject({ plan: { media: [{ type: 'photo', path: fotoA }] } });
    expect(job.payload.plan).not.toHaveProperty('music');
  });

  it('el recorte de una foto: cada salida con su ruta nueva dentro de la marca', async () => {
    const job = await request(editor, marcaA, 'media.image.process', {
      source: { path: fotoA },
      focalPoint: { x: 0.5, y: 0.4 },
      outputs: [
        { aspect: '9:16', width: 1080 },
        { aspect: '1:1', width: 1080, format: 'webp', quality: 80 },
      ],
    });
    const outputs = job.payload.outputs!;
    expect(outputs[0]!.path).toMatch(new RegExp(`^${orgA}/${marcaA}/recortes/[0-9a-f-]{36}-1-9x16\\.jpg$`));
    expect(outputs[1]!.path).toMatch(new RegExp(`^${orgA}/${marcaA}/recortes/[0-9a-f-]{36}-2-1x1\\.webp$`));
    expect(outputs[1]).toMatchObject({ aspect: '1:1', width: 1080, format: 'webp', quality: 80 });
  });

  it('solo los dos tipos de medios y una carga restringida', async () => {
    const bad = /no admitid|Elige|solo admite|Falta|Pide entre|Como mucho/;
    await rejected(
      editor,
      marcaA,
      'media.video.derivatives',
      { source: { path: clipA } },
      /Tipo de trabajo no admitido/,
    );
    await rejected(editor, marcaA, 'media.render', {}, /Tipo de trabajo no admitido/);
    // Un campo de más, una plantilla completa o la tipografía de la marca: fuera.
    await rejected(editor, marcaA, 'media.reel.template', reelInput({ output: { path: fotoA } }), bad);
    await rejected(editor, marcaA, 'media.reel.template', reelInput({ template: { schemaVersion: 1, id: 'x' } }), bad);
    await rejected(editor, marcaA, 'media.reel.template', reelInput({ template: { id: '../otra' } }), bad);
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      { template: { id: 'fundido-suave' }, plan: { media: [{ type: 'photo', path: fotoA }], fontPath: 'x.ttf' } },
      bad,
    );
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      { template: { id: 'fundido-suave' }, plan: { media: [] } },
      bad,
    );
    // Desenfoque de la pieza (20261121010000): número de 0 a 100.
    for (const blur of [101, -1, 'mucho']) {
      await rejected(
        editor,
        marcaA,
        'media.reel.template',
        { template: { id: 'fundido-suave' }, plan: { media: [{ type: 'photo', path: fotoA, blur }] } },
        /desenfoque va de 0 a 100/,
      );
    }
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      { template: { id: 'fundido-suave' }, plan: { media: Array(21).fill({ type: 'photo', path: fotoA }) } },
      bad,
    );
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      { template: { id: 'fundido-suave' }, plan: { media: [{ type: 'photo', path: fotoA, extra: 1 }] } },
      bad,
    );
    await rejected(editor, marcaA, 'media.image.process', { source: { path: fotoA }, outputs: [] }, bad);
    await rejected(
      editor,
      marcaA,
      'media.image.process',
      { source: { path: fotoA }, outputs: [{ aspect: '2:3', width: 100 }] },
      bad,
    );
    await rejected(
      editor,
      marcaA,
      'media.image.process',
      { source: { path: fotoA }, outputs: [{ aspect: '1:1', width: 100, path: fotoA }] },
      bad,
    );
  });

  it('cada ruta de entrada tiene que ser un recurso de esa marca y del tipo que toca', async () => {
    const noEs = /no es un recurso de esta marca|no es válida/;
    const reelWith = (item: Row, music?: Row) => ({
      template: { id: 'fundido-suave' },
      plan: { media: [item], ...(music ? { music } : {}) },
    });
    // Foto de otra organización y de otra marca de la misma organización.
    await rejected(editor, marcaA, 'media.reel.template', reelWith({ type: 'photo', path: fotoB }), noEs);
    await rejected(ana, marcaA, 'media.reel.template', reelWith({ type: 'photo', path: fotoA2 }), noEs);
    // Ruta con la forma de la marca pero sin recurso detrás, o trucada.
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      reelWith({ type: 'photo', path: `${orgA}/${marcaA}/media/no-existe.jpg` }),
      noEs,
    );
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      reelWith({ type: 'photo', path: `${orgA}/${marcaA}/../${marcaA2}/media/otra.jpg` }),
      noEs,
    );
    // Tipos cruzados: un documento como foto, una foto como clip o como música.
    await rejected(editor, marcaA, 'media.reel.template', reelWith({ type: 'photo', path: docA }), noEs);
    await rejected(editor, marcaA, 'media.reel.template', reelWith({ type: 'video', path: fotoA }), noEs);
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      reelWith({ type: 'photo', path: fotoA }, { path: fotoA }),
      noEs,
    );
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      reelWith({ type: 'photo', path: fotoA }, { path: `${orgB}/${marcaB}/media/x.m4a` }),
      noEs,
    );
    await rejected(
      editor,
      marcaA,
      'media.image.process',
      { source: { path: fotoB }, outputs: [{ aspect: '1:1', width: 10 }] },
      noEs,
    );
    await rejected(
      editor,
      marcaA,
      'media.image.process',
      { source: { path: clipA }, outputs: [{ aspect: '1:1', width: 10 }] },
      noEs,
    );
    expect(await db.query(`select 1 from public.jobs`)).toEqual([]);
  });

  it('solo quien edita la marca encarga; nadie encola en una marca ajena', async () => {
    const sinPermiso = /No tienes permiso|Inicia sesión|permission denied/;
    await rejected(cliente, marcaA, 'media.reel.template', reelInput(), sinPermiso);
    await rejected(lector, marcaA, 'media.reel.template', reelInput(), sinPermiso);
    await rejected(editor, marcaA2, 'media.reel.template', reelInput(), sinPermiso);
    await rejected(berta, marcaA, 'media.reel.template', reelInput(), sinPermiso);
    // Con sus propias fotos, pero en la marca de otra organización.
    await rejected(
      ana,
      marcaB,
      'media.reel.template',
      {
        template: { id: 'fundido-suave' },
        plan: { media: [{ type: 'photo', path: fotoA }] },
      },
      sinPermiso,
    );
    const { sql, params } = rpcStatement('request_media_job', {
      p_brand_id: marcaA,
      p_kind: 'media.reel.template',
      p_input: reelInput(),
      p_idempotency_key: 'sin-sesion-1',
    });
    await denied(db, null, sql, params, /permission denied for function/);
    expect(await db.query(`select 1 from public.jobs`)).toEqual([]);
  });

  it('como mucho cinco trabajos de medios en marcha por marca', async () => {
    const input = { template: { id: 'corte-ritmico' }, plan: { media: [{ type: 'photo', path: fotoA }] } };
    for (let i = 0; i < 5; i++) await request(editor, marcaA, 'media.reel.template', input);
    await rejected(
      editor,
      marcaA,
      'media.reel.template',
      input,
      /Hay 5 trabajos de medios en marcha en esta marca, el máximo a la vez/,
    );
    // Otra marca tiene su propio tope.
    await request(ana, marcaA2, 'media.reel.template', {
      template: { id: 'corte-ritmico' },
      plan: { media: [{ type: 'photo', path: fotoA2 }] },
    });
    // Al terminar uno, vuelve a haber hueco.
    const [running] = await claim();
    await serviceRpc(db, 'fail_job', { p_job_id: running!.id, p_worker: 'medios-1', p_error: 'x', p_retry: false });
    await request(editor, marcaA, 'media.reel.template', input);
  });

  it('el estado de los trabajos lo ve quien ve la marca; nadie de fuera', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    for (const user of [ana, editor, cliente, lector]) {
      expect(await as(db, user, `select status from public.jobs where id = $1`, [job.id]), user.email).toEqual([
        { status: 'queued' },
      ]);
    }
    expect(await as(db, berta, `select 1 from public.jobs where id = $1`, [job.id])).toEqual([]);
    await denied(db, editor, `update public.jobs set status = 'succeeded' where id = $1`, [job.id]);
  });
});

describe('cancelar desde la aplicación', () => {
  const cancel = async (user: TestUser, id: string) => {
    const { sql, params } = rpcStatement('cancel_media_job', { p_job_id: id });
    return (await as<{ data: JobRow }>(db, user, sql, params))[0]!.data;
  };

  it('quien edita la marca cancela un reel en cola; deja hueco para otro', async () => {
    const input = { template: { id: 'corte-ritmico' }, plan: { media: [{ type: 'photo', path: fotoA }] } };
    const jobs = [];
    for (let i = 0; i < 5; i++) jobs.push(await request(editor, marcaA, 'media.reel.template', input));
    expect(await cancel(editor, jobs[0]!.id)).toMatchObject({ status: 'cancelled' });
    expect((await jobById(jobs[0]!.id)).finished_at).not.toBeNull();
    // El trabajador ya no lo reclama, y cabe un encargo más.
    expect((await claim()).map((j) => j.id)).not.toContain(jobs[0]!.id);
    await request(editor, marcaA, 'media.reel.template', input);
  });

  it('se puede cancelar mientras se monta: el trabajador ya no lo puede cerrar ni llega a la biblioteca', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    const [running] = await claim();
    expect(running!.id).toBe(job.id);
    expect(await cancel(ana, job.id)).toMatchObject({ status: 'cancelled', locked_by: null });
    await expect(complete(job.id, reelResult(job.payload.output!.path))).rejects.toThrow();
    await expect(
      serviceRpc(db, 'extend_job_lease', { p_job_id: job.id, p_worker: 'medios-1', p_lease_seconds: 60 }),
    ).rejects.toThrow();
    expect(await assetsOf(job.id)).toEqual([]);
  });

  it('también los recortes; lo terminado ya no se cancela', async () => {
    const job = await request(editor, marcaA, 'media.image.process', {
      source: { path: fotoA },
      outputs: [{ aspect: '1:1' }],
    });
    expect(await cancel(editor, job.id)).toMatchObject({ status: 'cancelled' });
    await denied(db, editor, `select public.cancel_media_job($1)`, [job.id], /ya ha terminado/);
  });

  it('quien solo ve la marca, o es de otra, no cancela', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    for (const user of [cliente, lector, berta]) {
      await denied(db, user, `select public.cancel_media_job($1)`, [job.id], /No tienes permiso para cancelar/);
    }
    expect(await jobById(job.id)).toMatchObject({ status: 'queued' });
  });
});

describe('el resultado llega a la biblioteca al completarse', () => {
  it('el reel terminado aparece en la biblioteca de su marca, con su procedencia', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    const [claimed] = await claim();
    expect(claimed!.id).toBe(job.id);
    const outputPath = job.payload.output!.path;
    const done = await complete(job.id, reelResult(outputPath));

    const [reel] = await assetsOf(job.id);
    expect(reel).toMatchObject({
      kind: 'video',
      origin: 'generated',
      storage_path: outputPath,
      mime_type: 'video/mp4',
      bytes: 2_345_678,
      width: 1080,
      height: 1920,
      duration_ms: 6500,
      folder: 'Reels',
      created_by: editor.id,
    });
    expect(reel!.file_name).toMatch(/^reel-fundido-suave-\d{8}-\d{6}\.mp4$/);
    const fuente = async (p: string) =>
      (await db.query<{ id: string }>(`select id from public.media_assets where storage_path = $1`, [p]))[0]!.id;
    // En la columna común de procedencia (20261118120000), con su propio `type`.
    expect(reel!.provenance).toEqual({
      type: 'media_job',
      kind: 'media.reel.template',
      job_id: job.id,
      template_id: 'fundido-suave',
      template_schema_version: 1,
      music_asset_id: await fuente(musicaA),
      sources: [
        { type: 'photo', asset_id: await fuente(fotoA), path: fotoA },
        { type: 'video', asset_id: await fuente(clipA), path: clipA },
        { type: 'photo', asset_id: await fuente(foto2A), path: foto2A },
      ],
    });
    // El trabajo apunta al recurso creado: la aplicación lo abre desde ahí.
    expect(done.result!.assets).toEqual([{ id: reel!.id, path: outputPath, kind: 'video' }]);
    expect((await jobById(job.id)).result!.assets).toEqual(done.result!.assets);

    // Lo ve quien ve la marca, y nadie de fuera.
    expect(await as(db, lector, `select id from public.media_assets where id = $1`, [reel!.id])).toHaveLength(1);
    expect(await as(db, berta, `select id from public.media_assets where id = $1`, [reel!.id])).toEqual([]);
  });

  it('cada recorte terminado es un recurso de imagen', async () => {
    const job = await request(editor, marcaA, 'media.image.process', {
      source: { path: fotoA },
      outputs: [
        { aspect: '9:16', width: 1080 },
        { aspect: '1:1', width: 1080, format: 'webp' },
      ],
    });
    await claim();
    const [vertical, cuadrada] = job.payload.outputs!;
    await complete(job.id, {
      source: { width: 4000, height: 3000 },
      outputs: [
        { path: vertical!.path, aspect: '9:16', width: 1080, height: 1920, format: 'jpeg', bytes: 300_000 },
        { path: cuadrada!.path, aspect: '1:1', width: 1080, height: 1080, format: 'webp', bytes: 120_000 },
      ],
    });
    const rows = await db.query<AssetRow>(
      `select * from public.media_assets where provenance ->> 'job_id' = $1 order by bytes desc`,
      [job.id],
    );
    expect(rows.map((r) => [r.file_name, r.mime_type, r.width, r.height, r.bytes, r.folder, r.kind])).toEqual([
      ['plato-9x16.jpg', 'image/jpeg', 1080, 1920, 300_000, 'Recortes', 'image'],
      ['plato-1x1.webp', 'image/webp', 1080, 1080, 120_000, 'Recortes', 'image'],
    ]);
    expect(rows[0]!.provenance).toMatchObject({
      type: 'media_job',
      job_id: job.id,
      aspect: '9:16',
      sources: [{ type: 'photo', path: fotoA }],
    });
    expect((await jobById(job.id)).result!.assets).toHaveLength(2);
  });

  it('un resultado que no corresponde al encargo no cierra el trabajo ni crea nada', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    await claim();
    await expect(complete(job.id, reelResult(`${orgA}/${marcaA}/reels/otro.mp4`))).rejects.toThrow(
      /no corresponde a su encargo/,
    );
    await expect(complete(job.id, { ok: true })).rejects.toThrow(/no corresponde a su encargo/);
    expect(await jobById(job.id)).toMatchObject({ status: 'running' });
    expect(await assetsOf(job.id)).toEqual([]);
  });

  it('un fallo o una cancelación no crean nada en la biblioteca', async () => {
    const fails = await request(editor, marcaA, 'media.reel.template', reelInput());
    const cancelled = await request(editor, marcaA, 'media.reel.template', reelInput());
    await claim();
    await serviceRpc(db, 'fail_job', {
      p_job_id: fails.id,
      p_worker: 'medios-1',
      p_error: 'El reel pesa 61 MB',
      p_retry: false,
    });
    await serviceRpc(db, 'cancel_job', { p_job_id: cancelled.id });
    expect(await db.query(`select 1 from public.media_assets where provenance ->> 'type' = 'media_job'`)).toEqual([]);
  });

  it('el cliente no puede hacer pasar un archivo suyo por el resultado de un trabajo', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'video', $3, 'falso.mp4', 'video/mp4', 1, $4::jsonb)`,
      [marcaA, orgA, `${orgA}/${marcaA}/media/falso.mp4`, JSON.stringify({ type: 'media_job', job_id: job.id })],
      /solo la pone la base de datos/,
    );
    await denied(
      db,
      editor,
      `update public.media_assets set provenance = '{"type": "media_job"}' where storage_path = $1`,
      [fotoA],
    );
    // Otros tipos de procedencia (p. ej. la exportación del editor) siguen abiertos al insertar.
    await as(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', $3, 'export.png', 'image/png', 1, '{"type": "export"}'::jsonb)`,
      [marcaA, orgA, `${orgA}/${marcaA}/media/export-${job.id}.png`],
    );
  });

  it('la procedencia no pasa de los 2048 bytes de la columna aunque el reel tenga 20 piezas', async () => {
    // Rutas largas: con 20 piezas, las fuentes completas no caben.
    const largas: string[] = [];
    for (let i = 0; i < 20; i++) {
      largas.push(
        await asset(ana, orgA, marcaA, 'image', `${'foto-con-un-nombre-muy-largo-'.repeat(3)}${i}.jpg`, 'image/jpeg'),
      );
    }
    const job = await request(editor, marcaA, 'media.reel.template', {
      template: { id: 'pase-lateral' },
      plan: { media: largas.map((path) => ({ type: 'photo', path })) },
    });
    await claim();
    await complete(job.id, reelResult(job.payload.output!.path));
    const [reel] = await assetsOf(job.id);
    expect(Buffer.byteLength(JSON.stringify(reel!.provenance))).toBeLessThanOrEqual(2048);
    expect(reel!.provenance).toMatchObject({ type: 'media_job', job_id: job.id, sources_truncated: true });
    expect(reel!.provenance.source_asset_ids).toHaveLength(20);
  });
});

describe('contrato con el trabajador (su bucle real contra la cola SQL)', () => {
  const sqlQueue: JobQueue = {
    async claim({ worker, kinds, limit, leaseSeconds }) {
      const { sql, params } = rpcStatement('claim_jobs', {
        p_worker: worker,
        p_kinds: kinds,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      return (await asService<{ data: Job }>(db, sql, params)).map((r) => r.data);
    },
    async complete(jobId, worker, result) {
      await serviceRpc(db, 'complete_job', { p_job_id: jobId, p_worker: worker, p_result: result });
    },
    async fail(jobId, worker, error, retry) {
      await serviceRpc(db, 'fail_job', { p_job_id: jobId, p_worker: worker, p_error: error, p_retry: retry });
    },
    async release(jobId, worker) {
      await serviceRpc(db, 'release_job', { p_job_id: jobId, p_worker: worker });
    },
    async extendLease(jobId, worker, leaseSeconds) {
      await serviceRpc(db, 'extend_job_lease', { p_job_id: jobId, p_worker: worker, p_lease_seconds: leaseSeconds });
    },
  };

  it('lo que encarga la aplicación lo reclama el trabajador y su resultado acaba en la biblioteca', async () => {
    const job = await request(editor, marcaA, 'media.reel.template', reelInput());
    const seen: Job[] = [];
    const summary = await createWorker({
      queue: sqlQueue,
      storage: { download: async () => undefined, upload: async () => undefined },
      handlers: [
        {
          kind: 'media.reel.template',
          async run({ job: claimed }) {
            seen.push(claimed);
            const output = (claimed.payload as { output: { path: string } }).output;
            return reelResult(output.path);
          },
        },
      ],
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      workerId: 'medios-contrato',
      mode: 'drain',
      pollIntervalMs: 20,
      tmpRoot,
    }).run();

    expect(summary.outcomes.succeeded).toBe(1);
    // La carga que recibe el trabajador es la que valida su esquema: plantilla, plan y salida.
    expect(Object.keys(seen[0]!.payload).sort()).toEqual(['output', 'plan', 'template']);
    expect(seen[0]).toMatchObject({ organization_id: orgA, brand_id: marcaA });
    const [reel] = await assetsOf(job.id);
    expect(reel).toMatchObject({ kind: 'video', storage_path: job.payload.output!.path, folder: 'Reels' });
  });
});
