// Importar las publicaciones de una cuenta (docs/importar-publicaciones.md)
// contra las migraciones reales y la Graph API SIMULADA: paginación, reanudación,
// no duplicar, límites de la API, copia de imágenes a la biblioteca y permisos.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImportGraph, parsePost } from '../../supabase/functions/_shared/social/import-graph.ts';
import {
  imageSize,
  imageSources,
  META_CDN_HOST,
  runImportStep,
  type ImportDeps,
  type ImportRun,
  type StepResult,
} from '../../supabase/functions/_shared/social/importer.ts';
import {
  createSimulatedGraph,
  SIMULATED_CDN_HOST,
  type SimulatedExistingPost,
  type SimulatedGraph,
} from '../../supabase/functions/_shared/social/simulated-graph.ts';
import type { ObjectStorage } from '../../supabase/functions/_shared/storage/contract.ts';
import { KEYS, socialKit } from './apoyo-analitica';
import { as, createBrand, createDb, createOrg, createUser, denied, join, type Db, type TestUser } from './helpers';

let db: Db;
let kit: ReturnType<typeof socialKit>;
let ana: TestUser, editor: TestUser;
let org: string, marca: string, cuenta: string;
let graph: SimulatedGraph;
let uploaded: Array<{ key: string; bytes: number; type: string }>;

const TOKEN = 'sim-page-importar-1';
const CDN = new URL(SIMULATED_CDN_HOST).hostname;

const memoryStore: ObjectStorage = {
  backend: 'supabase',
  signGet: async () => '',
  signPut: async () => ({ url: '', method: 'PUT', headers: {}, expiresIn: 1 }),
  head: async () => null,
  put: async (key, body, type, bytes) => {
    uploaded.push({ key, bytes: (body as Uint8Array).length || bytes, type });
  },
  remove: async () => ({ failed: [] }),
  list: async () => [],
};

function posts(n: number, extra: (i: number) => Partial<SimulatedExistingPost> = () => ({})): SimulatedExistingPost[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `9${String(i).padStart(4, '0')}`,
    caption: `Publicación ${i}`,
    // Más reciente la de número más bajo.
    timestamp: new Date(Date.UTC(2026, 9, 28) - i * 86_400_000).toISOString(),
    ...extra(i),
  }));
}

function deps(extra: Partial<ImportDeps> = {}): ImportDeps {
  return {
    rpc: kit.rpc,
    api: createImportGraph({ fetch: graph.fetch }),
    keyRing: KEYS,
    userId: ana.id,
    fetch: graph.fetch,
    allowedImageHost: (host) => META_CDN_HOST.test(host) || host === CDN,
    uploadStore: async () => memoryStore,
    pageSize: 25,
    maxPages: 1,
    ...extra,
  };
}

async function begin(copy = false, user: TestUser = ana): Promise<ImportRun> {
  const [row] = await as<{ data: ImportRun }>(
    db,
    user,
    `select to_jsonb(r) as data from public.social_import_begin($1, $2) r`,
    [cuenta, copy],
  );
  return row!.data;
}

/** Pasos hasta terminar (o hasta `max`). */
async function drain(runId: string, extra: Partial<ImportDeps> = {}, max = 40): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runImportStep(runId, deps(extra));
    out.push(r);
    if (r.outcome !== 'progress') break;
  }
  return out;
}

const count = async (table: string, where = 'true') =>
  Number((await db.query<{ n: string }>(`select count(*)::text n from public.${table} where ${where}`))[0]!.n);

beforeAll(async () => {
  db = await createDb();
  kit = socialKit(db);
  ana = await createUser(db, 'ana@importar.test', 'Ana');
  editor = await createUser(db, 'editor@importar.test', 'Editor');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  cuenta = await kit.connect(ana, marca, TOKEN);
});

afterAll(async () => {
  await db?.close();
});

async function reset(existing: SimulatedExistingPost[]) {
  await db.exec(`delete from public.social_import_runs; delete from public.social_imported_media;`);
  graph = createSimulatedGraph({ existing });
  uploaded = [];
}

