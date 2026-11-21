// El trabajador de medios SIN la clave de servicio (migración 20261210010000,
// docs/alojamiento.md §5): las funciones `worker_gateway_*` de la base de
// datos REAL, la Edge Function `worker-gateway` (handler.ts, en Node, con
// almacenes en memoria) y el cliente del trabajador (worker/src/gateway.ts)
// con su bucle de verdad, todo junto.
//
// Permisos que se comprueban: el token no sirve para nada más que para el
// intermediario, un trabajo o una ruta de otra marca se rechaza, un trabajo
// reservado por otro no se toca, el token revocado (o rotado) deja de valer y
// hay un tope de llamadas por minuto.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { loadMediaStorageConfig } from '../../supabase/functions/_shared/storage/config.ts';
import type { ObjectStorage } from '../../supabase/functions/_shared/storage/contract.ts';
import { createWorkerGatewayHandler } from '../../supabase/functions/worker-gateway/handler.ts';
import { LeaseLostError, PermanentError } from '../../worker/src/errors';
import { createGatewayQueue, createGatewayStorage } from '../../worker/src/gateway';
import type { Handler } from '../../worker/src/handler';
import { createWorker } from '../../worker/src/worker';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  serviceRpc as callService,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

const SUPABASE = 'http://supabase.test';
const tokenOf = (n: number) => `rrss_wgt_${String(n).repeat(43).slice(0, 43)}`;
const TOKEN = tokenOf(1);
const OTHER_TOKEN = tokenOf(2);
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

let db: Db;
let root: TestUser, ana: TestUser, bruno: TestUser;
let org: string, marca: string, orgB: string, marcaB: string;
let tmp: string;

/** RPC de `public` como la clave de servicio, como la entrega la API (las de tabla, como lista). */
const rpc: RpcClient = async (fn, args) => {
  const names = Object.keys(args).filter((n) => args[n] !== undefined);
  const params = names.map((n) => {
    const v = args[n];
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const [meta] = await db.query<{ retset: boolean; void: boolean }>(
    `select p.proretset as retset, p.prorettype = 'void'::regtype as void from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = $1 limit 1`,
    [fn],
  );
  const sql = meta?.retset
    ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as data from public.${fn}(${list}) r`
    : meta?.void
      ? `select null::jsonb as data from (select public.${fn}(${list})) x`
      : `select to_jsonb(public.${fn}(${list})) as data`;
  try {
    const rows = await asService<{ data: unknown }>(db, sql, params);
    return { data: rows[0]?.data ?? null, error: null };
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { data: null, error: { code, message } };
  }
};

/** Almacén en memoria; sus URL firmadas apuntan al «Supabase» o al «R2» de la prueba. */
function memoryStore(backend: 'supabase' | 'r2'): ObjectStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const root = backend === 'supabase' ? `${SUPABASE}/storage/v1/object` : 'https://r2.test/bucket';
  return {
    backend,
    objects,
    signGet: async (key) => `${root}/${backend === 'supabase' ? 'sign/brand-media/' : ''}${key}?firma=lectura`,
    signPut: async (key, contentType, _bytes, seconds) => ({
      url: `${root}/${backend === 'supabase' ? 'upload/sign/brand-media/' : ''}${key}?firma=subida`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresIn: seconds,
    }),
    head: async (key) => (objects.has(key) ? { bytes: objects.get(key)!.length } : null),
    put: async () => undefined,
    remove: async () => ({ failed: [] }),
    list: async () => [],
  };
}

let supabaseStore: ReturnType<typeof memoryStore>;
let r2Store: ReturnType<typeof memoryStore>;

function gateway(withR2 = false) {
  const config = loadMediaStorageConfig(
    withR2
      ? {
          R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
          R2_ACCESS_KEY_ID: 'AKIAEJEMPLO000001',
          R2_SECRET_ACCESS_KEY: 'secreto000000000',
          R2_BUCKET: 'rrss-media',
        }
      : {},
  );
  return createWorkerGatewayHandler({
    rpc,
    config,
    r2: withR2 ? r2Store : null,
    supabase: supabaseStore,
    supabaseUrl: SUPABASE,
    driveUrl: async (p) => `${SUPABASE}/functions/v1/drive-media/file/firma-de-${p.split('/').pop()}`,
  });
}

/**
 * `fetch` del trabajador: las llamadas al intermediario van a su handler; las
 * URL firmadas, a los almacenes en memoria (que rechazan cualquier credencial).
 */
function workerFetch(withR2 = false): typeof fetch {
  const handler = gateway(withR2);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${SUPABASE}/functions/v1/worker-gateway/`)) {
      return handler(new Request(url, init));
    }
    const headers = new Headers(init?.headers);
    if (headers.has('authorization') || headers.has('apikey')) return new Response('sin credenciales', { status: 400 });
    const store = url.startsWith('https://r2.test/') ? r2Store : supabaseStore;
    const key = decodeURIComponent(
      url
        .split('?')[0]!
        .replace(
          /^(https:\/\/r2\.test\/bucket|http:\/\/supabase\.test\/storage\/v1\/object\/(upload\/)?sign\/brand-media)\//,
          '',
        ),
    );
    if (init?.method === 'PUT') {
      const body = init.body as ReadableStream<Uint8Array>;
      store.objects.set(key, Buffer.from(await new Response(body).arrayBuffer()));
      return new Response('{}', { status: 200 });
    }
    const file = store.objects.get(key);
    return file ? new Response(file) : new Response('{"message":"Object not found"}', { status: 404 });
  }) as typeof fetch;
}

