// OpenAI como proveedor de IMAGEN (supabase/functions/_shared/ai/media/openai-image.ts).
//
// `fetch` es un doble con la forma que la documentación oficial (consultada el
// 20/11/2026) dice que tienen las respuestas: ninguna prueba llama a OpenAI.
// Con servicio real NO se ha probado nada. Las de catálogo y precios usan las
// migraciones reales.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MediaProviderFailure,
  type ImageEditRequest,
  type ImageRequest,
  type MediaModel,
} from '../../supabase/functions/_shared/ai/media/contract.ts';
import { createMediaProviders } from '../../supabase/functions/_shared/ai/media/config.ts';
import type { FetchLike } from '../../supabase/functions/_shared/ai/media/http.ts';
import {
  createOpenAiImageProvider,
  editPromptFor,
  openAiImageSize,
} from '../../supabase/functions/_shared/ai/media/openai-image.ts';
import {
  mediaModelsFromRows,
  priceMediaUsage,
  resolveEditModel,
  resolveMediaModel,
  type MediaModelRow,
} from '../../supabase/functions/_shared/ai/media/models.ts';
import { createMediaRuntime } from '../../supabase/functions/_shared/ai/media/runtime.ts';
import { simulatedPng } from '../../supabase/functions/_shared/ai/media/simulated.ts';
import { probeIntegration } from '../../supabase/functions/_shared/integrations/probes.ts';
import { createDb, type Db, type Row } from './helpers';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(route: (call: Call, index: number) => { status?: number; json?: unknown; bytes?: Uint8Array }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    let body: unknown = init.body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ url, method: init.method ?? 'GET', headers, body });
    const reply = route(calls[calls.length - 1]!, calls.length);
    return new Response(reply.bytes ?? JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  };
  return { fetch, calls };
}

const PNG = simulatedPng('openai');
const answer = (extra: Record<string, unknown> = {}) => ({
  json: { created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }], usage: { input_tokens: 10 }, ...extra },
});

const model = (extra: Partial<MediaModel> = {}): MediaModel => ({
  provider: 'openai',
  model: 'gpt-image-2.5-sunburst',
  kind: 'image',
  displayName: 'OpenAI',
  billingUnit: 'megapixel',
  priceMicros: 70_000,
  priceDetails: { first_unit_micros: 73_000, input_megapixel_micros: 14_000 },
  priceVerified: true,
  dataRegion: 'global',
  trainsOnInputs: 'no',
  delivery: 'sync',
  operation: 'replace_background',
  settings: { quality: 'medium', output_format: 'jpeg', size_mode: 'custom', max_input_megapixels: 4 },
  priority: 0,
  active: true,
  ...extra,
});

const MASK = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const background = (extra: Partial<ImageEditRequest> = {}): ImageEditRequest => ({
  kind: 'image_edit',
  operation: 'replace_background',
  source: {
    mimeType: 'image/jpeg',
    width: 4000,
    height: 3000,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 9]),
  },
  prompt: 'mesa de mármol blanco con luz cálida',
  ...extra,
});

const signal = () => new AbortController().signal;
const run = (provider: ReturnType<typeof createOpenAiImageProvider>, request: ImageEditRequest | ImageRequest, m: MediaModel) =>
  provider.start({ request, model: m, idempotencyKey: 'g1', signal: signal() });

async function failure(promise: Promise<unknown>): Promise<MediaProviderFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaProviderFailure) return error;
    throw error;
  }
  throw new Error('Se esperaba un fallo del adaptador');
}

