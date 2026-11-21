// Vía del proveedor simulado SOLO para pruebas locales (local-test.ts): la
// guarda que impide usarlo fuera de un Supabase local y sus respuestas
// deterministas, construidas a partir del perfil y del encargo, pasando por el
// servicio real (cupo → generar → registrar) contra las migraciones.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { createAiService } from '../../supabase/functions/_shared/ai/service.ts';
import { loadAiTextConfig } from '../../supabase/functions/_shared/ai/text/config.ts';
import {
  isLocalSupabaseUrl,
  loadLocalTestTextConfig,
  LOCAL_TEST_FLAG,
  LocalTestConfigError,
} from '../../supabase/functions/_shared/ai/text/local-test.ts';
import { checkBrandCompliance } from '../../supabase/functions/_shared/ai/text/tasks/brand-check.ts';
import { generatePostCopy } from '../../supabase/functions/_shared/ai/text/tasks/post-copy.ts';
import { proposeBrandProfile } from '../../supabase/functions/_shared/ai/text/tasks/profile-proposal.ts';
import {
  createBrand,
  createDb,
  createOrg,
  createUser,
  serviceRpc,
  setAiQuota,
  type Db,
  type TestUser,
} from './helpers';

const LOCAL = { [LOCAL_TEST_FLAG]: 'true', SUPABASE_URL: 'http://127.0.0.1:55321' };

describe('guarda del proveedor simulado de pruebas locales', () => {
  it('sin la variable no hace nada: manda la configuración normal, que no admite el simulado', () => {
    expect(loadLocalTestTextConfig({ SUPABASE_URL: 'http://127.0.0.1:55321' })).toBeNull();
    expect(loadLocalTestTextConfig({ [LOCAL_TEST_FLAG]: '  ', SUPABASE_URL: 'http://127.0.0.1:55321' })).toBeNull();
    const normal = loadAiTextConfig({ AI_TEXT_PROVIDER: 'simulated', AI_TEXT_MODEL: 'x' });
    expect(normal.providers).toEqual([]);
    expect(normal.unavailable.simulated).toMatch(/no existe/);
  });

  it('con la variable, solo contra un Supabase local por http', () => {
    for (const url of ['http://127.0.0.1:55321', 'http://localhost:54321', 'http://kong:8000']) {
      const config = loadLocalTestTextConfig({ [LOCAL_TEST_FLAG]: 'true', SUPABASE_URL: url })!;
      expect(config.providers.map((p) => p.id)).toEqual(['simulated']);
      expect(config.models.map((m) => m.purposes)).toEqual([
        ['post.caption'],
        ['profile.proposal'],
        ['brand.check'],
        ['campaign.plan'],
        ['analytics.summary'],
        ['editor.copilot'],
      ]);
      expect(config.problems.join(' ')).toMatch(/SIMULADO para pruebas locales/);
    }
    expect(isLocalSupabaseUrl('http://127.0.0.1')).toBe(true);
  });

  it('con la variable y un Supabase que no es local, error claro y no arranca', () => {
    for (const url of [
      'https://abcdefgh.supabase.co',
      'https://localhost:54321', // https: no es el stack local de la CLI
      'http://kong.ejemplo.com',
      'http://127.0.0.1.ejemplo.com',
      'http://10.0.0.5:8000',
      'no es una url',
      undefined,
    ]) {
      expect(() => loadLocalTestTextConfig({ [LOCAL_TEST_FLAG]: 'true', SUPABASE_URL: url })).toThrow(
        LocalTestConfigError,
      );
    }
    expect(() =>
      loadLocalTestTextConfig({ [LOCAL_TEST_FLAG]: 'true', SUPABASE_URL: 'https://abcdefgh.supabase.co' }),
    ).toThrow(/solo se admite en pruebas locales/);
  });

  it('la variable solo admite «true»', () => {
    for (const value of ['1', 'yes', 'TRUE', 'false']) {
      expect(() =>
        loadLocalTestTextConfig({ [LOCAL_TEST_FLAG]: value, SUPABASE_URL: 'http://127.0.0.1:55321' }),
      ).toThrow(/solo admite el valor «true»/);
    }
  });
});

// ── Respuestas deterministas, por el servicio real ───────────────────────

let db: Db;
let root: TestUser;
let n = 0;
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
  root = await createUser(db, 'root@local-test.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
});
afterAll(async () => {
  await db?.close();
});

