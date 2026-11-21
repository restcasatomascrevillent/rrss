// Publicación (Fase 3) contra las migraciones reales y la Graph API SIMULADA:
//   programar → (regla dura de aprobación) → cola → publicador → «publicado»
// y lo que pasa cuando algo falla: un fallo o un reintento no publica dos
// veces, lo no aprobado no se publica aunque esté programado, token caducado,
// cupo de la API agotado, carrusel y reel. El aislamiento entre organizaciones
// está en aislamiento.test.ts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateDocumentFromAnyVersion } from '../../src/features/content/document/index.ts';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import type { ClaimedSocialJob } from '../../supabase/functions/_shared/social/contract.ts';
import { encryptToken, parseKeyRing, tokenBinding } from '../../supabase/functions/_shared/social/crypto.ts';
import { createMetaGraph } from '../../supabase/functions/_shared/social/meta-graph.ts';
import { processPublishJob, type PublisherDeps } from '../../supabase/functions/_shared/social/publisher.ts';
import {
  createSimulatedGraph,
  SIMULATED_IG_USER_ID,
  SIMULATED_PERMALINK_HOST,
  type SimulatedGraph,
} from '../../supabase/functions/_shared/social/simulated-graph.ts';
import { createSocialPublishHandler } from '../../supabase/functions/social-publish/handler.ts';
import {
  as,
  asService,
  assetPath,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser, revisor: TestUser, lector: TestUser;
let org: string, marca: string, marca2: string;
let cuenta: string, cuenta2: string;
let graph: SimulatedGraph;

const KEYS = parseKeyRing(`k1:${Buffer.alloc(32, 7).toString('base64')}`, 'k1');
const TOKEN = 'sim-page-pruebas-1';
const TOKEN2 = 'sim-page-pruebas-2';
const WORKER = 'pruebas:social-publish';

type Pub = {
  id: string;
  status: string;
  hold_reason: string | null;
  content_version: number | null;
  external_id: string | null;
  external_url: string | null;
  container_id: string | null;
  last_error_code: string | null;
  scheduled_at: string;
  social_account_id: string | null;
  media_asset_ids: string[];
  generation: number;
  attempt_count: number;
};

const COPY_OF = (caption: string, hashtags: string[]) => ({
  caption,
  hashtags,
  mentions: [],
  altText: 'Texto alternativo',
  callToAction: { label: '', url: '' },
});
/** Documento de una página tal y como lo guardaba la versión 1 (sin páginas). */
const DOC = (caption: string, hashtags: string[] = []) => ({
  schemaVersion: 1,
  canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
  layers: [],
  copy: COPY_OF(caption, hashtags),
});
/** Documento v4 con varias páginas (un carrusel). */
const PAGED_DOC = (pages: number, caption: string, hashtags: string[] = []) => ({
  schemaVersion: 4,
  canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
  pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i + 1}`, name: '', layers: [] })),
  copy: COPY_OF(caption, hashtags),
});

const toParams = (args: Record<string, unknown>) => {
  const names = Object.keys(args).filter((n) => args[n] !== undefined);
  return {
    list: names.map((n, i) => `${n} => $${i + 1}`).join(', '),
    params: names.map((n) => {
      const v = args[n];
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v;
    }),
  };
};

/** Llama a una función como lo haría supabase-js: jsonb tal cual, filas como objeto, conjuntos como lista. */
async function serviceCall(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const [meta] = await db.query<{ retset: boolean }>(
    `select bool_or(proretset) as retset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`,
    [fn],
  );
  const { list, params } = toParams(args);
  const sql = meta?.retset
    ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as data from public.${fn}(${list}) r`
    : `select to_jsonb(public.${fn}(${list})) as data`;
  const rows = await asService<{ data: unknown }>(db, sql, params);
  return rows[0]?.data ?? null;
}

const rpc: RpcClient = async (fn, args) => {
  try {
    return { data: await serviceCall(fn, args), error: null };
  } catch (error) {
    const { code, message, detail } = error as { code?: string; message: string; detail?: string };
    return { data: null, error: { code, message, details: detail ?? null } };
  }
};

async function userCall<T>(user: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const { list, params } = toParams(args);
  const [row] = await as<{ data: T }>(db, user, `select to_jsonb(r) as data from public.${fn}(${list}) r`, params);
  return row!.data;
}

const pubOf = async (id: string) =>
  (await db.query<Pub>(`select * from public.scheduled_publications where id = $1`, [id]))[0]!;

/** Pieza con un documento guardado, aprobada (si se pide) y con sus exportaciones JPEG. */
async function piece(
  opts: {
    brand?: string;
    format?: 'post' | 'carousel' | 'reel';
    approve?: boolean;
    exports?: number;
    /** Páginas del documento; por omisión, en un carrusel, una por exportación (al menos 2). */
    pages?: number;
    caption?: string;
    hashtags?: string[];
  } = {},
): Promise<{ contentId: string; assets: string[] }> {
  const brand = opts.brand ?? marca;
  const format = opts.format ?? 'post';
  const pages = opts.pages ?? (format === 'carousel' ? Math.max(2, opts.exports ?? 1) : 1);
  const [item] = await as<{ id: string }>(
    db,
    editor,
    `insert into public.content_items (brand_id, organization_id, title, network, format)
     values ($1, $2, 'Pieza', 'instagram', $3) returning id`,
    [brand, org, format],
  );
  const contentId = item!.id;
  await as(db, ana, `select public.save_content_version($1, $2::jsonb, 1)`, [
    contentId,
    JSON.stringify(
      pages > 1
        ? PAGED_DOC(pages, opts.caption ?? 'Pan de otoño', opts.hashtags ?? [])
        : DOC(opts.caption ?? 'Pan de otoño', opts.hashtags ?? []),
    ),
  ]);
  const assets: string[] = [];
  if (format === 'reel') {
    const [row] = await as<{ id: string }>(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'video', $3, 'reel.mp4', 'video/mp4', 100) returning id`,
      [brand, org, assetPath(org, brand, `${crypto.randomUUID()}.mp4`)],
    );
    assets.push(row!.id);
  } else {
    for (let i = 0; i < (opts.exports ?? 1); i++) {
      assets.push(await exportOf(brand, contentId, 1, 'image/jpeg', pages > 1 ? { page: i + 1, count: pages } : undefined));
    }
  }
  if (opts.approve ?? true) {
    await as(db, ana, `select public.set_content_status($1, 'approved', 1)`, [contentId]);
  }
  return { contentId, assets };
}

async function exportOf(
  brand: string,
  contentId: string,
  version: number | null,
  mime = 'image/jpeg',
  page?: { page: number; count: number },
) {
  const [row] = await as<{ id: string }>(
    db,
    editor,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
     values ($1, $2, 'image', $3, 'exportada.jpg', $4, 100, $5::jsonb) returning id`,
    [
      brand,
      org,
      assetPath(org, brand),
      mime,
      JSON.stringify({
        type: 'export',
        content_id: contentId,
        version,
        unsaved_changes: false,
        format: 'jpeg',
        ...(page ? { page: page.page, page_count: page.count } : {}),
      }),
    ],
  );
  return row!.id;
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

async function schedule(contentId: string, assets: string[], account = cuenta, user: TestUser = editor): Promise<Pub> {
  return userCall<Pub>(user, 'save_publication', {
    p_publication_id: null,
    p_content_id: contentId,
    p_scheduled_at: inAnHour(),
    p_social_account_id: account,
    p_media_asset_ids: assets,
  });
}

/** Hace que la publicación «toque ya» (como si hubiera pasado el tiempo). */
async function makeDue(pubId: string) {
  await db.query(`update public.scheduled_publications set scheduled_at = now() - interval '1 second' where id = $1`, [
    pubId,
  ]);
}

/** Pone ya disponibles los trabajos aplazados (como si hubiera pasado el tiempo). */
async function wakeJobs() {
  await db.query(`update public.jobs set run_after = now() where kind = 'social.publish' and status = 'queued'`);
}

function publisherDeps(extra: Partial<PublisherDeps> = {}): PublisherDeps {
  return {
    rpc,
    api: createMetaGraph({ fetch: graph.fetch }),
    keyRing: KEYS,
    signedUrl: async (path) => `https://almacen.pruebas.invalid/firmada/${path}`,
    workerName: WORKER,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    ...extra,
  };
}

/** Una pasada del reloj: encola lo que toca, reclama y publica. */
async function tick(extra: Partial<PublisherDeps> = {}) {
  await serviceCall('social_enqueue_due_publications', { p_limit: 100 });
  const jobs = (await serviceCall('claim_jobs', {
    p_worker: WORKER,
    p_kinds: ['social.publish'],
    p_limit: 20,
    p_lease_seconds: 300,
  })) as ClaimedSocialJob[];
  const results = [];
  for (const job of jobs) results.push(await processPublishJob(job, publisherDeps(extra)));
  return results;
}

async function connect(brand: string, token: string, externalId = SIMULATED_IG_USER_ID): Promise<string> {
  const binding = tokenBinding({ brandId: brand, network: 'instagram', externalId });
  const access = await encryptToken(KEYS, token, binding);
  const account = (await serviceCall('social_account_connect', {
    p_user_id: ana.id,
    p_brand_id: brand,
    p_network: 'instagram',
    p_external_id: externalId,
    p_username: 'cuenta_simulada',
    p_display_name: 'Cuenta simulada',
    p_page_id: '1',
    p_scopes: ['instagram_basic', 'instagram_content_publish'],
    p_token_expires_at: null,
    p_key_id: access.keyId,
    p_access_token_ciphertext: access.ciphertext,
    p_refresh_token_ciphertext: null,
  })) as { id: string };
  return account.id;
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@pub.test', 'Ana');
  editor = await createUser(db, 'editor@pub.test', 'Editor');
  revisor = await createUser(db, 'revisor@pub.test', 'Revisor');
  lector = await createUser(db, 'lector@pub.test', 'Lector');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
  marca2 = await createBrand(db, ana, org, 'Marca 2');
  for (const brand of [marca, marca2]) await join(db, ana, editor, org, 'member', brand, 'editor');
  await join(db, ana, revisor, org, 'member', marca, 'reviewer');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
  cuenta = await connect(marca, TOKEN);
  cuenta2 = await connect(marca2, TOKEN2);
});

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  graph = createSimulatedGraph();
});