describe('OpenAI imagen (HTTP simulado)', () => {
  it('cambiar el fondo: multipart a /v1/images/edits con foto, máscara, prompt de protección y cabeceras', async () => {
    const http = fakeFetch(() => answer());
    const provider = createOpenAiImageProvider({
      apiKey: 'clave-openai',
      organization: 'org-x',
      project: 'proj_x',
      fetch: http.fetch,
    });
    const result = await run(provider, background({ subjectMask: { mimeType: 'image/png', bytes: MASK } }), model());
    expect(result).toMatchObject({ status: 'completed', outputs: [{ mimeType: 'image/jpeg' }] });
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/images/edits');
    expect(call.headers).toMatchObject({
      authorization: 'Bearer clave-openai',
      'openai-organization': 'org-x',
      'openai-project': 'proj_x',
    });
    // Sin Content-Type: lo pone fetch con el delimitador.
    expect(call.headers['content-type']).toBeUndefined();
    const form = call.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(form.get('quality')).toBe('medium');
    expect(form.get('n')).toBe('1');
    expect(form.get('output_format')).toBe('jpeg');
    expect(form.get('background')).toBeNull();
    // 4000×3000 se pide a ~1,5 MP con la misma proporción y lados múltiplos de 16.
    expect(form.get('size')).toBe('1456x1088');
    expect(form.get('input_fidelity')).toBeNull();
    const prompt = String(form.get('prompt'));
    expect(prompt).toContain('mesa de mármol blanco con luz cálida');
    expect(prompt).toMatch(/Keep the food and the dish/);
    expect(prompt).toMatch(/opaque area of the mask is the dish/);
    const image = form.get('image') as File;
    expect(image.type).toBe('image/jpeg');
    expect(image.name).toBe('foto-1.jpg');
    const mask = form.get('mask') as File;
    expect(mask.type).toBe('image/png');
    expect(new Uint8Array(await mask.arrayBuffer())).toEqual(MASK);
  });

  it('sin máscara no manda `mask` y el prompt no habla de ella', async () => {
    const http = fakeFetch(() => answer());
    const provider = createOpenAiImageProvider({ apiKey: 'k', fetch: http.fetch });
    await run(provider, background(), model());
    const form = http.calls[0]!.body as FormData;
    expect(form.get('mask')).toBeNull();
    expect(String(form.get('prompt'))).not.toMatch(/mask/);
  });

  it('quitar el fondo pide fondo transparente en PNG; mejorar no lleva fondo ni descripción', async () => {
    const http = fakeFetch(() => answer());
    const provider = createOpenAiImageProvider({ apiKey: 'k', fetch: http.fetch });
    const quitar = await run(
      provider,
      background({ operation: 'remove_background', prompt: undefined }),
      model({ operation: 'remove_background' }),
    );
    expect(quitar).toMatchObject({ outputs: [{ mimeType: 'image/png' }] });
    const form = http.calls[0]!.body as FormData;
    expect(form.get('background')).toBe('transparent');
    expect(form.get('output_format')).toBe('png');
    await run(provider, background({ operation: 'enhance', prompt: undefined }), model({ operation: 'enhance' }));
    const enhance = http.calls[1]!.body as FormData;
    expect(enhance.get('background')).toBeNull();
    expect(String(enhance.get('prompt'))).toMatch(/lighting and colour/);
  });

  it('generar sin referencias va por /v1/images/generations en JSON; con referencias, por /edits', async () => {
    const http = fakeFetch(() => answer());
    const provider = createOpenAiImageProvider({ apiKey: 'k', fetch: http.fetch });
    const generate = model({ model: 'gpt-image-2.5-flare', operation: 'generate' });
    await run(provider, { kind: 'image', prompt: 'Un chuletón', aspectRatio: '4:5', size: { width: 1024, height: 1280 } }, generate);
    const first = http.calls[0]!;
    expect(first.url).toBe('https://api.openai.com/v1/images/generations');
    expect(first.headers['content-type']).toBe('application/json');
    expect(first.body).toMatchObject({ model: 'gpt-image-2.5-flare', prompt: 'Un chuletón', n: 1, quality: 'medium' });
    expect((first.body as { size: string }).size).toMatch(/^\d+x\d+$/);
    await run(
      provider,
      {
        kind: 'image',
        prompt: 'Como esta',
        aspectRatio: '1:1',
        size: { width: 1024, height: 1024 },
        references: [
          { mimeType: 'image/png', bytes: new Uint8Array([1]) },
          { mimeType: 'image/png', bytes: new Uint8Array([2]) },
        ],
      },
      generate,
    );
    expect(http.calls[1]!.url).toBe('https://api.openai.com/v1/images/edits');
    expect((http.calls[1]!.body as FormData).getAll('image[]')).toHaveLength(2);
  });

  it('descarga la foto de su URL firmada cuando no llegan los bytes', async () => {
    const http = fakeFetch((call) =>
      call.url.startsWith('https://firmada.test/') ? { bytes: new Uint8Array([0xff, 0xd8, 1]) } : answer(),
    );
    const provider = createOpenAiImageProvider({ apiKey: 'k', fetch: http.fetch });
    await run(
      provider,
      background({ source: { mimeType: 'image/jpeg', width: 1200, height: 900, url: 'https://firmada.test/foto' } }),
      model(),
    );
    expect(http.calls.map((c) => c.url)).toEqual(['https://firmada.test/foto', 'https://api.openai.com/v1/images/edits']);
  });

  it('con el endpoint de la UE, la región es eu; si no, global; usa OPENAI_BASE_URL sin /v1', () => {
    const eu = createOpenAiImageProvider({ apiKey: 'k', baseUrl: 'https://eu.api.openai.com/v1/', fetch: fakeFetch(() => answer()).fetch });
    expect(eu.dataRegion).toBe('eu');
    expect(createOpenAiImageProvider({ apiKey: 'k', fetch: fakeFetch(() => answer()).fetch }).dataRegion).toBe('global');
  });

  it('tamaños: custom conserva proporción y múltiplos de 16; preset elige uno de los tres', () => {
    expect(openAiImageSize(4000, 3000)).toEqual({ width: 1456, height: 1088 });
    expect(openAiImageSize(3000, 4000)).toEqual({ width: 1088, height: 1456 });
    for (const [w, h] of [
      [200, 200],
      [10000, 100],
      [100, 10000],
      [1080, 1350],
    ] as const) {
      const out = openAiImageSize(w, h);
      expect(out.width % 16).toBe(0);
      expect(out.height % 16).toBe(0);
      expect(out.width * out.height).toBeGreaterThanOrEqual(655_360);
      expect(out.width * out.height).toBeLessThanOrEqual(8_294_400);
      expect(Math.max(out.width, out.height) / Math.min(out.width, out.height)).toBeLessThanOrEqual(3.01);
    }
    expect(openAiImageSize(4000, 3000, 'preset')).toEqual({ width: 1536, height: 1024 });
    expect(openAiImageSize(3000, 4000, 'preset')).toEqual({ width: 1024, height: 1536 });
    expect(openAiImageSize(1000, 1000, 'preset')).toEqual({ width: 1024, height: 1024 });
  });

  it('coste: cota por megapíxel de salida más la entrada (foto y máscara), con tope por imagen', () => {
    const provider = createOpenAiImageProvider({ apiKey: 'k', fetch: fakeFetch(() => answer()).fetch });
    const m = model();
    const sinMascara = provider.estimateUsage(background(), m);
    expect(sinMascara).toEqual({ megapixels: 2, input_megapixels: 4 });
    const conMascara = provider.estimateUsage(background({ subjectMask: { mimeType: 'image/png', bytes: MASK } }), m);
    expect(conMascara).toEqual({ megapixels: 2, input_megapixels: 8 });
    // 73.000 (primer MP) + 70.000 (segundo) + 8 × 14.000.
    expect(priceMediaUsage(m, conMascara).micros).toBe(73_000 + 70_000 + 8 * 14_000);
    expect(priceMediaUsage(m, sinMascara)).toEqual({ micros: 73_000 + 70_000 + 4 * 14_000, unpriced: [] });
    // Una foto pequeña no paga el tope.
    const pequena = provider.estimateUsage(
      background({ source: { mimeType: 'image/jpeg', width: 800, height: 600, bytes: new Uint8Array(1) } }),
      m,
    );
    expect(pequena).toEqual({ megapixels: 1, input_megapixels: 1 });
    // Un modelo cobrado por imagen cuenta una.
    expect(provider.estimateUsage(background(), model({ billingUnit: 'image' }))).toEqual({ images: 1 });
  });

  it('errores: moderación, saldo, límite de uso, clave, caída y respuesta sin imagen', async () => {
    const provider = createOpenAiImageProvider({ apiKey: 'clave-secreta', fetch: fakeFetch(() => answer()).fetch });
    const withReply = (reply: { status?: number; json?: unknown }) =>
      createOpenAiImageProvider({ apiKey: 'clave-secreta', fetch: fakeFetch(() => reply).fetch });
    const m = model();
    expect(
      await failure(run(withReply({ status: 400, json: { error: { code: 'moderation_blocked', message: 'x' } } }), background(), m)),
    ).toMatchObject({ code: 'moderated' });
    expect(
      await failure(run(withReply({ status: 429, json: { error: { code: 'insufficient_quota', message: 'x' } } }), background(), m)),
    ).toMatchObject({ code: 'insufficient_credits' });
    expect(
      await failure(run(withReply({ status: 429, json: { error: { message: 'Rate limit' } } }), background(), m)),
    ).toMatchObject({ code: 'rate_limited', retryable: true });
    const auth = await failure(run(withReply({ status: 401, json: { error: { message: 'Incorrect API key' } } }), background(), m));
    expect(auth.code).toBe('auth');
    expect(auth.message).not.toContain('clave-secreta');
    expect(await failure(run(withReply({ status: 503 }), background(), m))).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    expect(await failure(run(withReply({ json: { data: [] } }), background(), m))).toMatchObject({ code: 'bad_response' });
    expect(await failure(run(provider, { kind: 'image', prompt: '', aspectRatio: '1:1', size: { width: 1, height: 1 } }, model({ model: 'a b' })))).toMatchObject({
      code: 'invalid_request',
    });
  });

  it('el prompt de cambiar el fondo siempre protege el plato', () => {
    expect(editPromptFor(background())).toMatch(/Do not add, remove, restyle or rearrange any food/);
  });
});