async function setup() {
  n += 1;
  const owner = await createUser(db, `duena${n}@local${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  await setAiQuota(db, root, org, 10_000_000);
  const config = loadLocalTestTextConfig(LOCAL)!;
  const service = createAiService({ rpc, providers: config.providers, models: config.models });
  return { org, service, actor: { userId: owner.id, brandId: brand } };
}

const FORMAL = {
  voice: {
    tone: ['Formal, de usted'],
    keyMessages: ['Pan de masa madre recién hecho cada mañana'],
    forbiddenPhrases: ['barato'],
    callsToAction: ['Reserve su hogaza'],
    hashtags: { required: ['LaEspiga'], recommended: ['MasaMadre'] },
  },
};
const CERCANA = {
  voice: {
    tone: ['Cercano'],
    keyMessages: ['Café de especialidad tostado en casa'],
    forbiddenPhrases: ['oferta'],
    callsToAction: ['Pásate a probarlo'],
    hashtags: { required: ['CafeLumen'], recommended: [] },
  },
};
const INSTAGRAM = { id: 'instagram', name: 'Instagram', maxChars: 2200, maxHashtags: 30 };

describe('respuestas del simulado de pruebas locales', () => {
  it('el texto sale del perfil y del encargo de cada marca, sin lo vetado y siempre igual', async () => {
    const a = await setup();
    const b = await setup();
    const brief = 'Hogaza de calabaza, barato y en oferta';
    const deA = await generatePostCopy(a.service, a.actor, {
      brandProfile: FORMAL,
      brief,
      network: INSTAGRAM,
      variants: 2,
    });
    const deB = await generatePostCopy(b.service, b.actor, {
      brandProfile: CERCANA,
      brief,
      network: INSTAGRAM,
      variants: 1,
    });

    expect(deA.variants).toHaveLength(2);
    expect(deA.variants[0]).toMatchObject({
      text: 'Le presentamos: hogaza de calabaza, y en oferta. Pan de masa madre recién hecho cada mañana. Reserve su hogaza.',
      hashtags: ['#LaEspiga', '#MasaMadre'],
      withinLimits: true,
    });
    expect(deA.variants[1]!.text).not.toBe(deA.variants[0]!.text);
    expect(deB.variants[0]).toMatchObject({
      text: 'Te presentamos: hogaza de calabaza, barato y en. Café de especialidad tostado en casa. Pásate a probarlo.',
      hashtags: ['#CafeLumen'],
    });
    // Determinista: lo mismo otra vez da lo mismo.
    const otraVez = await generatePostCopy(a.service, a.actor, {
      brandProfile: FORMAL,
      brief,
      network: INSTAGRAM,
      variants: 2,
    });
    expect(otraVez.variants.map((v) => v.text)).toEqual(deA.variants.map((v) => v.text));
    // Pasa por el servicio: queda registrado como simulado, con coste.
    expect(deA).toMatchObject({ provider: 'simulated', model: 'simulado-e2e' });
    expect(deA.costMicros).toBeGreaterThan(0);
  });

  it('la comprobación de marca señala lo vetado con la cita literal del texto', async () => {
    const a = await setup();
    const malo = await checkBrandCompliance(a.service, a.actor, {
      brandProfile: FORMAL,
      text: 'Pan BARATO para todos',
    });
    expect(malo.verdict).toBe('fail');
    expect(malo.criteria.find((c) => c.criterion === 'banned_topics')).toMatchObject({
      verdict: 'fail',
      evidence: ['BARATO'],
    });
    const bueno = await checkBrandCompliance(a.service, a.actor, { brandProfile: FORMAL, text: 'Pan de cada día' });
    expect(bueno.verdict).toBe('pass');
    const sinTono = await checkBrandCompliance(a.service, a.actor, { brandProfile: { voice: {} }, text: 'Hola' });
    expect(sinTono.verdict).toBe('review');
  });

  it('la propuesta de perfil cumple el esquema y sale de las fuentes', async () => {
    const a = await setup();
    const result = await proposeBrandProfile(a.service, a.actor, {
      sources: [{ title: 'notas.txt', text: 'Somos un obrador de barrio. Abrimos a las siete.' }],
    });
    expect(result.proposal.business).toMatchObject({ description: 'Somos un obrador de barrio.' });
  });
});