describe('programar: la regla dura de aprobación', () => {
  it('una pieza aprobada con su exportación y una cuenta queda armada; sin aprobar, en espera', async () => {
    const ok = await piece();
    const armada = await schedule(ok.contentId, ok.assets);
    expect(armada).toMatchObject({ status: 'scheduled', hold_reason: null, content_version: 1 });

    const sin = await piece({ approve: false });
    const espera = await schedule(sin.contentId, sin.assets);
    expect(espera).toMatchObject({ status: 'planned', hold_reason: 'not_approved', content_version: null });

    // Al aprobarla, se arma sola y adopta la versión aprobada.
    await as(db, ana, `select public.set_content_status($1, 'approved', 1)`, [sin.contentId]);
    expect(await pubOf(espera.id)).toMatchObject({ status: 'scheduled', content_version: 1 });
  });

  it('si la pieza cambia después de aprobar, la programación se detiene hasta reaprobar', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    expect(pub.status).toBe('scheduled');

    // Retirar la aprobación (sin cambiar la versión) la detiene; reaprobar la misma versión la rearma.
    await as(db, editor, `select public.set_content_status($1, 'draft')`, [p.contentId]);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'planned', hold_reason: 'not_approved' });
    await as(db, ana, `select public.set_content_status($1, 'approved', 1)`, [p.contentId]);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'scheduled' });

    // Guardar otra versión la detiene; aprobar la versión nueva NO la rearma con
    // la exportación vieja: hay que elegir la exportación de la versión nueva.
    await as(db, editor, `select public.save_content_version($1, $2::jsonb, 1)`, [
      p.contentId,
      JSON.stringify(DOC('Otro texto')),
    ]);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'planned', hold_reason: 'not_approved' });
    await as(db, ana, `select public.set_content_status($1, 'approved', 2)`, [p.contentId]);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'planned', hold_reason: 'content_changed' });

    const nueva = await exportOf(marca, p.contentId, 2);
    const actualizada = await userCall<Pub>(editor, 'save_publication', {
      p_publication_id: pub.id,
      p_content_id: p.contentId,
      p_scheduled_at: inAnHour(),
      p_social_account_id: cuenta,
      p_media_asset_ids: [nueva],
      p_content_version: 2,
    });
    expect(actualizada).toMatchObject({ status: 'scheduled', content_version: 2 });
  });

  it('ni siquiera el dueño de la base de datos pasa a «publicando» algo sin aprobar', async () => {
    const p = await piece({ approve: false });
    const pub = await schedule(p.contentId, p.assets);
    // La clave de servicio no puede escribir la tabla a mano…
    await expect(
      asService(db, `update public.scheduled_publications set scheduled_at = now() where id = $1`, [pub.id]),
    ).rejects.toThrow(/permission denied/);
    // …y la guarda vale incluso para el superusuario.
    await expect(
      db.query(
        `update public.scheduled_publications set status = 'publishing', hold_reason = null, content_version = 1,
           locked_by = 'x', locked_until = now() + interval '1 minute' where id = $1`,
        [pub.id],
      ),
    ).rejects.toThrow(/no está aprobado/);
    await expect(
      db.query(
        `update public.scheduled_publications set status = 'scheduled', hold_reason = null, content_version = 1 where id = $1`,
        [pub.id],
      ),
    ).rejects.toThrow(/no está aprobado/);
  });

  it('«publicado» solo con el identificador de la red, y lo publicado no cambia', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await expect(
      db.query(`update public.scheduled_publications set status = 'published', published_at = now() where id = $1`, [
        pub.id,
      ]),
    ).rejects.toThrow(/publicando|check/);
  });

  it('los recursos tienen que ser exportaciones JPEG de esa pieza y esa versión', async () => {
    const p = await piece({ exports: 0 });
    const png = await exportOf(marca, p.contentId, 1, 'image/png');
    expect((await schedule(p.contentId, [png])).hold_reason).toBe('invalid_media');

    const otra = await piece();
    const ajena = await exportOf(marca, otra.contentId, 1);
    const q = await piece({ exports: 0 });
    expect((await schedule(q.contentId, [ajena])).hold_reason).toBe('invalid_media');

    const r = await piece({ exports: 0 });
    expect((await schedule(r.contentId, [])).hold_reason).toBe('no_media');

    // Un carrusel necesita de 2 a 10 imágenes.
    const c = await piece({ format: 'carousel', exports: 1 });
    expect((await schedule(c.contentId, c.assets)).hold_reason).toBe('invalid_media');
  });

  it('una pieza se programa una sola vez, y solo quien edita la marca programa', async () => {
    const p = await piece();
    await schedule(p.contentId, p.assets);
    await expect(schedule(p.contentId, p.assets)).rejects.toThrow(/duplicate|única|unique/i);

    const q = await piece();
    await expect(schedule(q.contentId, q.assets, cuenta, revisor)).rejects.toThrow(/permiso/);
    await expect(schedule(q.contentId, q.assets, cuenta, lector)).rejects.toThrow(/permiso/);
    // Nadie escribe la tabla a mano.
    await denied(db, editor, `update public.scheduled_publications set status = 'published' where content_id = $1`, [
      p.contentId,
    ]);
    await denied(db, editor, `delete from public.scheduled_publications where content_id = $1`, [p.contentId]);
  });

  it('mover de fecha (arrastrar), cancelar y no programar en el pasado', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    const manana = new Date(Date.now() + 86_400_000).toISOString();
    const movida = await userCall<Pub & { scheduled_at: string }>(editor, 'reschedule_publication', {
      p_publication_id: pub.id,
      p_scheduled_at: manana,
    });
    expect(Date.parse(movida.scheduled_at)).toBe(Date.parse(manana));
    await expect(
      userCall(editor, 'reschedule_publication', { p_publication_id: pub.id, p_scheduled_at: '2020-01-01T00:00:00Z' }),
    ).rejects.toThrow(/pasado/);
    await expect(
      userCall(revisor, 'reschedule_publication', { p_publication_id: pub.id, p_scheduled_at: manana }),
    ).rejects.toThrow(/permiso/);
    expect((await userCall<Pub>(editor, 'cancel_publication', { p_publication_id: pub.id })).status).toBe('cancelled');
    // Cancelada, la pieza se puede volver a programar.
    expect((await schedule(p.contentId, p.assets)).status).toBe('scheduled');
  });

  it('desconectar la cuenta detiene lo programado y borra el token', async () => {
    const otraCuenta = await connect(marca2, 'sim-page-desconectar', '17841400000000999');
    const p = await piece({ brand: marca2 });
    const pub = await schedule(p.contentId, p.assets, otraCuenta);
    expect(pub.status).toBe('scheduled');
    await expect(userCall(editor, 'disconnect_social_account', { p_account_id: otraCuenta })).rejects.toThrow(
      /gestiona/,
    );
    await userCall(ana, 'disconnect_social_account', { p_account_id: otraCuenta });
    expect(await pubOf(pub.id)).toMatchObject({ status: 'planned', hold_reason: 'account_disconnected' });
    expect(await serviceCall('social_account_token', { p_account_id: otraCuenta })).toBeNull();
    // Volver a conectar la cuenta de antes para el resto de pruebas.
    cuenta2 = await connect(marca2, TOKEN2);
  });
});

