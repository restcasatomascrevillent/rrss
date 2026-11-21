// Flujo completo del servicio de IA con el proveedor simulado y la base de
// datos real (migraciones aplicadas):
//   pedir → reservar cupo → generar → registrar resultado y coste
// y lo que pasa cuando algo falla por el camino.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiError,
  AiProviderFailure,
  type AiGenerateParams,
  type AiModelSpec,
  type RpcClient,
} from '../../supabase/functions/_shared/ai/contract.ts';
import { createAiService, priceUsage } from '../../supabase/functions/_shared/ai/service.ts';
import {
  createSimulatedProvider,
  SIMULATED_PROVIDER_ID,
  type SimulatedProviderOptions,
} from '../../supabase/functions/_shared/ai/simulated-provider.ts';
import {
  createBrand,
  createDb,
  createOrg,
  createUser,
  join,
  serviceRpc,
  setAiQuota,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

// Precios inventados para las pruebas, en millonésimas por unidad.
const MODELS: AiModelSpec[] = [
  {
    provider: SIMULATED_PROVIDER_ID,
    model: 'sim-text-1',
    task: 'text',
    microsPerUnit: { input_tokens: 3, output_tokens: 15 },
  },
  { provider: SIMULATED_PROVIDER_ID, model: 'sim-image-1', task: 'image', microsPerUnit: { images: 40_000 } },
];

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

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@plataforma.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
});

afterAll(async () => {
  await db?.close();
});

