// Miniaturas de la biblioteca (migración 20261209010000): la columna
// `thumb_path`, quién puede escribirla, su borrado con el recurso y que una
// miniatura no cuente como huérfana de R2.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let ana: TestUser, editor: TestUser, lector: TestUser;
let org: string, marca: string, otraMarca: string;

const thumbPath = (o = org, b = marca) => `${o}/${b}/thumbs/${randomUUID()}.webp`;

async function insert(user: TestUser, path: string, thumb: string | null, brand = marca) {
  const rows = await as<{ id: string }>(
    db,
    user,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, thumb_path)
     values ($1, $2, 'image', $3, 'foto.jpg', 'image/jpeg', 900000, $4) returning id`,
    [brand, org, path, thumb],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@mini.test', 'Ana');
  editor = await createUser(db, 'editor@mini.test', 'Edu');
  lector = await createUser(db, 'lector@mini.test', 'Lea');
  org = await createOrg(db, ana, 'Empresa');
  marca = await createBrand(db, ana, org, 'Marca');
  otraMarca = await createBrand(db, ana, org, 'Otra marca');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
});

afterAll(async () => {
  await db.close();
});

describe('media_assets.thumb_path', () => {
  it('quien edita la marca crea el recurso con su miniatura', async () => {
    const thumb = thumbPath();
    const id = await insert(editor, assetPath(org, marca), thumb);
    const [row] = await as<{ thumb_path: string }>(
      db,
      lector,
      `select thumb_path from public.media_assets where id = $1`,
      [id],
    );
    expect(row?.thumb_path).toBe(thumb);
  });

  it('sin miniatura sigue valiendo (null)', async () => {
    const id = await insert(editor, assetPath(org, marca), null);
    const [row] = await as<{ thumb_path: string | null }>(
      db,
      editor,
      `select thumb_path from public.media_assets where id = $1`,
      [id],
    );
    expect(row?.thumb_path).toBeNull();
  });

  it('rechaza una ruta que no sea de la carpeta thumbs de su marca', async () => {
    const original = assetPath(org, marca);
    await insert(editor, original, null);
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, thumb_path)
      values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 10, $4)`,
      [marca, org, assetPath(org, marca), original],
      /check|thumb/i,
    );
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, thumb_path)
      values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 10, $4)`,
      [marca, org, assetPath(org, marca), thumbPath(org, otraMarca)],
      /check|thumb/i,
    );
  });

  it('dos recursos no comparten miniatura', async () => {
    const thumb = thumbPath();
    await insert(editor, assetPath(org, marca), thumb);
    await denied(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, thumb_path)
      values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 10, $4)`,
      [marca, org, assetPath(org, marca), thumb],
      /unique|duplicate|duplicad/i,
    );
  });

  it('el cliente no puede cambiarla después; el servidor sí', async () => {
    const id = await insert(editor, assetPath(org, marca), null);
    await denied(db, editor, `update public.media_assets set thumb_path = $2 where id = $1`, [id, thumbPath()]);
    await asService(db, `update public.media_assets set thumb_path = $2 where id = $1`, [id, thumbPath()]);
  });

  it('quien solo lee no crea recursos', async () => {
    await denied(
      db,
      lector,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, thumb_path)
      values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 10, $4)`,
      [marca, org, assetPath(org, marca), thumbPath()],
    );
  });
});

describe('borrado y limpieza', () => {
  it('al borrar el recurso, el original y la miniatura quedan en la cola de limpieza', async () => {
    const path = assetPath(org, marca);
    const thumb = thumbPath();
    const id = await insert(editor, path, thumb);
    await as(db, editor, `delete from public.media_assets where id = $1`, [id]);
    const rows = await as<{ storage_path: string }>(
      db,
      editor,
      `select storage_path from public.storage_cleanup_queue where storage_path = any($1::text[])`,
      [[path, thumb]],
    );
    expect(rows.map((r) => r.storage_path).sort()).toEqual([path, thumb].sort());
  });

  it('la miniatura entra en los archivos de la organización', async () => {
    const thumb = thumbPath();
    await insert(editor, assetPath(org, marca), thumb);
    const [row] = await db.query<{ p: string[] }>(`select private.organization_storage_paths($1) as p`, [org]);
    expect(row?.p).toContain(thumb);
  });
});

describe('huérfanos de R2', () => {
  it('una miniatura con recurso no es huérfana; sin recurso, sí', async () => {
    const thumb = thumbPath();
    const lonely = thumbPath();
    await asService(db, `select public.media_storage_register_upload(null, $1)`, [thumb]);
    await asService(db, `select public.media_storage_register_upload(null, $1)`, [lonely]);
    await insert(editor, assetPath(org, marca), thumb);
    await db.exec(`update private.media_object_locations set created_at = now() - interval '2 days'`);
    const [row] = await asService<{ rows: Array<{ storage_path: string }> }>(
      db,
      `select public.media_storage_orphans(null, null, interval '24 hours', 500) as rows`,
    );
    const orphans = row!.rows.map((r) => r.storage_path);
    expect(orphans).toContain(lonely);
    expect(orphans).not.toContain(thumb);
  });
});
