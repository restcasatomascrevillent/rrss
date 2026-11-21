// Plataforma → Integraciones (migración 20261120010000): claves de los servicios
// guardadas desde la interfaz, cifradas en Vault (aquí, su sustituto del
// andamiaje), que solo ve y escribe un superadministrador; la función
// `platform-integrations` con servicios simulados; la configuración efectiva
// (base de datos y, si no, entorno) y conectar Instagram pegando un token.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { computeAvailability } from '../../supabase/functions/_shared/integrations/availability.ts';
import { INTEGRATION_SETTINGS, validateSetting } from '../../supabase/functions/_shared/integrations/catalog.ts';
import { probeIntegration, type ProbeFetch } from '../../supabase/functions/_shared/integrations/probes.ts';
import {
  createSettingsLoader,
  memoByEnv,
  mergeIntegrationEnv,
} from '../../supabase/functions/_shared/integrations/settings.ts';
import { loadSocialConfig, type SocialConfig } from '../../supabase/functions/_shared/social/config.ts';
import { decryptToken, parseKeyRing, tokenBinding } from '../../supabase/functions/_shared/social/crypto.ts';
import { createMetaGraph } from '../../supabase/functions/_shared/social/meta-graph.ts';
import { checkAccountTokens } from '../../supabase/functions/_shared/social/oauth.ts';
import {
  createSimulatedGraph,
  SIMULATED_IG_USER_ID,
  SIMULATED_PAGE_ID,
  type SimulatedGraph,
} from '../../supabase/functions/_shared/social/simulated-graph.ts';
import { connectWithToken } from '../../supabase/functions/_shared/social/token-connect.ts';
import { createPlatformIntegrationsHandler } from '../../supabase/functions/platform-integrations/handler.ts';
import { createSocialConnectHandler } from '../../supabase/functions/social-connect/handler.ts';
import { UI_INTEGRATIONS } from '../../src/features/platform/integrations/catalog';
import { as, asService, createBrand, createDb, createOrg, createUser, denied, type Db, type TestUser } from './helpers';

let db: Db;
let root: TestUser, ana: TestUser, berta: TestUser;
let org: string, marca: string;

// Valores de prueba: no son claves de nadie.
const SECRET = 'secreto-de-prueba-0123456789abcdef';
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  client_email: 'rrss@proyecto-prueba.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
});

/** Llama a una función de `public` como lo haría la API (JSON; las de tabla, como lista). */
function rpcAs(user: TestUser | null): RpcClient {
  return async (fn, args) => {
    const names = Object.keys(args).filter((n) => args[n] !== undefined);
    const params = names.map((n) => args[n]);
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
      const rows = user
        ? await as<{ data: unknown }>(db, user, sql, params)
        : await asService<{ data: unknown }>(db, sql, params);
      return { data: rows[0]?.data ?? null, error: null };
    } catch (error) {
      const { code, message } = error as { code?: string; message: string };
      return { data: null, error: { code, message } };
    }
  };
}

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@integraciones.test', 'Root');
  ana = await createUser(db, 'ana@integraciones.test', 'Ana');
  berta = await createUser(db, 'berta@integraciones.test', 'Berta');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
});

afterAll(async () => {
  await db?.close();
});

describe('catálogo', () => {
  it('la base de datos, el servidor y la pantalla tienen los mismos ajustes', async () => {
    const rows = await db.query<{ setting_key: string; integration: string; is_secret: boolean }>(
      `select setting_key, integration, is_secret from private.integration_setting_keys order by 1`,
    );
    const server = INTEGRATION_SETTINGS.map((s) => ({
      setting_key: s.key,
      integration: s.integration,
      is_secret: s.secret,
    }));
    const byKey = (a: { setting_key: string }, b: { setting_key: string }) => (a.setting_key < b.setting_key ? -1 : 1);
    expect([...rows].sort(byKey)).toEqual([...server].sort(byKey));
    const ui = UI_INTEGRATIONS.flatMap((i) =>
      i.groups.flatMap((g) => g.fields.map((f) => ({ setting_key: f.key, integration: i.id, is_secret: f.secret }))),
    );
    expect([...ui].sort(byKey)).toEqual([...server].sort(byKey));
  });

  it('valida la forma de los valores sin citarlos', () => {
    expect(validateSetting('META_GRAPH_API_VERSION', 'v27.0')).toBeNull();
    expect(validateSetting('META_GRAPH_API_VERSION', '27')).toMatch(/v27\.0/);
    expect(validateSetting('COMFYUI_BASE_URL', 'http://ejemplo.test')).toMatch(/https/);
    expect(validateSetting('COMFYUI_BASE_URL', 'https://usuario:clave@ejemplo.test')).toMatch(/usuario/);
    expect(validateSetting('AI_VERTEX_SERVICE_ACCOUNT_JSON', '{"a":1}')).toMatch(/cuenta de servicio/);
    expect(validateSetting('AI_VERTEX_SERVICE_ACCOUNT_JSON', SERVICE_ACCOUNT)).toBeNull();
    expect(validateSetting('STRIPE_SECRET_KEY', 'pk_test_123')).not.toBeNull();
    expect(validateSetting('NO_EXISTE', 'x')).toMatch(/no existe/);
    const problem = validateSetting('META_APP_SECRET', 'con espacios y símbolos ¿?');
    expect(problem).not.toContain('símbolos');
  });
});