describe('aprobaciones y comentarios en la pieza', () => {
  it('aprobar por lotes dice qué se aprobó y qué no; queda en la conversación de la pieza', async () => {
    const a = await piece({ approve: false });
    const b = await piece({ approve: false });
    await as(db, editor, `select public.set_content_status($1, 'in_review')`, [a.contentId]);
    // b se queda en borrador: el revisor no puede aprobar un borrador.
    const filas = await as<{ content_id: string; ok: boolean; message: string | null }>(
      db,
      revisor,
      `select * from public.approve_content_items($1::jsonb)`,
      [
        JSON.stringify([
          { content_id: a.contentId, version: 1 },
          { content_id: b.contentId, version: 1 },
        ]),
      ],
    );
    expect(filas.find((f) => f.content_id === a.contentId)).toMatchObject({ ok: true });
    expect(filas.find((f) => f.content_id === b.contentId)).toMatchObject({ ok: false });
    const eventos = await as<{ kind: string; version: number; author_id: string }>(
      db,
      lector,
      `select kind, version, author_id from public.content_comments where content_id = $1`,
      [a.contentId],
    );
    expect(eventos).toEqual([{ kind: 'approved', version: 1, author_id: revisor.id }]);
    // El editor no aprueba, ni por lotes.
    const [rechazo] = await as<{ ok: boolean }>(db, editor, `select * from public.approve_content_items($1::jsonb)`, [
      JSON.stringify([{ content_id: b.contentId, version: 1 }]),
    ]);
    expect(rechazo?.ok).toBe(false);
  });

  it('comentar y pedir cambios; el lector solo lee', async () => {
    const p = await piece();
    await userCall(revisor, 'comment_content_item', { p_content_id: p.contentId, p_body: 'Me gusta la foto' });
    await expect(
      userCall(lector, 'comment_content_item', { p_content_id: p.contentId, p_body: 'Hola' }),
    ).rejects.toThrow(/permiso/);
    const item = await userCall<{ status: string }>(revisor, 'request_content_changes', {
      p_content_id: p.contentId,
      p_message: 'Cambia el titular',
    });
    expect(item.status).toBe('draft');
    const kinds = await as<{ kind: string }>(
      db,
      lector,
      `select kind from public.content_comments where content_id = $1 order by created_at, kind`,
      [p.contentId],
    );
    expect(kinds.map((k) => k.kind).sort()).toEqual(['approved', 'changes_requested', 'comment']);
  });
});

