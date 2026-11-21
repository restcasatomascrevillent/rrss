// Imágenes generadas con IA de punta a punta, con la base de datos real y la
// imagen simulada de las pruebas locales:
//   · almacenamiento: archivo en el cubo + recurso en la biblioteca con su procedencia;
//   · función `ai-media`: modelos, estimación sin reservar, generación síncrona y
//     asíncrona, permisos, cupo, referencias de la biblioteca;
//   · función `ai-media-poll`: solo con la clave de servicio, cierra los asíncronos;
//   · función `ai-media-webhook`: sin firma válida no se cree nada;
//   · guarda de la imagen simulada (solo con la variable y un Supabase local);
//   · migración: modelo de ComfyUI inactivo y disparador de pg_cron inofensivo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import type { MediaInput, MediaReader } from '../../supabase/functions/_shared/ai/media/contract.ts';
import {
  LOCAL_TEST_IMAGE_ASYNC_MODEL,
  LOCAL_TEST_IMAGE_MODEL,
  LOCAL_TEST_IMAGE_PRICE_MICROS,
  loadLocalTestMediaConfig,
} from '../../supabase/functions/_shared/ai/media/local-test.ts';
import type { MediaModelRow } from '../../supabase/functions/_shared/ai/media/models.ts';
import { createMediaRuntime, type MediaRuntime } from '../../supabase/functions/_shared/ai/media/runtime.ts';
import { createMediaService } from '../../supabase/functions/_shared/ai/media/service.ts';
import { createSimulatedVideoProvider, simulatedPng } from '../../supabase/functions/_shared/ai/media/simulated.ts';
import {
  createSupabaseMediaStorage,
  imageDimensions,
  provenanceJson,
  sniffMimeType,
  type GeneratedAssetRow,
  type MediaStorageBackend,
} from '../../supabase/functions/_shared/ai/media/supabase-storage.ts';
import { LocalTestConfigError } from '../../supabase/functions/_shared/ai/text/local-test.ts';
import { createAiMediaHandler, imageSizeFor } from '../../supabase/functions/ai-media/handler.ts';
import { createAiMediaPollHandler, hasServiceKey } from '../../supabase/functions/ai-media-poll/handler.ts';
import { createAiMediaWebhookHandler } from '../../supabase/functions/ai-media-webhook/handler.ts';
import {
  addAsset,
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  join,
  rpcStatement,
  serviceRpc,
  setAiQuota,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

const SERVICE_KEY = 'clave-de-servicio-de-prueba-0123456789';
const LOCAL_ENV = { AI_E2E_SIMULATED_PROVIDER: 'true', SUPABASE_URL: 'http://127.0.0.1:55321' };

let db: Db;
let root: TestUser;
let n = 0;
const sessions = new Map<string, TestUser>();

const rpc: RpcClient = async (fn, args) => {
  try {
    if (fn === 'claim_jobs') {
      const { sql, params } = rpcStatement(fn, args);
      const rows = await asService<{ data: Row }>(db, sql, params);
      return { data: rows.map((r) => r.data), error: null };
    }
    return { data: await serviceRpc(db, fn, args), error: null };
  } catch (error) {
    const { code, message, detail } = error as { code?: string; message: string; detail?: string };
    return { data: null, error: { code, message, details: detail ?? null } };
  }
};

const reader: MediaReader = {
  getGeneration: async (id) => {
    const rows = await asService<{
      id: string;
      organization_id: string;
      brand_id: string;
      provider: string;
      status: string;
    }>(
      db,
      `select id, organization_id, brand_id, provider, status::text as status from public.ai_generations where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },
  getJob: async (organizationId, key) => {
    const rows = await asService<{ id: string; status: string; payload: unknown }>(
      db,
      `select id, status::text as status, payload from public.jobs where organization_id = $1 and idempotency_key = $2`,
      [organizationId, key],
    );
    return rows[0] ?? null;
  },
};

/** Almacenamiento contra la base de datos real: objeto en storage.objects y fila en media_assets, con la clave de servicio. */
const uploads: { path: string; bytes: number; contentType: string }[] = [];
const backend: MediaStorageBackend = {
  async upload(path, bytes, contentType) {
    uploads.push({ path, bytes: bytes.byteLength, contentType });
    await asService(
      db,
      `insert into storage.objects (bucket_id, name, metadata) values ('brand-media', $1, $2::jsonb)
       on conflict (bucket_id, name) do update set metadata = excluded.metadata`,
      [path, JSON.stringify({ size: bytes.byteLength, mimetype: contentType })],
    );
  },
  async saveAsset(row: GeneratedAssetRow) {
    const [saved] = await asService<{ id: string }>(
      db,
      `insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type, bytes,
         width, height, folder, tags, provenance, created_by)
       values ($1, $2, $3::public.asset_kind, 'generated', $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13)
       on conflict (storage_path) do update set bytes = excluded.bytes, provenance = excluded.provenance
       returning id`,
      [
        row.brand_id,
        row.organization_id,
        row.kind,
        row.storage_path,
        row.file_name,
        row.mime_type,
        row.bytes,
        row.width,
        row.height,
        row.folder,
        row.tags,
        JSON.stringify(row.provenance),
        row.created_by,
      ],
    );
    return { id: saved!.id };
  },
};
const storage = createSupabaseMediaStorage(backend);

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@plataforma.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
});

afterAll(async () => {
  await db?.close();
});

function login(user: TestUser): string {
  const token = `sesion-${user.id}`;
  sessions.set(token, user);
  return token;
}

async function modelRows(): Promise<MediaModelRow[]> {
  return db.query<MediaModelRow & Row>(
    `select provider, model, task::text as task, display_name, billing_unit, price_micros, price_details, price_verified,
            data_region, trains_on_inputs, delivery, settings, priority, active
     from public.ai_media_models where active`,
  );
}

async function runtime(env: Record<string, string | undefined> = LOCAL_ENV): Promise<MediaRuntime> {
  return createMediaRuntime({
    env,
    fetch: async () => new Response(null, { status: 599 }),
    rpc,
    reader,
    storage,
    modelRows: await modelRows(),
    serviceOptions: { pollIntervalMs: 0 },
  });
}

function mediaHandler(env?: Record<string, string | undefined>) {
  return createAiMediaHandler({
    authenticate: async (token) => {
      const user = sessions.get(token);
      return user ? { userId: user.id } : null;
    },
    brandVisible: async (token, brandId) =>
      (await as(db, sessions.get(token)!, `select id from public.brands where id = $1`, [brandId])).length > 0,
    // Igual que la función real: con la identidad del usuario, bajo RLS.
    loadReferences: async (token, brandId, ids) => {
      const rows = await as<{ id: string; mime_type: string; kind: string }>(
        db,
        sessions.get(token)!,
        `select id, mime_type, kind::text as kind from public.media_assets where brand_id = $1 and id = any($2::uuid[])`,
        [brandId, ids],
      );
      if (rows.length !== ids.length || rows.some((r) => r.kind !== 'image')) return null;
      return rows.map((r): MediaInput => ({ mimeType: r.mime_type, url: `https://firmada.test/${r.id}` }));
    },
    runtime: () => runtime(env),
  });
}

