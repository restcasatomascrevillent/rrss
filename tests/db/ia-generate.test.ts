// Lógica de la Edge Function `ai-generate` (handler.ts) con la base de datos
// real y el proveedor simulado: sesión, permisos, cupo y las tres acciones.
// El perfil de marca se lee con la identidad del usuario, igual que hará la
// función desplegada (RLS).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiModelSpec, Json, RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { createAiService } from '../../supabase/functions/_shared/ai/service.ts';
import {
  createSimulatedProvider,
  SIMULATED_PROVIDER_ID,
  type SimulatedProviderOptions,
} from '../../supabase/functions/_shared/ai/simulated-provider.ts';
import { loadAiTextConfig } from '../../supabase/functions/_shared/ai/text/config.ts';
import { createAiGenerateHandler } from '../../supabase/functions/ai-generate/handler.ts';
import {
  as,
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

const MODELS: AiModelSpec[] = [
  { provider: SIMULATED_PROVIDER_ID, model: 'sim-text-1', task: 'text', microsPerUnit: { input_tokens: 3, output_tokens: 15 } },
];

const PROFILE = { voice: { tone: ['cercano'], forbiddenPhrases: ['el mejor de la ciudad'] } };

const ANSWERS: Record<string, unknown> = {
  'post.caption': { variants: [{ text: 'Ya huele a otoño.', hashtags: ['#otoño'] }, { text: 'Carta nueva.', hashtags: [] }] },
  'brand.check': {
    tone: { verdict: 'uncertain', explanation: 'El perfil no dice si se tutea.', evidence: [] },
    banned_topics: { verdict: 'pass', explanation: 'Nada vetado.', evidence: [] },
  },
  'profile.proposal': {
    business: { description: 'Restaurante.', products: [], locations: [], valueProps: [] },
    audience: { segments: [] },
    goals: [],
    voice: { tone: [], personality: '', values: [], keyMessages: [], allowedPhrases: [], forbiddenPhrases: [] },
    visual: { colors: [], fonts: [], styleNotes: '' },
    channels: [],
    languages: { primary: 'es', others: [] },
    restrictions: { legal: [], advertising: [] },
    notes: [],
  },
};

let db: Db;
let root: TestUser;
let n = 0;
/** «Sesiones» de prueba: token → usuario. */
const sessions = new Map<string, TestUser>();

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

function login(user: TestUser): string {
  const token = `sesion-${user.id}`;
  sessions.set(token, user);
  return token;
}

async function setup(options: { quota?: number | null; profile?: Json | null; respond?: SimulatedProviderOptions['respond'] } = {}) {
  n += 1;
  const owner = await createUser(db, `propietaria${n}@funcion${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  if (options.quota !== null) await setAiQuota(db, root, org, options.quota ?? 10_000_000);
  if (options.profile !== null) {
    await as(db, owner, `select public.save_brand_profile($1, $2::jsonb)`, [brand, JSON.stringify(options.profile ?? PROFILE)]);
  }

  const provider = createSimulatedProvider({
    respond: options.respond ?? ((request) => JSON.stringify(ANSWERS[request.input.cacheKey!.split(':')[0]!])),
  });
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const handler = createAiGenerateHandler({
    service: createAiService({ rpc, providers: [provider], models: MODELS }),
    authenticate: async (token) => {
      const user = sessions.get(token);
      return user ? { userId: user.id } : null;
    },
    // Igual que la función real: con la identidad del usuario, bajo RLS.
    loadBrandProfile: async (token, brandId) => {
      const user = sessions.get(token)!;
      const brands = await as<{ ai_mode: string }>(db, user, `select id, ai_mode from public.brands where id = $1`, [
        brandId,
      ]);
      if (brands.length === 0) return { brandVisible: false, profile: null, aiMode: 'api' };
      const profiles = await as<{ data: Json }>(
        db,
        user,
        `select data from public.brand_profiles where brand_id = $1 and status = 'active'`,
        [brandId],
      );
      return {
        brandVisible: true,
        profile: profiles[0]?.data ?? null,
        aiMode: brands[0]!.ai_mode === 'agency' ? 'agency' : 'api',
      };
    },
    log: (event, data) => logs.push({ event, data }),
  });

  const call = async (token: string | null, body: unknown, method = 'POST') => {
    const response = await handler(
      new Request('https://funciones.test/ai-generate', {
        method,
        headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
        body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      }),
    );
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as Row };
  };

  const caption = (extra: Record<string, unknown> = {}) => ({
    action: 'post.caption',
    brandId: brand,
    input: {
      brief: 'Presentamos la carta de otoño',
      network: { id: 'instagram', name: 'Instagram', maxChars: 2200, maxHashtags: 30 },
      variants: 2,
      ...extra,
    },
  });

  return { owner, org, brand, provider, handler, call, caption, logs, token: login(owner) };
}

const generations = (org: string) =>
  db.query<Row>(`select * from public.ai_generations where organization_id = $1 order by created_at`, [org]);

describe('sesión y forma de la petición', () => {
  it('sin sesión, o con una que no vale, no se hace nada', async () => {
    const t = await setup();
    expect(await t.call(null, t.caption())).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } });
    expect(await t.call('token-inventado', t.caption())).toMatchObject({ status: 401 });
    expect(t.provider.calls).toEqual([]);
  });

  it('responde a la comprobación previa del navegador (CORS) y solo admite POST', async () => {
    const t = await setup();
    const preflight = await t.call(null, null, 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    expect((await t.call(t.token, null, 'GET')).status).toBe(405);
  });

  it('una petición mal formada se rechaza con un mensaje claro', async () => {
    const t = await setup();
    for (const body of [
      '{no es json',
      { brandId: t.brand, input: {} },
      { action: 'borrar.todo', brandId: t.brand, input: {} },
      { action: 'post.caption', brandId: 'no-es-uuid', input: {} },
      { action: 'post.caption', brandId: t.brand },
      t.caption({ brief: '' }),
      t.caption({ variants: 9 }),
      t.caption({ network: { id: 'x', name: 'X', maxChars: -1 } }),
    ]) {
      const response = await t.call(t.token, body);
      expect(response).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
      expect(typeof (response.body.error as Row).message).toBe('string');
    }
    expect(t.provider.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);
  });
});

describe('las tres acciones', () => {
  it('post.caption: lee el perfil de la marca en el servidor y devuelve las variantes', async () => {
    const t = await setup();
    const response = await t.call(t.token, t.caption());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      action: 'post.caption',
      network: 'instagram',
      requestedVariants: 2,
      variants: [
        { text: 'Ya huele a otoño.', hashtags: ['#otoño'], withinLimits: true },
        { text: 'Carta nueva.', hashtags: [], withinLimits: true },
      ],
    });
    // Ni proveedor, ni modelo, ni coste en la respuesta al navegador.
    for (const key of ['provider', 'model', 'usage', 'costMicros']) expect(response.body).not.toHaveProperty(key);

    const [row] = await generations(t.org);
    expect(row).toMatchObject({ id: response.body.generationId, requested_by: t.owner.id, status: 'succeeded' });
    // El perfil que llega al modelo es el guardado, no algo que mande el navegador.
    expect(t.provider.calls[0]!.input.context![0]).toMatchObject({ label: 'perfil de marca', cacheable: true });
    expect(t.provider.calls[0]!.input.context![0]!.content).toMatch(/el mejor de la ciudad/);
  });

  it('brand.check: devuelve el veredicto y manda a revisión humana lo dudoso', async () => {
    const t = await setup();
    const response = await t.call(t.token, { action: 'brand.check', brandId: t.brand, input: { text: 'Ven a vernos.' } });
    expect(response).toMatchObject({
      status: 200,
      body: {
        action: 'brand.check',
        verdict: 'review',
        needsHumanReview: true,
        criteria: [
          { criterion: 'tone', verdict: 'uncertain' },
          { criterion: 'banned_topics', verdict: 'pass' },
        ],
      },
    });
  });

  it('profile.proposal: funciona sin perfil previo y no guarda nada', async () => {
    const t = await setup({ profile: null });
    const response = await t.call(t.token, {
      action: 'profile.proposal',
      brandId: t.brand,
      input: { sources: [{ title: 'Manual.pdf', text: 'Somos un restaurante.' }] },
    });
    expect(response).toMatchObject({ status: 200, body: { action: 'profile.proposal', status: 'proposal', sources: ['Manual.pdf'] } });
    expect((response.body.proposal as Row).business).toMatchObject({ description: 'Restaurante.' });
    expect(await db.query(`select 1 from public.brand_profiles where brand_id = $1`, [t.brand])).toEqual([]);
  });

  it('sin perfil de marca no se redacta ni se comprueba', async () => {
    const t = await setup({ profile: null });
    const response = await t.call(t.token, t.caption());
    expect(response).toMatchObject({ status: 409, body: { error: { code: 'brand_profile_missing' } } });
    expect(t.provider.calls).toEqual([]);
  });
});

describe('permisos y cupo', () => {
  it('quien ve la marca pero no puede crear contenido recibe un 403 y no se llama al proveedor', async () => {
    const t = await setup();
    const cliente = await createUser(db, `cliente${n}@funcion${n}.test`);
    await join(db, t.owner, cliente, t.org, 'member', t.brand, 'client');
    const response = await t.call(login(cliente), t.caption());
    expect(response).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect((response.body.error as Row).message).toMatch(/No tienes permiso/);
    expect(t.provider.calls).toEqual([]);
    expect(await generations(t.org)).toEqual([]);
  });

  it('la marca de otra organización no existe para quien no pertenece a ella', async () => {
    const t = await setup();
    const ajena = await setup();
    const response = await t.call(t.token, { ...t.caption(), brandId: ajena.brand });
    expect(response).toMatchObject({ status: 404, body: { error: { code: 'brand_not_found' } } });
    expect(t.provider.calls).toEqual([]);
    expect(await generations(ajena.org)).toEqual([]);
  });

  it('cupo agotado: 402 con el mensaje del cupo, sin cifras y sin llamar al proveedor', async () => {
    const t = await setup({ quota: 50 });
    const response = await t.call(t.token, t.caption());
    expect(response.status).toBe(402);
    expect(response.body.error).toEqual({
      code: 'quota_exhausted',
      message: 'El cupo de IA de este mes está agotado: no queda saldo suficiente para esta generación',
      retryable: false,
    });
    expect(t.provider.calls).toEqual([]);
  });

  it('organización sin cupo asignado: 402', async () => {
    const t = await setup({ quota: null });
    const response = await t.call(t.token, t.caption());
    expect(response).toMatchObject({ status: 402, body: { error: { code: 'quota_missing' } } });
  });
});

describe('modo agencia', () => {
  it('en una marca que redacta por encargo, ninguna acción de texto llega al proveedor ni gasta cupo', async () => {
    const t = await setup();
    await as(db, t.owner, `update public.brands set ai_mode = 'agency' where id = $1`, [t.brand]);
    for (const body of [
      t.caption(),
      { action: 'brand.check', brandId: t.brand, input: { text: 'Ven a vernos.' } },
      { action: 'profile.proposal', brandId: t.brand, input: { sources: [{ title: 'a.txt', text: 'Somos.' }] } },
    ]) {
      const response = await t.call(t.token, body);
      expect(response).toMatchObject({ status: 409, body: { error: { code: 'agency_mode', retryable: false } } });
      expect((response.body.error as Row).message).toMatch(/Encargos/);
    }
    // El plan de campaña también se pide a la agencia (desde Campañas).
    const plan = await t.call(t.token, {
      action: 'campaign.plan',
      brandId: t.brand,
      input: { instruction: 'Otoño', startDate: '2026-12-01', endDate: '2026-12-07', targets: [] },
    });
    expect(plan).toMatchObject({ status: 409, body: { error: { code: 'agency_mode', retryable: false } } });
    expect((plan.body.error as Row).message).toMatch(/Campañas/);
    expect(t.provider.calls).toEqual([]);
    // Ni reserva de cupo ni generación registrada.
    expect(await generations(t.org)).toEqual([]);
  });

  it('al volver al servicio de IA, se puede redactar otra vez', async () => {
    const t = await setup();
    await as(db, t.owner, `update public.brands set ai_mode = 'agency' where id = $1`, [t.brand]);
    await as(db, t.owner, `update public.brands set ai_mode = 'api' where id = $1`, [t.brand]);
    expect((await t.call(t.token, t.caption())).status).toBe(200);
  });

  it('una marca ajena en modo agencia sigue sin existir para quien no pertenece a ella', async () => {
    const t = await setup();
    const ajena = await setup();
    await as(db, ajena.owner, `update public.brands set ai_mode = 'agency' where id = $1`, [ajena.brand]);
    const response = await t.call(t.token, { ...t.caption(), brandId: ajena.brand });
    expect(response).toMatchObject({ status: 404, body: { error: { code: 'brand_not_found' } } });
  });
});

describe('fallos de la IA', () => {
  it('si la respuesta del modelo no sirve, se dice, con la generación registrada', async () => {
    const t = await setup({ respond: () => 'esto no es JSON' });
    const response = await t.call(t.token, t.caption());
    expect(response).toMatchObject({ status: 502, body: { error: { code: 'invalid_output', retryable: true } } });
    const [row] = await generations(t.org);
    expect((response.body.error as Row).generationId).toBe(row!.id);
  });

  it('IA sin configurar: 503 con un mensaje neutro; el motivo (qué variable falta) solo va al registro del servidor', async () => {
    const t = await setup();
    const config = loadAiTextConfig({ AI_TEXT_PROVIDER: 'anthropic-vertex', AI_TEXT_MODEL: 'modelo-v' });
    const logs: Record<string, unknown>[] = [];
    const handler = createAiGenerateHandler({
      service: createAiService({ rpc, providers: config.providers, models: config.models, unavailable: config.unavailable }),
      authenticate: async () => ({ userId: t.owner.id }),
      loadBrandProfile: async () => ({ brandVisible: true, profile: PROFILE, aiMode: 'api' }),
      log: (_event, data) => logs.push(data),
    });
    const response = await handler(
      new Request('https://funciones.test/ai-generate', {
        method: 'POST',
        headers: { authorization: 'Bearer x' },
        body: JSON.stringify(t.caption()),
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_configured');
    expect(body.error.message).toBe('La IA no está disponible en este momento. Avisa a quien administra la plataforma.');
    expect(JSON.stringify(logs)).toMatch(/AI_VERTEX_PROJECT_ID/);
    expect(await generations(t.org)).toEqual([]);
  });
});

describe('campaign.plan (Campañas)', () => {
  const PLAN = {
    objective: 'Dar a conocer la carta de otoño.',
    summary: 'Una pieza.',
    observed: ['Tono cercano.'],
    dataBacked: [],
    hypotheses: [],
    pieces: [
      {
        network: 'instagram',
        format: 'post',
        date: '2026-11-24',
        idea: 'Guiso',
        caption: 'Guiso de setas.',
        hashtags: ['#otoño'],
        assetIds: [],
        why: 'Martes.',
      },
    ],
  };
  const body = (brand: string, extra: Record<string, unknown> = {}) => ({
    action: 'campaign.plan',
    brandId: brand,
    input: {
      instruction: 'Prepara la semana que viene',
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      targets: [{ network: 'instagram', format: 'post' }],
      ...extra,
    },
  });

  it('devuelve el plan propuesto, sin guardar nada ni enseñar proveedor o coste', async () => {
    const t = await setup({ respond: () => JSON.stringify(PLAN) });
    const response = await t.call(t.token, body(t.brand));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      action: 'campaign.plan',
      status: 'proposal',
      plan: { objective: 'Dar a conocer la carta de otoño.', pieces: [{ date: '2026-11-24', hashtags: ['otoño'] }] },
      discarded: [],
    });
    for (const key of ['provider', 'model', 'usage', 'costMicros']) expect(response.body).not.toHaveProperty(key);
    expect(await db.query(`select 1 from public.campaigns where brand_id = $1`, [t.brand])).toEqual([]);
    const [row] = await generations(t.org);
    expect(row).toMatchObject({ purpose: 'campaign.plan', status: 'succeeded' });
  });

  it('una petición incompleta es un 400 claro, sin llamar al proveedor', async () => {
    const t = await setup({ respond: () => JSON.stringify(PLAN) });
    const response = await t.call(t.token, body(t.brand, { endDate: '2026-11-01' }));
    expect(response).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(t.provider.calls).toEqual([]);
  });
});