describe('publicador con la Graph API simulada', () => {
  it('publica una imagen aprobada y guarda su identificador y su enlace', async () => {
    const p = await piece({ caption: 'Pan de otoño #panaderia', hashtags: ['panaderia', 'otoño'] });
    const pub = await schedule(p.contentId, p.assets);

    // Antes de su hora no sale nada.
    expect((await tick()).filter((r) => r.publicationId === pub.id)).toEqual([]);
    await makeDue(pub.id);
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'published' });

    const after = await pubOf(pub.id);
    expect(after.status).toBe('published');
    expect(after.external_id).toBe(graph.published[0]!.id);
    expect(after.external_url).toBe(`${SIMULATED_PERMALINK_HOST}/p/${after.external_id}/`);
    expect(graph.published).toHaveLength(1);
    // El texto publicado es el de la versión aprobada con los hashtags que faltaban.
    expect(graph.published[0]!.caption).toBe('Pan de otoño #panaderia\n\n#otoño');
    expect(graph.published[0]!.mediaUrls[0]).toMatch(/^https:\/\/almacen\.pruebas\.invalid\/firmada\//);

    const intentos = await as(
      db,
      lector,
      `select outcome, external_id from public.publication_attempts where publication_id = $1`,
      [pub.id],
    );
    expect(intentos).toEqual([{ outcome: 'published', external_id: after.external_id }]);

    // Otra pasada no hace nada: ya está publicada.
    await tick();
    expect(graph.published).toHaveLength(1);
  });

  it('un tiempo agotado DESPUÉS de publicar no duplica: se recupera la publicación', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    graph.fail({ op: 'media_publish', mode: 'timeout_after' });
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'recovered' });
    expect(graph.published).toHaveLength(1);
    const after = await pubOf(pub.id);
    expect(after).toMatchObject({ status: 'published', external_id: graph.published[0]!.id });
    expect(graph.calls.filter((c) => c.endsWith('/media_publish'))).toHaveLength(1);
  });

  it('si el servidor cae tras publicar y antes de anotarlo, el reintento no vuelve a publicar', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    // Simula la caída: la base de datos no acepta el «publicado» la primera vez.
    let caidas = 0;
    const rpcQueCae: RpcClient = async (fn, args) => {
      if (fn === 'social_publication_succeed' && caidas++ === 0) {
        return { data: null, error: { message: 'conexión perdida' } };
      }
      return rpc(fn, args);
    };
    const [primera] = (await tick({ rpc: rpcQueCae })).filter((x) => x.publicationId === pub.id);
    expect(primera).toMatchObject({ outcome: 'error' });
    expect(graph.published).toHaveLength(1);
    expect((await pubOf(pub.id)).status).toBe('publishing');

    await wakeJobs();
    const [segunda] = (await tick({ rpc: rpcQueCae })).filter((x) => x.publicationId === pub.id);
    expect(segunda).toMatchObject({ outcome: 'recovered' });
    expect(graph.published).toHaveLength(1);
    expect((await pubOf(pub.id)).status).toBe('published');
  });

  it('un fallo provocado antes de publicar se reintenta con el mismo contenedor y publica una sola vez', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    graph.fail({
      op: 'media_publish',
      mode: 'error',
      error: { code: 2, message: 'Service temporarily unavailable', status: 503 },
    });
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'retrying' });
    const tras = await pubOf(pub.id);
    expect(tras).toMatchObject({ status: 'scheduled', last_error_code: 'transient' });
    expect(tras.container_id).toBeTruthy();
    expect(graph.published).toHaveLength(0);

    await wakeJobs();
    const [r2] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r2).toMatchObject({ outcome: 'published' });
    expect(graph.published).toHaveLength(1);
    // No se creó un segundo contenedor: se reutilizó el guardado.
    expect(graph.calls.filter((c) => c === `POST /${SIMULATED_IG_USER_ID}/media`)).toHaveLength(1);
    const intentos = await db.query<{ outcome: string }>(
      `select outcome from public.publication_attempts where publication_id = $1 order by attempt_no`,
      [pub.id],
    );
    expect(intentos.map((i) => i.outcome)).toEqual(['retrying', 'published']);
  });

  it('lo que no está aprobado no se publica aunque esté programado y su trabajo llegue a la cola', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    await serviceCall('social_enqueue_due_publications', { p_limit: 100 });
    // Entre encolar y publicar, alguien guarda otra versión: la aprobación ya no vale.
    await as(db, editor, `select public.save_content_version($1, $2::jsonb, 1)`, [
      p.contentId,
      JSON.stringify(DOC('Cambio de última hora')),
    ]);
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r?.outcome).toBe('not_ready');
    expect(graph.published).toHaveLength(0);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'planned', hold_reason: 'not_approved' });
    const [intento] = await db.query(`select outcome from public.publication_attempts where publication_id = $1`, [
      pub.id,
    ]);
    expect(intento).toEqual({ outcome: 'not_ready' });
  });

  it('si deja de estar aprobada mientras se prepara el medio, no llega a media_publish', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    // La retirada de la aprobación ocurre justo cuando Instagram responde al crear el contenedor.
    const api = createMetaGraph({ fetch: graph.fetch });
    const r = await (async () => {
      await serviceCall('social_enqueue_due_publications', { p_limit: 100 });
      const jobs = (await serviceCall('claim_jobs', {
        p_worker: WORKER,
        p_kinds: ['social.publish'],
        p_limit: 20,
        p_lease_seconds: 300,
      })) as ClaimedSocialJob[];
      const job = jobs.find((j) => j.payload.publication_id === pub.id)!;
      return processPublishJob(
        job,
        publisherDeps({
          api: {
            ...api,
            async containerStatus(id, token) {
              await as(db, editor, `select public.set_content_status($1, 'draft')`, [p.contentId]);
              return api.containerStatus(id, token);
            },
          },
        }),
      );
    })();
    expect(r.outcome).toBe('not_ready');
    expect(graph.published).toHaveLength(0);
    expect(graph.calls.some((c) => c.endsWith('/media_publish'))).toBe(false);
    expect((await pubOf(pub.id)).status).toBe('planned');
  });

  it('token caducado: no se publica, la cuenta pide reconectar y lo programado se detiene', async () => {
    const p = await piece({ brand: marca2 });
    const pub = await schedule(p.contentId, p.assets, cuenta2);
    const otra = await piece({ brand: marca2 });
    const pendiente = await schedule(otra.contentId, otra.assets, cuenta2);
    await makeDue(pub.id);
    graph.expireToken(TOKEN2);
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'failed', errorCode: 'token_expired' });
    expect(graph.published).toHaveLength(0);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'failed', last_error_code: 'token_expired' });
    const [account] = await db.query(`select status from public.social_accounts where id = $1`, [cuenta2]);
    expect(account).toEqual({ status: 'needs_reauth' });
    expect(await pubOf(pendiente.id)).toMatchObject({ status: 'planned', hold_reason: 'account_needs_reauth' });

    // Reconectar (token nuevo) y reintentar: publica una vez.
    cuenta2 = await connect(marca2, 'sim-page-pruebas-2b');
    expect(await pubOf(pendiente.id)).toMatchObject({ status: 'scheduled' });
    const reintento = await userCall<Pub>(editor, 'retry_publication', { p_publication_id: pub.id });
    expect(reintento).toMatchObject({ status: 'scheduled', generation: 2 });
    await makeDue(pub.id);
    const [r2] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r2).toMatchObject({ outcome: 'published' });
    expect(graph.published).toHaveLength(1);
  });

  it('cupo de la API agotado: se aplaza sin gastar intentos y se anota el uso en la cuenta', async () => {
    graph = createSimulatedGraph({ quotaTotal: 50, quotaUsage: 50 });
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'deferred', errorCode: 'publish_limit' });
    expect(graph.published).toHaveLength(0);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'scheduled', last_error_code: 'publish_limit' });
    const [job] = await db.query<{ attempts: number; status: string; later: boolean }>(
      `select attempts, status::text, run_after > now() + interval '50 minutes' as later from public.jobs
       where payload ->> 'publication_id' = $1`,
      [pub.id],
    );
    expect(job).toEqual({ attempts: 0, status: 'queued', later: true });
    const [account] = await db.query(`select quota_usage, quota_total from public.social_accounts where id = $1`, [
      cuenta,
    ]);
    expect(account).toEqual({ quota_usage: 50, quota_total: 50 });

    // Cuando hay cupo otra vez, sale.
    graph.setQuotaUsage(10);
    await wakeJobs();
    const [r2] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r2).toMatchObject({ outcome: 'published' });
  });

  it('el límite de publicación que devuelve media_publish también aplaza', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    graph.fail({ op: 'media_publish', mode: 'error', error: { code: 9, subcode: 2207042, message: 'limit' } });
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'deferred', errorCode: 'publish_limit' });
    expect(graph.published).toHaveLength(0);
  });

  it('carrusel: un contenedor por imagen y uno del carrusel, publicado una vez', async () => {
    const p = await piece({ format: 'carousel', exports: 3 });
    const pub = await schedule(p.contentId, p.assets);
    expect(pub.status).toBe('scheduled');
    await makeDue(pub.id);
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'published' });
    expect(graph.published).toHaveLength(1);
    expect(graph.published[0]).toMatchObject({ kind: 'CAROUSEL' });
    expect(graph.published[0]!.mediaUrls).toHaveLength(3);
  });

  it('reel: si Instagram aún procesa el vídeo, se espera sin soltar el cerrojo ni gastar intentos', async () => {
    graph = createSimulatedGraph({ reelPolls: 3 });
    const p = await piece({ format: 'reel' });
    const pub = await schedule(p.contentId, p.assets);
    expect(pub.status).toBe('scheduled');
    await makeDue(pub.id);
    const [r] = (await tick({ pollAttempts: 1 })).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'waiting' });
    expect(await pubOf(pub.id)).toMatchObject({ status: 'publishing' });

    // Otro trabajo de la misma publicación (por ejemplo, tras moverla) la encuentra ocupada.
    const otro = (await serviceCall('enqueue_job', {
      p_organization_id: org,
      p_kind: 'social.publish',
      p_payload: { publication_id: pub.id },
      p_idempotency_key: `otro-${pub.id}`,
      p_brand_id: marca,
    })) as { id: string };
    const results = await tick({ pollAttempts: 1 });
    expect(results.find((x) => x.publicationId === pub.id && x.outcome === 'busy')).toBeTruthy();
    expect(otro.id).toBeTruthy();

    await wakeJobs();
    const finales = (await tick({ pollAttempts: 5 })).filter((x) => x.publicationId === pub.id);
    expect(finales.map((x) => x.outcome)).toContain('published');
    expect(graph.published).toHaveLength(1);
    expect(graph.published[0]).toMatchObject({ kind: 'REELS' });
    const [job] = await db.query<{ attempts: number }>(
      `select attempts from public.jobs where payload ->> 'publication_id' = $1 and idempotency_key like 'social.publish:%'`,
      [pub.id],
    );
    expect(job?.attempts).toBe(1);
  });

  it('una cancelada antes de su hora no se publica', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    await serviceCall('social_enqueue_due_publications', { p_limit: 100 });
    await userCall(editor, 'cancel_publication', { p_publication_id: pub.id });
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r?.outcome).toBe('gone');
    expect(graph.published).toHaveLength(0);
  });
});