async function post(token: string | null, route: string, body: Record<string, unknown>, withR2 = false) {
  const res = await gateway(withR2)(
    new Request(`${SUPABASE}/functions/v1/worker-gateway${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json()) as any };
}

async function setToken(token: string): Promise<void> {
  await as(db, root, `select public.admin_set_integration_setting('WORKER_GATEWAY_TOKEN', $1)`, [
    `sha256:${hashOf(token)}`,
  ]);
}

let n = 0;
async function enqueue(brand: string, organization: string, kind = 'media.image.process', payload: Row = {}) {
  const job = await callService<{ id: string }>(db, 'enqueue_job', {
    p_organization_id: organization,
    p_kind: kind,
    p_payload: payload,
    p_idempotency_key: `gw-${++n}`,
    p_brand_id: brand,
  });
  return job.id;
}

const jobRow = async (id: string) =>
  (
    await db.query<{ status: string; locked_by: string | null; result: Row | null; last_error: string | null }>(
      `select status, locked_by, result, last_error from public.jobs where id = $1`,
      [id],
    )
  )[0]!;

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@gateway.test');
  ana = await createUser(db, 'ana@gateway.test');
  bruno = await createUser(db, 'bruno@gateway.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  org = await createOrg(db, ana, 'Empresa A');
  marca = await createBrand(db, ana, org, 'Marca A');
  orgB = await createOrg(db, bruno, 'Empresa B');
  marcaB = await createBrand(db, bruno, orgB, 'Marca B');
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rrss-gateway-'));
});

afterAll(async () => {
  await db?.close();
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.exec(`delete from public.jobs; delete from private.worker_gateway_calls;`);
  supabaseStore = memoryStore('supabase');
  r2Store = memoryStore('r2');
  await setToken(TOKEN);
});

describe('el token del trabajador no sirve para nada más', () => {
  it('nadie salvo la clave de servicio ejecuta las funciones del intermediario; la comprobación del token, ni ella', async () => {
    const calls = [
      `select * from public.worker_gateway_claim($1, 'w', null, 1, 60)`,
      `select public.worker_gateway_complete($1, 'w', gen_random_uuid(), '{}')`,
      `select public.worker_gateway_fail($1, 'w', gen_random_uuid(), 'x', true)`,
      `select public.worker_gateway_release($1, 'w', gen_random_uuid())`,
      `select public.worker_gateway_extend($1, 'w', gen_random_uuid(), 60)`,
      `select public.worker_gateway_authorize_path($1, 'w', gen_random_uuid(), 'a/b/c', false)`,
    ];
    for (const user of [ana, root, null]) {
      for (const sql of calls) await denied(db, user, sql, [hashOf(TOKEN)], /permission denied/);
    }
    await expect(asService(db, `select private.worker_gateway_identity($1, 'w')`, [hashOf(TOKEN)])).rejects.toThrow(
      /permission denied/,
    );
    for (const user of [ana, root, null]) {
      await denied(db, user, `select * from private.worker_gateway_calls`, [], /permission denied/);
    }
    await expect(asService(db, `select * from private.worker_gateway_calls`)).rejects.toThrow(/permission denied/);
  });

  it('el intermediario solo acepta tokens del trabajador: ni claves de Supabase, ni JWT, ni nada', async () => {
    for (const bad of [
      null,
      'sb_secret_0123456789abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9.e30.firma',
      'rrss_wgt_corto',
    ]) {
      const r = await post(bad, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 });
      expect(r.status).toBe(401);
    }
    // Con la forma buena pero otro token: la base de datos lo rechaza.
    expect((await post(OTHER_TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 })).status).toBe(403);
    // Y la huella guardada tampoco vale como token.
    expect(
      (await rpc('worker_gateway_claim', { p_token_hash: `sha256:${hashOf(TOKEN)}`, p_worker: 'w' })).error?.code,
    ).toBe('42501');
  });

  it('solo reclama tipos del trabajador, con su nombre marcado por el token', async () => {
    const media = await enqueue(marca, org);
    const other = await enqueue(marca, org, 'analytics.capture');
    const r = await post(TOKEN, '/claim', { worker: 'media-1', limit: 16, leaseSeconds: 60 });
    expect(r.status).toBe(200);
    expect(r.json.jobs.map((j: Row) => j.id)).toEqual([media]);
    expect((await jobRow(media)).locked_by).toBe(`gw:${hashOf(TOKEN).slice(0, 12)}:media-1`);
    expect((await jobRow(other)).status).toBe('queued');
    // Pedir tipos ajenos explícitamente tampoco.
    const ajenos = await post(TOKEN, '/claim', {
      worker: 'media-1',
      kinds: ['analytics.capture'],
      limit: 1,
      leaseSeconds: 60,
    });
    expect(ajenos.status).toBe(400);
    expect((await post(TOKEN, '/claim', { worker: 'media-1', limit: 17, leaseSeconds: 60 })).status).toBe(400);
    expect((await post(TOKEN, '/claim', { worker: 'nombre con espacios', limit: 1, leaseSeconds: 60 })).status).toBe(
      400,
    );
  });
});

describe('cada operación comprueba trabajo, trabajador y marca', () => {
  it('una ruta de otra marca (u otra organización) se rechaza, y en Drive no se escribe', async () => {
    const job = await enqueue(marca, org);
    await post(TOKEN, '/claim', { worker: 'media-1', limit: 1, leaseSeconds: 60 });
    const read = (p: string) => post(TOKEN, '/read-url', { worker: 'media-1', jobId: job, path: p });
    const ok = await read(`${org}/${marca}/media/foto.jpg`);
    expect(ok).toMatchObject({ status: 200, json: { backend: 'supabase' } });
    // Relativa: el trabajador le pone delante su SUPABASE_URL.
    expect(ok.json.url).toBe(`/storage/v1/object/sign/brand-media/${org}/${marca}/media/foto.jpg?firma=lectura`);
    for (const p of [
      `${orgB}/${marcaB}/media/foto.jpg`,
      `${org}/${marcaB}/media/foto.jpg`,
      `${orgB}/${marca}/media/foto.jpg`,
    ]) {
      const r = await read(p);
      expect(r.status).toBe(403);
      expect(r.json.error.message).toMatch(/no pertenece a la marca del trabajo/);
    }
    for (const p of [`${org}/${marca}/../${marcaB}/x.jpg`, `${org}/${marca}`, `${org}/${marca}//x.jpg`]) {
      expect((await read(p)).status).toBe(400);
    }
    const drive = await read(`${org}/${marca}/drive/abcdefghij12345`);
    expect(drive.json).toEqual({ backend: 'drive', url: '/functions/v1/drive-media/file/firma-de-abcdefghij12345' });
    const write = await post(TOKEN, '/write-url', {
      worker: 'media-1',
      jobId: job,
      path: `${org}/${marca}/drive/abcdefghij12345`,
      contentType: 'image/jpeg',
      bytes: 10,
    });
    expect(write.status).toBe(403);
  });

  it('un trabajo de otra marca reservado por otro trabajador no se toca', async () => {
    const ajeno = await enqueue(marcaB, orgB);
    // Lo reserva un trabajador con la clave de servicio (modo local), no el del token.
    await asService(db, `select * from public.claim_jobs('local-1', array['media.image.process'], 1, 60)`);
    const tries = [
      post(TOKEN, '/complete', { worker: 'local-1', jobId: ajeno, result: {} }),
      post(TOKEN, '/fail', { worker: 'local-1', jobId: ajeno, error: 'x' }),
      post(TOKEN, '/release', { worker: 'local-1', jobId: ajeno }),
      post(TOKEN, '/extend', { worker: 'local-1', jobId: ajeno, leaseSeconds: 60 }),
      post(TOKEN, '/read-url', { worker: 'local-1', jobId: ajeno, path: `${orgB}/${marcaB}/media/a.jpg` }),
    ];
    for (const r of await Promise.all(tries)) expect(r.status).toBe(409);
    expect(await jobRow(ajeno)).toMatchObject({ status: 'running', locked_by: 'local-1' });
  });

  it('con el cliente del trabajador: reserva perdida y rechazos tienen su error', async () => {
    const job = await enqueue(marca, org);
    const options = { supabaseUrl: SUPABASE, token: TOKEN, fetch: workerFetch() };
    const queue = createGatewayQueue(options);
    const [claimed] = await queue.claim({
      worker: 'media-1',
      kinds: ['media.image.process'],
      limit: 1,
      leaseSeconds: 60,
    });
    expect(claimed!.id).toBe(job);
    await expect(queue.complete(job, 'media-2', {})).rejects.toBeInstanceOf(LeaseLostError);
    const storage = createGatewayStorage(options).forJob!(claimed!, 'media-1');
    await expect(storage.download(`${orgB}/${marcaB}/media/x.jpg`, path.join(tmp, 'x'))).rejects.toBeInstanceOf(
      PermanentError,
    );
    await queue.extendLease(job, 'media-1', 120);
    await queue.release(job, 'media-1');
    expect(await jobRow(job)).toMatchObject({ status: 'queued', locked_by: null });
  });
});