describe('OpenAI imagen · configuración y elección', () => {
  const env = (extra: Record<string, string> = {}) => ({ OPENAI_API_KEY: 'k', ...extra });
  const deps = { fetch: fakeFetch(() => answer()).fetch };

  it('se carga con la misma clave que el texto; sin clave o con dirección mala, dice por qué', () => {
    expect(createMediaProviders(env(), deps).providers.map((p) => p.id)).toContain('openai');
    const sin = createMediaProviders({}, deps);
    expect(sin.unavailable.find((u) => u.id === 'openai')?.reason).toBe('falta la variable OPENAI_API_KEY');
    const mala = createMediaProviders(env({ OPENAI_BASE_URL: 'http://api.openai.com' }), deps);
    expect(mala.providers.map((p) => p.id)).not.toContain('openai');
    expect(mala.unavailable.find((u) => u.id === 'openai')?.reason).toMatch(/https/);
  });

  const row = (operation: string, model = 'gpt-image-2.5-sunburst', priority = 0): MediaModelRow => ({
    provider: 'openai',
    model,
    task: 'image',
    operation,
    display_name: 'OpenAI',
    billing_unit: 'megapixel',
    price_micros: 70_000,
    price_details: { first_unit_micros: 73_000, input_megapixel_micros: 14_000 },
    price_verified: true,
    data_region: 'global',
    trains_on_inputs: 'no',
    delivery: 'sync',
    settings: {},
    priority,
    active: true,
  });
  const rows = [
    row('replace_background'),
    row('enhance'),
    row('remove_background', 'gpt-image-2.5-sunburst', -10),
    row('generate', 'gpt-image-2.5-flare'),
  ];

  it('fuera de la UE solo con AI_MEDIA_ALLOW_NON_EU; con él se ofrecen las tres ediciones y la generación', () => {
    const models = mediaModelsFromRows(rows);
    const availability = createMediaProviders(env(), deps);
    expect(() => resolveEditModel('replace_background', models, availability)).toThrow(/UE/);
    expect(resolveEditModel('replace_background', models, availability, { allowNonEu: true }).model.operation).toBe(
      'replace_background',
    );
    expect(resolveMediaModel('image', models, availability, { allowNonEu: true }).model.model).toBe('gpt-image-2.5-flare');
    const blocked = createMediaRuntime({
      env: env(),
      fetch: deps.fetch,
      rpc: async () => ({ data: null, error: null }),
      reader: { getGeneration: async () => null, getJob: async () => null },
      storage: { put: async () => ({ path: 'x' }) },
      modelRows: rows,
    });
    expect(blocked.editChoices).toEqual([]);
    expect(blocked.imageChoices).toEqual([]);
    const allowed = createMediaRuntime({
      env: env({ AI_MEDIA_ALLOW_NON_EU: 'true' }),
      fetch: deps.fetch,
      rpc: async () => ({ data: null, error: null }),
      reader: { getGeneration: async () => null, getJob: async () => null },
      storage: { put: async () => ({ path: 'x' }) },
      modelRows: rows,
    });
    expect(allowed.editChoices.map((c) => [c.operation, c.usesSubjectMask])).toEqual([
      ['remove_background', false],
      ['replace_background', true],
      ['enhance', false],
    ]);
    expect(allowed.imageChoices.map((c) => c.id)).toEqual(['openai:gpt-image-2.5-flare']);
    // Con el endpoint de la UE no hace falta permitir nada.
    const eu = createMediaRuntime({
      env: env({ OPENAI_BASE_URL: 'https://eu.api.openai.com' }),
      fetch: deps.fetch,
      rpc: async () => ({ data: null, error: null }),
      reader: { getGeneration: async () => null, getJob: async () => null },
      storage: { put: async () => ({ path: 'x' }) },
      modelRows: rows,
    });
    expect(eu.editChoices).toHaveLength(3);
    expect(eu.editChoices.every((c) => c.euProcessing)).toBe(true);
  });
});