async function call(
  handler: (request: Request) => Promise<Response>,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request('http://funcion.test/ai-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function setup(options: { quota?: number | null } = {}) {
  n += 1;
  const owner = await createUser(db, `propietaria${n}@imagen${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  if (options.quota !== null) await setAiQuota(db, root, org, options.quota ?? 10_000_000);
  return { owner, org, brand, token: login(owner) };
}

const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };

// ───────────────────────────── Almacenamiento ─────────────────────────────

describe('almacenamiento de los medios generados', () => {
  it('reconoce el tipo y el tamaño de la imagen por sus bytes', () => {
    const png = simulatedPng('hola');
    expect(sniffMimeType(png)).toBe('image/png');
    expect(imageDimensions(png)).toEqual({ width: 8, height: 8 });
    expect(sniffMimeType(new TextEncoder().encode('no soy una imagen'))).toBeNull();
  });

  it('guarda el archivo en <org>/<marca>/ia/ y crea el recurso con su procedencia, sin duplicar al repetir', async () => {
    const { org, brand, owner } = await setup();
    const [generation] = await asService<{ id: string }>(
      db,
      `select (public.ai_reserve_generation($1, $2, 'image', 'post.visual', 'simulated-image', 'm', 10, 600)).id`,
      [owner.id, brand],
    );
    const object = {
      organizationId: org,
      brandId: brand,
      generationId: generation!.id,
      kind: 'image' as const,
      index: 0,
      mimeType: 'application/octet-stream',
      bytes: simulatedPng('terraza'),
      provenance: {
        provider: 'simulated-image',
        model: 'm',
        purpose: 'post.visual',
        prompt: 'Terraza al atardecer',
        requestedBy: owner.id,
        dataRegion: 'eu' as const,
        trainsOnInputs: 'no' as const,
        untestedAdapter: true,
      },
    };
    const first = await storage.put(object);
    const again = await storage.put(object);
    expect(first.path).toBe(`${org}/${brand}/ia/${generation!.id}-0.png`);
    expect(again).toEqual(first);
    const rows = await asService<Row>(db, `select * from public.media_assets where provenance->>'generation_id' = $1`, [
      generation!.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.assetId,
      origin: 'generated',
      kind: 'image',
      mime_type: 'image/png',
      width: 8,
      height: 8,
      folder: 'IA',
      created_by: owner.id,
      file_name: 'IA · Terraza al atardecer.png',
      provenance: {
        type: 'ai_generation',
        provider: 'simulated-image',
        model: 'm',
        prompt: 'Terraza al atardecer',
        purpose: 'post.visual',
        generation_id: generation!.id,
        untested_adapter: true,
      },
    });
    // Quien ve la marca ve el recurso (la RLS de siempre).
    expect(await as(db, owner, `select id from public.media_assets where id = $1`, [first.assetId])).toHaveLength(1);
  });

  it('la procedencia cabe siempre en los 2048 bytes de la columna, aunque el encargo sea largo', async () => {
    const { org, brand, owner } = await setup();
    const [generation] = await asService<{ id: string }>(
      db,
      `select (public.ai_reserve_generation($1, $2, 'image', 'post.visual', 'simulated-image', 'm', 10, 600)).id`,
      [owner.id, brand],
    );
    const prompt = 'Café con churros ☕ en la terraza, '.repeat(120);
    const json = provenanceJson(generation!.id, {
      provider: 'simulated-image',
      model: 'm',
      prompt,
      dataRegion: 'eu',
      trainsOnInputs: 'no',
      untestedAdapter: true,
    });
    expect(new TextEncoder().encode(JSON.stringify(json)).length).toBeLessThanOrEqual(2048);
    expect(prompt.startsWith(json.prompt as string)).toBe(true);
    const { assetId } = await storage.put({
      organizationId: org,
      brandId: brand,
      generationId: generation!.id,
      kind: 'image',
      index: 0,
      mimeType: 'image/png',
      bytes: simulatedPng('largo'),
      provenance: {
        provider: 'simulated-image',
        model: 'm',
        prompt,
        dataRegion: 'eu',
        trainsOnInputs: 'no',
        untestedAdapter: true,
      },
    });
    const [row] = await asService<Row>(
      db,
      `select octet_length(provenance::text) as n from public.media_assets where id = $1`,
      [assetId],
    );
    expect(Number(row!.n)).toBeLessThanOrEqual(2048);
  });

  it('rechaza lo que supera 50 MB o no es del tipo pedido, sin subir nada', async () => {
    const before = uploads.length;
    const base = { organizationId: 'o', brandId: 'b', generationId: 'g', kind: 'image' as const, index: 0 };
    await expect(
      createSupabaseMediaStorage(backend, { maxBytes: 10 }).put({
        ...base,
        mimeType: 'image/png',
        bytes: simulatedPng('x'),
      }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(
      storage.put({ ...base, mimeType: 'text/plain', bytes: new TextEncoder().encode('texto') }),
    ).rejects.toMatchObject({ code: 'bad_response' });
    expect(uploads.length).toBe(before);
  });
});

// ───────────────────────────── ai-media ─────────────────────────────

describe('función ai-media', () => {
  it('sin sesión, 401; marca ajena, 404; acción desconocida, 400', async () => {
    const handler = mediaHandler();
    const { brand } = await setup();
    const other = await setup();
    expect((await call(handler, null, { action: 'image.models', brandId: brand })).status).toBe(401);
    expect((await call(handler, 'falso', { action: 'image.models', brandId: brand })).status).toBe(401);
    const foreign = await call(handler, other.token, { action: 'image.models', brandId: brand });
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign.body).code).toBe('brand_not_found');
    expect((await call(handler, other.token, { action: 'video.generate', brandId: other.brand })).status).toBe(400);
  });

  it('lista los modelos configurados: los simulados en local; el de ComfyUI no (inactivo y sin servidor)', async () => {
    const { brand, token } = await setup();
    const result = await call(mediaHandler(), token, { action: 'image.models', brandId: brand });
    expect(result.status).toBe(200);
    const models = result.body.models as { id: string; default: boolean; delivery: string; untestedAdapter: boolean }[];
    expect(models.map((m) => [m.id, m.delivery, m.default])).toEqual([
      [`simulated-image:${LOCAL_TEST_IMAGE_MODEL}`, 'sync', true],
      [`simulated-image-async:${LOCAL_TEST_IMAGE_ASYNC_MODEL}`, 'async', false],
    ]);
    expect(models.every((m) => m.untestedAdapter)).toBe(true);

    // Sin la vía de pruebas locales no hay ningún modelo: «no configurado».
    const none = await call(mediaHandler({}), token, { action: 'image.models', brandId: brand });
    expect(none.body.models).toEqual([]);
    const generate = await call(mediaHandler({}), token, {
      action: 'image.generate',
      brandId: brand,
      input: { prompt: 'Una terraza', aspectRatio: '1:1' },
    });
    expect(generate.status).toBe(503);
    expect(errorOf(generate.body)).toMatchObject({ code: 'not_configured' });
  });

  it('estima el coste antes de generar, sin reservar cupo ni llamar a nadie', async () => {
    const { brand, org, token } = await setup();
    const result = await call(mediaHandler(), token, {
      action: 'image.estimate',
      brandId: brand,
      input: { prompt: '', aspectRatio: '4:5' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      costMicros: LOCAL_TEST_IMAGE_PRICE_MICROS,
      model: `simulated-image:${LOCAL_TEST_IMAGE_MODEL}`,
      size: imageSizeFor('4:5'),
    });
    const generations = await asService(db, `select id from public.ai_generations where organization_id = $1`, [org]);
    expect(generations).toEqual([]);
  });

  it('genera una imagen síncrona: recurso en la biblioteca, coste real y procedencia', async () => {
    const { brand, org, owner, token } = await setup();
    const result = await call(mediaHandler(), token, {
      action: 'image.generate',
      brandId: brand,
      input: { prompt: 'Mesa para dos con vela', aspectRatio: '1:1' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'completed', costMicros: LOCAL_TEST_IMAGE_PRICE_MICROS });
    const asset = result.body.asset as { id: string; path: string };
    expect(asset.path).toMatch(new RegExp(`^${org}/${brand}/ia/`));

    const [row] = await as<Row>(db, owner, `select * from public.media_assets where id = $1`, [asset.id]);
    expect(row).toMatchObject({
      origin: 'generated',
      provenance: {
        type: 'ai_generation',
        generation_id: result.body.generationId,
        prompt: 'Mesa para dos con vela',
        provider: 'simulated-image',
        purpose: 'post.visual',
      },
    });
    const [generation] = await asService<Row>(
      db,
      `select status::text as status, cost_micros::int as cost, output from public.ai_generations where id = $1`,
      [result.body.generationId],
    );
    expect(generation).toMatchObject({ status: 'succeeded', cost: LOCAL_TEST_IMAGE_PRICE_MICROS });
    expect((generation!.output as { assets: { asset_id: string }[] }).assets[0]!.asset_id).toBe(asset.id);
  });

  it('valida la petición: encargo, proporción, modelo y referencias', async () => {
    const { brand, org, owner, token } = await setup();
    const other = await setup();
    const foreignAsset = await addAsset(db, other.owner, other.org, other.brand);
    const ownAsset = await addAsset(db, owner, org, brand);
    const handler = mediaHandler();
    const generate = (input: Record<string, unknown>) =>
      call(handler, token, { action: 'image.generate', brandId: brand, input });

    expect(errorOf((await generate({ prompt: '  ', aspectRatio: '1:1' })).body).message).toMatch(/Describe la imagen/);
    expect(errorOf((await generate({ prompt: 'x', aspectRatio: '3:1' })).body).message).toMatch(/proporción/);
    expect(
      errorOf((await generate({ prompt: 'x', aspectRatio: '1:1', model: 'bfl:flux-2-pro' })).body).message,
    ).toMatch(/no está disponible/);
    const foreign = await generate({ prompt: 'x', aspectRatio: '1:1', referenceAssetIds: [foreignAsset] });
    expect(foreign.status).toBe(400);
    expect(errorOf(foreign.body).message).toMatch(/referencia/);
    const ok = await generate({ prompt: 'Con mi foto', aspectRatio: '9:16', referenceAssetIds: [ownAsset] });
    expect(ok.status).toBe(200);
  });

  it('sin permiso de edición, 403; cupo agotado o sin cupo, 402 sin llamar al proveedor', async () => {
    const { brand, org, owner } = await setup({ quota: 10_000 });
    const viewer = await createUser(db, `lectora${n}@imagen.test`);
    await join(db, owner, viewer, org, 'member', brand, 'viewer');
    const handler = mediaHandler();
    const input = { prompt: 'Tapas', aspectRatio: '1:1' };

    const forbidden = await call(handler, login(viewer), { action: 'image.generate', brandId: brand, input });
    expect(forbidden.status).toBe(403);
    expect(errorOf(forbidden.body).code).toBe('forbidden');

    const exhausted = await call(handler, login(owner), { action: 'image.generate', brandId: brand, input });
    expect(exhausted.status).toBe(402);
    expect(errorOf(exhausted.body).code).toBe('quota_exhausted');

    const noQuota = await setup({ quota: null });
    const missing = await call(handler, noQuota.token, { action: 'image.generate', brandId: noQuota.brand, input });
    expect(errorOf(missing.body).code).toBe('quota_missing');
    expect(await asService(db, `select id from public.media_assets where brand_id = $1`, [brand])).toEqual([]);
  });
});

// ─────────────────────────── Asíncronos: sondeo ───────────────────────────

describe('generación asíncrona y función ai-media-poll', () => {
  const pollRequest = (headers: Record<string, string>) =>
    new Request('http://funcion.test/ai-media-poll', { method: 'POST', headers, body: '{}' });

  it('solo atiende a la clave de servicio, en Authorization o en apikey', () => {
    expect(hasServiceKey(pollRequest({ authorization: `Bearer ${SERVICE_KEY}` }), [SERVICE_KEY])).toBe(true);
    expect(hasServiceKey(pollRequest({ apikey: SERVICE_KEY }), [SERVICE_KEY])).toBe(true);
    expect(hasServiceKey(pollRequest({ authorization: 'Bearer otra' }), [SERVICE_KEY])).toBe(false);
    expect(hasServiceKey(pollRequest({}), [SERVICE_KEY])).toBe(false);
    // Una clave vacía o corta en la configuración no abre la puerta.
    expect(hasServiceKey(pollRequest({ authorization: 'Bearer ' }), [''])).toBe(false);
  });

  it('devuelve el trabajo en curso y el sondeo lo cierra: recurso, coste y trabajo terminado', async () => {
    const { brand, owner, token } = await setup();
    const started = await call(mediaHandler(), token, {
      action: 'image.generate',
      brandId: brand,
      input: {
        prompt: 'Cócteles en la barra',
        aspectRatio: '9:16',
        model: `simulated-image-async:${LOCAL_TEST_IMAGE_ASYNC_MODEL}`,
      },
    });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'pending' });
    const generationId = started.body.generationId as string;

    const poll = createAiMediaPollHandler({
      serviceKeys: [SERVICE_KEY],
      rpc,
      service: async () => (await runtime()).serviceFor(),
      workerName: 'prueba-sondeo',
    });

    // Sin la clave: 401 y la cola intacta.
    const denied = await poll(pollRequest({ authorization: 'Bearer de-un-usuario' }));
    expect(denied.status).toBe(401);
    const [queued] = await asService<Row>(
      db,
      `select status::text as status from public.jobs where idempotency_key = $1`,
      [`ai-media:${generationId}`],
    );
    expect(queued!.status).toBe('queued');

    // El simulado asíncrono «termina» a los 2 s.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const response = await poll(pollRequest({ apikey: SERVICE_KEY }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { processed: number; results: { status: string; generationId: string }[] };
    expect(body.results).toContainEqual(expect.objectContaining({ status: 'completed', generationId }));

    const [generation] = await as<Row>(
      db,
      owner,
      `select status::text as status from public.ai_generations where id = $1`,
      [generationId],
    );
    expect(generation!.status).toBe('succeeded');
    const assets = await as<Row>(
      db,
      owner,
      `select provenance from public.media_assets where provenance->>'generation_id' = $1`,
      [generationId],
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]!.provenance).toMatchObject({ prompt: 'Cócteles en la barra', provider: 'simulated-image-async' });
    const [job] = await asService<Row>(
      db,
      `select status::text as status from public.jobs where idempotency_key = $1`,
      [`ai-media:${generationId}`],
    );
    expect(job!.status).toBe('succeeded');

    // Sin trabajos pendientes no hace nada.
    const idle = await poll(pollRequest({ authorization: `Bearer ${SERVICE_KEY}` }));
    expect(await idle.json()).toMatchObject({ processed: 0 });
  });
});

// ─────────────────────────── Webhook ───────────────────────────

describe('función ai-media-webhook', () => {
  const hook = (url: string, body: string, headers: Record<string, string> = {}) =>
    new Request(url, { method: 'POST', headers, body });

  it('rechaza peticiones mal formadas, proveedores sin webhooks y firmas falsas', async () => {
    const video = createSimulatedVideoProvider({ webhookSecret: 'secreto' });
    const service = createMediaService({
      rpc,
      reader,
      storage,
      fetch: async () => new Response(null, { status: 599 }),
      providers: { providers: [video], unavailable: [{ id: 'higgsfield', reason: 'falta la variable X' }] },
      models: [],
    });
    const handler = createAiMediaWebhookHandler({ service: async () => service });
    const generation = '00000000-0000-4000-8000-000000000000';

    expect((await handler(hook('http://f.test/ai-media-webhook?provider=simulated-video', '{}'))).status).toBe(400);
    expect(
      (await handler(hook(`http://f.test/ai-media-webhook?provider=bfl&generation=${generation}`, '{}'))).status,
    ).toBe(404);
    const forged = await handler(
      hook(
        `http://f.test/ai-media-webhook?provider=simulated-video&generation=${generation}`,
        JSON.stringify({ job_id: 'x', status: 'completed' }),
        { 'x-simulated-signature': 'falsa' },
      ),
    );
    expect(forged.status).toBe(401);
    // Firma buena pero de una generación que no existe: tampoco se cree.
    const orphan = await handler(
      hook(
        `http://f.test/ai-media-webhook?provider=simulated-video&generation=${generation}`,
        JSON.stringify({ job_id: 'x', status: 'completed' }),
        { 'x-simulated-signature': 'secreto' },
      ),
    );
    expect(orphan.status).toBe(401);
  });
});

