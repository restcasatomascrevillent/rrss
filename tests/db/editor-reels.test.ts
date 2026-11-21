// Editor de reels contra las migraciones reales (20261207010000_reel_editor):
// el montaje se guarda como versión de una pieza de formato reel, el encargo
// admite el plan v2 y el enlace con la pieza, cada archivo y cada tipografía
// se comprueban contra la marca, la música exige su licencia y el vídeo
// resultante queda unido a la pieza y a la versión en su procedencia.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  payload: Row & { output: { path: string }; plan: Row; content?: Row };
  result: (Row & { assets?: Array<{ id: string }> }) | null;
}

let db: Db;
let ana: TestUser, editor: TestUser, berta: TestUser;
let orgA: string, orgB: string, marcaA: string, marcaA2: string, marcaB: string;
let fotoA: string, clipA: string, musicaA: string, fuenteA: string, fuenteA2: string, clipB: string;
let reelA: string, postA: string, reelA2: string, reelB: string;
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

async function font(user: TestUser, org: string, brand: string, family: string) {
  const storagePath = `${org}/${brand}/fonts/${family.toLowerCase()}.ttf`;
  await as(
    db,
    user,
    `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type,
                                     bytes, license_confirmed)
     values ($1, $2, $3, 'ttf', $4, 'f.ttf', 'font/ttf', 10, true)`,
    [brand, org, family, storagePath],
  );
  return storagePath;
}

async function piece(user: TestUser, org: string, brand: string, format: string) {
  const rows = await as<{ id: string }>(
    db,
    user,
    `insert into public.content_items (brand_id, organization_id, title, network, format)
     values ($1, $2, 'Reel de prueba', 'instagram', $3) returning id`,
    [brand, org, format],
  );
  return rows[0]!.id;
}

const STYLE = {
  sizeRatio: 0.06,
  color: '#FFFFFF',
  marginRatio: 0.2,
  maxWidthRatio: 0.84,
  lineHeight: 1.3,
  box: null,
  outline: null,
  fadeSeconds: 0.25,
};

const planV2 = (overrides: Row = {}): Row => ({
  version: 2,
  clips: [
    { id: 'c1', type: 'photo', path: fotoA, seconds: 2, transition: { type: 'fade', seconds: 0.4 } },
    {
      id: 'c2',
      type: 'video',
      path: clipA,
      in: 0.5,
      out: 2.5,
      volume: 0.6,
      subtitles: [{ start: 0.6, end: 1.5, text: 'Hola' }],
    },
  ],
  texts: [
    { id: 't1', text: 'Menú del día', start: 0, end: 2, position: 'top', style: { ...STYLE, fontPath: fuenteA } },
  ],
  subtitles: { enabled: true, position: 'bottom', style: STYLE },
  music: {
    path: musicaA,
    startAt: 0,
    volume: 0.3,
    fadeInSeconds: 0.5,
    fadeOutSeconds: 1,
    license: { confirmed: true, note: 'Licencia de la marca' },
  },
  ...overrides,
});

const project = (plan: Row = planV2()) => ({ kind: 'reel', template: { id: 'fundido-suave' }, plan });

async function saveVersion(user: TestUser, contentId: string, data: Row) {
  const { sql, params } = rpcStatement('save_content_version', {
    p_content_id: contentId,
    p_data: data,
    p_schema_version: 2,
    p_change_note: 'Montaje',
  });
  return (await as<{ data: { version: number } }>(db, user, sql, params))[0]!.data;
}

const request = async (user: TestUser, brand: string, input: Row) => {
  const { sql, params } = rpcStatement('request_media_job', {
    p_brand_id: brand,
    p_kind: 'media.reel.template',
    p_input: input,
    p_idempotency_key: `editor-${++n}`,
  });
  return (await as<{ data: JobRow }>(db, user, sql, params))[0]!.data;
};