describe('carrusel: una versión con varias páginas', () => {
  beforeEach(async () => {
    await tick();
    graph = createSimulatedGraph();
  });

  const pathsOf = async (ids: string[]) =>
    (
      await db.query<{ storage_path: string }>(
        `select a.storage_path from unnest($1::uuid[]) with ordinality u(id, ord)
         join public.media_assets a on a.id = u.id order by u.ord`,
        [ids],
      )
    ).map((r) => r.storage_path);

  it('se arma solo con una exportación de cada página de la versión, en el orden de las páginas', async () => {
    const p = await piece({ format: 'carousel', exports: 3 });
    // En orden: armada.
    const pub = await schedule(p.contentId, p.assets);
    expect(pub.status).toBe('scheduled');
    // Desordenada: en espera.
    const moved = await userCall<Pub>(editor, 'save_publication', {
      p_publication_id: pub.id,
      p_content_id: p.contentId,
      p_scheduled_at: inAnHour(),
      p_social_account_id: cuenta,
      p_media_asset_ids: [p.assets[1], p.assets[0], p.assets[2]],
    });
    expect(moved).toMatchObject({ status: 'planned', hold_reason: 'invalid_media' });
  });

  it('falta una página, sobra una, se repite o es de otra versión: no se arma', async () => {
    const tresPaginas = await piece({ format: 'carousel', exports: 2, pages: 3 });
    expect((await schedule(tresPaginas.contentId, tresPaginas.assets)).hold_reason).toBe('invalid_media');

    const repetida = await piece({ format: 'carousel', exports: 2 });
    expect((await schedule(repetida.contentId, [repetida.assets[0]!, repetida.assets[0]!])).hold_reason).toBe(
      'invalid_media',
    );

    // Exportaciones sin número de página (las de antes del documento v4) no valen para un carrusel.
    const sinPagina = await piece({ format: 'carousel', exports: 0, pages: 2 });
    const viejas = [await exportOf(marca, sinPagina.contentId, 1), await exportOf(marca, sinPagina.contentId, 1)];
    expect((await schedule(sinPagina.contentId, viejas)).hold_reason).toBe('invalid_media');

    // Una tanda de páginas que dice tener 3 en un documento de 2.
    const otraTanda = await piece({ format: 'carousel', exports: 0, pages: 2 });
    const mal = [
      await exportOf(marca, otraTanda.contentId, 1, 'image/jpeg', { page: 1, count: 3 }),
      await exportOf(marca, otraTanda.contentId, 1, 'image/jpeg', { page: 2, count: 3 }),
    ];
    expect((await schedule(otraTanda.contentId, mal)).hold_reason).toBe('invalid_media');

    // Páginas de otra versión.
    const otraVersion = await piece({ format: 'carousel', exports: 0, pages: 2 });
    const deLaDos = [
      await exportOf(marca, otraVersion.contentId, 2, 'image/jpeg', { page: 1, count: 2 }),
      await exportOf(marca, otraVersion.contentId, 2, 'image/jpeg', { page: 2, count: 2 }),
    ];
    expect((await schedule(otraVersion.contentId, deLaDos)).hold_reason).toBe('invalid_media');
  });

  it('un post con un documento de varias páginas no se arma; uno de una página sí', async () => {
    const varias = await piece({ format: 'post', exports: 0, pages: 2 });
    const portada = await exportOf(marca, varias.contentId, 1, 'image/jpeg', { page: 1, count: 2 });
    expect((await schedule(varias.contentId, [portada])).hold_reason).toBe('invalid_media');
    const una = await piece({ format: 'post' });
    expect((await schedule(una.contentId, una.assets)).status).toBe('scheduled');
  });

  it('el publicador envía las imágenes en el orden de las páginas', async () => {
    const p = await piece({ format: 'carousel', exports: 4 });
    const pub = await schedule(p.contentId, p.assets);
    expect(pub.status).toBe('scheduled');
    await makeDue(pub.id);
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'published' });
    expect(graph.published).toHaveLength(1);
    expect(graph.published[0]).toMatchObject({ kind: 'CAROUSEL' });
    const expected = (await pathsOf(p.assets)).map((path) => `https://almacen.pruebas.invalid/firmada/${path}`);
    expect(graph.published[0]!.mediaUrls).toEqual(expected);
  });

  it('el SQL para el integrador une 4 versiones (una diapositiva cada una) en una versión de 4 páginas', async () => {
    const layer = (id: string, color: string) => ({
      id,
      type: 'shape',
      shape: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fill: color,
      groupId: 'g1',
    });
    const slide = (n: number) => ({
      ...DOC(`Diapositiva ${n}`),
      schemaVersion: 3,
      layers: [layer('fondo', '#111111'), layer('titulo', `#00000${n}`)],
    });
    const [item] = await as<{ id: string }>(
      db,
      editor,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Carrusel por versiones', 'instagram', 'carousel') returning id`,
      [marca, org],
    );
    for (let n = 1; n <= 4; n++) {
      await as(db, ana, `select public.save_content_version($1, $2::jsonb, 3)`, [item!.id, JSON.stringify(slide(n))]);
    }
    const template = await readFile(path.join(import.meta.dirname, '../../scripts/unir-versiones-en-carrusel.sql'), 'utf8');
    // Sin rellenar, no hace nada.
    await expect(db.exec(template)).rejects.toThrow(/uuid/);
    await db.exec('rollback').catch(() => undefined);
    await db.exec(
      template
        .replace("'<content_id de la pieza>'", `'${item!.id}'`)
        .replace("'<user_id de un editor de la marca>'", `'${editor.id}'`),
    );
    const [saved] = await db.query<{ version: number; schema_version: number; data: unknown; created_by: string }>(
      `select version, schema_version, data, created_by from public.content_versions
       where content_id = $1 order by version desc limit 1`,
      [item!.id],
    );
    // El SQL del integrador escribe documentos v4: se leen migrándolos, como hace la aplicación.
    expect(saved).toMatchObject({ version: 5, schema_version: 4, created_by: editor.id });
    const checked = validateDocumentFromAnyVersion(saved!.data);
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
    expect(checked.document.pages.map((p) => p.layers.map((l) => l.id))).toEqual([
      ['s1-fondo', 's1-titulo'],
      ['s2-fondo', 's2-titulo'],
      ['s3-fondo', 's3-titulo'],
      ['s4-fondo', 's4-titulo'],
    ]);
    expect(checked.document.pages[2]!.layers[0]!.groupId).toBe('s3-g1');
    expect(checked.document.copy.caption).toBe('Diapositiva 4');
    // Con sus 4 exportaciones en orden y aprobada, se programa.
    const assets: string[] = [];
    for (let n = 1; n <= 4; n++) {
      assets.push(await exportOf(marca, item!.id, 5, 'image/jpeg', { page: n, count: 4 }));
    }
    await as(db, ana, `select public.set_content_status($1, 'approved', 5)`, [item!.id]);
    expect((await schedule(item!.id, assets)).status).toBe('scheduled');
    // Ya convertida, no se puede convertir otra vez (las versiones 1 a 4 siguen siendo v3, pero la lista pide la 5).
    await expect(
      db.exec(
        template
          .replace("'<content_id de la pieza>'", `'${item!.id}'`)
          .replace("'<user_id de un editor de la marca>'", `'${editor.id}'`)
          .replace('array[1, 2, 3, 4]', 'array[4, 5]'),
      ),
    ).rejects.toThrow(/ya tiene páginas/);
    await db.exec('rollback').catch(() => undefined);
  });

  it('un carrusel que cambia de versión se rearma con las páginas de la versión aprobada, conservando fecha y cuenta', async () => {
    const p = await piece({ format: 'carousel', exports: 3 });
    const pub = await schedule(p.contentId, p.assets);
    expect(pub.status).toBe('scheduled');
    // Otra versión de 3 páginas, aprobada: la publicación espera con «content_changed».
    await as(db, editor, `select public.save_content_version($1, $2::jsonb, 1)`, [
      p.contentId,
      JSON.stringify(PAGED_DOC(3, 'Otra tanda')),
    ]);
    await as(db, ana, `select public.set_content_status($1, 'approved', 2)`, [p.contentId]);
    expect(await pubOf(pub.id)).toMatchObject({ status: 'planned', hold_reason: 'content_changed' });

    // Lo que hace el botón «Usar la versión aprobada»: la misma RPC, con la fecha y la cuenta de siempre.
    const nuevas: string[] = [];
    for (let page = 1; page <= 3; page++) {
      nuevas.push(await exportOf(marca, p.contentId, 2, 'image/jpeg', { page, count: 3 }));
    }
    const rearmada = await userCall<Pub>(editor, 'save_publication', {
      p_publication_id: pub.id,
      p_content_id: p.contentId,
      p_scheduled_at: pub.scheduled_at,
      p_social_account_id: pub.social_account_id,
      p_media_asset_ids: nuevas,
      p_content_version: 2,
    });
    expect(rearmada).toMatchObject({ status: 'scheduled', hold_reason: null, content_version: 2 });
    expect(rearmada.media_asset_ids).toEqual(nuevas);
    expect(new Date(rearmada.scheduled_at).getTime()).toBe(new Date(pub.scheduled_at).getTime());
    expect(rearmada.social_account_id).toBe(pub.social_account_id);
  });

  it('«publicar ahora» con las páginas en orden publica; desordenadas, se niega y no deja nada', async () => {
    const p = await piece({ format: 'carousel', exports: 3 });
    const args = {
      p_content_id: p.contentId,
      p_social_account_id: cuenta,
      p_content_version: 1,
    };
    await expect(
      userCall<Pub>(editor, 'publish_publication_now', {
        ...args,
        p_media_asset_ids: [p.assets[2], p.assets[1], p.assets[0]],
      }),
    ).rejects.toThrow();
    expect(
      (await db.query(`select 1 from public.scheduled_publications where content_id = $1`, [p.contentId])).length,
    ).toBe(0);

    const pub = await userCall<Pub>(editor, 'publish_publication_now', { ...args, p_media_asset_ids: p.assets });
    expect(pub.status).toBe('scheduled');
    const [r] = (await tick()).filter((x) => x.publicationId === pub.id);
    expect(r).toMatchObject({ outcome: 'published' });
    const expected = (await pathsOf(p.assets)).map((path) => `https://almacen.pruebas.invalid/firmada/${path}`);
    expect(graph.published.at(-1)!.mediaUrls).toEqual(expected);
  });
});

