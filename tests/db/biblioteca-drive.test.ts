// Biblioteca con Google Drive contra las migraciones reales y Drive SIMULADO:
// conectar (OAuth), elegir fotos, darlas de alta, firmar direcciones y servir
// la imagen; quién puede cada cosa y que nada ocupe Storage ni el plan.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { LocalTestConfigError } from '../../supabase/functions/_shared/ai/text/local-test.ts';
import type { DriveConfig } from '../../supabase/functions/_shared/drive/config.ts';
import { DRIVE_SCOPES } from '../../supabase/functions/_shared/drive/contract.ts';
import { createGoogleDrive } from '../../supabase/functions/_shared/drive/google-drive.ts';
import { loadDriveLocalTest } from '../../supabase/functions/_shared/drive/local-test.ts';
import {
  createSimulatedDrive,
  SIMULATED_DRIVE_EMAIL,
  type SimulatedDrive,
} from '../../supabase/functions/_shared/drive/simulated-drive.ts';
import { signTicket, verifyTicket } from '../../supabase/functions/_shared/drive/tickets.ts';
import { parseKeyRing } from '../../supabase/functions/_shared/social/crypto.ts';
import { createDriveMediaHandler, type DriveAssetRef } from '../../supabase/functions/drive-media/handler.ts';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  type Db,
  type TestUser,
} from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser, lector: TestUser, berta: TestUser;
let org: string, marca: string, otraMarca: string, orgB: string, marcaB: string;
let drive: SimulatedDrive;

const KEYS = parseKeyRing(`k1:${Buffer.alloc(32, 7).toString('base64')}`, 'k1');
const APP = 'http://app.pruebas.test';
const BASE = 'http://funciones.pruebas.test/functions/v1/drive-media';
const SERVICE = 'clave-de-servicio-de-pruebas';
const tokenOf = (u: TestUser) => `jwt-${u.id}`;

