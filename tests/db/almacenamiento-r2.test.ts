// Almacenamiento de medios en Cloudflare R2 (migración 20261124010000,
// docs/almacenamiento-r2.md): en qué almacén queda cada recurso, quién puede
// apuntar una subida a R2, la cola de limpieza con su almacén, la Edge Function
// `media-storage` con un cubo simulado en memoria, la firma SigV4 contra los
// ejemplos públicos de Amazon S3, el adaptador S3 y «Probar conexión».
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { computeAvailability } from '../../supabase/functions/_shared/integrations/availability.ts';
import { validateSetting } from '../../supabase/functions/_shared/integrations/catalog.ts';
import { probeIntegration, type ProbeFetch } from '../../supabase/functions/_shared/integrations/probes.ts';
import { isMediaKey, type ObjectStorage } from '../../supabase/functions/_shared/storage/contract.ts';
import { loadMediaStorageConfig, r2Endpoint } from '../../supabase/functions/_shared/storage/config.ts';
import { createS3Storage } from '../../supabase/functions/_shared/storage/s3.ts';
import { presignS3Url, signS3Request } from '../../supabase/functions/_shared/storage/sigv4.ts';
import { createMediaStorageHandler, type AssetLocation } from '../../supabase/functions/media-storage/handler.ts';
import {
  as,
  asService,
  assetPath,
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

const SERVICE = 'clave-de-servicio-de-pruebas';
const tokenOf = (u: TestUser) => `jwt-${u.id}`;
const ACCOUNT = '0123456789abcdef0123456789abcdef';

/** Llama a una función de `public` como la clave de servicio (argumentos por nombre). */
const serviceRpc: RpcClient = async (fn, args) => {
  const names = Object.keys(args).filter((n) => args[n] !== undefined);
  const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  try {
    const rows = await asService<{ data: unknown }>(
      db,
      `select to_jsonb(public.${fn}(${list})) as data`,
      names.map((n) => args[n]),
    );
    return { data: rows[0]?.data ?? null, error: null };
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return { data: null, error: { code, message } };
  }
};

/** Cubo en memoria con la misma interfaz que R2 y Supabase. */
function memoryStorage(backend: 'supabase' | 'r2'): ObjectStorage & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    backend,
    objects,
    signGet: async (key, seconds, o = {}) =>
      `https://${backend}.test/${key}?ttl=${seconds}${o.download ? `&download=${encodeURIComponent(o.download)}` : ''}`,
    signPut: async (key, contentType, bytes, seconds) => ({
      url: `https://${backend}.test/${key}?put=${bytes}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresIn: seconds,
    }),
    head: async (key) => (objects.has(key) ? { bytes: objects.get(key)! } : null),
    put: async (key, _b, _t, bytes) => void objects.set(key, bytes),
    remove: async (keys) => {
      for (const k of keys) objects.delete(k);
      return { failed: [] };
    },
    list: async (prefix) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, bytes]) => ({ key, bytes })),
  };
}

const users = () => [ana, editor, lector, berta];
const userByToken = (token: string) => users().find((u) => tokenOf(u) === token) ?? null;

function handler(r2: ObjectStorage | null, supabase: ObjectStorage, env: Record<string, string> = {}) {
  const config = loadMediaStorageConfig(
    r2
      ? {
          R2_ACCOUNT_ID: ACCOUNT,
          R2_ACCESS_KEY_ID: 'AKIAEJEMPLO000001',
          R2_SECRET_ACCESS_KEY: 'secreto000000000',
          R2_BUCKET: 'rrss-media',
          ...env,
        }
      : env,
  );
  return createMediaStorageHandler({
    config,
    r2,
    supabase,
    rpc: serviceRpc,
    authenticate: async (token) => {
      const user = userByToken(token);
      return user ? { userId: user.id } : null;
    },
    isServiceToken: (t) => t === SERVICE,
    async assetsForPaths(token, paths) {
      const sql = `select storage_path, storage_backend from public.media_assets
                   where source = 'storage' and storage_path = any($1::text[])`;
      if (token === null) return asService<AssetLocation & Record<string, unknown>>(db, sql, [paths]);
      const user = userByToken(token);
      return user ? as<AssetLocation & Record<string, unknown>>(db, user, sql, [paths]) : [];
    },
    async cleanupForPaths(token, paths) {
      const user = userByToken(token);
      if (!user) return [];
      return as<AssetLocation & Record<string, unknown>>(
        db,
        user,
        `select storage_path, storage_backend from public.storage_cleanup_queue where storage_path = any($1::text[])`,
        [paths],
      );
    },
  });
}

async function post(
  h: (r: Request) => Promise<Response>,
  route: string,
  token: string | null,
  body: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; json: any }> {
  const res = await h(
    new Request(`http://funciones.test/functions/v1/media-storage${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function addAssetAt(user: TestUser, orgId: string, brandId: string, path: string): Promise<string> {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
     values ($1, $2, 'image', $3, 'foto.jpg', 'image/jpeg', 1234) returning id`,
    [brandId, orgId, path],
  );
  return row!.id;
}

const backendOf = async (path: string) =>
  (
    await asService<{ b: string }>(db, `select storage_backend as b from public.media_assets where storage_path = $1`, [
      path,
    ])
  )[0]?.b;

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@r2.test', 'Ana');
  editor = await createUser(db, 'editor@r2.test', 'Edu');
  lector = await createUser(db, 'lector@r2.test', 'Lea');
  berta = await createUser(db, 'berta@r2.test', 'Berta');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
  otraMarca = await createBrand(db, ana, org, 'Otra marca');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
  orgB = await createOrg(db, berta, 'Otra empresa');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
});

afterAll(async () => {
  await db.close();
});

describe('en qué almacén queda cada recurso (base de datos)', () => {
  it('por defecto, en Supabase; si el servidor apuntó la subida a R2, en R2', async () => {
    const normal = assetPath(org, marca);
    await addAssetAt(editor, org, marca, normal);
    expect(await backendOf(normal)).toBe('supabase');

    const enR2 = assetPath(org, marca);
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [editor.id, enR2]);
    await addAssetAt(editor, org, marca, enR2);
    expect(await backendOf(enR2)).toBe('r2');
  });

  it('el cliente no escribe el almacén ni al crear ni después', async () => {
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, storage_backend)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1, 'r2')`,
      [marca, org, assetPath(org, marca)],
      /permission denied/,
    );
    await denied(db, ana, `update public.media_assets set storage_backend = 'r2'`, [], /permission denied/);
  });

  it('solo quien edita la marca apunta una subida, y nunca en otra organización ni en la carpeta de Drive', async () => {
    const reg = (user: TestUser | null, path: string) =>
      asService(db, `select public.media_storage_register_upload($1, $2)`, [user?.id ?? null, path]);
    await expect(reg(lector, assetPath(org, marca))).rejects.toThrow(/edita la marca/);
    await expect(reg(editor, assetPath(org, otraMarca))).rejects.toThrow(/edita la marca/);
    await expect(reg(berta, assetPath(org, marca))).rejects.toThrow(/edita la marca/);
    // Ruta de una marca con la organización de otra: no es de ninguna marca.
    await expect(reg(berta, `${orgB}/${marca}/media/x.jpg`)).rejects.toThrow(/ninguna marca/);
    await expect(reg(editor, `${org}/${marca}/drive/archivoDeDrive01`)).rejects.toThrow(/no válida/);
    await expect(reg(editor, `${org}/${marca}/../x.jpg`)).rejects.toThrow(/no válida/);
    await expect(reg(editor, `${org}/${marca}//x.jpg`)).rejects.toThrow(/no válida/);
    // El servidor (sin persona) puede apuntar en cualquier marca.
    await reg(null, assetPath(orgB, marcaB));
  });

  it('un reintento que vuelve a escribir la misma ruta pasa el recurso a R2', async () => {
    const path = assetPath(org, marca);
    await addAssetAt(editor, org, marca, path);
    expect(await backendOf(path)).toBe('supabase');
    await asService(db, `select public.media_storage_register_upload(null, $1)`, [path]);
    expect(await backendOf(path)).toBe('r2');
  });

  it('borrar el recurso anota el archivo en la cola con su almacén; olvidarlo limpia la cola y lo apuntado', async () => {
    const path = assetPath(org, marca);
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [editor.id, path]);
    await addAssetAt(editor, org, marca, path);
    await as(db, editor, `delete from public.media_assets where storage_path = $1`, [path]);
    const [queued] = await as<{ storage_backend: string }>(
      db,
      editor,
      `select storage_backend from public.storage_cleanup_queue where storage_path = $1`,
      [path],
    );
    expect(queued?.storage_backend).toBe('r2');
    const [forgot] = await asService<{ n: number }>(db, `select public.media_storage_forget_paths($1::text[]) as n`, [
      [path],
    ]);
    expect(forgot!.n).toBe(1);
    const [left] = await db.query<{ n: number }>(
      `select count(*)::int as n from private.media_object_locations where storage_path = $1`,
      [path],
    );
    expect(left!.n).toBe(0);
  });

  it('la clave de servicio puede pasar un recurso a R2 (script de migración); uno de Drive no puede estar en R2', async () => {
    const path = assetPath(org, marca);
    await addAssetAt(editor, org, marca, path);
    await asService(db, `update public.media_assets set storage_backend = 'r2' where storage_path = $1`, [path]);
    expect(await backendOf(path)).toBe('r2');
    const [constraint] = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'media_assets_backend_storage_only'`,
    );
    expect(constraint!.def).toMatch(/source = 'storage'.*storage_backend = 'supabase'/);
  });
});

describe('Edge Function media-storage', () => {
  it('con sesión firma solo los archivos en R2 de las marcas que ve; lo de Supabase lo firma el navegador', async () => {
    const r2 = memoryStorage('r2');
    const sb = memoryStorage('supabase');
    const h = handler(r2, sb);
    const enR2 = assetPath(org, marca);
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [editor.id, enR2]);
    await addAssetAt(editor, org, marca, enR2);
    const enSupabase = assetPath(org, marca);
    await addAssetAt(editor, org, marca, enSupabase);
    const deB = assetPath(orgB, marcaB);
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [berta.id, deB]);
    await addAssetAt(berta, orgB, marcaB, deB);

    const viendo = await post(h, '/sign', tokenOf(lector), { paths: [enR2, enSupabase, deB] });
    expect(viendo.status).toBe(200);
    expect(Object.keys(viendo.json.urls)).toEqual([enR2]);
    expect(viendo.json.urls[enR2]).toMatch(/^https:\/\/r2\.test\/.+ttl=3600$/);

    // Otra organización no ve nada de esta.
    expect((await post(h, '/sign', tokenOf(berta), { paths: [enR2] })).json.urls).toEqual({});
    // Sin sesión, nada.
    expect((await post(h, '/sign', null, { paths: [enR2] })).status).toBe(401);
    expect((await post(h, '/sign', 'jwt-de-nadie', { paths: [enR2] })).status).toBe(401);
  });

  it('con la clave de servicio firma cualquier ruta en su almacén (lo que no es un recurso, en Supabase)', async () => {
    const r2 = memoryStorage('r2');
    const h = handler(r2, memoryStorage('supabase'));
    const enR2 = assetPath(org, marca);
    await asService(db, `select public.media_storage_register_upload(null, $1)`, [enR2]);
    await addAssetAt(editor, org, marca, enR2);
    const fuente = `${org}/${marca}/sources/${randomUUID()}-dossier.pdf`;
    const r = await post(h, '/sign', SERVICE, { paths: [enR2, fuente, '../fuera'], seconds: 99_999 });
    expect(r.json.urls[enR2]).toMatchObject({ backend: 'r2' });
    expect(r.json.urls[fuente]).toMatchObject({ backend: 'supabase' });
    expect(r.json.urls['../fuera']).toBeUndefined();
    // Como mucho 6 horas.
    expect(r.json.expiresIn).toBe(21_600);
  });

  it('subir: quien edita recibe la URL de R2 y queda apuntado; quien solo ve, no', async () => {
    const h = handler(memoryStorage('r2'), memoryStorage('supabase'));
    const path = assetPath(org, marca);
    const ok = await post(h, '/upload', tokenOf(editor), { path, contentType: 'image/jpeg', bytes: 5000 });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ backend: 'r2', method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    await addAssetAt(editor, org, marca, path);
    expect(await backendOf(path)).toBe('r2');

    const lectorUpload = await post(h, '/upload', tokenOf(lector), {
      path: assetPath(org, marca),
      contentType: 'image/jpeg',
      bytes: 10,
    });
    expect(lectorUpload.status).toBe(403);
    const ajena = await post(h, '/upload', tokenOf(berta), {
      path: assetPath(org, marca),
      contentType: 'image/jpeg',
      bytes: 10,
    });
    expect(ajena.status).toBe(403);
    expect(
      (
        await post(h, '/upload', tokenOf(editor), {
          path: `${org}/${marca}/drive/x1234567890`,
          contentType: 'image/jpeg',
          bytes: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(h, '/upload', tokenOf(editor), { path: assetPath(org, marca), contentType: 'nada', bytes: 1 }))
        .status,
    ).toBe(400);
  });

  it('con MEDIA_UPLOAD_BACKEND=supabase (o sin R2) las subidas siguen en Supabase y no se apunta nada', async () => {
    for (const h of [
      handler(memoryStorage('r2'), memoryStorage('supabase'), { MEDIA_UPLOAD_BACKEND: 'supabase' }),
      handler(null, memoryStorage('supabase')),
    ]) {
      const path = assetPath(org, marca);
      const r = await post(h, '/upload', tokenOf(editor), { path, contentType: 'image/png', bytes: 10 });
      expect(r.json).toEqual({ backend: 'supabase' });
      await addAssetAt(editor, org, marca, path);
      expect(await backendOf(path)).toBe('supabase');
    }
  });

  it('borrar: cada archivo en su almacén, solo los que la persona puede limpiar', async () => {
    const r2 = memoryStorage('r2');
    const sb = memoryStorage('supabase');
    const h = handler(r2, sb);
    const enR2 = assetPath(org, marca);
    const enSupabase = assetPath(org, marca);
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [editor.id, enR2]);
    await addAssetAt(editor, org, marca, enR2);
    await addAssetAt(editor, org, marca, enSupabase);
    r2.objects.set(enR2, 1);
    sb.objects.set(enSupabase, 1);
    await as(db, editor, `delete from public.media_assets where storage_path = any($1::text[])`, [[enR2, enSupabase]]);

    // Quien solo ve no limpia nada.
    expect((await post(h, '/delete', tokenOf(lector), { paths: [enR2, enSupabase] })).json.removed).toEqual([]);
    expect(r2.objects.has(enR2)).toBe(true);

    const r = await post(h, '/delete', tokenOf(editor), { paths: [enR2, enSupabase] });
    expect(r.json.removed.sort()).toEqual([enR2, enSupabase].sort());
    expect(r2.objects.has(enR2)).toBe(false);
    expect(sb.objects.has(enSupabase)).toBe(false);
    const [queue] = await asService<{ n: number }>(
      db,
      `select count(*)::int as n from public.storage_cleanup_queue where storage_path = any($1::text[])`,
      [[enR2, enSupabase]],
    );
    expect(queue!.n).toBe(0);
    // La clave de servicio no borra por aquí.
    expect((await post(h, '/delete', SERVICE, { paths: [enR2] })).status).toBe(403);
  });

  it('huérfanos: descartar borra de R2 lo subido sin recurso (solo lo propio); la tarea del servidor barre lo viejo', async () => {
    const r2 = memoryStorage('r2');
    const h = handler(r2, memoryStorage('supabase'));
    const up = async (token: string, path: string) => {
      expect((await post(h, '/upload', token, { path, contentType: 'image/jpeg', bytes: 10 })).status).toBe(200);
      r2.objects.set(path, 10);
    };
    const fallida = assetPath(org, marca); // el alta de la fila falló
    const conRecurso = assetPath(org, marca);
    const deOtro = assetPath(org, marca);
    const vieja = assetPath(org, marca);
    const reciente = assetPath(org, marca);
    await up(tokenOf(editor), fallida);
    await up(tokenOf(editor), conRecurso);
    await addAssetAt(editor, org, marca, conRecurso);
    await up(tokenOf(ana), deOtro);
    await up(tokenOf(editor), vieja);
    await up(tokenOf(editor), reciente);
    await db.query(
      `update private.media_object_locations set created_at = now() - interval '2 days' where storage_path = $1`,
      [vieja],
    );

    // Con recurso o de otra persona: no se toca. Quien solo ve o es ajeno, tampoco.
    const noTocar = await post(h, '/discard', tokenOf(editor), { paths: [conRecurso, deOtro] });
    expect(noTocar.json.removed).toEqual([]);
    expect((await post(h, '/discard', tokenOf(berta), { paths: [fallida] })).json.removed).toEqual([]);
    expect((await post(h, '/discard', SERVICE, { paths: [fallida] })).status).toBe(403);
    expect(r2.objects.has(fallida)).toBe(true);

    const ok = await post(h, '/discard', tokenOf(editor), { paths: [fallida] });
    expect(ok.json.removed).toEqual([fallida]);
    expect(r2.objects.has(fallida)).toBe(false);
    const rest = await db.query<{ n: number }>(
      `select count(*)::int as n from private.media_object_locations where storage_path = $1`,
      [fallida],
    );
    expect(rest[0]!.n).toBe(0);

    // La tarea programada: solo el servidor, solo lo de más de 24 h y sin recurso.
    expect((await post(h, '/purge-orphans', tokenOf(editor), {})).status).toBe(403);
    const sweep = await post(h, '/purge-orphans', SERVICE, {});
    expect(sweep.json.removed).toContain(vieja);
    expect(sweep.json.removed).not.toContain(reciente);
    expect(sweep.json.removed).not.toContain(conRecurso);
    expect(r2.objects.has(vieja)).toBe(false);
    expect(r2.objects.has(reciente)).toBe(true);
    expect(r2.objects.has(conRecurso)).toBe(true);
  });

  it('huérfanos: la función no la puede llamar el cliente', async () => {
    await denied(db, editor, `select * from public.media_storage_orphans(null)`);
    await denied(db, editor, `select private.media_storage_orphans_dispatch()`);
  });

  it('si un archivo está en R2 y R2 ya no está configurado, lo dice (503) en vez de inventar una URL', async () => {
    const path = assetPath(org, marca);
    await asService(db, `select public.media_storage_register_upload(null, $1)`, [path]);
    await addAssetAt(editor, org, marca, path);
    const r = await post(handler(null, memoryStorage('supabase')), '/sign', tokenOf(editor), { paths: [path] });
    expect(r.status).toBe(503);
  });
});

describe('firma SigV4 (ejemplos públicos de la documentación de Amazon S3)', () => {
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const now = new Date('2013-05-24T00:00:00Z');

  it('URL prefirmada (GET, 24 h)', async () => {
    const url = await presignS3Url({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      credentials,
      expiresSeconds: 86_400,
      now,
    });
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('petición firmada en cabeceras (GET con Range)', async () => {
    const headers = await signS3Request({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      credentials,
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      now,
    });
    expect(headers.authorization).toMatch(
      /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    );
  });
});

describe('adaptador S3 (R2)', () => {
  const settings = {
    endpoint: r2Endpoint(ACCOUNT, 'eu'),
    publicEndpoint: r2Endpoint(ACCOUNT, 'eu'),
    bucket: 'rrss-media',
    region: 'auto',
    accessKeyId: 'AKIAEJEMPLO000001',
    secretAccessKey: 'secreto-de-prueba-000000',
    jurisdiction: 'eu' as const,
  };

  it('usa el punto de acceso de la UE, firma tipo y tamaño en la subida y nunca pone la clave en la URL', async () => {
    expect(settings.endpoint).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
    const s3 = createS3Storage(settings, async () => new Response(null));
    const key = `${randomUUID()}/${randomUUID()}/media/mi foto ñ.jpg`;
    const put = await s3.signPut(key, 'image/jpeg', 1234, 900);
    const u = new URL(put.url);
    expect(u.host).toBe(`${ACCOUNT}.eu.r2.cloudflarestorage.com`);
    expect(u.pathname).toBe(`/rrss-media/${key.split('/').map(encodeURIComponent).join('/')}`);
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(put.url).not.toContain(settings.secretAccessKey);
    await expect(s3.signPut(key, 'image/jpeg', 0, 900)).rejects.toThrow(/Tamaño/);
  });

  it('HEAD, borrar (lo que ya no estaba no es error) y listar paginando', async () => {
    const seen: string[] = [];
    const s3 = createS3Storage(settings, async (input, init) => {
      const u = new URL(input);
      seen.push(`${init?.method} ${u.pathname}${u.search}`);
      expect((init?.headers as Record<string, string>).authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAEJEMPLO000001\//,
      );
      if (init?.method === 'HEAD')
        return new Response(null, {
          status: u.pathname.endsWith('/no') ? 404 : 200,
          headers: { 'content-length': '42' },
        });
      if (init?.method === 'DELETE') return new Response(null, { status: u.pathname.endsWith('/roto') ? 500 : 204 });
      const token = u.searchParams.get('continuation-token');
      return new Response(
        token
          ? '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a/2 &amp; b.jpg</Key><Size>7</Size></Contents></ListBucketResult>'
          : '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken><Contents><Key>a/1.jpg</Key><Size>5</Size></Contents></ListBucketResult>',
        { status: 200 },
      );
    });
    expect(await s3.head('a/si')).toEqual({ bytes: 42 });
    expect(await s3.head('a/no')).toBeNull();
    expect((await s3.remove(['a/1', 'a/roto'])).failed).toEqual(['a/roto']);
    expect(await s3.list('a/')).toEqual([
      { key: 'a/1.jpg', bytes: 5 },
      { key: 'a/2 & b.jpg', bytes: 7 },
    ]);
    expect(seen.filter((s) => s.startsWith('GET'))).toHaveLength(2);
  });

  it('las rutas válidas son de una marca y fuera de la carpeta de Drive', () => {
    const o = randomUUID();
    const b = randomUUID();
    expect(isMediaKey(`${o}/${b}/media/x.jpg`)).toBe(true);
    expect(isMediaKey(`${o}/${b}/drive/x`)).toBe(false);
    expect(isMediaKey(`${o}/${b}/../x.jpg`)).toBe(false);
    expect(isMediaKey(`${o}/${b}/a\\b.jpg`)).toBe(false);
    expect(isMediaKey(`x/${b}/media/x.jpg`)).toBe(false);
  });
});

describe('configuración, disponibilidad y «Probar conexión» de R2', () => {
  const env = {
    SUPABASE_URL: 'https://proyecto.supabase.co',
    R2_ACCOUNT_ID: ACCOUNT,
    R2_ACCESS_KEY_ID: 'AKIAEJEMPLO000001',
    R2_SECRET_ACCESS_KEY: 'secreto-de-prueba-000000',
    R2_BUCKET: 'rrss-media',
  };

  it('sin R2 todo sigue en Supabase; con R2, las subidas van a R2 salvo que se diga lo contrario', () => {
    expect(loadMediaStorageConfig({}).uploadBackend).toBe('supabase');
    expect(loadMediaStorageConfig(env)).toMatchObject({ uploadBackend: 'r2', s3: { jurisdiction: 'eu' } });
    expect(loadMediaStorageConfig({ ...env, MEDIA_UPLOAD_BACKEND: 'supabase' }).uploadBackend).toBe('supabase');
    const partial = loadMediaStorageConfig({ R2_BUCKET: 'rrss-media' });
    expect(partial.s3).toBeNull();
    expect(partial.problems.join(' ')).toMatch(/R2_ACCOUNT_ID.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/);
    expect(computeAvailability(env, []).mediaStorage).toBe(true);
    expect(computeAvailability({}, []).mediaStorage).toBe(false);
  });

  it('el S3 local de las pruebas solo arranca con un Supabase local', () => {
    expect(() =>
      loadMediaStorageConfig({
        ...env,
        MEDIA_STORAGE_E2E_SIMULATED: 'true',
        MEDIA_STORAGE_S3_ENDPOINT: 'http://127.0.0.1:9000',
      }),
    ).toThrow(/solo se admite en pruebas locales/);
    const local = loadMediaStorageConfig({
      SUPABASE_URL: 'http://kong:8000',
      MEDIA_STORAGE_E2E_SIMULATED: 'true',
      MEDIA_STORAGE_S3_ENDPOINT: 'http://host.docker.internal:9000',
      MEDIA_STORAGE_S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      R2_ACCESS_KEY_ID: 'minioadmin',
      R2_SECRET_ACCESS_KEY: 'minioadmin',
      R2_BUCKET: 'rrss-media',
    });
    expect(local.s3).toMatchObject({
      endpoint: 'http://host.docker.internal:9000',
      publicEndpoint: 'http://127.0.0.1:9000',
      jurisdiction: 'local',
    });
  });

  it('valida los ajustes antes de guardarlos', () => {
    expect(validateSetting('R2_ACCOUNT_ID', ACCOUNT)).toBeNull();
    expect(validateSetting('R2_ACCOUNT_ID', 'cuenta')).toMatch(/hexadecimales/);
    expect(validateSetting('R2_BUCKET', 'Rrss_Media')).toMatch(/Minúsculas/);
    expect(validateSetting('R2_JURISDICTION', 'us')).toMatch(/eu, default/);
    expect(validateSetting('MEDIA_UPLOAD_BACKEND', 'r2')).toBeNull();
  });

  it('«Probar conexión» hace un HeadBucket firmado y no cita la clave', async () => {
    const calls: string[] = [];
    const fetchWith =
      (status: number): ProbeFetch =>
      async (input, init) => {
        calls.push(`${init?.method} ${input}`);
        return new Response(null, { status });
      };
    const ok = await probeIntegration('r2', env, { fetch: fetchWith(200) });
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([`HEAD https://${ACCOUNT}.eu.r2.cloudflarestorage.com/rrss-media`]);
    const forbidden = await probeIntegration('r2', env, { fetch: fetchWith(403) });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.message).toMatch(/rechaza la clave/);
    expect((await probeIntegration('r2', env, { fetch: fetchWith(404) })).message).toMatch(/no existe/);
    const sinRed = await probeIntegration('r2', env, {
      fetch: async () => {
        throw new TypeError('sin red');
      },
    });
    expect(sinRed.ok).toBe(false);
    const fuera = await probeIntegration('r2', { ...env, R2_JURISDICTION: 'default' }, { fetch: fetchWith(200) });
    expect(fuera.checks.find((c) => c.ok === null)?.message).toMatch(/no está en la jurisdicción UE/);
    expect(JSON.stringify([ok, forbidden, fuera])).not.toContain('secreto-de-prueba');
    const vacio = await probeIntegration('r2', {}, { fetch: fetchWith(200) });
    expect(vacio.ok).toBe(false);
  });
});
