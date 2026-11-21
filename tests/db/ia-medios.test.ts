// Imagen y vídeo generativos, con los proveedores simulados y la base de datos
// real (migraciones aplicadas):
//   estimar → reservar cupo → lanzar → (cola: sondeo o webhook) → guardar → coste real
// y lo que pasa cuando algo falla por el camino.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError, type RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import {
  MEDIA_JOB_KIND,
  MediaProviderFailure,
  MediaRequestError,
  type ClaimedJob,
  type ImageRequest,
  type MediaProvider,
  type MediaReader,
  type MediaStorage,
  type VideoRequest,
} from '../../supabase/functions/_shared/ai/media/contract.ts';
import { createHiggsfieldVideoProvider } from '../../supabase/functions/_shared/ai/media/higgsfield-video.ts';
import { mediaModelsFromRows, type MediaModelRow } from '../../supabase/functions/_shared/ai/media/models.ts';
import { createMediaService, type MediaServiceConfig } from '../../supabase/functions/_shared/ai/media/service.ts';
import {
  createSimulatedImageProvider,
  createSimulatedVideoProvider,
  type SimulatedOptions,
  type SimulatedVideoOptions,
} from '../../supabase/functions/_shared/ai/media/simulated.ts';
import {
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

let db: Db;
let root: TestUser;
let n = 0;

/** Las funciones SQL llamadas como las llamará el servidor: con la clave de servicio. */
const rpc: RpcClient = async (fn, args) => {
  try {
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

// Precios inventados para las pruebas, en millonésimas por unidad.
const TEST_MODELS = `
  insert into public.ai_media_models
    (provider, model, task, display_name, billing_unit, price_micros, price_details, price_checked_on, price_source,
     price_verified, data_region, trains_on_inputs, delivery, settings, priority, active)
  values
    ('simulated-image', 'sim-image-1', 'image', 'Imagen simulada', 'image', 40000, '{}', '2026-11-17', 'prueba',
     true, 'eu', 'no', 'sync', '{}', 10, true),
    ('simulated-image', 'sim-image-mp', 'image', 'Imagen simulada por megapíxel', 'megapixel', 15000,
     '{"first_unit_micros": 30000}', '2026-11-17', 'prueba', true, 'eu', 'no', 'sync', '{}', 5, true),
    ('simulated-image', 'sim-image-us', 'image', 'Imagen simulada fuera de la UE', 'image', 20000, '{}', '2026-11-17',
     'prueba', true, 'us', 'yes', 'sync', '{}', 50, true),
    ('simulated-video', 'sim-video-1', 'video', 'Vídeo simulado', 'second', 100000, '{}', '2026-11-17', 'prueba',
     true, 'eu', 'no', 'async', '{"min_seconds": 3, "max_seconds": 15}', 10, true)`;

let models: ReturnType<typeof mediaModelsFromRows>;

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@plataforma.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  await db.exec(TEST_MODELS);
  // El registro se lee como lo leerá el servidor: con la clave de servicio.
  models = mediaModelsFromRows(await asService<MediaModelRow & Row>(db, `select * from public.ai_media_models`));
});

afterAll(async () => {
  await db?.close();
});

// Cada prueba empieza con la cola vacía.
beforeEach(async () => {
  await db.exec(`delete from public.jobs`);
});

const IMAGE: ImageRequest = {
  kind: 'image',
  prompt: 'Mesa de otoño con la carta nueva',
  aspectRatio: '4:5',
  size: { width: 1080, height: 1350 },
};
const VIDEO: VideoRequest = {
  kind: 'video',
  startImage: { mimeType: 'image/jpeg', url: 'https://almacen.test/firmada/foto.jpg' },
  prompt: 'Travelling lento sobre la mesa',
  durationSeconds: 10,
  aspectRatio: '9:16',
};

/** Organización nueva con su marca, su cupo y un servicio con los proveedores simulados. */
async function setup(
  limitMicros: number | null,
  options: {
    image?: SimulatedOptions;
    video?: SimulatedVideoOptions;
    service?: Partial<MediaServiceConfig>;
    wrapVideo?: (provider: MediaProvider) => MediaProvider;
  } = {},
) {
  n += 1;
  const owner = await createUser(db, `propietaria${n}@medios${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  if (limitMicros !== null) await setAiQuota(db, root, org, limitMicros);

  const image = createSimulatedImageProvider(options.image);
  const video = createSimulatedVideoProvider(options.video);
  const files = new Map<string, Uint8Array>();
  let puts = 0;
  const storage: MediaStorage = {
    put: async (object) => {
      puts += 1;
      const path = `${object.organizationId}/${object.brandId}/generated/${object.generationId}-${object.index}`;
      files.set(path, object.bytes);
      return { path };
    },
  };
  const service = createMediaService({
    rpc,
    reader,
    storage,
    fetch: () => Promise.reject(new Error('Las pruebas no descargan nada')),
    providers: { providers: [image, options.wrapVideo ? options.wrapVideo(video) : video], unavailable: [] },
    models,
    webhookBaseUrl: 'https://funciones.test/ai-media-webhook',
    pollIntervalMs: 0,
    ...options.service,
  });
  const generate = (request: ImageRequest | VideoRequest, userId = owner.id) =>
    service.generate({
      userId,
      brandId: brand,
      purpose: request.kind === 'image' ? 'post.visual' : 'reel.clip',
      request,
    });
  return { owner, org, brand, image, video, files, puts: () => puts, service, generate };
}

const generations = (org: string) =>
  db.query<Row>(`select * from public.ai_generations where organization_id = $1 order by created_at`, [org]);
const jobs = (org: string) => db.query<Row>(`select * from public.jobs where organization_id = $1`, [org]);

async function committed(org: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `select coalesce(sum(reserved_delta_micros + cost_delta_micros), 0)::int as n from public.ai_usage where organization_id = $1`,
    [org],
  );
  return row!.n;
}

/** Reclama el trabajo de medios pendiente, como lo hará el trabajador. */
async function claim(worker = 'trabajador-1'): Promise<ClaimedJob> {
  await db.exec(`update public.jobs set run_after = now() - interval '1 second' where status = 'queued'`);
  const { sql, params } = rpcStatement('claim_jobs', { p_worker: worker, p_kinds: [MEDIA_JOB_KIND], p_limit: 10 });
  const rows = await asService<{ data: ClaimedJob }>(db, sql, params);
  expect(rows).toHaveLength(1);
  return rows[0]!.data;
}

async function aiError(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiError) return error;
    throw error;
  }
  throw new Error('Se esperaba un AiError y la generación terminó bien');
}

describe('imagen (síncrona)', () => {
  it('estima antes de generar; después reserva, genera, guarda y registra el coste', async () => {
    const t = await setup(100_000);

    // Estimar no reserva ni llama a nadie.
    expect(t.service.estimate(IMAGE)).toMatchObject({
      provider: 'simulated-image',
      model: 'sim-image-1',
      usage: { images: 1 },
      costMicros: 40_000,
      dataHandling: { dataRegion: 'eu', euProcessing: true, trainsOnInputs: 'no', untestedAdapter: true },
    });
    expect(t.image.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);

    const result = await t.generate(IMAGE);
    if (result.status !== 'completed') throw new Error('La imagen simulada es síncrona');
    expect(result).toMatchObject({
      provider: 'simulated-image',
      model: 'sim-image-1',
      estimatedCostMicros: 40_000,
      costMicros: 40_000,
      usage: { images: 1 },
      euProcessing: true,
    });

    // La imagen de prueba es un PNG de verdad, guardado en la ruta de la marca.
    const [asset] = result.assets;
    expect(asset).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(asset!.path.startsWith(`${t.org}/${t.brand}/`)).toBe(true);
    const bytes = t.files.get(asset!.path)!;
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(asset!.bytes).toBe(bytes.byteLength);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({
      id: result.generationId,
      task: 'image',
      purpose: 'post.visual',
      provider: 'simulated-image',
      model: 'sim-image-1',
      status: 'succeeded',
      usage: { images: 1 },
      provider_request_id: 'sim-image-1',
      output: {
        assets: [{ kind: 'image', path: asset!.path, mime_type: 'image/png', bytes: bytes.byteLength }],
        data_region: 'eu',
        trains_on_inputs: 'no',
        untested_adapter: true,
      },
    });
    expect(Number(row!.cost_micros)).toBe(40_000);
    expect(await committed(t.org)).toBe(40_000);
    expect(await jobs(t.org)).toEqual([]);
  });

  it('la misma petición produce exactamente la misma imagen de prueba', async () => {
    const t = await setup(1_000_000);
    const a = await t.generate(IMAGE);
    const b = await t.generate(IMAGE);
    const c = await t.generate({ ...IMAGE, prompt: 'Otra cosa' });
    if (a.status !== 'completed' || b.status !== 'completed' || c.status !== 'completed') throw new Error('síncrona');
    const file = (r: typeof a) => [...t.files.get(r.assets[0]!.path)!];
    expect(file(a)).toEqual(file(b));
    expect(file(a)).not.toEqual(file(c));
  });

  it('con el cupo agotado no se llama al proveedor', async () => {
    const t = await setup(39_999); // la imagen necesita reservar 40 000
    const error = await aiError(t.generate(IMAGE));
    expect(error.code).toBe('quota_exhausted');
    expect(error.details).toMatchObject({ limit_micros: 39_999, requested_micros: 40_000 });
    expect(t.image.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);
    expect(t.puts()).toBe(0);

    const sinCupo = await setup(null);
    expect((await aiError(sinCupo.generate(IMAGE))).code).toBe('quota_missing');
    expect(sinCupo.image.calls).toEqual([]);
  });

  it('quien no puede crear contenido en la marca no genera', async () => {
    const t = await setup(100_000);
    const cliente = await createUser(db, `cliente${n}@medios${n}.test`);
    await join(db, t.owner, cliente, t.org, 'member', t.brand, 'client');
    expect((await aiError(t.generate(IMAGE, cliente.id))).code).toBe('forbidden');
    expect(t.image.calls).toEqual([]);
  });

  it('un límite de uso del proveedor devuelve la reserva y dice cuánto esperar', async () => {
    const t = await setup(40_000, {
      image: {
        failWith: (_request, call) =>
          call === 1
            ? new MediaProviderFailure('rate_limited', 'Límite de uso (HTTP 429)', {
                retryable: true,
                retryAfterSeconds: 7,
              })
            : null,
      },
    });
    const error = await aiError(t.generate(IMAGE));
    expect(error).toMatchObject({ code: 'provider_failed', retryable: true });
    expect(error.details).toEqual({ provider_code: 'rate_limited', retry_after_seconds: 7 });
    expect(error.message).toMatch(/No se ha consumido cupo/);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({ status: 'failed', error_code: 'rate_limited', cost_micros: null });
    expect(await committed(t.org)).toBe(0);

    // El cupo solo da para una imagen: si el fallo hubiera retenido la reserva, esta no saldría.
    expect((await t.generate(IMAGE)).status).toBe('completed');
  });

  it('de un error inesperado no se guarda el mensaje (puede llevar secretos)', async () => {
    const t = await setup(100_000, { image: { failWith: () => new Error('401 Authorization: Bearer clave-secreta') } });
    const error = await aiError(t.generate(IMAGE));
    expect(error).toMatchObject({ code: 'provider_failed', retryable: false });
    const [row] = await generations(t.org);
    expect(row).toMatchObject({ status: 'failed', error_code: 'unexpected' });
    expect(JSON.stringify(row)).not.toMatch(/clave-secreta/);
  });

  it('si el proveedor tarda demasiado se corta, sin consumir cupo', async () => {
    const t = await setup(100_000, { image: { delayMs: 2000 }, service: { startTimeoutMs: 40 } });
    const error = await aiError(t.generate(IMAGE));
    expect(error).toMatchObject({ code: 'provider_timeout', retryable: true });
    expect(t.image.calls[0]!.signal.aborted).toBe(true);
    expect((await generations(t.org))[0]).toMatchObject({ status: 'failed', error_code: 'timeout' });
    expect(await committed(t.org)).toBe(0);
  });

  it('si el resultado no se puede guardar, el gasto se apunta y no se entrega nada', async () => {
    const t = await setup(100_000, {
      service: { storage: { put: () => Promise.reject(new Error('almacenamiento caído')) } },
    });
    const error = await aiError(t.generate(IMAGE));
    expect(error).toMatchObject({ code: 'internal', retryable: true });
    const [row] = await generations(t.org);
    expect(row).toMatchObject({ status: 'succeeded', output: { assets: [], error: 'storage_failed' } });
    expect(await committed(t.org)).toBe(40_000);
  });

  it('una petición imposible se rechaza antes de reservar', async () => {
    const t = await setup(100_000);
    await expect(t.generate({ ...IMAGE, size: { width: 0, height: 1350 } })).rejects.toBeInstanceOf(MediaRequestError);
    await expect(t.generate({ ...IMAGE, prompt: '  ' })).rejects.toBeInstanceOf(MediaRequestError);
    await expect(t.generate({ ...VIDEO, durationSeconds: 16 })).rejects.toThrow(/entre 3 y 15 segundos/);
    await expect(t.generate({ ...VIDEO, durationSeconds: 2 })).rejects.toBeInstanceOf(MediaRequestError);
    expect(t.image.calls).toEqual([]);
    expect(t.video.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);
  });
});

describe('vídeo (asíncrono, por la cola)', () => {
  it('reserva la cota superior, encola el seguimiento y al terminar registra coste y segundos', async () => {
    const t = await setup(2_000_000);
    expect(t.service.estimate(VIDEO)).toMatchObject({ usage: { seconds: 10 }, costMicros: 1_000_000 });

    const result = await t.generate(VIDEO);
    if (result.status !== 'pending') throw new Error('El vídeo simulado es asíncrono');
    expect(result).toMatchObject({ provider: 'simulated-video', model: 'sim-video-1', estimatedCostMicros: 1_000_000 });

    // Mientras está en curso, el cupo reservado cuenta entero.
    expect((await generations(t.org))[0]).toMatchObject({ id: result.generationId, task: 'video', status: 'reserved' });
    expect(await committed(t.org)).toBe(1_000_000);
    const [queued] = await jobs(t.org);
    expect(queued).toMatchObject({
      id: result.jobId,
      kind: MEDIA_JOB_KIND,
      status: 'queued',
      brand_id: t.brand,
      idempotency_key: `ai-media:${result.generationId}`,
      created_by: t.owner.id,
      payload: { generation_id: result.generationId, provider: 'simulated-video', job: { id: 'sim-video-1' } },
    });
    // El proveedor recibe adónde avisar y una clave para no duplicar el envío.
    expect(t.video.calls[0]).toMatchObject({
      idempotencyKey: result.generationId,
      webhookUrl: `https://funciones.test/ai-media-webhook?provider=simulated-video&generation=${result.generationId}`,
    });

    // Primer sondeo: sigue en curso y el trabajo vuelve a la cola.
    expect(await t.service.processJob(await claim(), 'trabajador-1')).toEqual({
      status: 'pending',
      generationId: result.generationId,
    });
    expect((await jobs(t.org))[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await generations(t.org))[0]).toMatchObject({ status: 'reserved' });

    // Segundo sondeo: terminado.
    const done = await t.service.processJob(await claim(), 'trabajador-1');
    if (done.status !== 'completed') throw new Error(`Se esperaba terminado y es ${done.status}`);
    expect(done.costMicros).toBe(1_000_000);
    expect(new TextDecoder().decode(t.files.get(done.assets[0]!.path))).toMatch(/^VIDEO SIMULADO/);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({
      status: 'succeeded',
      usage: { seconds: 10 },
      provider_request_id: 'sim-video-1',
      output: { assets: [{ kind: 'video', path: done.assets[0]!.path }], untested_adapter: true },
    });
    expect(Number(row!.cost_micros)).toBe(1_000_000);
    expect(await committed(t.org)).toBe(1_000_000);
    expect((await jobs(t.org))[0]).toMatchObject({ status: 'succeeded', result: { status: 'completed' } });
  });

  it('se cobra por los segundos realmente generados, no por los pedidos', async () => {
    const t = await setup(2_000_000, { video: { pollsUntilDone: 0, reportSeconds: 8 } });
    await t.generate(VIDEO);
    const done = await t.service.processJob(await claim(), 'trabajador-1');
    expect(done).toMatchObject({ status: 'completed', costMicros: 800_000 });
    expect((await generations(t.org))[0]).toMatchObject({ usage: { seconds: 8 } });
    expect(await committed(t.org)).toBe(800_000);
  });

  it('con el cupo agotado no se lanza el vídeo ni se encola nada', async () => {
    const t = await setup(999_999);
    expect((await aiError(t.generate(VIDEO))).code).toBe('quota_exhausted');
    expect(t.video.calls).toEqual([]);
    expect(await jobs(t.org)).toEqual([]);

    // Un vídeo en curso retiene su reserva: el siguiente no cabe aunque aún no haya coste.
    const justo = await setup(1_500_000);
    await justo.generate(VIDEO);
    expect((await aiError(justo.generate(VIDEO))).code).toBe('quota_exhausted');
    expect(justo.video.calls).toHaveLength(1);
  });

  it('si el proveedor falla el trabajo, la reserva se devuelve', async () => {
    const t = await setup(2_000_000, { video: { pollsUntilDone: 0, finishWith: 'failed' } });
    const pending = await t.generate(VIDEO);
    expect(await t.service.processJob(await claim(), 'trabajador-1')).toEqual({
      status: 'failed',
      generationId: pending.generationId,
      code: 'provider_error',
    });
    expect((await generations(t.org))[0]).toMatchObject({
      status: 'failed',
      error_code: 'provider_error',
      cost_micros: null,
    });
    expect(await committed(t.org)).toBe(0);
    expect((await jobs(t.org))[0]).toMatchObject({ status: 'failed' });
  });

  it('un trabajo que nunca termina se abandona al pasar el tiempo máximo', async () => {
    let clock = Date.now();
    const t = await setup(2_000_000, {
      video: { pollsUntilDone: Infinity },
      service: { asyncDeadlineSeconds: 600, now: () => clock },
    });
    const pending = await t.generate(VIDEO);
    expect((await t.service.processJob(await claim(), 'trabajador-1')).status).toBe('pending');

    clock += 601_000;
    expect(await t.service.processJob(await claim(), 'trabajador-1')).toEqual({
      status: 'failed',
      generationId: pending.generationId,
      code: 'never_finished',
    });
    expect(t.video.cancelled).toEqual(['sim-video-1']); // se avisa al proveedor
    expect((await generations(t.org))[0]).toMatchObject({ status: 'failed', error_code: 'never_finished' });
    expect(await committed(t.org)).toBe(0);
    expect((await jobs(t.org))[0]).toMatchObject({ status: 'failed' });
  });

  it('…y también al agotar los intentos de consulta', async () => {
    const t = await setup(2_000_000, { video: { pollsUntilDone: Infinity }, service: { maxPollAttempts: 2 } });
    await t.generate(VIDEO);
    expect((await t.service.processJob(await claim(), 'trabajador-1')).status).toBe('pending');
    expect(await t.service.processJob(await claim(), 'trabajador-1')).toMatchObject({
      status: 'failed',
      code: 'never_finished',
    });
    expect(t.video.polls.get('sim-video-1')).toBe(2);
    expect(await committed(t.org)).toBe(0);
    expect((await jobs(t.org))[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('un límite de uso al consultar no da el trabajo por perdido: se vuelve a consultar', async () => {
    let fail = true;
    const t = await setup(2_000_000, {
      video: { pollsUntilDone: 0 },
      wrapVideo: (provider) => ({
        ...provider,
        poll: (job, model, signal) =>
          fail
            ? Promise.reject(new MediaProviderFailure('rate_limited', 'Límite de uso (HTTP 429)', { retryable: true }))
            : provider.poll!(job, model, signal),
      }),
    });
    await t.generate(VIDEO);
    expect((await t.service.processJob(await claim(), 'trabajador-1')).status).toBe('pending');
    expect((await generations(t.org))[0]).toMatchObject({ status: 'reserved' });
    expect((await jobs(t.org))[0]).toMatchObject({
      status: 'queued',
      last_error: expect.stringMatching(/Límite de uso/),
    });

    fail = false;
    expect((await t.service.processJob(await claim(), 'trabajador-1')).status).toBe('completed');
  });

  it('varios sondeos en la misma reclamación', async () => {
    const t = await setup(2_000_000, { video: { pollsUntilDone: 2 }, service: { pollsPerClaim: 3 } });
    await t.generate(VIDEO);
    expect((await t.service.processJob(await claim(), 'trabajador-1')).status).toBe('completed');
    expect(t.video.polls.get('sim-video-1')).toBe(3);
  });
});

describe('webhook', () => {
  it('cierra la generación; repetido no hace nada, y el sondeo posterior tampoco', async () => {
    const t = await setup(2_000_000, { video: { pollsUntilDone: Infinity } });
    const pending = await t.generate(VIDEO);
    const webhook = t.video.webhookFor('sim-video-1', 'completed');

    expect(await t.service.handleWebhook('simulated-video', pending.generationId, webhook)).toEqual({
      status: 'completed',
      generationId: pending.generationId,
    });
    expect((await generations(t.org))[0]).toMatchObject({ status: 'succeeded', usage: { seconds: 10 } });
    expect(await committed(t.org)).toBe(1_000_000);
    expect(t.puts()).toBe(1);

    // El mismo aviso otra vez (los proveedores reintentan): ni se guarda ni se cobra de nuevo.
    for (let i = 0; i < 2; i += 1) {
      expect(await t.service.handleWebhook('simulated-video', pending.generationId, webhook)).toEqual({
        status: 'duplicate',
        generationId: pending.generationId,
      });
    }
    expect(t.puts()).toBe(1);
    expect(await committed(t.org)).toBe(1_000_000);
    const entries = await db.query(`select entry from public.ai_usage where generation_id = $1 order by id`, [
      pending.generationId,
    ]);
    expect(entries.map((e) => e.entry)).toEqual(['reserve', 'settle']);

    // El trabajo de sondeo que quedaba en la cola encuentra la generación cerrada.
    expect(await t.service.processJob(await claim(), 'trabajador-1')).toEqual({
      status: 'already_closed',
      generationId: pending.generationId,
    });
    expect(t.video.polls.get('sim-video-1')).toBe(0);
    expect((await jobs(t.org))[0]).toMatchObject({ status: 'succeeded', result: { status: 'already_closed' } });
  });

  it('un aviso de fallo devuelve la reserva; repetido no hace nada', async () => {
    const t = await setup(2_000_000);
    const pending = await t.generate(VIDEO);
    const webhook = t.video.webhookFor('sim-video-1', 'failed');
    expect((await t.service.handleWebhook('simulated-video', pending.generationId, webhook)).status).toBe('failed');
    expect((await t.service.handleWebhook('simulated-video', pending.generationId, webhook)).status).toBe('duplicate');
    expect((await generations(t.org))[0]).toMatchObject({ status: 'failed', error_code: 'provider_error' });
    expect(await committed(t.org)).toBe(0);
  });

  it('sin firma válida, o de otro trabajo, no se cree', async () => {
    const t = await setup(2_000_000);
    const pending = await t.generate(VIDEO);
    const good = t.video.webhookFor('sim-video-1', 'completed');

    await expect(
      t.service.handleWebhook('simulated-video', pending.generationId, { ...good, headers: {} }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    // Aviso auténtico, pero de un trabajo que no es el de esta generación.
    await expect(
      t.service.handleWebhook('simulated-video', pending.generationId, t.video.webhookFor('sim-video-99', 'completed')),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    // Generación que no existe, o de otro proveedor.
    await expect(
      t.service.handleWebhook('simulated-video', '00000000-0000-0000-0000-000000000000', good),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    expect((await aiError(t.service.handleWebhook('simulated-image', pending.generationId, good))).code).toBe(
      'not_configured',
    );

    expect((await generations(t.org))[0]).toMatchObject({ status: 'reserved' });
    expect(t.puts()).toBe(0);
  });
});

describe('elección de modelo', () => {
  const image = createSimulatedImageProvider();
  const base = (extra: Partial<MediaServiceConfig>) =>
    createMediaService({
      rpc,
      reader,
      storage: { put: async () => ({ path: 'x' }) },
      fetch: () => Promise.reject(new Error('sin red')),
      providers: { providers: [image], unavailable: [] },
      models,
      ...extra,
    });

  it('por defecto solo se eligen solos los modelos que procesan en la UE', () => {
    // «sim-image-us» tiene más prioridad, pero no es de la UE.
    expect(base({}).estimate(IMAGE)).toMatchObject({ model: 'sim-image-1', dataHandling: { euProcessing: true } });
    expect(base({ selection: { allowNonEu: true } }).estimate(IMAGE)).toMatchObject({
      model: 'sim-image-us',
      costMicros: 20_000,
      dataHandling: { dataRegion: 'us', euProcessing: false, trainsOnInputs: 'yes' },
    });
  });

  it('un modelo fuera de la UE se puede fijar a propósito, y va marcado', () => {
    const service = base({ selection: { preferred: { image: 'simulated-image:sim-image-us' } } });
    expect(service.estimate(IMAGE).dataHandling).toMatchObject({ euProcessing: false, trainsOnInputs: 'yes' });
  });

  it('el precio por megapíxel redondea hacia arriba y distingue el primero', () => {
    const service = base({ selection: { preferred: { image: 'simulated-image:sim-image-mp' } } });
    // 1080×1350 = 1,46 MP → 2 MP: 30 000 el primero + 15 000 el segundo.
    expect(service.estimate(IMAGE)).toMatchObject({ usage: { megapixels: 2 }, costMicros: 45_000 });
  });

  it('sin adaptador disponible lo dice con claridad', () => {
    const sinClave = base({
      providers: {
        providers: [image],
        unavailable: [{ id: 'simulated-video', reason: 'falta la variable CLAVE_DE_VIDEO' }],
      },
    });
    expect(() => sinClave.estimate(VIDEO)).toThrow(/falta la variable CLAVE_DE_VIDEO/);
    expect(() => base({ selection: { preferred: { image: 'otro:modelo' } } }).estimate(IMAGE)).toThrow(
      /no está en el registro de modelos/,
    );
    const soloFueraDeLaUe = base({ models: models.filter((m) => m.dataRegion !== 'eu') });
    expect(() => soloFueraDeLaUe.estimate(IMAGE)).toThrow(/ninguno procesa los datos en la UE/);
    expect(() => base({ models: [] }).estimate(IMAGE)).toThrow(/No hay ningún modelo de imagen activo/);
  });

  it('las filas sembradas por la migración están inactivas y no se eligen', () => {
    const seeded = models.filter((m) => !m.provider.startsWith('simulated'));
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.filter((m) => m.active)).toEqual([]);
    expect(() => base({ models: seeded, selection: { allowNonEu: true } }).estimate(IMAGE)).toThrow(/ningún modelo/);
  });
});

describe('de extremo a extremo con un adaptador de verdad y HTTP simulado', () => {
  const KLING = 'kling-video/v3.0/std/image-to-video';

  it('Higgsfield: reserva, lanza, sondea, descarga el vídeo a nuestro almacenamiento y cobra los segundos', async () => {
    n += 1;
    const owner = await createUser(db, `propietaria${n}@medios${n}.test`);
    const org = await createOrg(db, owner, `Organización ${n}`);
    const brand = await createBrand(db, owner, org, `Marca ${n}`);
    await setAiQuota(db, root, org, 1_000_000);

    const requests: string[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      requests.push(`${init.method ?? 'GET'} ${url}`);
      if (url === `https://api.higgsfield.ai/${KLING}`) {
        return Response.json({
          status: 'queued',
          request_id: 'req-1',
          status_url: 'https://api.higgsfield.ai/requests/req-1/status',
          cancel_url: 'https://api.higgsfield.ai/requests/req-1/cancel',
        });
      }
      if (url === 'https://api.higgsfield.ai/requests/req-1/status') {
        return Response.json({
          status: 'completed',
          request_id: 'req-1',
          video: { url: 'https://cdn.higgsfield.test/out.mp4' },
        });
      }
      if (url === 'https://cdn.higgsfield.test/out.mp4') {
        return new Response(Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112), {
          headers: { 'content-type': 'video/mp4' },
        });
      }
      return new Response('{}', { status: 404 });
    };
    const files = new Map<string, Uint8Array>();
    // La fila sembrada está inactiva y con el precio sin verificar: aquí se
    // activa solo en memoria, con un precio de prueba.
    const seeded = models.find((m) => m.provider === 'higgsfield' && m.model === KLING)!;
    const service = createMediaService({
      rpc,
      reader,
      storage: {
        put: async (object) => {
          const path = `${object.organizationId}/${object.brandId}/generated/${object.generationId}-${object.index}`;
          files.set(path, object.bytes);
          return { path };
        },
      },
      fetch,
      providers: {
        providers: [createHiggsfieldVideoProvider({ keyId: 'id', keySecret: 'secreto', fetch })],
        unavailable: [],
      },
      models: [{ ...seeded, active: true, priceVerified: true, priceMicros: 100_000 }],
      // No procesa en la UE: solo se usa porque se fija a propósito.
      selection: { preferred: { video: `higgsfield:${KLING}` } },
      pollIntervalMs: 0,
    });

    const pending = await service.generate({
      userId: owner.id,
      brandId: brand,
      purpose: 'reel.clip',
      request: { ...VIDEO, durationSeconds: 5 },
    });
    expect(pending).toMatchObject({
      status: 'pending',
      provider: 'higgsfield',
      estimatedCostMicros: 500_000,
      euProcessing: false,
      trainsOnInputs: 'yes',
      untestedAdapter: true,
    });
    expect(await committed(org)).toBe(500_000);

    const done = await service.processJob(await claim(), 'trabajador-1');
    if (done.status !== 'completed') throw new Error(`Se esperaba terminado y es ${done.status}`);
    expect(done.assets).toEqual([{ kind: 'video', path: done.assets[0]!.path, mimeType: 'video/mp4', bytes: 8 }]);
    expect([...files.get(done.assets[0]!.path)!]).toEqual([0, 0, 0, 24, 102, 116, 121, 112]);
    expect(requests).toEqual([
      `POST https://api.higgsfield.ai/${KLING}`,
      'GET https://api.higgsfield.ai/requests/req-1/status',
      'GET https://cdn.higgsfield.test/out.mp4',
    ]);

    const [row] = await generations(org);
    expect(row).toMatchObject({
      status: 'succeeded',
      provider: 'higgsfield',
      model: KLING,
      usage: { seconds: 5 },
      provider_request_id: 'req-1',
      output: { data_region: 'unknown', trains_on_inputs: 'yes', untested_adapter: true },
    });
    expect(Number(row!.cost_micros)).toBe(500_000);
    expect(await committed(org)).toBe(500_000);
  });
});