describe('guardar y leer ajustes (base de datos)', () => {
  it('el superadministrador guarda un secreto: va a Vault y nunca vuelve en claro', async () => {
    await as(db, root, `select public.admin_set_integration_setting('META_APP_SECRET', $1)`, [SECRET]);
    await as(db, root, `select public.admin_set_integration_setting('META_APP_ID', '1234567890')`);
    const rows = await as<{ setting_key: string; value: string | null; hint: string | null; updated_by_email: string }>(
      db,
      root,
      `select * from public.admin_integration_settings()`,
    );
    const secret = rows.find((r) => r.setting_key === 'META_APP_SECRET')!;
    expect(secret.value).toBeNull();
    expect(secret.hint).toBe('…cdef');
    expect(secret.updated_by_email).toBe('root@integraciones.test');
    expect(rows.find((r) => r.setting_key === 'META_APP_ID')!.value).toBe('1234567890');
    // En la tabla no está el valor: solo el identificador del secreto de Vault.
    const dump =
      JSON.stringify(await db.query(`select * from private.integration_settings`)) +
      JSON.stringify(await db.query(`select * from private.integration_audit`));
    expect(dump).not.toContain(SECRET);
    const [vault] = await db.query<{ n: string }>(
      `select count(*)::text as n from vault.secrets where name = 'rrss_integration_meta_app_secret'`,
    );
    expect(vault!.n).toBe('1');
  });

  it('de una cuenta de servicio de Google, la pista es su correo', async () => {
    await as(db, root, `select public.admin_set_integration_setting('AI_VERTEX_SERVICE_ACCOUNT_JSON', $1)`, [
      SERVICE_ACCOUNT,
    ]);
    const [row] = await as<{ hint: string }>(
      db,
      root,
      `select hint from public.admin_integration_settings() where setting_key = 'AI_VERTEX_SERVICE_ACCOUNT_JSON'`,
    );
    expect(row!.hint).toBe('cuenta rrss@proyecto-prueba.iam.gserviceaccount.com');
    await as(db, root, `select public.admin_delete_integration_setting('AI_VERTEX_SERVICE_ACCOUNT_JSON')`);
  });

  it('sustituir reutiliza el secreto de Vault; borrar lo quita', async () => {
    await as(db, root, `select public.admin_set_integration_setting('STRIPE_SECRET_KEY', 'sk_test_primeraclave0001')`);
    await as(db, root, `select public.admin_set_integration_setting('STRIPE_SECRET_KEY', 'sk_test_segundaclave0002')`);
    const [count] = await db.query<{ n: string }>(
      `select count(*)::text as n from vault.secrets where name = 'rrss_integration_stripe_secret_key'`,
    );
    expect(count!.n).toBe('1');
    const values = await asService<{ data: Record<string, string> }>(
      db,
      `select public.integration_settings_for_service() as data`,
    );
    expect(values[0]!.data.STRIPE_SECRET_KEY).toBe('sk_test_segundaclave0002');
    const [deleted] = await as<{ ok: boolean }>(
      db,
      root,
      `select public.admin_delete_integration_setting('STRIPE_SECRET_KEY') as ok`,
    );
    expect(deleted!.ok).toBe(true);
    const [after] = await db.query<{ n: string }>(
      `select count(*)::text as n from vault.secrets where name = 'rrss_integration_stripe_secret_key'`,
    );
    expect(after!.n).toBe('0');
  });

  it('la actividad dice quién cambió qué, sin el valor', async () => {
    const audit = await as<{ action: string; setting_key: string; actor_email: string; data: unknown }>(
      db,
      root,
      `select * from public.admin_integration_audit(50)`,
    );
    expect(audit.some((a) => a.action === 'set' && a.setting_key === 'META_APP_SECRET')).toBe(true);
    expect(audit.some((a) => a.action === 'delete' && a.setting_key === 'STRIPE_SECRET_KEY')).toBe(true);
    expect(audit.every((a) => a.actor_email === 'root@integraciones.test')).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/sk_test_|secreto-de-prueba/);
  });

  it('rechaza ajustes fuera del catálogo y valores vacíos', async () => {
    await denied(
      db,
      root,
      `select public.admin_set_integration_setting('SUPABASE_SERVICE_ROLE_KEY', 'x')`,
      [],
      /no existe/,
    );
    await denied(
      db,
      root,
      `select public.admin_set_integration_setting('AI_E2E_SIMULATED_PROVIDER', 'true')`,
      [],
      /no existe/,
    );
    await denied(db, root, `select public.admin_set_integration_setting('META_APP_ID', '   ')`, [], /vacío/);
  });

  it('nadie más lee ni escribe: ni propietarios, ni usuarios, ni anónimos', async () => {
    for (const user of [ana, berta, null]) {
      const pattern = /permission denied|Solo para superadministradores/;
      await denied(db, user, `select * from public.admin_integration_settings()`, [], pattern);
      await denied(db, user, `select * from public.admin_integration_tests()`, [], pattern);
      await denied(db, user, `select * from public.admin_integration_audit(10)`, [], pattern);
      await denied(db, user, `select public.admin_set_integration_setting('META_APP_ID', '1')`, [], pattern);
      await denied(db, user, `select public.admin_delete_integration_setting('META_APP_ID')`, [], pattern);
      await denied(db, user, `select public.integration_settings_for_service()`, [], /permission denied/);
      await denied(
        db,
        user,
        `select public.integration_record_test($1, 'meta', true, 'x')`,
        [root.id],
        /permission denied/,
      );
      for (const table of [
        'integration_setting_keys',
        'integration_settings',
        'integration_tests',
        'integration_audit',
      ]) {
        await denied(db, user, `select * from private.${table}`, [], /permission denied/);
      }
      await denied(db, user, `select * from vault.decrypted_secrets`, [], /permission denied/);
    }
    // Tampoco el superadministrador ve las tablas ni los valores en claro directamente.
    await denied(db, root, `select * from private.integration_settings`, [], /permission denied/);
    await denied(db, root, `select public.integration_settings_for_service()`, [], /permission denied/);
    // Y la clave de servicio solo pasa por las funciones, no por las tablas.
    await expect(asService(db, `select * from private.integration_settings`)).rejects.toThrow(/permission denied/);
  });

  it('el resultado de una prueba solo lo anota el servidor y en nombre de un superadministrador', async () => {
    await expect(
      asService(db, `select public.integration_record_test($1, 'meta', true, 'bien')`, [ana.id]),
    ).rejects.toThrow(/superadministradores/);
    await asService(db, `select public.integration_record_test($1, 'meta', true, 'Meta reconoce la aplicación')`, [
      root.id,
    ]);
    const [test] = await as<{ ok: boolean; message: string; tested_by_email: string }>(
      db,
      root,
      `select * from public.admin_integration_tests() where integration = 'meta'`,
    );
    expect(test).toMatchObject({
      ok: true,
      message: 'Meta reconoce la aplicación',
      tested_by_email: 'root@integraciones.test',
    });
    // Google Drive (20261123010000) también es una integración; una inventada, no.
    await asService(db, `select public.integration_record_test($1, 'google_drive', true, 'completa')`, [root.id]);
    await expect(
      asService(db, `select public.integration_record_test($1, 'dropbox', true, 'x')`, [root.id]),
    ).rejects.toThrow(/no existe/);
  });

  it('no se puede quitar una clave de cifrado con la que hay tokens guardados', async () => {
    const k1 = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
    const k2 = `k2:${Buffer.alloc(32, 2).toString('base64')}`;
    await as(db, root, `select public.admin_set_integration_setting('SOCIAL_TOKEN_KEYS', $1)`, [k1]);
    await db.query(
      `insert into public.social_accounts (id, brand_id, organization_id, network, external_id)
       values ('00000000-0000-4000-8000-0000000000aa', $1, $2, 'instagram', '178410000099')`,
      [marca, org],
    );
    await db.query(
      `insert into private.social_account_secrets (account_id, organization_id, key_id, access_token_ciphertext)
       values ('00000000-0000-4000-8000-0000000000aa', $1, 'k1', 'cifrado-de-prueba-xxxxxxxx')`,
      [org],
    );
    await denied(db, root, `select public.admin_set_integration_setting('SOCIAL_TOKEN_KEYS', $1)`, [k2], /k1/);
    await denied(db, root, `select public.admin_delete_integration_setting('SOCIAL_TOKEN_KEYS')`, [], /k1/);
    // Añadir una clave sí se puede.
    await as(db, root, `select public.admin_set_integration_setting('SOCIAL_TOKEN_KEYS', $1)`, [`${k1},${k2}`]);
    await db.query(`delete from public.social_accounts where id = '00000000-0000-4000-8000-0000000000aa'`);
  });
});