describe('revocar, rotar y tope de llamadas', () => {
  it('el token revocado deja de valer; al rotar, el anterior tampoco', async () => {
    await enqueue(marca, org);
    expect((await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 })).status).toBe(200);
    await as(db, root, `select public.admin_delete_integration_setting('WORKER_GATEWAY_TOKEN')`);
    const revoked = await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 });
    expect(revoked.status).toBe(403);
    expect(revoked.json.error.message).toMatch(/revocado/);

    await setToken(OTHER_TOKEN);
    expect((await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 })).status).toBe(403);
    expect((await post(OTHER_TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 })).status).toBe(200);
  });

  it('más de 1.200 llamadas en un minuto: se rechaza hasta el minuto siguiente', async () => {
    await db.exec(
      `insert into private.worker_gateway_calls (minute, calls) values (date_trunc('minute', now()), 1200)`,
    );
    const r = await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 });
    expect(r.status).toBe(429);
    await db.exec(`update private.worker_gateway_calls set minute = minute - interval '2 hours'`);
    expect((await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 })).status).toBe(200);
    // Lo de hace más de una hora se borra solo.
    expect(
      await db.query(`select 1 from private.worker_gateway_calls where minute < now() - interval '1 hour'`),
    ).toEqual([]);
  });

  it('peticiones demasiado grandes o subidas por encima del tope', async () => {
    const job = await enqueue(marca, org);
    await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 });
    const huge = await post(TOKEN, '/complete', { worker: 'w', jobId: job, result: { x: 'a'.repeat(400 * 1024) } });
    expect(huge.status).toBe(413);
    const big = await post(TOKEN, '/write-url', {
      worker: 'w',
      jobId: job,
      path: `${org}/${marca}/recortes/x.jpg`,
      contentType: 'image/jpeg',
      bytes: 60 * 1024 * 1024,
    });
    expect(big.status).toBe(413);
  });
});

