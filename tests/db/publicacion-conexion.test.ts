// Conectar una cuenta de Instagram (OAuth con Facebook Login for Business)
// contra las migraciones reales y la Graph API SIMULADA; cifrado de los
// tokens; clasificación de los errores de Meta y la guarda de solo local.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { LocalTestConfigError } from '../../supabase/functions/_shared/ai/text/local-test.ts';
import { composeCaption } from '../../supabase/functions/_shared/social/caption.ts';
import { loadSocialConfig, type SocialConfig } from '../../supabase/functions/_shared/social/config.ts';
import {
  decryptToken,
  encryptToken,
  parseKeyRing,
  tokenBinding,
  TokenKeyError,
} from '../../supabase/functions/_shared/social/crypto.ts';
import { loadSocialLocalTest } from '../../supabase/functions/_shared/social/local-test.ts';
import { classifyGraphError, createMetaGraph } from '../../supabase/functions/_shared/social/meta-graph.ts';
import { checkAccountTokens, startConnect } from '../../supabase/functions/_shared/social/oauth.ts';
import {
  createSimulatedGraph,
  SIMULATED_IG_USER_ID,
  type SimulatedGraph,
} from '../../supabase/functions/_shared/social/simulated-graph.ts';
import { createSocialConnectHandler } from '../../supabase/functions/social-connect/handler.ts';
import { as, asService, createBrand, createDb, createOrg, createUser, join, type Db, type TestUser } from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser;
let org: string, marca: string;
let graph: SimulatedGraph;

const KEYS = parseKeyRing(`k1:${Buffer.alloc(32, 3).toString('base64')}`, 'k1');
const APP = 'http://app.pruebas.test';
const CALLBACK = 'http://funciones.pruebas.test/functions/v1/social-connect/callback';