function call(user: TestUser | null): RpcClient {
  return async (fn, args) => {
    const names = Object.keys(args).filter((n) => args[n] !== undefined);
    const params = names.map((n) =>
      Array.isArray(args[n]) || (args[n] && typeof args[n] === 'object') ? JSON.stringify(args[n]) : args[n],
    );
    const list = names
      .map((n, i) => {
        const value = args[n];
        if (Array.isArray(value) && n !== 'p_files')
          return `${n} => (select array_agg(x) from jsonb_array_elements_text($${i + 1}::jsonb) x)`;
        if (n === 'p_files') return `${n} => $${i + 1}::jsonb`;
        return `${n} => $${i + 1}`;
      })
      .join(', ');
    const setReturning = fn === 'drive_assets_import';
    const sql = setReturning
      ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as data from public.${fn}(${list}) r`
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

const users = () => [ana, editor, lector, berta];
const userByToken = (token: string) => users().find((u) => tokenOf(u) === token) ?? null;

function config(overrides: Partial<DriveConfig> = {}): DriveConfig {
  return {
    drive,
    simulated: true,
    keyRing: KEYS,
    client: { clientId: 'cliente', clientSecret: 'secreto' },
    scopes: DRIVE_SCOPES,
    callbackUrl: `${BASE}/callback`,
    appUrl: APP,
    problems: [],
    ...overrides,
  };
}

const clock = Date.parse('2026-11-20T10:15:00Z');

function handler(cfg = config()) {
  return createDriveMediaHandler({
    config: cfg,
    rpc: call(null),
    userRpc: (token) => call(userByToken(token)),
    async assetsForPaths(token, paths) {
      const sql = `select storage_path, drive_connection_id, drive_file_id from public.media_assets
                   where source = 'google_drive' and storage_path = any($1::text[])`;
      if (token === null) return asService<DriveAssetRef & Record<string, unknown>>(db, sql, [paths]);
      const user = userByToken(token);
      return user ? as<DriveAssetRef & Record<string, unknown>>(db, user, sql, [paths]) : [];
    },
    isServiceToken: (t) => t === SERVICE,
    now: () => clock,
  });
}

let h: ReturnType<typeof handler>;

// Respuestas de la función leídas sin tipar: cada prueba mira lo suyo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(path: string, token: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const res = await h(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

async function connect(user: TestUser, orgId = org): Promise<string> {
  const started = await post('/start', tokenOf(user), { organizationId: orgId });
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  const res = await h(new Request(started.json.url));
  expect(res.status).toBe(302);
  return res.headers.get('location')!;
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@drive.test', 'Ana');
  editor = await createUser(db, 'editor@drive.test', 'Editor');
  lector = await createUser(db, 'lector@drive.test', 'Lector');
  berta = await createUser(db, 'berta@drive.test', 'Berta');
  org = await createOrg(db, ana, 'Agencia', 'agency');
  marca = await createBrand(db, ana, org, 'Marca uno');
  otraMarca = await createBrand(db, ana, org, 'Marca dos');
  orgB = await createOrg(db, berta, 'Otra empresa');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
  drive = createSimulatedDrive();
  h = handler();
});

afterAll(async () => {
  await db?.close();
});

describe('conectar Google Drive (OAuth)', () => {
  it('sin configurar no empieza', async () => {
    h = handler(config({ client: null }));
    const res = await post('/start', tokenOf(ana), { organizationId: org });
    expect(res.status).toBe(503);
    h = handler();
  });

  it('solo quien administra la organización conecta', async () => {
    expect((await post('/start', tokenOf(editor), { organizationId: org })).status).toBe(403);
    expect((await post('/start', tokenOf(berta), { organizationId: org })).status).toBe(403);
    expect((await post('/start', null, { organizationId: org })).status).toBe(401);
  });

  it('el adaptador real manda a Google con acceso de solo lectura, sin pedir permiso de escritura', () => {
    const google = createGoogleDrive({ fetch: async () => new Response(null) });
    const url = new URL(
      google.authUrl({ clientId: 'c', redirectUri: `${BASE}/callback`, state: 'e'.repeat(64), scopes: DRIVE_SCOPES }),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toContain('drive.readonly');
    expect(url.searchParams.get('scope')).not.toMatch(/auth\/drive(\s|$)/);
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('al volver de Google guarda la conexión con el token cifrado y vuelve a los ajustes', async () => {
    const location = await connect(ana);
    expect(location).toBe(`${APP}/o/${org}/ajustes/drive?drive=connected`);
    const [conexion] = await as(db, ana, `select account_email, status from public.drive_connections`);
    expect(conexion).toMatchObject({ account_email: SIMULATED_DRIVE_EMAIL, status: 'active' });
    const [secreto] = await db.query<{ refresh_token_ciphertext: string }>(
      `select refresh_token_ciphertext from private.drive_connection_secrets`,
    );
    expect(secreto!.refresh_token_ciphertext).not.toContain('sim-refresh');
    await expect(as(db, ana, `select * from private.drive_connection_secrets`)).rejects.toThrow(/permission denied/);
  });

  it('el estado anti-CSRF solo vale una vez', async () => {
    const started = await post('/start', tokenOf(ana), { organizationId: org });
    await h(new Request(started.json.url));
    const again = await h(new Request(started.json.url));
    expect(again.headers.get('location')).toBe(`${APP}/?drive=expired`);
  });

  it('volver a conectar la misma cuenta no duplica la conexión', async () => {
    await connect(ana);
    const rows = await as(db, ana, `select id from public.drive_connections where status = 'active'`);
    expect(rows).toHaveLength(1);
  });

  it('la ven los miembros de la organización y nadie de fuera', async () => {
    expect(await as(db, lector, `select id from public.drive_connections`)).toHaveLength(1);
    expect(await as(db, berta, `select id from public.drive_connections`)).toEqual([]);
  });
});

describe('elegir fotos y darlas de alta', () => {
  it('quien edita la marca ve las carpetas e imágenes; lo que no se puede pintar sale marcado', async () => {
    const root = await post('/browse', tokenOf(editor), { brandId: marca });
    expect(root.status, JSON.stringify(root.json)).toBe(200);
    expect(root.json.items.map((i: { name: string }) => i.name)).toEqual(['Local', 'Platos']);
    const platos = await post('/browse', tokenOf(editor), { brandId: marca, folderId: 'simFolderPlatos0001' });
    const heic = platos.json.items.find((i: { name: string }) => i.name === 'IMG_0001.HEIC');
    expect(heic).toMatchObject({ supported: false, thumbTicket: null });
    const coca = platos.json.items.find((i: { name: string }) => i.name === 'Coca de verduras.png');
    expect(coca).toMatchObject({ supported: true, width: 96, height: 64 });
    expect(coca.thumbTicket).toMatch(/^v1\./);
  });

  it('quien solo ve la marca, o es de otra organización, no navega el Drive', async () => {
    expect((await post('/browse', tokenOf(lector), { brandId: marca })).status).toBe(403);
    expect((await post('/browse', tokenOf(berta), { brandId: marca })).status).toBe(403);
    // Berta no tiene Drive conectado.
    expect((await post('/browse', tokenOf(berta), { brandId: marcaB })).status).toBe(400);
    expect((await post('/browse', tokenOf(editor), { brandId: marca, folderId: "x' or 1=1" })).status).toBe(400);
  });

  it('da de alta solo con los metadatos de Google, sin archivo en Storage y sin gastar plan', async () => {
    const res = await post('/import', tokenOf(editor), {
      brandId: marca,
      fileIds: ['simImgCoca00000001', 'simImgSala00000001'],
      folder: 'Drive',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.assets).toHaveLength(2);
    const filas = await as(
      db,
      editor,
      `select file_name, mime_type, width, height, source, origin, folder, storage_path, drive_file_id, created_by
       from public.media_assets where brand_id = $1 order by file_name`,
      [marca],
    );
    expect(filas[0]).toMatchObject({
      file_name: 'Coca de verduras.png',
      mime_type: 'image/png',
      width: 96,
      height: 64,
      source: 'google_drive',
      origin: 'import',
      folder: 'Drive',
      storage_path: `${org}/${marca}/drive/simImgCoca00000001`,
      created_by: editor.id,
    });
    const [plan] = await asService<{ bytes: string }>(db, `select private.org_storage_bytes($1)::text as bytes`, [org]);
    expect(Number(plan!.bytes)).toBe(0);
  });

  it('el mismo archivo no se duplica en la marca', async () => {
    await post('/import', tokenOf(editor), { brandId: marca, fileIds: ['simImgCoca00000001'] });
    const filas = await as(db, editor, `select 1 from public.media_assets where drive_file_id = 'simImgCoca00000001'`);
    expect(filas).toHaveLength(1);
  });

  it('no deja añadir HEIC ni nada que no sea una imagen que el navegador pinte', async () => {
    const res = await post('/import', tokenOf(editor), { brandId: marca, fileIds: ['simImgHeic00000001'] });
    expect(res.status).toBe(422);
    expect(res.json.error.message).toMatch(/HEIC/);
  });

  it('desde el cliente no se crea ni se redirige un recurso de Drive', async () => {
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, source, drive_file_id)
       values ($1, $2, 'image', $3, 'x.png', 'image/png', 1, 'google_drive', 'simImgArroz0000001')`,
      [marca, org, `${org}/${marca}/drive/simImgArroz0000001`],
      // Las columnas de Drive ni siquiera se pueden escribir desde el cliente; y si se pudiera, la guarda lo impide.
      /permission denied|servidor/,
    );
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.png', 'image/png', 1)`,
      [marca, org, `${org}/${marca}/drive/simImgArroz0000001`],
      /reservada/,
    );
    await denied(
      db,
      editor,
      `update public.media_assets set drive_file_id = 'simImgArroz0000001',
         storage_path = $2 where drive_file_id = 'simImgSala00000001' and brand_id = $1`,
      [marca, `${org}/${marca}/drive/simImgArroz0000001`],
      /permission denied|No se puede cambiar/,
    );
    // Ni llamar al alta del servidor.
    await denied(
      db,
      editor,
      `select public.drive_assets_import($1, $2, null, '[]'::jsonb)`,
      [editor.id, marca],
      /permission denied/,
    );
  });

  it('el servidor no da de alta en una marca que la persona no edita', async () => {
    const [conexion] = await asService<{ id: string }>(db, `select id from public.drive_connections limit 1`);
    const files = JSON.stringify([{ id: 'simImgArroz0000001', name: 'a.png', mime_type: 'image/png', bytes: 1 }]);
    await expect(
      asService(db, `select * from public.drive_assets_import($1, $2, $3, $4::jsonb)`, [
        editor.id,
        otraMarca,
        conexion!.id,
        files,
      ]),
    ).rejects.toThrow(/edita la marca/);
    // Ni con una conexión de otra organización.
    await expect(
      asService(db, `select * from public.drive_assets_import($1, $2, $3, $4::jsonb)`, [
        berta.id,
        marcaB,
        conexion!.id,
        files,
      ]),
    ).rejects.toThrow(/no es de la organización/);
  });
});