const rejected = (user: TestUser, brand: string, input: Row, pattern: RegExp) => {
  const { sql, params } = rpcStatement('request_media_job', {
    p_brand_id: brand,
    p_kind: 'media.reel.template',
    p_input: input,
    p_idempotency_key: `rechazo-${++n}`,
  });
  return denied(db, user, sql, params, pattern);
};

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test');
  editor = await createUser(db, 'editor@a.test');
  berta = await createUser(db, 'berta@b.test');
  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  marcaA = await createBrand(db, ana, orgA, 'Marca A');
  marcaA2 = await createBrand(db, ana, orgA, 'Marca A2');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
  await join(db, ana, editor, orgA, 'member', marcaA, 'editor');
  fotoA = await asset(ana, orgA, marcaA, 'image', 'plato.jpg', 'image/jpeg');
  clipA = await asset(ana, orgA, marcaA, 'video', 'cocina.mp4', 'video/mp4');
  musicaA = await asset(ana, orgA, marcaA, 'audio', 'musica.m4a', 'audio/mp4');
  clipB = await asset(berta, orgB, marcaB, 'video', 'ajeno.mp4', 'video/mp4');
  fuenteA = await font(ana, orgA, marcaA, 'Titular');
  fuenteA2 = await font(ana, orgA, marcaA2, 'Otra');
  reelA = await piece(editor, orgA, marcaA, 'reel');
  postA = await piece(editor, orgA, marcaA, 'post');
  reelA2 = await piece(ana, orgA, marcaA2, 'reel');
  reelB = await piece(berta, orgB, marcaB, 'reel');
});

afterAll(async () => {
  await db?.close();
});

describe('el montaje como versión de la pieza', () => {
  it('se guarda con versiones, como un diseño, y se puede aprobar esa versión', async () => {
    const v1 = await saveVersion(editor, reelA, project());
    expect(v1.version).toBe(1);
    const v2 = await saveVersion(editor, reelA, project(planV2({ texts: [] })));
    expect(v2.version).toBe(2);
    const rows = await as<{ version: number; schema_version: number; kind: string }>(
      db,
      editor,
      `select version, schema_version, data ->> 'kind' as kind from public.content_versions
       where content_id = $1 order by version`,
      [reelA],
    );
    expect(rows).toEqual([
      { version: 1, schema_version: 2, kind: 'reel' },
      { version: 2, schema_version: 2, kind: 'reel' },
    ]);
    const { sql, params } = rpcStatement('set_content_status', {
      p_content_id: reelA,
      p_status: 'approved',
      p_expected_version: 2,
    });
    await as(db, ana, sql, params);
    const [item] = await db.query<{ status: string }>(`select status from public.content_items where id = $1`, [reelA]);
    expect(item!.status).toBe('approved');
  });
});

