// Ediciones sencillas del editor (documento v5) contra las migraciones reales
// (20261211010000_templates_document_v5): las plantillas de marca aceptan los
// documentos v3, v4 y v5 y siguen rechazando una versión que no existe; y con
// la vuelta atrás vuelven a aceptar solo v3 y v4.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrand, createDb, createOrg, createUser, MIGRATIONS_DIR, type Db } from './helpers';

const ROLLBACK = path.join(MIGRATIONS_DIR, '../rollbacks/20261211010000_templates_document_v5.sql');
const MIGRATION = path.join(MIGRATIONS_DIR, '20261211010000_templates_document_v5.sql');

let db: Db;
let org: string;
let brand: string;
let n = 0;

beforeAll(async () => {
  db = await createDb();
  const ana = await createUser(db, 'ana-edicion@example.com', 'Ana');
  org = await createOrg(db, ana, 'Empresa A');
  brand = await createBrand(db, ana, org, 'Marca A');
});
afterAll(async () => {
  await db?.close();
});

/** Inserta una plantilla con un documento de la versión dada (como superusuario: lo que se prueba es la restricción). */
async function insertTemplate(version: number | string, extra: Record<string, unknown> = {}) {
  n += 1;
  const document = {
    schemaVersion: version,
    canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
    pages: [
      {
        id: 'p1',
        layers: [
          {
            id: 'texto',
            type: 'text',
            x: 0,
            y: 0,
            width: 800,
            height: 200,
            text: 'Hola',
            fontFamily: 'sans-serif',
            fontSize: 80,
            color: '#111111',
            outline: { color: '#FFFFFF', width: 6 },
            shadow: { color: '#000000', blur: 12, offsetX: 0, offsetY: 4, opacity: 0.4 },
            background: { color: '#FFD700', opacity: 1, padding: 20, radius: 12 },
          },
        ],
      },
    ],
    ...extra,
  };
  return db.query(
    `insert into public.brand_design_templates (brand_id, organization_id, template_key, name, network, format, document)
     values ($1, $2, $3, 'Prueba', 'instagram', 'post', $4::jsonb) returning id`,
    [brand, org, `edicion-${n}`, JSON.stringify(document)],
  );
}

describe('plantillas con el documento v5', () => {
  it('acepta las versiones 3, 4 y 5 y rechaza las demás', async () => {
    for (const version of [3, 4, 5]) await expect(insertTemplate(version), `v${version}`).resolves.toHaveLength(1);
    await expect(insertTemplate(6)).rejects.toThrow(/brand_design_templates_document_check/);
    await expect(insertTemplate(2)).rejects.toThrow(/brand_design_templates_document_check/);
  });

  it('un documento v5 con todas las ediciones de capa se guarda tal cual', async () => {
    const [row] = await db.query<{ document: { pages: { layers: { outline?: unknown; shadow?: unknown }[] }[] } }>(
      `select document from public.brand_design_templates where template_key = 'edicion-3'`,
    );
    const layer = row!.document.pages[0]!.layers[0]!;
    expect(layer.outline).toEqual({ color: '#FFFFFF', width: 6 });
    expect(layer.shadow).toBeTruthy();
  });

  it('la vuelta atrás deja solo v3 y v4, y se puede volver a aplicar', async () => {
    await db.exec(`delete from public.brand_design_templates where document ->> 'schemaVersion' = '5'`);
    await db.exec(await readFile(ROLLBACK, 'utf8'));
    await expect(insertTemplate(4)).resolves.toHaveLength(1);
    await expect(insertTemplate(5)).rejects.toThrow(/brand_design_templates_document_check/);
    await db.exec(await readFile(MIGRATION, 'utf8'));
    await expect(insertTemplate(5)).resolves.toHaveLength(1);
  });
});