describe('configuración efectiva', () => {
  it('lo guardado manda sobre el entorno, pero solo para los ajustes del catálogo', () => {
    const env = mergeIntegrationEnv(
      { META_APP_ID: '111', SUPABASE_URL: 'http://127.0.0.1:54321', OTRA: 'x' },
      {
        META_APP_ID: '222',
        SUPABASE_URL: 'https://otro.test',
        AI_E2E_SIMULATED_PROVIDER: 'true',
        SOCIAL_E2E_SIMULATED_GRAPH: 'true',
        META_APP_SECRET: '   ',
      },
    );
    expect(env.META_APP_ID).toBe('222');
    expect(env.SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(env.AI_E2E_SIMULATED_PROVIDER).toBeUndefined();
    expect(env.SOCIAL_E2E_SIMULATED_GRAPH).toBeUndefined();
    expect(env.META_APP_SECRET).toBeUndefined();
    expect(env.OTRA).toBe('x');
  });

  it('las claves de cifrado se unen: lo cifrado con la del entorno se sigue descifrando', () => {
    const envKey = `viejo:${Buffer.alloc(32, 7).toString('base64')}`;
    const dbKey = `nuevo:${Buffer.alloc(32, 8).toString('base64')}`;
    const env = mergeIntegrationEnv(
      { SOCIAL_TOKEN_KEYS: envKey, SOCIAL_TOKEN_KEY_ID: 'viejo' },
      { SOCIAL_TOKEN_KEYS: dbKey },
    );
    const ring = parseKeyRing(env.SOCIAL_TOKEN_KEYS, env.SOCIAL_TOKEN_KEY_ID);
    expect([...ring.keys.keys()]).toEqual(['nuevo', 'viejo']);
    expect(ring.currentKeyId).toBe('nuevo');
  });

  it('se lee con caché corta y, si la base de datos falla, sigue con el entorno', async () => {
    let now = 0;
    let reads = 0;
    let broken = false;
    const loader = createSettingsLoader({
      baseEnv: { META_APP_ID: '1' },
      now: () => now,
      ttlMs: 30_000,
      async readStored() {
        reads += 1;
        if (broken) throw new Error('caída');
        return { META_APP_ID: '2' };
      },
    });
    const a = await loader.get();
    const b = await loader.get();
    expect(a).toBe(b);
    expect(a.META_APP_ID).toBe('2');
    expect(reads).toBe(1);
    now = 31_000;
    expect(await loader.get()).toBe(a); // mismo contenido: mismo objeto
    expect(reads).toBe(2);
    broken = true;
    now = 70_000;
    expect((await loader.get()).META_APP_ID).toBe('2'); // lo último leído
    const fresh = createSettingsLoader({
      baseEnv: { META_APP_ID: '1' },
      readStored: async () => Promise.reject(new Error('x')),
    });
    expect((await fresh.get()).META_APP_ID).toBe('1');
    const memo = memoByEnv((env) => ({ id: env.META_APP_ID }));
    expect(memo(a)).toBe(memo(a));
  });

  it('disponibilidad: solo lo que está configurado', () => {
    const none = computeAvailability({}, []);
    expect(none).toEqual({
      publishing: false,
      socialOAuth: false,
      socialToken: false,
      aiText: false,
      aiImage: false,
      billing: false,
      drive: false,
      mediaStorage: false,
      reelSubtitles: false,
    });
    const keys = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
    const some = computeAvailability(
      {
        SUPABASE_URL: 'https://proyecto.supabase.co',
        SOCIAL_TOKEN_KEYS: keys,
        META_APP_ID: '123456',
        META_APP_SECRET: 'abcdef0123456789',
        SOCIAL_APP_URL: 'https://app.test',
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        BILLING_APP_URL: 'https://app.test',
        MISTRAL_API_KEY: 'clave',
        AI_TEXT_PROVIDER: 'mistral',
        AI_TEXT_MODEL: 'mistral-medium',
      },
      [],
    );
    // El callback se deduce de la URL https de Supabase.
    expect(some).toMatchObject({ publishing: true, socialOAuth: true, socialToken: true, billing: true });
    // Sin precios completos, la IA de texto no está lista.
    expect(some.aiText).toBe(false);
    // Sin el cliente OAuth de Google, Drive no está listo.
    expect(some.drive).toBe(false);
    const drive = computeAvailability(
      {
        SUPABASE_URL: 'https://proyecto.supabase.co',
        SOCIAL_TOKEN_KEYS: keys,
        GOOGLE_DRIVE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
        GOOGLE_DRIVE_CLIENT_SECRET: 'secreto-de-cliente',
        DRIVE_APP_URL: 'https://app.test',
      },
      [],
    );
    // La vuelta de Google se deduce de la URL https de Supabase.
    expect(drive.drive).toBe(true);
  });
});

describe('Probar conexión de Google Drive (sin red)', () => {
  const keys = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
  const noNetwork: ProbeFetch = async () => {
    throw new TypeError('sin red');
  };

  it('con todo configurado dice que el cliente se comprueba al conectar, sin llamar a nadie', async () => {
    const env = {
      SUPABASE_URL: 'https://proyecto.supabase.co',
      SOCIAL_TOKEN_KEYS: keys,
      GOOGLE_DRIVE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
      GOOGLE_DRIVE_CLIENT_SECRET: 'secreto-de-cliente-0123',
      DRIVE_APP_URL: 'https://app.test',
    };
    const r = await probeIntegration('google_drive', env, { fetch: noNetwork });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.ok === null)?.message).toMatch(/se comprueba al conectar/);
    expect(JSON.stringify(r)).not.toContain('secreto-de-cliente');
  });

  it('sin cliente ni claves dice qué falta (solo nombres)', async () => {
    const r = await probeIntegration(
      'google_drive',
      { SUPABASE_URL: 'https://proyecto.supabase.co' },
      { fetch: noNetwork },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/GOOGLE_DRIVE_CLIENT_ID/);
    expect(r.message).toMatch(/SOCIAL_TOKEN_KEYS/);
  });

  it('valida el ID de cliente', () => {
    expect(validateSetting('GOOGLE_DRIVE_CLIENT_ID', '123-abc.apps.googleusercontent.com')).toBeNull();
    expect(validateSetting('GOOGLE_DRIVE_CLIENT_ID', 'otra-cosa')).toMatch(/googleusercontent/);
  });
});