describe('OpenAI imagen · probar conexión', () => {
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
  const text = {
    AI_TEXT_PROVIDER: 'openai',
    AI_TEXT_MODEL: 'gpt-x',
    OPENAI_API_KEY: 'clave-openai',
    OPENAI_BASE_URL: 'https://eu.api.openai.com',
    AI_PRICES: JSON.stringify({ 'openai/gpt-x': { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0.1 } }),
  };

  it('además de listar modelos, dice si la clave ve un modelo de imagen', async () => {
    const withImage = await probeIntegration('ai_text', text, {
      fetch: ok({ data: [{ id: 'gpt-x' }, { id: 'gpt-image-2.5-sunburst' }] }),
    });
    expect(withImage.checks.find((c) => c.name === 'OpenAI imagen')).toMatchObject({ ok: true });
    expect(JSON.stringify(withImage)).not.toContain('clave-openai');
    const without = await probeIntegration('ai_text', text, { fetch: ok({ data: [{ id: 'gpt-x' }] }) });
    const check = without.checks.find((c) => c.name === 'OpenAI imagen');
    expect(check).toMatchObject({ ok: null });
    expect(check?.message).toMatch(/verificar la organización/);
    expect(without.checks.find((c) => c.name === 'OpenAI')).toMatchObject({ ok: true });
  });
});