describe('encargar el montaje (plan v2)', () => {
  it('admite el plan v2 con la pieza, y la base pone la salida y la tipografía de la marca', async () => {
    const job = await request(editor, marcaA, {
      template: { id: 'fundido-suave' },
      plan: planV2(),
      content: { id: reelA, version: 2 },
    });
    expect(job.payload.output.path).toMatch(new RegExp(`^${orgA}/${marcaA}/reels/[0-9a-f-]{36}\\.mp4$`));
    expect(job.payload.content).toEqual({ id: reelA, version: 2 });
    expect(job.payload.plan).toMatchObject({ version: 2, clips: [{ id: 'c1' }, { id: 'c2', in: 0.5 }] });
    expect(job.payload.plan.fontPath).toBe(fuenteA);

    // Solo subtítulos, sin textos: también lleva la tipografía de la marca.
    const subs = await request(editor, marcaA, { template: { id: 'fundido-suave' }, plan: planV2({ texts: [] }) });
    expect(subs.payload.plan.fontPath).toBe(fuenteA);
    // Sin textos ni subtítulos, no.
    const bare = await request(editor, marcaA, {
      template: { id: 'fundido-suave' },
      plan: planV2({ texts: [], subtitles: { enabled: false, position: 'bottom', style: STYLE } }),
    });
    expect(bare.payload.plan).not.toHaveProperty('fontPath');
  });

  it('rechaza archivos y tipografías de otra marca, campos de más y música sin licencia', async () => {
    const input = (plan: Row) => ({ template: { id: 'fundido-suave' }, plan });
    const clips = planV2().clips as Row[];
    await rejected(
      editor,
      marcaA,
      input(planV2({ clips: [{ ...clips[1], path: clipB }] })),
      /no es un recurso de esta marca/,
    );
    await rejected(
      editor,
      marcaA,
      input(
        planV2({
          texts: [{ id: 't', text: 'x', start: 0, end: 1, position: 'top', style: { ...STYLE, fontPath: fuenteA2 } }],
        }),
      ),
      /tipografía no es un \.ttf u \.otf de esta marca/,
    );
    await rejected(
      editor,
      marcaA,
      input(
        planV2({
          subtitles: {
            enabled: true,
            position: 'bottom',
            style: { ...STYLE, fontPath: `${orgA}/${marcaA}/fonts/no.ttf` },
          },
        }),
      ),
      /tipografía no es/,
    );
    await rejected(editor, marcaA, input(planV2({ fontPath: fuenteA })), /solo admite/);
    await rejected(editor, marcaA, input(planV2({ clips: [{ ...clips[0], cliente: 'x' }] })), /campos no admitidos/);
    const music = planV2().music as Row;
    await rejected(editor, marcaA, input(planV2({ music: { ...music, license: { confirmed: false } } })), /licencia/);
    await rejected(editor, marcaA, input(planV2({ music: { ...music, license: undefined } })), /licencia/);
    await rejected(
      editor,
      marcaA,
      input(planV2({ clips: [{ ...clips[1], subtitles: [{ start: 0, end: 1, text: '' }] }] })),
      /subtítulo no válido/,
    );
  });

  it('la pieza tiene que ser un reel vivo de la misma marca, con esa versión', async () => {
    const input = (content: Row) => ({ template: { id: 'fundido-suave' }, plan: planV2(), content });
    const pattern = /no es un reel de esta marca/;
    await rejected(editor, marcaA, input({ id: reelA, version: 9 }), pattern);
    await rejected(editor, marcaA, input({ id: postA, version: 1 }), pattern);
    await saveVersion(ana, reelA2, project());
    await rejected(ana, marcaA, input({ id: reelA2, version: 1 }), pattern);
    await rejected(editor, marcaA, input({ id: reelB, version: 1 }), pattern);
    await rejected(editor, marcaA, input({ id: 'no-es-un-uuid', version: 1 }), pattern);
  });

  it('el vídeo montado queda unido a la pieza y a su versión, con la licencia de la música', async () => {
    const job = await request(editor, marcaA, {
      template: { id: 'fundido-suave' },
      plan: planV2(),
      content: { id: reelA, version: 2 },
    });
    const { sql, params } = rpcStatement('claim_jobs', { p_worker: 'editor-1', p_limit: 10 });
    await asService(db, sql, params);
    const done = await serviceRpc<JobRow>(db, 'complete_job', {
      p_job_id: job.id,
      p_worker: 'editor-1',
      p_result: {
        template: { id: 'fundido-suave', schemaVersion: 1 },
        plan: { version: 2 },
        content: { id: reelA, version: 2 },
        output: {
          path: job.payload.output.path,
          width: 1080,
          height: 1920,
          fps: 30,
          durationSeconds: 3.6,
          videoCodec: 'h264',
          audioCodec: 'aac',
          bytes: 123456,
        },
        timeline: [],
        warnings: [],
      },
    });
    const assetId = done.result!.assets![0]!.id;
    const [video] = await db.query<{ provenance: Row; kind: string }>(
      `select kind, provenance from public.media_assets where id = $1`,
      [assetId],
    );
    expect(video!.kind).toBe('video');
    expect(video!.provenance).toMatchObject({
      type: 'media_job',
      plan_version: 2,
      content_id: reelA,
      content_version: 2,
      music_license: { confirmed: true, note: 'Licencia de la marca' },
      sources: [
        { type: 'photo', path: fotoA },
        { type: 'video', path: clipA },
      ],
    });
    // Quien ve la marca encuentra los montajes de la pieza; la otra organización, no.
    const mine = await as(db, editor, `select id from public.media_assets where provenance ->> 'content_id' = $1`, [
      reelA,
    ]);
    expect(mine).toHaveLength(1);
    const theirs = await as(db, berta, `select id from public.media_assets where provenance ->> 'content_id' = $1`, [
      reelA,
    ]);
    expect(theirs).toHaveLength(0);
  });
});
