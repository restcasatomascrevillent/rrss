// Interpretación de la analítica con IA (`analytics.summary`, Fase 5) por la
// lógica de `ai-generate`, con la base de datos real y el proveedor simulado:
// a la IA solo le llegan las cifras medidas (leídas con la identidad del
// usuario); lo que devuelve es siempre hipótesis apoyada en datos que existen;
// en modo agencia no se usa.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Json, RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { createAiService } from '../../supabase/functions/_shared/ai/service.ts';
import { createSimulatedProvider } from '../../supabase/functions/_shared/ai/simulated-provider.ts';
import { loadLocalTestTextConfig } from '../../supabase/functions/_shared/ai/text/local-test.ts';
import {
  analyze,
  previousPeriod,
  type MediaSummary,
  type MetricDefinition,
} from '../../supabase/functions/_shared/analytics/analyst.ts';
import { createAiGenerateHandler, type AiGenerateDeps } from '../../supabase/functions/ai-generate/handler.ts';
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
  type TestUser,
} from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser, lector: TestUser;
let marca: string, marcaAgencia: string, marcaVacia: string;
const sessions = new Map<string, TestUser>();
const login = (u: TestUser) => {
  sessions.set(`s-${u.id}`, u);
  return `s-${u.id}`;
};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const PERIOD = { from: day(-14), to: day(0) };

const rpc: RpcClient = async (fn, args) => {
  try {
    return { data: await serviceRpc(db, fn, args), error: null };
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { data: null, error: { code, message, details: null } };
  }
};

/** Igual que la función desplegada: cifras leídas con la identidad del usuario y redactadas por el analista. */
const loadAnalyticsFacts: NonNullable<AiGenerateDeps['loadAnalyticsFacts']> = async (token, brandId, period) => {
  const user = sessions.get(token)!;
  const previous = previousPeriod(period);
  const [brand] = await as<{ ai_mode: string }>(db, user, `select ai_mode from public.brands where id = $1`, [brandId]);
  const definitions = (await as(
    db,
    user,
    `select * from public.analytics_metric_definitions`,
  )) as unknown as MetricDefinition[];
  const points = await as<{ metric_id: string; date: string; value: string; provisional: boolean }>(
    db,
    user,
    `select metric_id, metric_date::text as date, value::text, provisional from public.account_metrics_daily
     where brand_id = $1 and metric_date >= $2 and metric_date < $3`,
    [brandId, previous.from, period.to],
  );
  const media = (await as(db, user, `select * from public.analytics_media_summary($1, $2, $3)`, [
    brandId,
    period.from,
    period.to,
  ])) as unknown as MediaSummary[];
  const analysis = analyze({
    definitions,
    points: points.map((p) => ({ ...p, value: Number(p.value) })),
    media,
    previousMedia: [],
    period,
    previous,
    unavailable: [],
    accounts: [{ network: 'instagram', username: 'cuenta', status: 'active' }],
  });
  return {
    aiMode: brand?.ai_mode ?? 'api',
    periodLabel: `${period.from} – ${period.to}`,
    facts: analysis.facts.filter((f) => f.metricId).map((f) => ({ id: f.id, text: f.text })),
  };
};

function handler(respond?: (request: { input: { context?: { label: string; content: string }[] } }) => string) {
  const local = loadLocalTestTextConfig({ AI_E2E_SIMULATED_PROVIDER: 'true', SUPABASE_URL: 'http://127.0.0.1:54321' })!;
  const providers = respond ? [createSimulatedProvider({ respond: (r) => respond(r) })] : local.providers;
  return createAiGenerateHandler({
    service: createAiService({ rpc, providers, models: local.models }),
    authenticate: async (token) => (sessions.has(token) ? { userId: sessions.get(token)!.id } : null),
    loadBrandProfile: async (token, brandId) => {
      const user = sessions.get(token)!;
      const rows = await as<{ ai_mode: string }>(db, user, `select ai_mode from public.brands where id = $1`, [
        brandId,
      ]);
      if (!rows.length) return { brandVisible: false, profile: null, aiMode: 'api' };
      const aiMode = rows[0]!.ai_mode === 'agency' ? 'agency' : 'api';
      const profiles = await as<{ data: Json }>(
        db,
        user,
        `select data from public.brand_profiles where brand_id = $1 and status = 'active'`,
        [brandId],
      );
      return { brandVisible: true, profile: profiles[0]?.data ?? null, aiMode };
    },
    loadAnalyticsFacts,
  });
}

