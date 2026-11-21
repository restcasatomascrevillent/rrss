// Procedencia de los recursos de la biblioteca (imágenes exportadas desde el
// editor), contra las migraciones reales: se escribe al insertar, no se puede
// cambiar después, tiene forma acotada y respeta el aislamiento entre marcas.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  assetPath,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  MIGRATIONS_DIR,
  type Db,
  type TestUser,
} from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser, lector: TestUser, berta: TestUser;
let orgA: string, orgB: string, marcaA: string, marcaB: string;

const CONTENT_ID = '11111111-1111-4111-8111-111111111111';
const EXPORT = {
  type: 'export',
  content_id: CONTENT_ID,
  version: 3,
  unsaved_changes: false,
  format: 'png',
  width: 1080,
  height: 1350,
  pixel_ratio: 1,
  exported_at: '2026-11-18T10:00:00.000Z',
};

const INSERT_WITH = `insert into public.media_assets
  (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
  values ($1, $2, 'image', $3, $4, 'image/png', 10, $5::jsonb) returning id`;

const insert = (user: TestUser, brand: string, org: string, provenance: unknown, name = 'export.png') =>
  as<{ id: string }>(db, user, INSERT_WITH, [brand, org, assetPath(org, brand), name, JSON.stringify(provenance)]);

const provenanceOf = async (user: TestUser, id: string) => {
  const [row] = await as<{ provenance: unknown }>(
    db,
    user,
    `select provenance from public.media_assets where id = $1`,
    [id],
  );
  return row!.provenance;
};

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test', 'Ana');
  editor = await createUser(db, 'editor@a.test', 'Editor');
  lector = await createUser(db, 'lector@a.test', 'Lector');
  berta = await createUser(db, 'berta@b.test', 'Berta');
  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  marcaA = await createBrand(db, ana, orgA, 'Marca A');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
  await join(db, ana, editor, orgA, 'member', marcaA, 'editor');
  await join(db, ana, lector, orgA, 'member', marcaA, 'viewer');
});
afterAll(async () => {
  await db?.close();
});

describe('procedencia de los recursos', () => {
  it('un recurso subido a mano tiene la procedencia vacía', async () => {
    const [row] = await as<{ id: string }>(
      db,
      editor,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'foto.jpg', 'image/jpeg', 10) returning id`,
      [marcaA, orgA, assetPath(orgA, marcaA)],
    );
    expect(await provenanceOf(editor, row!.id)).toEqual({});
  });

  it('quien edita la marca guarda la procedencia de una exportación al insertar', async () => {
    const [row] = await insert(editor, marcaA, orgA, EXPORT);
    expect(await provenanceOf(editor, row!.id)).toEqual(EXPORT);
  });

  it('se puede listar lo que sale de una pieza', async () => {
    const rows = await as(
      db,
      editor,
      `select id from public.media_assets where provenance ->> 'content_id' = $1 and brand_id = $2`,
      [CONTENT_ID, marcaA],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('no se puede cambiar después de crear el recurso (ni por quien lo creó)', async () => {
    const [row] = await insert(editor, marcaA, orgA, EXPORT, 'otra.png');
    await denied(db, editor, `update public.media_assets set provenance = '{}'::jsonb where id = $1`, [row!.id]);
    await denied(db, ana, `update public.media_assets set provenance = '{"type":"x"}'::jsonb where id = $1`, [row!.id]);
  });

  it('editar la ficha (derechos, etiquetas) no toca la procedencia', async () => {
    const [row] = await insert(editor, marcaA, orgA, EXPORT, 'ficha.png');
    await as(
      db,
      editor,
      `update public.media_assets set rights = '{"license":"propia"}'::jsonb, tags = '{exportación}' where id = $1`,
      [row!.id],
    );
    expect(await provenanceOf(editor, row!.id)).toEqual(EXPORT);
  });

  it('tiene forma de objeto con tipo y un tamaño acotado', async () => {
    const check = /check constraint|media_assets_provenance/i;
    await denied(db, editor, INSERT_WITH, [marcaA, orgA, assetPath(orgA, marcaA), 'x.png', '[1]'], check);
    await denied(db, editor, INSERT_WITH, [marcaA, orgA, assetPath(orgA, marcaA), 'x.png', '{"sin":"tipo"}'], check);
    const grande = JSON.stringify({ type: 'export', notas: 'x'.repeat(5000) });
    await denied(db, editor, INSERT_WITH, [marcaA, orgA, assetPath(orgA, marcaA), 'x.png', grande], check);
  });

  it('el aislamiento no cambia: ni un lector ni otra organización pueden crearla o verla', async () => {
    const args = [marcaA, orgA, assetPath(orgA, marcaA), 'x.png', JSON.stringify(EXPORT)];
    await denied(db, lector, INSERT_WITH, args);
    await denied(db, berta, INSERT_WITH, args);
    const [ajeno] = await insert(berta, marcaB, orgB, EXPORT, 'b.png');
    expect(await as(db, editor, `select id from public.media_assets where id = $1`, [ajeno!.id])).toEqual([]);
    const propios = await as(db, berta, `select id from public.media_assets where provenance ->> 'content_id' = $1`, [
      CONTENT_ID,
    ]);
    expect(propios).toHaveLength(1);
  });

  it('la vuelta atrás quita la columna y la migración se puede volver a aplicar', async () => {
    const file = '20261118120000_media_assets_provenance.sql';
    const rollback = await readFile(path.join(MIGRATIONS_DIR, '../rollbacks', file), 'utf8');
    const migration = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const columns = () =>
      db.query(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'media_assets' and column_name = 'provenance'`,
      );
    expect(await columns()).toHaveLength(1);
    await db.exec(rollback);
    expect(await columns()).toHaveLength(0);
    await db.exec(migration);
    expect(await columns()).toHaveLength(1);
  });
});