describe('ver las imágenes', () => {
  const ruta = () => `${org}/${marca}/drive/simImgCoca00000001`;

  it('firma solo lo que la persona ve y la dirección sirve el PNG con CORS abierto', async () => {
    const res = await post('/sign', tokenOf(lector), { paths: [ruta()] });
    expect(res.status).toBe(200);
    const ticket = res.json.tickets[ruta()].full as string;
    const img = await h(new Request(`${BASE}/file/${encodeURIComponent(ticket)}`));
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('access-control-allow-origin')).toBe('*');
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
  });

  it('a quien no ve la marca no le firma nada', async () => {
    const res = await post('/sign', tokenOf(berta), { paths: [ruta()] });
    expect(res.json.tickets).toEqual({});
    expect((await post('/sign', null, { paths: [ruta()] })).status).toBe(401);
    expect((await post('/sign', tokenOf(ana), { paths: ['../../etc/passwd'] })).status).toBe(400);
  });

  it('el servidor (trabajador de medios) firma con la clave de servicio', async () => {
    const res = await post('/sign', SERVICE, { paths: [ruta()] });
    expect(Object.keys(res.json.tickets)).toEqual([ruta()]);
  });

  it('una firma tocada, de otra clave o caducada no vale', async () => {
    const [conexion] = await asService<{ id: string }>(db, `select id from public.drive_connections limit 1`);
    const target = { connectionId: conexion!.id, fileId: 'simImgArroz0000001', variant: 'full' as const };
    const t = Math.floor(clock / 1000);
    const ticket = await signTicket(KEYS, target, t);
    expect(await verifyTicket(KEYS, ticket, t)).toEqual(target);
    expect(await verifyTicket(KEYS, ticket.replace('simImgArroz', 'simImgCocaX'), t)).toBeNull();
    const otra = parseKeyRing(`k1:${Buffer.alloc(32, 9).toString('base64')}`, 'k1');
    expect(await verifyTicket(otra, ticket, t)).toBeNull();
    expect(await verifyTicket(KEYS, ticket, t + 3 * 3600)).toBeNull();
    const res = await h(new Request(`${BASE}/file/${encodeURIComponent(ticket.slice(0, -2) + 'xx')}`));
    expect(res.status).toBe(403);
  });

  it('si Google revoca el acceso, la conexión pide volver a conectar', async () => {
    drive.revoke();
    h = handler(); // función nueva: sin token de acceso en memoria
    const res = await post('/browse', tokenOf(editor), { brandId: marca });
    expect(res.status).toBe(409);
    const [conexion] = await as(db, ana, `select status from public.drive_connections where status <> 'disconnected'`);
    expect(conexion).toMatchObject({ status: 'needs_reauth' });
    // Volver a conectar la arregla.
    await connect(ana);
    expect((await post('/browse', tokenOf(editor), { brandId: marca })).status).toBe(200);
  });

  it('desconectar borra el token; los recursos se quedan y vuelven al reconectar', async () => {
    const [conexion] = await as<{ id: string }>(
      db,
      ana,
      `select id from public.drive_connections where status = 'active'`,
    );
    await denied(db, editor, `select public.disconnect_drive($1)`, [conexion!.id], /administra/);
    await as(db, ana, `select public.disconnect_drive($1)`, [conexion!.id]);
    expect(await db.query(`select 1 from private.drive_connection_secrets`)).toEqual([]);
    expect(await as(db, editor, `select 1 from public.media_assets where source = 'google_drive'`)).toHaveLength(2);
    await connect(ana);
    const [nueva] = await as<{ id: string }>(
      db,
      ana,
      `select id from public.drive_connections where status = 'active'`,
    );
    const vinculados = await as(db, editor, `select 1 from public.media_assets where drive_connection_id = $1`, [
      nueva!.id,
    ]);
    expect(vinculados).toHaveLength(2);
  });

  it('borrar un recurso de Drive no anota nada para limpiar en Storage', async () => {
    await as(db, editor, `delete from public.media_assets where drive_file_id = 'simImgSala00000001'`);
    expect(
      await asService(db, `select 1 from public.storage_cleanup_queue where storage_path like '%/drive/%'`),
    ).toEqual([]);
  });
});

describe('guarda de las pruebas locales', () => {
  it('el Drive simulado solo arranca contra un Supabase local', () => {
    expect(loadDriveLocalTest({})).toBeNull();
    expect(() => loadDriveLocalTest({ DRIVE_E2E_SIMULATED: 'true', SUPABASE_URL: 'https://x.supabase.co' })).toThrow(
      LocalTestConfigError,
    );
    expect(loadDriveLocalTest({ DRIVE_E2E_SIMULATED: 'true', SUPABASE_URL: 'http://127.0.0.1:55321' })).not.toBeNull();
  });
});