describe('función social-publish', () => {
  it('sin la clave de servicio no toca la cola', async () => {
    const handler = createSocialPublishHandler({
      serviceKeys: ['clave-de-servicio-de-pruebas-larga'],
      rpc,
      publisher: () => null,
      accountsToCheck: async () => [],
      checkTokens: async () => 0,
      workerName: WORKER,
    });
    const sin = await handler(new Request('http://x/social-publish', { method: 'POST' }));
    expect(sin.status).toBe(401);
    const con = await handler(
      new Request('http://x/social-publish', {
        method: 'POST',
        headers: { apikey: 'clave-de-servicio-de-pruebas-larga' },
      }),
    );
    expect(con.status).toBe(200);
  });

  it('con la clave, publica lo que toca', async () => {
    const p = await piece();
    const pub = await schedule(p.contentId, p.assets);
    await makeDue(pub.id);
    await serviceCall('social_enqueue_due_publications', { p_limit: 100 });
    const handler = createSocialPublishHandler({
      serviceKeys: ['clave-de-servicio-de-pruebas-larga'],
      rpc,
      publisher: () => publisherDeps(),
      accountsToCheck: async () => [],
      checkTokens: async () => 0,
      workerName: WORKER,
    });
    const res = await handler(
      new Request('http://x/social-publish', {
        method: 'POST',
        headers: { authorization: 'Bearer clave-de-servicio-de-pruebas-larga' },
      }),
    );
    const body = (await res.json()) as { results: Row[] };
    expect(body.results.find((x) => x.publicationId === pub.id)).toMatchObject({ outcome: 'published' });
    expect((await pubOf(pub.id)).status).toBe('published');
  });
});