describe('lectura de /media', () => {
  it('interpreta campos, hijos y paginación como Meta', async () => {
    await reset(posts(7, (i) => (i === 0 ? { mediaType: 'CAROUSEL_ALBUM', children: 3 } : {})));
    const api = createImportGraph({ fetch: graph.fetch });
    const first = await api.listMedia('17841400000000001', TOKEN, { limit: 5 });
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items[0]).toMatchObject({ media_type: 'CAROUSEL_ALBUM', permalink: expect.stringContaining('/p/') });
    expect(first.items[0]!.children).toHaveLength(3);
    const second = await api.listMedia('17841400000000001', TOKEN, { limit: 5, after: first.nextCursor });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it('descarta lo que no trae identificador y recorta lo desmedido', () => {
    expect(parsePost({ caption: 'sin id' })).toBeNull();
    expect(parsePost({ id: 1, caption: 'x'.repeat(9000) })!.caption).toHaveLength(5000);
  });

  it('elige qué imágenes copiar: vídeo = portada, carrusel = cada pieza', () => {
    expect(imageSources({ media_type: 'VIDEO', media_url: 'v', thumbnail_url: 't', children: [] })).toEqual([
      { url: 't', kind: 'video_thumbnail' },
    ]);
    expect(
      imageSources({
        media_type: 'CAROUSEL_ALBUM',
        media_url: null,
        thumbnail_url: null,
        children: [{ media_type: 'IMAGE', media_url: 'a' }, { media_type: 'VIDEO', thumbnail_url: 'b' }, {}],
      }).map((s) => s.url),
    ).toEqual(['a', 'b']);
  });

  it('lee el tamaño de un PNG', () => {
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    expect(imageSize(png)).toEqual({ width: 1, height: 1 });
  });
});

describe('importar sin copiar imágenes', () => {
  it('recorre todo el histórico por páginas y no duplica al repetirlo', async () => {
    await reset(posts(60));
    const run = await begin();
    const steps = await drain(run.id);
    expect(steps.at(-1)!.outcome).toBe('completed');
    // 60 publicaciones a 25 por página = 3 páginas, una por paso.
    expect(steps.at(-1)!.run).toMatchObject({ pages: 3, items_seen: 60, items_new: 60, status: 'completed' });
    expect(await count('social_imported_media')).toBe(60);
    // Las direcciones y el enlace quedan guardados.
    const [row] = await db.query<{ permalink: string; media_url: string }>(
      `select permalink, media_url from public.social_imported_media order by published_at desc limit 1`,
    );
    expect(row!.permalink).toContain('/p/90000/');
    expect(row!.media_url).toContain(SIMULATED_CDN_HOST);

    // Una segunda importación renueva las filas sin añadir ninguna.
    const again = await begin();
    expect(again.id).not.toBe(run.id);
    const last = (await drain(again.id)).at(-1)!;
    expect(last.run).toMatchObject({ items_seen: 60, items_new: 0 });
    expect(await count('social_imported_media')).toBe(60);
  });

  it('se detiene a mitad sin perder lo importado y se reanuda donde iba', async () => {
    await reset(posts(60));
    const run = await begin();
    expect((await runImportStep(run.id, deps())).run!.items_seen).toBe(25);
    // «Detener»: queda en pausa y los pasos ya no avanzan.
    const [paused] = await as<{ data: ImportRun }>(
      db,
      ana,
      `select to_jsonb(r) as data from public.social_import_pause($1) r`,
      [run.id],
    );
    expect(paused!.data.status).toBe('paused');
    expect((await runImportStep(run.id, deps())).outcome).toBe('paused');
    expect(await count('social_imported_media')).toBe(25);
    const callsBefore = graph.calls.length;

    // Volver a pulsar «Importar» REANUDA la misma importación.
    const resumed = await begin();
    expect(resumed.id).toBe(run.id);
    expect(resumed.after_cursor).toBeTruthy();
    const steps = await drain(run.id);
    expect(steps.at(-1)!.outcome).toBe('completed');
    expect(await count('social_imported_media')).toBe(60);
    // Solo se pidieron las dos páginas que faltaban.
    expect(graph.calls.slice(callsBefore).filter((c) => c.endsWith('/media'))).toHaveLength(2);
    expect(await count('social_import_runs')).toBe(1);
  });

  it('un fallo de la red a mitad no pierde la página guardada ni adelanta el cursor', async () => {
    await reset(posts(60));
    const run = await begin();
    await runImportStep(run.id, deps());
    graph.fail({ op: 'media_list', mode: 'error', error: { code: 1, message: 'Boom', status: 500 } });
    const failed = await runImportStep(run.id, deps());
    expect(failed.outcome).toBe('error');
    expect(failed.run).toMatchObject({ status: 'paused', items_seen: 25 });
    expect(await count('social_imported_media')).toBe(25);
    await begin();
    expect((await drain(run.id)).at(-1)!.outcome).toBe('completed');
    expect(await count('social_imported_media')).toBe(60);
  });

  it('no deja que dos pasos trabajen a la vez ni que un paso viejo haga retroceder el cursor', async () => {
    await reset(posts(60));
    const run = await begin();
    await db.query(`update public.social_import_runs set lease_until = now() + interval '1 minute' where id = $1`, [
      run.id,
    ]);
    expect((await runImportStep(run.id, deps())).outcome).toBe('busy');
    await db.query(`update public.social_import_runs set lease_until = null where id = $1`, [run.id]);
    await runImportStep(run.id, deps());
    await runImportStep(run.id, deps());
    // Un paso rezagado que pidió la primera página llega tarde: guarda sin duplicar y no retrocede.
    const late = (await kit.serviceCall('social_import_save_page', {
      p_run_id: run.id,
      p_items: [{ id: '90000', media_type: 'IMAGE', caption: 'otra vez' }],
      p_from_cursor: null,
      p_next_cursor: 'zzz',
    })) as { stale: boolean; run: ImportRun };
    expect(late.stale).toBe(true);
    expect(late.run.pages).toBe(2);
    expect(await count('social_imported_media')).toBe(50);
  });

  it('respeta el límite de llamadas: lo declarado por Meta y el error de límite', async () => {
    await reset(posts(60));
    const run = await begin();
    graph.setMediaUsageHeader(
      JSON.stringify({
        '1': [{ call_count: 95, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 0 }],
      }),
    );
    const waiting = await runImportStep(run.id, deps({ maxPages: 4 }));
    // Guardó la página que ya tenía y paró.
    expect(waiting.outcome).toBe('waiting');
    expect(waiting.run!.items_seen).toBe(25);
    expect(waiting.retryAfterSeconds).toBeGreaterThanOrEqual(900);
    const calls = graph.calls.length;
    // Mientras dure la espera no se llama a la red.
    expect((await runImportStep(run.id, deps())).outcome).toBe('waiting');
    expect(graph.calls.length).toBe(calls);

    graph.setMediaUsageHeader(null);
    await db.query(`update public.social_import_runs set retry_after = now() - interval '1 second' where id = $1`, [
      run.id,
    ]);
    graph.fail({ op: 'media_list', mode: 'error', error: { code: 80002, message: 'Too many calls', status: 400 } });
    const limited = await runImportStep(run.id, deps());
    expect(limited.outcome).toBe('waiting');
    expect(limited.run!.items_seen).toBe(25);
    await db.query(`update public.social_import_runs set retry_after = null where id = $1`, [run.id]);
    expect((await drain(run.id)).at(-1)!.outcome).toBe('completed');
    expect(await count('social_imported_media')).toBe(60);
  });

  it('con el token caducado, la cuenta pide volver a conectarse y el token no sale en la respuesta', async () => {
    await reset(posts(10));
    const run = await begin();
    graph.expireToken(TOKEN);
    const result = await runImportStep(run.id, deps());
    expect(result.outcome).toBe('error');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const [account] = await db.query<{ status: string }>(`select status from public.social_accounts where id = $1`, [
      cuenta,
    ]);
    expect(account!.status).toBe('needs_reauth');
    // Sin cuenta conectada no se puede ni empezar.
    await expect(begin()).rejects.toThrow(/no está conectada/);
    await db.query(`update public.social_accounts set status = 'active', last_error = null where id = $1`, [cuenta]);
  });
});

describe('copiar las imágenes a la biblioteca', () => {
  const mix = (i: number): Partial<SimulatedExistingPost> =>
    i === 0
      ? { mediaType: 'CAROUSEL_ALBUM', children: 3 }
      : i === 1
        ? { mediaType: 'VIDEO', productType: 'REELS' }
        : {};

  it('da de alta cada imagen en «Instagram / Publicadas» con su procedencia y sin duplicar', async () => {
    await reset(posts(6, mix));
    await db.exec(`delete from public.media_assets where origin = 'import'`);
    const run = await begin(true);
    const steps = await drain(run.id);
    expect(steps.at(-1)!.outcome).toBe('completed');
    expect(steps.at(-1)!.run).toMatchObject({ copied: 6, copy_failed: 0, phase: 'done' });
    // 3 del carrusel + 1 portada del reel + 4 imágenes.
    const assets = await db.query<{
      folder: string;
      provenance: Record<string, unknown>;
      storage_path: string;
      origin: string;
    }>(
      `select folder, provenance, storage_path, origin from public.media_assets where origin = 'import' order by storage_path`,
    );
    expect(assets).toHaveLength(8);
    expect(new Set(assets.map((a) => a.folder))).toEqual(new Set(['Instagram / Publicadas']));
    expect(assets[0]!.storage_path.startsWith(`${org}/${marca}/instagram/publicadas/`)).toBe(true);
    expect(assets.map((a) => a.provenance.permalink).every((p) => String(p).includes('/p/9000'))).toBe(true);
    expect(assets.every((a) => a.provenance.type === 'instagram_import' && a.provenance.published_at)).toBe(true);
    expect(uploaded).toHaveLength(8);
    const [row] = await db.query<{ asset_ids: string[]; copy_status: string }>(
      `select asset_ids, copy_status from public.social_imported_media where external_id = '90000'`,
    );
    expect(row).toMatchObject({ copy_status: 'copied' });
    expect(row!.asset_ids).toHaveLength(3);

    // Importar otra vez no duplica ni las filas ni los recursos.
    const again = await begin(true);
    await drain(again.id);
    expect(await count('media_assets', `origin = 'import'`)).toBe(8);
  });

  it('una imagen que falla se anota y la importación sigue; otra importación la recupera', async () => {
    await reset(posts(3));
    await db.exec(`delete from public.media_assets where origin = 'import'`);
    graph.fail({ op: 'cdn', mode: 'error', error: { code: 1, message: 'caducada', status: 403 } });
    const run = await begin(true);
    const last = (await drain(run.id)).at(-1)!;
    expect(last.outcome).toBe('completed');
    expect(last.run).toMatchObject({ copied: 2, copy_failed: 1 });
    const [bad] = await db.query<{ copy_error: string }>(
      `select copy_error from public.social_imported_media where copy_status = 'failed'`,
    );
    expect(bad!.copy_error).toMatch(/caducado/);
    const again = await begin(true);
    expect((await drain(again.id)).at(-1)!.run).toMatchObject({ copied: 1, copy_failed: 0 });
    expect(await count('media_assets', `origin = 'import'`)).toBe(3);
  });

  it('solo se descarga de la CDN de Meta', async () => {
    await reset(posts(1));
    await db.exec(`delete from public.media_assets where origin = 'import'`);
    const run = await begin(true);
    const result = (await drain(run.id, { allowedImageHost: () => false })).at(-1)!;
    expect(result.run).toMatchObject({ copied: 0, copy_failed: 1 });
    expect(uploaded).toHaveLength(0);
  });

  it('si el plan no tiene espacio, se detiene sin subir nada y se puede reanudar', async () => {
    await reset(posts(2));
    await db.exec(`delete from public.media_assets where origin = 'import'`);
    const [free] = await db.query<{ id: string }>(
      `select id from public.plans where code = 'free' or is_default limit 1`,
    );
    expect(free).toBeTruthy();
    // Plan sin sitio: se simula con un límite de almacenamiento ya agotado.
    await db.query(`update public.plans set max_storage_bytes = 1 where code = 'legacy'`);
    const run = await begin(true);
    const result = (await drain(run.id)).at(-1)!;
    expect(result.outcome).toBe('error');
    expect(result.message).toMatch(/espacio/);
    expect(uploaded).toHaveLength(0);
    await db.query(`update public.plans set max_storage_bytes = null where code = 'legacy'`);
    await begin(true);
    expect((await drain(run.id)).at(-1)!.outcome).toBe('completed');
    expect(await count('media_assets', `origin = 'import'`)).toBe(2);
  });
});

describe('permisos', () => {
  it('solo quien gestiona la marca importa; el editor no', async () => {
    await reset(posts(2));
    await denied(db, editor, `select public.social_import_begin($1, false)`, [cuenta], /gestiona/);
    const run = await begin();
    await denied(db, editor, `select public.social_import_pause($1)`, [run.id], /gestiona/);
    const claim = kit.serviceCall('social_import_claim', { p_run_id: run.id, p_user_id: editor.id });
    await expect(claim).rejects.toThrow(/gestiona/);
  });
});