describe('catálogo de modelos de OpenAI (migración 20261202010000)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('un mismo modelo sirve a varias operaciones, con precio por megapíxel, región global y NACEN inactivos', async () => {
    const rows = await db.query<Row>(
      `select model, operation, billing_unit, price_micros, price_micros::int as price, delivery, price_details, price_verified, data_region,
              trains_on_inputs, active, priority, settings
       from public.ai_media_models where provider = 'openai' order by operation, model`,
    );
    expect(rows.map((r) => [r.operation, r.model, r.priority])).toEqual([
      ['enhance', 'gpt-image-2.5-sunburst', 0],
      ['generate', 'gpt-image-2.5-flare', 0],
      ['remove_background', 'gpt-image-2.5-sunburst', -10],
      ['replace_background', 'gpt-image-2.5-sunburst', 0],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        billing_unit: 'megapixel',
        price: 70_000,
        price_details: { first_unit_micros: 73_000, input_megapixel_micros: 14_000 },
        data_region: 'global',
        price_verified: false,
        active: false,
      });
    }
    // Los precios del registro se convierten en un modelo con coste calculable.
    const models = mediaModelsFromRows(rows.map((r) => ({ ...r, provider: 'openai', task: 'image' }) as unknown as MediaModelRow));
    expect(models).toHaveLength(4);
    expect(priceMediaUsage(models[0]!, { megapixels: 2, input_megapixels: 4 }).micros).toBe(73_000 + 70_000 + 56_000);
  });

  it('las operaciones nuevas se aceptan y las desconocidas, no; (proveedor, modelo, operación) es único', async () => {
    await expect(
      db.query(
        `insert into public.ai_media_models (provider, model, task, operation, display_name, billing_unit, price_micros,
           price_checked_on, price_source, data_region, trains_on_inputs, delivery)
         values ('x', 'm', 'image', 'pintar', 'M', 'image', 1, '2026-11-20', 's', 'eu', 'no', 'sync')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into public.ai_media_models (provider, model, task, operation, display_name, billing_unit, price_micros,
           price_checked_on, price_source, data_region, trains_on_inputs, delivery)
         values ('openai', 'gpt-image-2.5-sunburst', 'image', 'enhance', 'M', 'image', 1, '2026-11-20', 's', 'eu', 'no', 'sync')`,
      ),
    ).rejects.toThrow();
  });
});