describe('publicar ahora', () => {
  // Lo que dejaron las pruebas anteriores en la cola se saca antes (el lote de la función es de 5 trabajos).
  beforeEach(async () => {
    await tick();
    graph = createSimulatedGraph();
  });

  const nowArgs = (p: { contentId: string; assets: string[] }, account = cuenta) => ({
    p_content_id: p.contentId,
    p_social_account_id: account,
    p_media_asset_ids: p.assets,
    p_content_version: 1,
  });
  const jobsOf = async (pubId: string) =>
    (
      await db.query<{ n: number }>(
        `select count(*)::int as n from public.jobs where kind = 'social.publish' and payload->>'publication_id' = $1`,
        [pubId],
      )
    )[0]!.n;

  /** Cliente RPC con la sesión de una persona (lo que hace la ruta /now con su JWT). */
  const asUserRpc =
    (user: TestUser): RpcClient =>
    async (fn, args) => {
      try {
        const { list, params } = toParams(args);
        const [row] = await as<{ data: unknown }>(db, user, `select to_jsonb(public.${fn}(${list})) as data`, params);
        return { data: row?.data ?? null, error: null };
      } catch (error) {
        const { code, message, detail } = error as { code?: string; message: string; detail?: string };
        return { data: null, error: { code, message, details: detail ?? null } };
      }
    };

  const nowHandler = () =>
    createSocialPublishHandler({
      serviceKeys: ['clave-de-servicio-de-pruebas-larga'],
      rpc,
      userRpc: (token) => asUserRpc(token === 'tok-lector' ? lector : editor),
      publisher: () => publisherDeps(),
      accountsToCheck: async () => [],
      checkTokens: async () => 0,
      workerName: 'pruebas:ahora',
    });
  const kickRequest = (pubId: string, token = 'tok-editor') =>
    new Request('http://x/social-publish/now', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId: pubId }),
    });

  it('una pieza aprobada se publica al momento, sin esperar a su hora, y una sola vez', async () => {
    const p = await piece();
    const pub = await userCall<Pub>(editor, 'publish_publication_now', nowArgs(p));
    expect(pub.status).toBe('scheduled');
    expect(await jobsOf(pub.id)).toBe(1);

    const res = await nowHandler()(kickRequest(pub.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Row[] };
    expect(body.results.find((r) => r.publicationId === pub.id)).toMatchObject({ outcome: 'published' });
    const after = await pubOf(pub.id);
    expect(after.status).toBe('published');
    expect(after.external_url).toBe(`${SIMULATED_PERMALINK_HOST}/p/${after.external_id}/`);
    expect(graph.published).toHaveLength(1);

    // El reloj, después, no encola ni publica nada más; repetir «ahora» devuelve lo mismo.
    expect(await tick()).toEqual([]);
    expect(await jobsOf(pub.id)).toBe(1);
    const again = await userCall<Pub>(editor, 'publish_publication_now', nowArgs(p));
    expect(again.id).toBe(pub.id);
    expect(again.status).toBe('published');
    expect(graph.published).toHaveLength(1);
  });

  it('la llamada directa y el reloj, uno tras otro, dan una sola publicación', async () => {
    const p = await piece();
    const pub = await userCall<Pub>(editor, 'publish_publication_now', nowArgs(p));
    // Una tras otra: PGlite tiene una sola conexión, así que aquí se prueba la
    // idempotencia (la segunda pasada la encuentra publicada). La exclusión entre
    // procesos de verdad la dan FOR UPDATE SKIP LOCKED y el cerrojo de fila.
    await nowHandler()(kickRequest(pub.id));
    await tick();
    await tick();
    expect((await pubOf(pub.id)).status).toBe('published');
    expect(graph.published).toHaveLength(1);
    const intentos = await db.query<{ outcome: string }>(
      `select outcome from public.publication_attempts where publication_id = $1 and outcome in ('published', 'recovered')`,
      [pub.id],
    );
    expect(intentos).toHaveLength(1);
  });

  it('dos trabajos para la misma publicación (otra clave) tampoco la publican dos veces', async () => {
    const p = await piece();
    const pub = await userCall<Pub>(editor, 'publish_publication_now', nowArgs(p));
    // Un trabajo extra, como si la hora hubiera cambiado entre dos pasadas del reloj.
    await serviceCall('enqueue_job', {
      p_organization_id: org,
      p_kind: 'social.publish',
      p_payload: { publication_id: pub.id, generation: pub.generation },
      p_idempotency_key: `otra-clave:${pub.id}`,
      p_brand_id: marca,
      p_priority: 10,
      p_max_attempts: 5,
    });
    expect(await jobsOf(pub.id)).toBe(2);
    const resultados = [...(await tick()), ...(await tick())].filter((r) => r.publicationId === pub.id);
    expect(resultados.filter((r) => r.outcome === 'published')).toHaveLength(1);
    expect(graph.published).toHaveLength(1);
    expect((await pubOf(pub.id)).status).toBe('published');
  });

  it('adelanta una programada para dentro de una hora; la ruta de la función por sí sola no adelanta nada', async () => {
    const p = await piece();
    const futura = await schedule(p.contentId, p.assets);
    expect(futura.status).toBe('scheduled');
    const kick = await nowHandler()(kickRequest(futura.id));
    expect(kick.status).toBe(200);
    expect((await pubOf(futura.id)).status).toBe('scheduled');
    expect(graph.published).toHaveLength(0);

    const ahora = await userCall<Pub>(editor, 'publish_publication_now', {
      ...nowArgs(p),
      p_publication_id: futura.id,
    });
    expect(ahora.id).toBe(futura.id);
    await nowHandler()(kickRequest(futura.id));
    expect((await pubOf(futura.id)).status).toBe('published');
  });

  it('sin aprobar, sin exportación o sin cuenta no se publica y no queda nada guardado', async () => {
    const sinAprobar = await piece({ approve: false });
    await expect(
      as(db, editor, `select public.publish_publication_now($1, $2, $3, 1)`, [
        sinAprobar.contentId,
        cuenta,
        sinAprobar.assets,
      ]),
    ).rejects.toMatchObject({ code: 'PB003', detail: 'not_approved' });
    expect(
      await db.query(`select 1 from public.scheduled_publications where content_id = $1`, [sinAprobar.contentId]),
    ).toEqual([]);

    const aprobada = await piece();
    await expect(
      as(db, editor, `select public.publish_publication_now($1, $2, '{}'::uuid[], 1)`, [aprobada.contentId, cuenta]),
    ).rejects.toMatchObject({ code: 'PB003', detail: 'no_media' });
    await expect(
      as(db, editor, `select public.publish_publication_now($1, null, $2, 1)`, [aprobada.contentId, aprobada.assets]),
    ).rejects.toMatchObject({ code: 'PB003', detail: 'no_account' });
    await expect(
      as(db, editor, `select public.publish_publication_now($1, $2, $3, 2)`, [
        aprobada.contentId,
        cuenta,
        aprobada.assets,
      ]),
    ).rejects.toThrow(/versión/);
    expect(
      await db.query(`select 1 from public.scheduled_publications where content_id = $1`, [aprobada.contentId]),
    ).toEqual([]);
    expect(graph.published).toHaveLength(0);
  });

  it('solo quien puede programar: el lector no publica ni empuja la cola, ni con la cuenta de otra marca', async () => {
    const p = await piece();
    await denied(db, lector, `select public.publish_publication_now($1, $2, $3, 1)`, [p.contentId, cuenta, p.assets]);
    const pub = await userCall<Pub>(editor, 'publish_publication_now', nowArgs(p));
    await denied(db, lector, `select public.publication_publish_kick($1)`, [pub.id]);
    expect((await nowHandler()(kickRequest(pub.id, 'tok-lector'))).status).toBe(403);
    const q = await piece();
    await expect(
      as(db, editor, `select public.publish_publication_now($1, $2, $3, 1)`, [q.contentId, cuenta2, q.assets]),
    ).rejects.toThrow(/cuenta/);
    // Sin sesión, la ruta no publica nada.
    const sin = await nowHandler()(
      new Request('http://x/social-publish/now', { method: 'POST', body: JSON.stringify({ publicationId: pub.id }) }),
    );
    expect(sin.status).toBe(401);
  });

  it('un rechazo de la red deja «falló» y «ahora» lo reintenta sobre la misma publicación', async () => {
    const p = await piece();
    graph.fail({ op: 'container', mode: 'error', error: { code: 100, message: 'Imagen no válida', status: 400 } });
    const pub = await userCall<Pub>(editor, 'publish_publication_now', nowArgs(p));
    await nowHandler()(kickRequest(pub.id));
    expect((await pubOf(pub.id)).status).toBe('failed');
    expect(graph.published).toHaveLength(0);

    const retried = await userCall<Pub>(editor, 'publish_publication_now', { ...nowArgs(p), p_publication_id: pub.id });
    expect(retried).toMatchObject({ id: pub.id, status: 'scheduled', generation: pub.generation + 1 });
    await nowHandler()(kickRequest(pub.id));
    expect((await pubOf(pub.id)).status).toBe('published');
    expect(graph.published).toHaveLength(1);
  });
});