describe('el bucle del trabajador entero por el intermediario', () => {
  it('reclama, baja la entrada, sube el resultado y cierra el trabajo, sin ninguna clave de Supabase', async () => {
    const source = `${org}/${marca}/media/${randomUUID()}.jpg`;
    const output = `${org}/${marca}/recortes/${randomUUID()}.jpg`;
    supabaseStore.objects.set(source, Buffer.from('foto-original'));
    const job = await enqueue(marca, org, 'media.image.process', { source: { path: source }, output });
    const copy: Handler = {
      kind: 'media.image.process',
      async run(context) {
        const local = path.join(context.workDir, 'entrada.jpg');
        await context.storage.download(source, local, context.signal);
        const out = path.join(context.workDir, 'salida.jpg');
        await writeFile(out, `${await readFile(local, 'utf8')}-recortada`);
        await context.storage.upload(out, output, { contentType: 'image/jpeg', signal: context.signal });
        return { output };
      },
    };
    const options = { supabaseUrl: SUPABASE, token: TOKEN, fetch: workerFetch() };
    const worker = createWorker({
      queue: createGatewayQueue(options),
      storage: createGatewayStorage(options),
      handlers: [copy],
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      workerId: 'media-fly',
      mode: 'drain',
      concurrency: 1,
      leaseSeconds: 60,
      maxAttemptSeconds: 60,
      pollIntervalMs: 50,
      idleExitMs: 0,
      shutdownGraceMs: 0,
      tmpRoot: tmp,
    });
    const summary = await worker.run();
    expect(summary.stoppedBy).not.toBe('queue-error');
    expect(await jobRow(job)).toMatchObject({ status: 'succeeded', result: { output } });
    expect(supabaseStore.objects.get(output)?.toString()).toBe('foto-original-recortada');
  });

  it('con R2: la subida va a R2 y queda apuntada para el alta del recurso', async () => {
    const job = await enqueue(marca, org);
    await post(TOKEN, '/claim', { worker: 'w', limit: 1, leaseSeconds: 60 }, true);
    const target = `${org}/${marca}/reels/${randomUUID()}.mp4`;
    const r = await post(
      TOKEN,
      '/write-url',
      { worker: 'w', jobId: job, path: target, contentType: 'video/mp4', bytes: 1000 },
      true,
    );
    expect(r.json).toMatchObject({ backend: 'r2', method: 'PUT' });
    expect(r.json.url).toMatch(/^https:\/\/r2\.test\//);
    const [row] = await db.query(`select backend from private.media_object_locations where storage_path = $1`, [
      target,
    ]);
    expect(row).toEqual({ backend: 'r2' });
    // Y al leerla, el intermediario sabe que está en R2.
    const read = await post(TOKEN, '/read-url', { worker: 'w', jobId: job, path: target }, true);
    expect(read.json).toMatchObject({ backend: 'r2' });
  });
});