describe('Probar conexión (servicios simulados)', () => {
  const calls: string[] = [];
  const fake =
    (routes: Record<string, (init?: RequestInit) => Response>): ProbeFetch =>
    async (input, init) => {
      calls.push(input);
      const key = Object.keys(routes).find((k) => input.startsWith(k));
      if (!key) throw new TypeError('sin red');
      return routes[key]!(init);
    };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const keys = `k1:${Buffer.alloc(32, 1).toString('base64')}`;

  it('Meta: reconoce la aplicación con el token de aplicación (Graph API simulada)', async () => {
    const graph = createSimulatedGraph();
    const env = {
      META_APP_ID: '1234567890',
      META_APP_SECRET: SECRET,
      SOCIAL_TOKEN_KEYS: keys,
      SUPABASE_URL: 'https://proyecto.supabase.test',
      SOCIAL_APP_URL: 'https://app.test',
    };
    const good = await probeIntegration('meta', env, { fetch: fake({}), graphFetch: graph.fetch });
    expect(good).toMatchObject({ ok: true });
    expect(good.message).toContain('Aplicación simulada');
    expect(good.message).toContain('Conectar con Meta');
    // Meta reconoce la aplicación, pero sin la dirección de la aplicación no sale el botón de OAuth:
    // la prueba lo dice en vez de dar «Funciona».
    const noAppUrl = await probeIntegration(
      'meta',
      { ...env, SOCIAL_APP_URL: '' },
      { fetch: fake({}), graphFetch: graph.fetch },
    );
    expect(noAppUrl.ok).toBe(false);
    expect(noAppUrl.message).toMatch(/SOCIAL_APP_URL/);
    const bad = await probeIntegration(
      'meta',
      { ...env, META_APP_SECRET: 'malsecreto0123456789' },
      {
        fetch: fake({}),
        graphFetch: graph.fetch,
      },
    );
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/no reconoce/);
    expect(JSON.stringify(bad)).not.toContain('malsecreto');
    const nokeys = await probeIntegration(
      'meta',
      { ...env, SOCIAL_TOKEN_KEYS: '' },
      { fetch: fake({}), graphFetch: graph.fetch },
    );
    expect(nokeys.ok).toBe(false);
    expect(nokeys.message).toMatch(/SOCIAL_TOKEN_KEYS/);
  });

  it('ComfyUI: /system_stats con el token; sin red lo dice', async () => {
    let auth = '';
    const comfy = fake({
      'https://comfy.test/system_stats': (init) => {
        auth = new Headers(init?.headers).get('authorization') ?? '';
        return ok({
          system: { comfyui_version: '0.9.1' },
          devices: [{ name: 'NVIDIA T4', vram_free: 15 * 1024 ** 3 }],
        });
      },
    });
    const r = await probeIntegration(
      'comfyui',
      { COMFYUI_BASE_URL: 'https://comfy.test', COMFYUI_API_TOKEN: 'token-de-prueba', COMFYUI_DATA_REGION: 'eu' },
      { fetch: comfy },
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/0\.9\.1.*T4.*15\.0 GB/);
    expect(auth).toBe('Bearer token-de-prueba');
    const down = await probeIntegration('comfyui', { COMFYUI_BASE_URL: 'https://caido.test' }, { fetch: comfy });
    expect(down.ok).toBe(false);
    expect(down.message).toMatch(/No se pudo llegar/);
    const insecure = await probeIntegration('comfyui', { COMFYUI_BASE_URL: 'http://comfy.test' }, { fetch: comfy });
    expect(insecure.ok).toBe(false);
  });

  it('IA de texto: lista modelos de Mistral y Anthropic; avisa si faltan precios', async () => {
    const providers = fake({
      'https://api.mistral.ai/v1/models': () => ok({ data: [] }),
      'https://api.anthropic.com/v1/models': () => new Response('{}', { status: 401 }),
    });
    const prices = JSON.stringify({
      'mistral/mistral-medium': { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 1 },
    });
    const r = await probeIntegration(
      'ai_text',
      {
        AI_TEXT_PROVIDER: 'mistral',
        AI_TEXT_MODEL: 'mistral-medium',
        MISTRAL_API_KEY: 'clave-mistral',
        AI_PRICES: prices,
      },
      { fetch: providers },
    );
    expect(r).toMatchObject({ ok: true, message: 'Mistral acepta la clave.' });
    const anthropic = await probeIntegration(
      'ai_text',
      {
        AI_TEXT_PROVIDER: 'anthropic',
        AI_TEXT_MODEL: 'claude',
        ANTHROPIC_API_KEY: 'clave-anthropic',
        AI_ALLOW_NON_EU_PROCESSING: 'true',
      },
      { fetch: providers },
    );
    expect(anthropic.ok).toBe(false);
    expect(anthropic.message).toMatch(/rechaza la clave.*Precios|rechaza la clave/);
    const empty = await probeIntegration('ai_text', {}, { fetch: providers });
    expect(empty).toMatchObject({ ok: false });
    expect(empty.message).toMatch(/ninguna tarea/);
  });

  it('IA de texto: OpenAI lista modelos en el endpoint de la UE con sus cabeceras', async () => {
    const seen: Record<string, string>[] = [];
    const providers = fake({
      'https://eu.api.openai.com/v1/models': (init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return ok({ data: [] });
      },
    });
    const prices = JSON.stringify({
      'openai/gpt-x': { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0.1 },
    });
    const r = await probeIntegration(
      'ai_text',
      {
        AI_TEXT_PROVIDER: 'openai',
        AI_TEXT_MODEL: 'gpt-x',
        OPENAI_API_KEY: 'clave-openai',
        OPENAI_BASE_URL: 'https://eu.api.openai.com',
        OPENAI_PROJECT: 'proj_x',
        AI_PRICES: prices,
      },
      { fetch: providers },
    );
    expect(r).toMatchObject({ ok: true, message: 'OpenAI acepta la clave (eu.api.openai.com).' });
    expect(seen[0]).toMatchObject({ Authorization: 'Bearer clave-openai', 'OpenAI-Project': 'proj_x' });
    expect(JSON.stringify(r)).not.toContain('clave-openai');
    // Sin admitir otro tratamiento, la dirección global no se prueba ni se carga.
    const global = await probeIntegration(
      'ai_text',
      { AI_TEXT_PROVIDER: 'openai', AI_TEXT_MODEL: 'gpt-x', OPENAI_API_KEY: 'clave-openai' },
      { fetch: providers },
    );
    expect(global.ok).toBe(false);
    expect(global.message).toMatch(/eu\.api\.openai\.com/);
  });

  it('IA de imagen: saldo de Black Forest Labs; Ideogram no se puede comprobar gratis', async () => {
    const r = await probeIntegration(
      'ai_image',
      { BFL_API_KEY: 'clave-bfl', IDEOGRAM_API_KEY: 'clave-ideogram' },
      { fetch: fake({ 'https://api.eu.bfl.ai/v1/credits': () => ok({ credits: 10 }) }) },
    );
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'Ideogram')).toMatchObject({ ok: null });
  });

  it('Stripe: /v1/account con la clave; el webhook se comprueba con el primer aviso', async () => {
    const r = await probeIntegration(
      'stripe',
      { STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc', BILLING_APP_URL: 'https://app.test' },
      { fetch: fake({ 'https://api.stripe.com/v1/account': () => ok({ id: 'acct_1' }) }) },
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/modo de pruebas/);
    expect(calls.filter((c) => c.includes('stripe'))).toHaveLength(1);
  });
});