// ─────────────────────── Guarda de las pruebas locales ───────────────────────

describe('imagen simulada: solo con la variable y un Supabase local', () => {
  it('sin la variable no hace nada', () => {
    expect(loadLocalTestMediaConfig({ SUPABASE_URL: 'http://127.0.0.1:55321' })).toBeNull();
    expect(
      loadLocalTestMediaConfig({ AI_E2E_SIMULATED_PROVIDER: ' ', SUPABASE_URL: 'http://127.0.0.1:55321' }),
    ).toBeNull();
  });

  it.each(['http://127.0.0.1:55321', 'http://localhost:54321', 'http://kong:8000'])('se admite con %s', (url) => {
    const config = loadLocalTestMediaConfig({ AI_E2E_SIMULATED_PROVIDER: 'true', SUPABASE_URL: url })!;
    expect(config.models.map((m) => m.model)).toEqual([LOCAL_TEST_IMAGE_MODEL, LOCAL_TEST_IMAGE_ASYNC_MODEL]);
  });

  it.each([
    'https://abcdefgh.supabase.co',
    'https://127.0.0.1:55321',
    'http://kong.ejemplo.com',
    'http://10.0.0.5:8000',
    undefined,
  ])('se rechaza con %s, y la función no arranca', async (url) => {
    const env = { AI_E2E_SIMULATED_PROVIDER: 'true', SUPABASE_URL: url };
    expect(() => loadLocalTestMediaConfig(env)).toThrow(LocalTestConfigError);
    await expect(runtime(env)).rejects.toThrow(LocalTestConfigError);
  });

  it('solo admite el valor «true»', () => {
    expect(() =>
      loadLocalTestMediaConfig({ AI_E2E_SIMULATED_PROVIDER: 'yes', SUPABASE_URL: 'http://127.0.0.1:55321' }),
    ).toThrow(/solo admite el valor «true»/);
  });
});