/** Organización nueva con su marca, su cupo y un servicio con el proveedor simulado. */
async function setup(
  limitMicros: number | null,
  options: SimulatedProviderOptions & { timeoutMs?: number; models?: AiModelSpec[]; rpc?: RpcClient } = {},
) {
  n += 1;
  const owner = await createUser(db, `propietaria${n}@org${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  if (limitMicros !== null) await setAiQuota(db, root, org, limitMicros);

  const provider = createSimulatedProvider(options);
  const service = createAiService({
    rpc: options.rpc ?? rpc,
    providers: [provider],
    models: options.models ?? MODELS,
    timeoutMs: options.timeoutMs,
  });
  const request = (extra: Partial<AiGenerateParams> = {}): AiGenerateParams => ({
    userId: owner.id,
    brandId: brand,
    task: 'text',
    purpose: 'post.caption',
    input: {
      instructions: 'Escribe un pie de foto.',
      prompt: 'Nueva carta de otoño',
      context: [{ label: 'perfil de marca', content: 'Tono cercano, sin emojis.' }],
      params: { max_output_tokens: 100 },
    },
    ...extra,
  });
  return { owner, org, brand, provider, service, request };
}

const generations = (org: string) =>
  db.query<Row>(`select * from public.ai_generations where organization_id = $1 order by created_at`, [org]);

async function committed(org: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `select coalesce(sum(reserved_delta_micros + cost_delta_micros), 0)::int as n from public.ai_usage where organization_id = $1`,
    [org],
  );
  return row!.n;
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

describe('generación correcta', () => {
  it('reserva cupo, genera y registra el resultado y su coste', async () => {
    const t = await setup(100_000);
    const result = await t.service.generate(t.request());

    // Entrada: 6 + 5 + 7 tokens (4 caracteres por token). Salida: «[simulado] Nueva carta de otoño» = 8.
    expect(result.usage).toEqual({ input_tokens: 18, output_tokens: 8 });
    expect(result.costMicros).toBe(18 * 3 + 8 * 15);
    expect(result).toMatchObject({
      output: { simulated: true, text: '[simulado] Nueva carta de otoño' },
      provider: SIMULATED_PROVIDER_ID,
      model: 'sim-text-1',
    });

    const [row] = await generations(t.org);
    expect(row).toMatchObject({
      id: result.generationId,
      brand_id: t.brand,
      requested_by: t.owner.id,
      task: 'text',
      purpose: 'post.caption',
      provider: SIMULATED_PROVIDER_ID,
      model: 'sim-text-1',
      status: 'succeeded',
      usage: { input_tokens: 18, output_tokens: 8 },
      output: { simulated: true, text: '[simulado] Nueva carta de otoño' },
      provider_request_id: 'sim-1',
      error_code: null,
    });
    expect(Number(row!.cost_micros)).toBe(174);
    expect(row!.latency_ms).toBeGreaterThanOrEqual(0);
    // Se reservó la cota superior (18 de entrada + 100 de salida) y solo cuenta el coste real.
    expect(Number(row!.reserved_micros)).toBe(18 * 3 + 100 * 15);
    expect(await committed(t.org)).toBe(174);

    // El material del cliente llega al adaptador separado de las instrucciones.
    expect(t.provider.calls).toHaveLength(1);
    expect(t.provider.calls[0]!.input.instructions).toBe('Escribe un pie de foto.');
    expect(t.provider.calls[0]!.input.context).toEqual([
      { label: 'perfil de marca', content: 'Tono cercano, sin emojis.' },
    ]);
  });

  it('cada tarea usa su modelo y sus unidades', async () => {
    const t = await setup(1_000_000);
    const result = await t.service.generate(
      t.request({ task: 'image', purpose: 'post.visual', input: { prompt: 'Mesa de otoño', params: { count: 2 } } }),
    );
    expect(result).toMatchObject({ model: 'sim-image-1', usage: { images: 2 }, costMicros: 80_000 });
    expect(await committed(t.org)).toBe(80_000);
  });

  it('el coste de varias generaciones se acumula en el cupo de su organización', async () => {
    const t = await setup(400);
    await t.service.generate(t.request({ input: { prompt: 'Uno', params: { max_output_tokens: 10 } } }));
    await t.service.generate(t.request({ input: { prompt: 'Dos', params: { max_output_tokens: 10 } } }));
    const rows = await generations(t.org);
    expect(rows.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(await committed(t.org)).toBe(rows.reduce((sum, r) => sum + Number(r.cost_micros), 0));
  });
});

describe('cupo', () => {
  it('con el cupo agotado no se llama al proveedor y el mensaje lo explica', async () => {
    const t = await setup(1000); // la petición necesita reservar 1554
    const error = await aiError(t.service.generate(t.request()));
    expect(error.code).toBe('quota_exhausted');
    expect(error.message).toBe(
      'El cupo de IA de este mes está agotado: no queda saldo suficiente para esta generación',
    );
    expect(error.details).toMatchObject({ limit_micros: 1000, committed_micros: 0, requested_micros: 1554 });
    expect(error.retryable).toBe(false);

    expect(t.provider.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);
    expect(await committed(t.org)).toBe(0);
  });

  it('se agota al gastarlo: la siguiente generación ya no sale', async () => {
    const t = await setup(1700);
    await t.service.generate(t.request()); // gasta 174; quedan 1526 y hacen falta 1554
    expect((await aiError(t.service.generate(t.request()))).code).toBe('quota_exhausted');
    expect(t.provider.calls).toHaveLength(1);
  });

  it('sin cupo asignado no se genera', async () => {
    const t = await setup(null);
    const error = await aiError(t.service.generate(t.request()));
    expect(error.code).toBe('quota_missing');
    expect(error.message).toMatch(/no tiene cupo de IA asignado/);
    expect(t.provider.calls).toEqual([]);
  });

  it('quien no puede crear contenido en la marca no genera', async () => {
    const t = await setup(100_000);
    const cliente = await createUser(db, `cliente${n}@org${n}.test`);
    await join(db, t.owner, cliente, t.org, 'member', t.brand, 'client');
    const error = await aiError(t.service.generate(t.request({ userId: cliente.id })));
    expect(error.code).toBe('forbidden');
    expect(t.provider.calls).toEqual([]);
    expect(await committed(t.org)).toBe(0);
  });
});

describe('fallos del proveedor', () => {
  it('un fallo del proveedor no consume cupo y queda registrado', async () => {
    const t = await setup(2000, {
      failWith: (_request, call) =>
        call === 1 ? new AiProviderFailure('rate_limited', 'Demasiadas peticiones', { retryable: true }) : null,
    });
    const error = await aiError(t.service.generate(t.request()));
    expect(error).toMatchObject({ code: 'provider_failed', retryable: true });
    expect(error.message).toMatch(/No se ha consumido cupo/);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({
      id: error.generationId,
      status: 'failed',
      cost_micros: null,
      error_code: 'rate_limited',
      error_message: 'Demasiadas peticiones',
    });
    expect(await committed(t.org)).toBe(0);

    // El cupo (2000) solo da para una reserva de 1554: si el fallo la hubiera
    // retenido, este reintento no saldría.
    const retry = await t.service.generate(t.request());
    expect(retry.costMicros).toBe(174);
    expect(await committed(t.org)).toBe(174);
  });

  it('de un error inesperado no se guarda el mensaje (puede llevar secretos)', async () => {
    const t = await setup(100_000, {
      failWith: () => new Error('401 con cabecera Authorization: Bearer clave-secreta'),
    });
    const error = await aiError(t.service.generate(t.request()));
    expect(error).toMatchObject({ code: 'provider_failed', retryable: false });
    expect(error.message).not.toMatch(/clave-secreta/);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({ status: 'failed', error_code: 'unexpected' });
    expect(JSON.stringify(row)).not.toMatch(/clave-secreta/);
    expect(await committed(t.org)).toBe(0);
  });

  it('si el proveedor tarda demasiado se corta, sin consumir cupo', async () => {
    const t = await setup(100_000, { delayMs: 2000, timeoutMs: 40 });
    const error = await aiError(t.service.generate(t.request()));
    expect(error).toMatchObject({ code: 'provider_timeout', retryable: true });
    expect(t.provider.calls[0]!.signal.aborted).toBe(true);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({ status: 'failed', error_code: 'timeout' });
    expect(await committed(t.org)).toBe(0);
  });
});

describe('configuración y registro', () => {
  it('sin modelo configurado para la tarea no se reserva ni se llama', async () => {
    const t = await setup(100_000);
    const error = await aiError(t.service.generate(t.request({ task: 'video' })));
    expect(error.code).toBe('not_configured');
    expect(t.provider.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);

    // Tampoco si el modelo apunta a un adaptador que no está cargado.
    const sinAdaptador = await setup(100_000, {
      models: [{ provider: 'otro', model: 'x', task: 'text', microsPerUnit: { input_tokens: 1, output_tokens: 1 } }],
    });
    expect((await aiError(sinAdaptador.service.generate(sinAdaptador.request()))).code).toBe('not_configured');
  });

  it('un modelo sin precio completo no se usa: sin precio no hay reserva', async () => {
    const t = await setup(100_000, {
      models: [
        { provider: SIMULATED_PROVIDER_ID, model: 'sim-text-1', task: 'text', microsPerUnit: { input_tokens: 3 } },
      ],
    });
    const error = await aiError(t.service.generate(t.request()));
    expect(error.code).toBe('not_configured');
    expect(error.details).toMatchObject({ unpriced: ['output_tokens'] });
    expect(t.provider.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);
  });

  it('si el proveedor declara una unidad sin precio se cobra lo reservado, no cero', async () => {
    const t = await setup(100_000, { reportUsage: (usage) => ({ ...usage, cached_tokens: 50 }) });
    const result = await t.service.generate(t.request());
    expect(result.costMicros).toBe(1554);
    expect(await committed(t.org)).toBe(1554);
  });

  it('si no se puede registrar el resultado no se entrega, y la reserva sigue contando', async () => {
    const t = await setup(100_000, {
      rpc: (fn, args) =>
        fn === 'ai_complete_generation' ? Promise.reject(new Error('conexión perdida')) : rpc(fn, args),
    });
    const error = await aiError(t.service.generate(t.request()));
    expect(error).toMatchObject({ code: 'internal', retryable: true });
    expect(t.provider.calls).toHaveLength(1);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({ id: error.generationId, status: 'reserved' });
    expect(await committed(t.org)).toBe(1554);
  });

  it('si la base de datos no responde al reservar, no se llama al proveedor', async () => {
    const t = await setup(100_000, { rpc: () => Promise.reject(new Error('sin red')) });
    const error = await aiError(t.service.generate(t.request()));
    expect(error).toMatchObject({ code: 'internal', retryable: true });
    expect(t.provider.calls).toEqual([]);
  });
});

describe('precio de un consumo', () => {
  const spec = MODELS[0]!;

  it('multiplica cada unidad por su precio y redondea hacia arriba', () => {
    expect(priceUsage(spec, { input_tokens: 10, output_tokens: 2 })).toEqual({ micros: 60, unpriced: [] });
    const fraccion = { ...spec, microsPerUnit: { input_tokens: 0.15 } };
    expect(priceUsage(fraccion, { input_tokens: 7 })).toEqual({ micros: 2, unpriced: [] }); // 1,05 → 2
    expect(priceUsage(spec, {})).toEqual({ micros: 0, unpriced: [] });
  });

  it('señala las unidades sin precio o con cantidades imposibles', () => {
    expect(priceUsage(spec, { input_tokens: 1, seconds: 3 }).unpriced).toEqual(['seconds']);
    expect(priceUsage(spec, { input_tokens: -1, output_tokens: Number.NaN }).unpriced).toEqual([
      'input_tokens',
      'output_tokens',
    ]);
    // Una unidad desconocida a cero no molesta.
    expect(priceUsage(spec, { seconds: 0 })).toEqual({ micros: 0, unpriced: [] });
  });
});