const call = async (
  user: TestUser,
  brandId: string,
  input: Record<string, unknown>,
  respond?: Parameters<typeof handler>[0],
) => {
  const response = await handler(respond)(
    new Request('http://local/ai-generate', {
      method: 'POST',
      headers: { authorization: `Bearer ${login(user)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'analytics.summary', brandId, input }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

async function withMetrics(owner: TestUser, brand: string, externalId: string) {
  const account = await serviceRpc<{ id: string }>(db, 'social_account_connect', {
    p_user_id: owner.id,
    p_brand_id: brand,
    p_network: 'instagram',
    p_external_id: externalId,
    p_username: 'cuenta',
    p_display_name: 'Cuenta',
    p_page_id: '1',
    p_scopes: ['instagram_basic'],
    p_token_expires_at: null,
    p_key_id: 'k1',
    p_access_token_ciphertext: 'c'.repeat(40),
    p_refresh_token_ciphertext: null,
  });
  const rows = [];
  for (let i = -28; i < 0; i++) {
    rows.push({ metric_id: 'instagram.account.reach', date: day(i), value: i < -14 ? 100 : 200 });
  }
  await serviceRpc(db, 'analytics_record_capture', {
    p_account_id: account.id,
    p_job_id: null,
    p_status: 'succeeded',
    p_started_at: new Date().toISOString(),
    p_window_from: day(-28),
    p_window_to: day(-1),
    p_account_rows: rows,
    p_media_rows: [],
  });
}

beforeAll(async () => {
  db = await createDb();
  const root = await createUser(db, 'root@ia.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  ana = await createUser(db, 'ana@ia-analitica.test');
  editor = await createUser(db, 'editor@ia-analitica.test');
  lector = await createUser(db, 'lector@ia-analitica.test');
  const org = await createOrg(db, ana, 'Empresa');
  await setAiQuota(db, root, org, 10_000_000);
  marca = await createBrand(db, ana, org, 'Marca');
  marcaAgencia = await createBrand(db, ana, org, 'Marca en agencia');
  marcaVacia = await createBrand(db, ana, org, 'Marca sin cifras');
  for (const b of [marca, marcaAgencia, marcaVacia]) await join(db, ana, editor, org, 'member', b, 'editor');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
  await as(db, ana, `update public.brands set ai_mode = 'agency' where id = $1`, [marcaAgencia]);
  await withMetrics(ana, marca, '501');
  await withMetrics(ana, marcaAgencia, '502');
});

afterAll(async () => {
  await db?.close();
});

describe('analytics.summary', () => {
  it('devuelve solo hipótesis, cada una apoyada en datos que existen', async () => {
    const { status, body } = await call(editor, marca, PERIOD);
    expect(status).toBe(200);
    const hypotheses = body.hypotheses as Array<{ kind: string; source: string; text: string; basedOn: string[] }>;
    expect(hypotheses.length).toBeGreaterThan(0);
    for (const h of hypotheses) {
      expect(h).toMatchObject({ kind: 'hypothesis', source: 'ai' });
      expect(h.basedOn).toEqual(['total:instagram.account.reach']);
      // El simulado cita el dato tal cual: lo que llegó a la IA son las cifras medidas.
      expect(h.text).toMatch(/\[simulado\].*Alcance: 2800/);
    }
  });

  it('descarta lo que no se apoya en ningún dato', async () => {
    const { status, body } = await call(editor, marca, PERIOD, () =>
      JSON.stringify({
        hypotheses: [
          { text: 'Inventada: subió por el anuncio de la tele.', based_on: ['no-existe'] },
          { text: 'Podría deberse a publicar más.', based_on: ['total:instagram.account.reach'] },
        ],
      }),
    );
    expect(status).toBe(200);
    expect(body.discarded).toBe(1);
    expect((body.hypotheses as unknown[]).length).toBe(1);
  });

  it('en modo agencia no se usa la IA (ni se reserva cupo)', async () => {
    const before = await db.query(`select count(*)::int as n from public.ai_generations`);
    const { status, body } = await call(editor, marcaAgencia, PERIOD);
    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe('agency_mode');
    expect(await db.query(`select count(*)::int as n from public.ai_generations`)).toEqual(before);
  });

  it('sin cifras, o con un periodo mal escrito, no se llama a la IA', async () => {
    expect((await call(editor, marcaVacia, PERIOD)).status).toBe(400);
    expect((await call(editor, marca, { from: '2026-13-01', to: PERIOD.to })).status).toBe(400);
    expect((await call(editor, marca, { from: PERIOD.to, to: PERIOD.from })).status).toBe(400);
  });

  it('quien solo ve la marca no gasta cupo de IA', async () => {
    const { status } = await call(lector, marca, PERIOD);
    expect(status).toBe(403);
  });
});