// ───────────────────────────── Migración ─────────────────────────────

describe('migración de imágenes con IA', () => {
  it('el modelo de ComfyUI nace inactivo, sin precio verificado y sin entrenar con nada', async () => {
    const [row] = await db.query<Row>(
      `select active, price_verified, price_micros::int as price, data_region, trains_on_inputs, delivery
       from public.ai_media_models where provider = 'comfyui'`,
    );
    expect(row).toEqual({
      active: false,
      price_verified: false,
      price: 0,
      data_region: 'unknown',
      trains_on_inputs: 'no',
      delivery: 'async',
    });
  });

  it('el disparador de pg_cron no hace nada sin trabajos ni sin Vault, y nadie más lo puede ejecutar', async () => {
    expect((await db.query<Row>(`select private.ai_media_poll_dispatch() as r`))[0]!.r).toBeNull();
    const { owner, org, brand } = await setup();
    await asService(db, `select public.enqueue_job($1, 'ai.media.poll', '{}'::jsonb, 'prueba-disparador', $2)`, [
      org,
      brand,
    ]);
    // Hay trabajo, pero en PGlite no hay Vault ni pg_net: avisa y no llama a nada.
    expect((await db.query<Row>(`select private.ai_media_poll_dispatch() as r`))[0]!.r).toBeNull();
    await expect(as(db, owner, `select private.ai_media_poll_dispatch()`)).rejects.toThrow(/permission denied/);
    await expect(asService(db, `select private.ai_media_poll_dispatch()`)).rejects.toThrow(/permission denied/);
  });
});