describe('función platform-integrations', () => {
  const tokens = new Map<string, TestUser>();
  let probed: Array<{ id: string; env: Record<string, string | undefined> }> = [];
  const loaderEnv = { COMFYUI_BASE_URL: 'https://desde-el-entorno.test' };

  function handler() {
    const settings = createSettingsLoader({
      baseEnv: loaderEnv,
      async readStored() {
        const [row] = await asService<{ data: Record<string, unknown> }>(
          db,
          `select public.integration_settings_for_service() as data`,
        );
        return row!.data;
      },
    });
    return createPlatformIntegrationsHandler({
      rpc: rpcAs(null),
      userRpc: (token) => rpcAs(tokens.get(token) ?? null),
      authenticate: async (token) => (tokens.has(token) ? { userId: tokens.get(token)!.id } : null),
      settings,
      baseEnv: loaderEnv,
      imageModelRows: async () => [],
      probe: async (id, env) => {
        probed.push({ id, env });
        return { ok: true, message: 'Simulado: responde.', checks: [] };
      },
      randomKey: () => Buffer.alloc(32, 9).toString('base64'),
      now: () => new Date('2026-11-20T10:11:12Z'),
    });
  }
  const post = async (token: string, body: unknown) => {
    const res = await handler()(
      new Request('http://funciones.test/platform-integrations', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(() => {
    tokens.set('t-root', root);
    tokens.set('t-ana', ana);
  });

  it('sin sesión, 401; cualquiera con sesión pregunta la disponibilidad (solo booleanos)', async () => {
    expect((await post('t-nadie', { action: 'availability' })).status).toBe(401);
    const r = await post('t-ana', { action: 'availability' });
    expect(r.status).toBe(200);
    expect(Object.values(r.body).every((v) => typeof v === 'boolean')).toBe(true);
  });

  it('solo el superadministrador ve el estado, guarda, prueba y genera claves', async () => {
    for (const body of [
      { action: 'status' },
      { action: 'save', integration: 'comfyui', values: { COMFYUI_API_TOKEN: 'x'.repeat(20) } },
      { action: 'test', integration: 'comfyui' },
      { action: 'generate_token_key' },
    ]) {
      expect((await post('t-ana', body)).status).toBe(403);
    }
  });

  it('guarda una integración, la prueba con lo guardado y el navegador nunca recibe el secreto', async () => {
    const token = 'token-comfy-de-prueba-0123456789';
    const saved = await post('t-root', {
      action: 'save',
      integration: 'comfyui',
      values: { COMFYUI_BASE_URL: 'https://comfy.prueba.test', COMFYUI_API_TOKEN: token, COMFYUI_DATA_REGION: 'eu' },
    });
    expect(saved).toMatchObject({ status: 200 });
    probed = [];
    const tested = await post('t-root', { action: 'test', integration: 'comfyui' });
    expect(tested.body).toMatchObject({ ok: true });
    // La prueba usa lo guardado, que manda sobre la variable de entorno.
    expect(probed[0]!.env.COMFYUI_BASE_URL).toBe('https://comfy.prueba.test');
    expect(probed[0]!.env.COMFYUI_API_TOKEN).toBe(token);
    const status = await post('t-root', { action: 'status' });
    const text = JSON.stringify(status.body);
    expect(text).not.toContain(token);
    expect(text).toContain('…6789');
    expect(status.body.environment).toEqual(['COMFYUI_BASE_URL']);
    const audit = status.body.audit as Array<{ action: string; integration: string }>;
    expect(audit.some((a) => a.action === 'test' && a.integration === 'comfyui')).toBe(true);
    // Borrar: vuelve a la variable de entorno.
    await post('t-root', { action: 'save', integration: 'comfyui', values: { COMFYUI_BASE_URL: null } });
    probed = [];
    await post('t-root', { action: 'test', integration: 'comfyui' });
    expect(probed[0]!.env.COMFYUI_BASE_URL).toBe('https://desde-el-entorno.test');
  });

  it('rechaza ajustes de otra integración, valores mal formados y las claves de cifrado a mano', async () => {
    const other = await post('t-root', { action: 'save', integration: 'comfyui', values: { META_APP_ID: '123456' } });
    expect(other.status).toBe(400);
    const bad = await post('t-root', { action: 'save', integration: 'meta', values: { META_GRAPH_API_VERSION: '27' } });
    expect(bad).toMatchObject({ status: 400 });
    const keys = await post('t-root', { action: 'save', integration: 'meta', values: { SOCIAL_TOKEN_KEYS: 'a:b' } });
    expect(keys.status).toBe(400);
    const secretBad = await post('t-root', {
      action: 'save',
      integration: 'stripe',
      values: { STRIPE_SECRET_KEY: 'esto-no-es-una-clave-de-stripe' },
    });
    expect(secretBad.status).toBe(400);
    expect(JSON.stringify(secretBad.body)).not.toContain('esto-no-es');
  });

  it('genera una clave de cifrado nueva sin quitar las anteriores', async () => {
    const r = await post('t-root', { action: 'generate_token_key' });
    expect(r.body).toEqual({ keyId: 'k20261120101112' });
    const [row] = await asService<{ data: Record<string, string> }>(
      db,
      `select public.integration_settings_for_service() as data`,
    );
    const ring = parseKeyRing(row!.data.SOCIAL_TOKEN_KEYS, row!.data.SOCIAL_TOKEN_KEY_ID);
    expect([...ring.keys.keys()]).toEqual(['k1', 'k2', 'k20261120101112']);
    expect(ring.currentKeyId).toBe('k20261120101112');
    // Y no vuelve al navegador.
    const status = await post('t-root', { action: 'status' });
    expect(JSON.stringify(status.body)).not.toContain(Buffer.alloc(32, 9).toString('base64'));
  });

  it('el token del trabajador: se genera, sale una vez, solo se guarda su huella y se revoca', async () => {
    expect((await post('t-ana', { action: 'generate_worker_token' })).status).toBe(403);
    // A mano no se pone (ni por la función ni directamente en la base de datos).
    const manual = await post('t-root', {
      action: 'save',
      integration: 'media_worker',
      values: { WORKER_GATEWAY_TOKEN: `rrss_wgt_${'x'.repeat(43)}` },
    });
    expect(manual.status).toBe(400);
    await expect(
      as(
        db,
        root,
        `select public.admin_set_integration_setting('WORKER_GATEWAY_TOKEN', 'sb_secret_pegada_a_mano_000')`,
      ),
    ).rejects.toThrow(/Generar token/);

    const r = await post('t-root', { action: 'generate_worker_token' });
    expect(r.status).toBe(200);
    const token = r.body.token as string;
    expect(token).toMatch(/^rrss_wgt_[A-Za-z0-9_-]{43}$/);
    const [row] = await asService<{ data: Record<string, string> }>(
      db,
      `select public.integration_settings_for_service() as data`,
    );
    expect(row!.data.WORKER_GATEWAY_TOKEN).toBe(`sha256:${createHash('sha256').update(token).digest('hex')}`);
    const status = await post('t-root', { action: 'status' });
    expect(JSON.stringify(status.body)).not.toContain(token);
    // Rotar da otro distinto; revocar lo borra.
    const again = await post('t-root', { action: 'generate_worker_token' });
    expect(again.body.token).not.toBe(token);
    const revoked = await post('t-root', {
      action: 'save',
      integration: 'media_worker',
      values: { WORKER_GATEWAY_TOKEN: null },
    });
    expect(revoked.status).toBe(200);
    const [after] = await asService<{ data: Record<string, string> }>(
      db,
      `select public.integration_settings_for_service() as data`,
    );
    expect(after!.data.WORKER_GATEWAY_TOKEN).toBeUndefined();
  });
});

describe('conectar Instagram con un token', () => {
  let graph: SimulatedGraph;
  const KEYS = parseKeyRing(`k1:${Buffer.alloc(32, 3).toString('base64')}`, 'k1');
  const PAGE_TOKEN = `sim-page-${SIMULATED_PAGE_ID}-token-largo-de-prueba`;
  let marcaToken: string;
  let editorT: TestUser;

  function config(overrides: Partial<SocialConfig> = {}): SocialConfig {
    return {
      graph: createMetaGraph({ fetch: graph.fetch }),
      simulated: false,
      keyRing: KEYS,
      // Sin aplicación de Meta del producto: con token no hace falta.
      meta: null,
      callbackUrl: null,
      appUrl: null,
      problems: [],
      ...overrides,
    };
  }

  beforeAll(async () => {
    graph = createSimulatedGraph();
    marcaToken = await createBrand(db, ana, org, 'Marca con token');
    editorT = await createUser(db, 'editor@integraciones.test', 'Editor');
    const { join } = await import('./helpers');
    await join(db, ana, editorT, org, 'member', marcaToken, 'editor');
  });

  const input = (accessToken = PAGE_TOKEN, igUserId = SIMULATED_IG_USER_ID) => ({
    brandId: marcaToken,
    network: 'instagram',
    igUserId,
    accessToken,
  });

  it('valida el token contra la Graph API, lo guarda cifrado y la cuenta queda «con token»', async () => {
    const r = await connectWithToken(config(), rpcAs(null), rpcAs(ana), input());
    expect(r.username).toBe('cuenta_simulada');
    expect(r.tokenType).toBe('PAGE');
    expect(r.expiresAt).toBeNull();
    expect(r.dataAccessExpiresAt).not.toBeNull();
    const [account] = await db.query<{
      id: string;
      connection_method: string;
      page_id: string;
      token_expires_at: string;
    }>(`select * from public.social_accounts where brand_id = $1 and status = 'active'`, [marcaToken]);
    expect(account!.connection_method).toBe('token');
    expect(account!.page_id).toBe(SIMULATED_PAGE_ID);
    expect(account!.token_expires_at).not.toBeNull();
    const [secret] = await db.query<{ key_id: string; access_token_ciphertext: string }>(
      `select * from private.social_account_secrets where account_id = $1`,
      [account!.id],
    );
    expect(secret!.access_token_ciphertext).not.toContain('sim-page');
    const plain = await decryptToken(
      KEYS,
      secret!.key_id,
      secret!.access_token_ciphertext,
      tokenBinding({ brandId: marcaToken, network: 'instagram', externalId: SIMULATED_IG_USER_ID }),
    );
    expect(plain).toBe(PAGE_TOKEN);
    // La comprobación diaria lo valida consigo mismo, sin aplicación del producto.
    expect(
      await checkAccountTokens(config(), rpcAs(null), [
        { id: account!.id, brand_id: marcaToken, network: 'instagram', external_id: SIMULATED_IG_USER_ID },
      ]),
    ).toBe(1);
    graph.expireToken(PAGE_TOKEN);
    await checkAccountTokens(config(), rpcAs(null), [
      { id: account!.id, brand_id: marcaToken, network: 'instagram', external_id: SIMULATED_IG_USER_ID },
    ]);
    const [after] = await db.query<{ status: string; last_error: string }>(
      `select status, last_error from public.social_accounts where id = $1`,
      [account!.id],
    );
    expect(after).toMatchObject({ status: 'needs_reauth' });
    expect(after!.last_error).toMatch(/pega uno nuevo/);
  });

  it('rechaza tokens no válidos, de otra cuenta, de Instagram Login y a quien no gestiona la marca', async () => {
    await expect(
      connectWithToken(config(), rpcAs(null), rpcAs(ana), input('otro-token-que-no-vale-0000')),
    ).rejects.toMatchObject({
      code: 'invalid_token',
    });
    await expect(
      connectWithToken(
        config(),
        rpcAs(null),
        rpcAs(ana),
        input(`sim-page-${SIMULATED_PAGE_ID}-otro-token-largo`, '17841499999999999'),
      ),
    ).rejects.toMatchObject({ code: 'wrong_account' });
    await expect(
      connectWithToken(config(), rpcAs(null), rpcAs(ana), input('IGQVJ-token-de-instagram-login')),
    ).rejects.toMatchObject({
      code: 'unsupported_token',
    });
    await expect(
      connectWithToken(config(), rpcAs(null), rpcAs(editorT), input(`sim-page-${SIMULATED_PAGE_ID}-token-del-editor`)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(connectWithToken(config({ keyRing: null }), rpcAs(null), rpcAs(ana), input())).rejects.toMatchObject({
      status: 503,
    });
  });

  it('por la función social-connect: POST /token con la sesión; la respuesta no lleva el token', async () => {
    const h = createSocialConnectHandler({ config: config(), rpc: rpcAs(null), userRpc: () => rpcAs(ana) });
    const token = `sim-page-${SIMULATED_PAGE_ID}-por-la-funcion-0001`;
    const res = await h(
      new Request('http://funciones.test/social-connect/token', {
        method: 'POST',
        headers: { authorization: 'Bearer sesion', 'content-type': 'application/json' },
        body: JSON.stringify(input(token)),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toMatchObject({ username: 'cuenta_simulada', tokenType: 'PAGE' });
    const unauth = await h(new Request('http://funciones.test/social-connect/token', { method: 'POST', body: '{}' }));
    expect(unauth.status).toBe(401);
  });

  it('volver a conectar por OAuth la deja como «oauth»', async () => {
    const cfg = loadSocialConfig({ SOCIAL_TOKEN_KEYS: `k1:${Buffer.alloc(32, 3).toString('base64')}` }, graph.fetch);
    expect(cfg.keyRing).not.toBeNull();
    await rpcAs(null)('social_account_connect', {
      p_user_id: ana.id,
      p_brand_id: marcaToken,
      p_network: 'instagram',
      p_external_id: SIMULATED_IG_USER_ID,
      p_username: 'cuenta_simulada',
      p_display_name: '',
      p_page_id: SIMULATED_PAGE_ID,
      p_scopes: ['instagram_basic'],
      p_token_expires_at: null,
      p_key_id: 'k1',
      p_access_token_ciphertext: 'cifrado-de-prueba-yyyyyyyy',
    });
    const [account] = await db.query<{ connection_method: string }>(
      `select connection_method from public.social_accounts where brand_id = $1 and status <> 'disconnected'`,
      [marcaToken],
    );
    expect(account!.connection_method).toBe('oauth');
  });
});