function call(user: TestUser | null): RpcClient {
  return async (fn, args) => {
    const names = Object.keys(args).filter((n) => args[n] !== undefined);
    const params = names.map((n) => args[n]);
    const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
    const sql = `select to_jsonb(public.${fn}(${list})) as data`;
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

function config(overrides: Partial<SocialConfig> = {}): SocialConfig {
  return {
    graph: createMetaGraph({ fetch: graph.fetch }),
    simulated: false,
    keyRing: KEYS,
    meta: { appId: 'app', appSecret: 'secreto', configId: 'cfg-1', scopes: ['instagram_basic'] },
    callbackUrl: CALLBACK,
    appUrl: APP,
    problems: [],
    ...overrides,
  };
}

function handler(cfg = config()) {
  return createSocialConnectHandler({ config: cfg, rpc: call(null), userRpc: () => call(ana) });
}

async function start(user: TestUser, cfg = config()): Promise<string> {
  return startConnect(cfg, call(user), { brandId: marca, network: 'instagram' });
}

async function callback(query: Record<string, string>, cfg = config()): Promise<string> {
  const u = new URL(CALLBACK);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const res = await handler(cfg)(new Request(u));
  expect(res.status).toBe(302);
  return res.headers.get('location')!;
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@conexion.test', 'Ana');
  editor = await createUser(db, 'editor@conexion.test', 'Editor');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  graph = createSimulatedGraph();
});

afterAll(async () => {
  await db?.close();
});

describe('conectar una cuenta (OAuth)', () => {
  it('quien gestiona la marca recibe el diálogo de Meta con el estado anti-CSRF y la configuración', async () => {
    const url = new URL(await start(ana));
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v27.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app');
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('config_id')).toBe('cfg-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
    // Solo se guarda la huella del estado, y nadie del cliente la lee.
    const [fila] = await db.query<{ state_hash: string }>(`select state_hash from private.social_oauth_states limit 1`);
    expect(fila!.state_hash).not.toBe(url.searchParams.get('state'));
    await expect(as(db, ana, `select * from private.social_oauth_states`)).rejects.toThrow(/permission denied/);
  });

  it('quien solo edita no conecta ni desconecta', async () => {
    await expect(start(editor)).rejects.toMatchObject({ status: 403 });
  });

  it('vuelta de Meta: guarda la cuenta con el token cifrado y vuelve a la aplicación', async () => {
    const state = new URL(await start(ana)).searchParams.get('state')!;
    const location = await callback({ code: 'sim-code-1', state });
    expect(location).toBe(`${APP}/o/${org}/m/${marca}/marca?seccion=datos&social=connected`);

    const [cuenta] = await as<{ id: string; status: string; external_id: string; username: string; scopes: string[] }>(
      db,
      editor,
      `select id, status, external_id, username, scopes from public.social_accounts where brand_id = $1`,
      [marca],
    );
    expect(cuenta).toMatchObject({ status: 'active', external_id: SIMULATED_IG_USER_ID, username: 'cuenta_simulada' });
    expect(cuenta!.scopes).toContain('instagram_content_publish');

    // El token no es legible desde el cliente, ni en claro en la base de datos.
    await expect(as(db, ana, `select * from private.social_account_secrets`)).rejects.toThrow(/permission denied/);
    await expect(as(db, ana, `select public.social_account_token($1)`, [cuenta!.id])).rejects.toThrow(
      /permission denied/,
    );
    const [secreto] = await db.query<{ access_token_ciphertext: string; key_id: string }>(
      `select key_id, access_token_ciphertext from private.social_account_secrets where account_id = $1`,
      [cuenta!.id],
    );
    expect(secreto!.access_token_ciphertext).not.toMatch(/sim-page/);
    const claro = await decryptToken(
      KEYS,
      secreto!.key_id,
      secreto!.access_token_ciphertext,
      tokenBinding({ brandId: marca, network: 'instagram', externalId: SIMULATED_IG_USER_ID }),
    );
    expect(claro).toMatch(/^sim-page-/);

    // El estado no se puede volver a usar.
    expect(await callback({ code: 'sim-code-2', state })).toBe(`${APP}/?social=expired`);
  });

  it('volver a conectar la misma cuenta la renueva (misma fila); cancelar en Meta vuelve con «denied»', async () => {
    const [antes] = await db.query<{ id: string }>(`select id from public.social_accounts where brand_id = $1`, [
      marca,
    ]);
    const state = new URL(await start(ana)).searchParams.get('state')!;
    await callback({ code: 'sim-code-3', state });
    const filas = await db.query<{ id: string }>(
      `select id from public.social_accounts where brand_id = $1 and status <> 'disconnected'`,
      [marca],
    );
    expect(filas).toEqual([{ id: antes!.id }]);

    const state2 = new URL(await start(ana)).searchParams.get('state')!;
    expect(await callback({ error: 'access_denied', state: state2 })).toBe(
      `${APP}/o/${org}/m/${marca}/marca?seccion=datos&social=denied`,
    );
  });

  it('un estado inventado o caducado no conecta nada', async () => {
    expect(await callback({ code: 'sim-code-4', state: 'f'.repeat(64) })).toBe(`${APP}/?social=expired`);
    const state = new URL(await start(ana)).searchParams.get('state')!;
    await db.query(`update private.social_oauth_states set expires_at = now() - interval '1 second'`);
    expect(await callback({ code: 'sim-code-5', state })).toBe(`${APP}/?social=expired`);
  });

  it('sin cuenta de Instagram o con varias, no se elige por la persona', async () => {
    const sinIg = createSimulatedGraph({ pages: [{ id: '1', name: 'Página', instagram: null }] });
    const varias = createSimulatedGraph({
      pages: [
        { id: '1', name: 'A', instagram: { id: '11', username: 'a' } },
        { id: '2', name: 'B', instagram: { id: '22', username: 'b' } },
      ],
    });
    const s1 = new URL(await start(ana)).searchParams.get('state')!;
    expect(
      await callback({ code: 'sim-code-6', state: s1 }, config({ graph: createMetaGraph({ fetch: sinIg.fetch }) })),
    ).toMatch(/social=no_instagram$/);
    const s2 = new URL(await start(ana)).searchParams.get('state')!;
    expect(
      await callback({ code: 'sim-code-7', state: s2 }, config({ graph: createMetaGraph({ fetch: varias.fetch }) })),
    ).toMatch(/social=several_accounts$/);
  });

  it('el inicio exige sesión y una configuración completa', async () => {
    const h = handler();
    const sin = await h(new Request(`${CALLBACK.replace('/callback', '/start')}`, { method: 'POST', body: '{}' }));
    expect(sin.status).toBe(401);
    const con = await h(
      new Request(`${CALLBACK.replace('/callback', '/start')}`, {
        method: 'POST',
        headers: { authorization: 'Bearer token-de-ana' },
        body: JSON.stringify({ brandId: marca, network: 'instagram' }),
      }),
    );
    expect(con.status).toBe(200);
    expect(((await con.json()) as { url: string }).url).toMatch(/^https:\/\/www\.facebook\.com\//);
    await expect(
      startConnect(config({ meta: null }), call(ana), { brandId: marca, network: 'instagram' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('en la prueba local (simulada) no hay diálogo de Meta: se vuelve directo al callback', async () => {
    const url = new URL(await start(ana, config({ simulated: true })));
    expect(url.toString().startsWith(CALLBACK)).toBe(true);
    expect(url.searchParams.get('code')).toMatch(/^sim-code-/);
  });

  it('la comprobación diaria marca la cuenta si Meta dice que el token ya no vale', async () => {
    const [cuenta] = await db.query<{ id: string; external_id: string }>(
      `select id, external_id from public.social_accounts where brand_id = $1 and status = 'active'`,
      [marca],
    );
    const [secreto] = await db.query<{ key_id: string; access_token_ciphertext: string }>(
      `select key_id, access_token_ciphertext from private.social_account_secrets where account_id = $1`,
      [cuenta!.id],
    );
    const token = await decryptToken(
      KEYS,
      secreto!.key_id,
      secreto!.access_token_ciphertext,
      tokenBinding({ brandId: marca, network: 'instagram', externalId: cuenta!.external_id }),
    );
    graph.expireToken(token);
    const n = await checkAccountTokens(config(), call(null), [
      { id: cuenta!.id, brand_id: marca, network: 'instagram', external_id: cuenta!.external_id },
    ]);
    expect(n).toBe(1);
    const [despues] = await db.query(
      `select status, token_checked_at is not null as comprobada from public.social_accounts where id = $1`,
      [cuenta!.id],
    );
    expect(despues).toEqual({ status: 'needs_reauth', comprobada: true });
  });
});

describe('cifrado de los tokens', () => {
  const binding = tokenBinding({ brandId: 'b', network: 'instagram', externalId: '1' });

  it('cifra con IV aleatorio y descifra solo con la misma cuenta', async () => {
    const a = await encryptToken(KEYS, 'secreto', binding);
    const b = await encryptToken(KEYS, 'secreto', binding);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptToken(KEYS, a.keyId, a.ciphertext, binding)).toBe('secreto');
    await expect(
      decryptToken(
        KEYS,
        a.keyId,
        a.ciphertext,
        tokenBinding({ brandId: 'otra', network: 'instagram', externalId: '1' }),
      ),
    ).rejects.toBeInstanceOf(TokenKeyError);
  });

  it('rota claves: la vieja descifra, la nueva cifra', async () => {
    const vieja = await encryptToken(KEYS, 'secreto', binding);
    const anillo = parseKeyRing(
      `k1:${Buffer.alloc(32, 3).toString('base64')},k2:${Buffer.alloc(32, 9).toString('base64')}`,
      'k2',
    );
    expect(await decryptToken(anillo, vieja.keyId, vieja.ciphertext, binding)).toBe('secreto');
    expect((await encryptToken(anillo, 'x', binding)).keyId).toBe('k2');
  });

  it('rechaza claves mal formadas', () => {
    expect(() => parseKeyRing(undefined, undefined)).toThrow(TokenKeyError);
    expect(() => parseKeyRing('k1:corta', 'k1')).toThrow(/32 bytes|base64/);
    expect(() => parseKeyRing(`k1:${Buffer.alloc(32).toString('base64')}`, 'k9')).toThrow(/SOCIAL_TOKEN_KEY_ID/);
  });
});

describe('errores de Meta y guarda de solo local', () => {
  it('clasifica los errores documentados', () => {
    expect(classifyGraphError(401, { error: { code: 190, message: 'expired' } }).kind).toBe('token');
    expect(classifyGraphError(400, { error: { code: 9, error_subcode: 2207042 } }).kind).toBe('publish_limit');
    expect(classifyGraphError(400, { error: { code: 4 } }).kind).toBe('rate_limited');
    expect(classifyGraphError(503, { error: { code: 2 } }).kind).toBe('transient');
    expect(classifyGraphError(400, { error: { code: 100, error_subcode: 2207009 } }).kind).toBe('rejected');
  });

  it('la Graph API simulada solo se activa con la variable Y un Supabase local', () => {
    expect(loadSocialLocalTest({})).toBeNull();
    expect(() =>
      loadSocialLocalTest({ SOCIAL_E2E_SIMULATED_GRAPH: 'true', SUPABASE_URL: 'https://abc.supabase.co' }),
    ).toThrow(LocalTestConfigError);
    expect(() =>
      loadSocialLocalTest({ SOCIAL_E2E_SIMULATED_GRAPH: 'si', SUPABASE_URL: 'http://127.0.0.1:55321' }),
    ).toThrow(LocalTestConfigError);
    const local = loadSocialLocalTest({ SOCIAL_E2E_SIMULATED_GRAPH: 'true', SUPABASE_URL: 'http://kong:8000' });
    expect(local?.problems[0]).toMatch(/SIMULADA/);
    // Fuera de local, la configuración usa el fetch real y dice lo que falta.
    const real = loadSocialConfig({}, async () => new Response('{}'));
    expect(real.simulated).toBe(false);
    expect(real.problems.join(' ')).toMatch(/META_APP_ID.*META_APP_SECRET|SOCIAL_TOKEN_KEYS/);
  });

  it('el texto publicado añade al final los hashtags que no están ya en el pie', () => {
    expect(composeCaption({ caption: 'Hola #Pan', hashtags: ['pan', '#Otoño', 'otoño'], altText: '' })).toBe(
      'Hola #Pan\n\n#Otoño',
    );
    expect(composeCaption({ caption: 'Solo texto', hashtags: [], altText: '' })).toBe('Solo texto');
  });
});
