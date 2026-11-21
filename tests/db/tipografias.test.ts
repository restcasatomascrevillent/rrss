// Tipografías de la marca (migración 20261119211000): permisos, comprobaciones
// de la fila, tipos admitidos en el cubo y la tipografía que reciben los reels.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser, berta: TestUser;
let orgA: string, orgB: string, marcaA: string, marcaA2: string, marcaB: string;
let foto: string;

const MIME: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };

async function addFont(
  user: TestUser,
  org: string,
  brand: string,
  font: { family: string; weight?: number; style?: string; format?: string; license?: boolean },
): Promise<string> {
  const format = font.format ?? 'ttf';
  const [row] = await as<{ storage_path: string }>(
    db,
    user,
    `insert into public.brand_fonts (brand_id, organization_id, family, weight, style, format, storage_path, file_name,
                                     mime_type, bytes, license_confirmed)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2048, $10) returning storage_path`,
    [
      brand,
      org,
      font.family,
      font.weight ?? 400,
      font.style ?? 'normal',
      format,
      `${org}/${brand}/fonts/${crypto.randomUUID()}.${format}`,
      `fuente.${format}`,
      MIME[format],
      font.license ?? true,
    ],
  );
  return row!.storage_path;
}

async function requestReel(user: TestUser, brand: string, texts: Row[]) {
  const [row] = await as<{ payload: { plan: Row & { fontPath?: string } } }>(
    db,
    user,
    `select payload from public.request_media_job($1, 'media.reel.template', $2::jsonb, $3)`,
    [
      brand,
      JSON.stringify({ template: { id: 'fundido-suave' }, plan: { media: [{ type: 'photo', path: foto }], texts } }),
      `reel-${crypto.randomUUID()}`,
    ],
  );
  return row!.payload.plan;
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test');
  editor = await createUser(db, 'editor@a.test');
  berta = await createUser(db, 'berta@b.test');
  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  marcaA = await createBrand(db, ana, orgA, 'Marca A');
  marcaA2 = await createBrand(db, ana, orgA, 'Marca A2');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
  await join(db, ana, editor, orgA, 'member', marcaA, 'editor');
  foto = `${orgA}/${marcaA}/media/foto.jpg`;
  await as(
    db,
    ana,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
     values ($1, $2, 'image', $3, 'foto.jpg', 'image/jpeg', 1000)`,
    [marcaA, orgA, foto],
  );
});
afterAll(async () => {
  await db?.close();
});

describe('subir tipografías', () => {
  it('quien gestiona la marca sube; el editor y otra organización no', async () => {
    await addFont(ana, orgA, marcaA, { family: 'Serifa Propia', format: 'woff2' });
    await expect(addFont(editor, orgA, marcaA, { family: 'Otra' })).rejects.toThrow(/row-level security/);
    await expect(addFont(berta, orgA, marcaA, { family: 'Otra' })).rejects.toThrow(/row-level security/);
    const visibles = await as(db, editor, `select family from public.brand_fonts where brand_id = $1`, [marcaA]);
    expect(visibles).toEqual([{ family: 'Serifa Propia' }]);
    expect(await as(db, berta, `select 1 from public.brand_fonts`)).toEqual([]);
  });

  it('exige declarar la licencia, una ruta de la marca y datos válidos', async () => {
    await expect(addFont(ana, orgA, marcaA, { family: 'Sin licencia', license: false })).rejects.toThrow(/check/);
    await expect(addFont(ana, orgA, marcaA, { family: 'X', weight: 450 })).rejects.toThrow(/check/);
    await expect(addFont(ana, orgA, marcaA, { family: 'X;}' })).rejects.toThrow(/check/);
    await expect(addFont(ana, orgA, marcaA, { family: 'Serifa Propia', format: 'woff2' })).rejects.toThrow(/duplicate/);
    // Ruta de otra marca.
    await denied(
      db,
      ana,
      `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type, bytes,
                                       license_confirmed)
       values ($1, $2, 'Ruta ajena', 'ttf', $3, 'f.ttf', 'font/ttf', 10, true)`,
      [marcaA, orgA, `${orgA}/${marcaA2}/fonts/f.ttf`],
      /check/,
    );
    // Más de 5 MB.
    await denied(
      db,
      ana,
      `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type, bytes,
                                       license_confirmed)
       values ($1, $2, 'Pesada', 'ttf', $3, 'f.ttf', 'font/ttf', 6000000, true)`,
      [marcaA, orgA, `${orgA}/${marcaA}/fonts/pesada.ttf`],
      /check/,
    );
  });

  it('el cubo admite los tipos de fuente', async () => {
    const [bucket] = await db.query<{ allowed_mime_types: string[] }>(
      `select allowed_mime_types from storage.buckets where id = 'brand-media'`,
    );
    expect(bucket!.allowed_mime_types).toEqual(
      expect.arrayContaining(['font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'application/pdf']),
    );
  });

  it('el cliente no cambia una tipografía (solo sube y borra)', async () => {
    await denied(db, ana, `update public.brand_fonts set family = 'Cambiada' where brand_id = $1`, [marcaA]);
    // El editor no gestiona la marca: su borrado no alcanza ninguna fila.
    expect(await as(db, editor, `delete from public.brand_fonts where brand_id = $1 returning id`, [marcaA])).toEqual(
      [],
    );
    expect(await as(db, ana, `select 1 from public.brand_fonts where brand_id = $1`, [marcaA])).toHaveLength(1);
  });
});

describe('tipografía de los reels', () => {
  it('sin .ttf/.otf, el reel no lleva tipografía (el trabajador usa la de reserva)', async () => {
    // Solo hay una .woff2: no vale para FFmpeg.
    expect(await as(db, editor, `select * from public.brand_reel_font_info($1)`, [marcaA])).toEqual([]);
    const plan = await requestReel(editor, marcaA, [{ text: 'Hola', start: 0, end: 2 }]);
    expect(plan.fontPath).toBeUndefined();
  });

  it('con archivos .ttf/.otf: la familia del perfil primero, redonda y peso cercano a 400', async () => {
    await addFont(ana, orgA, marcaA, { family: 'Palo Seco', weight: 700 });
    const regular = await addFont(ana, orgA, marcaA, { family: 'Palo Seco', weight: 400, format: 'otf' });
    await addFont(ana, orgA, marcaA, { family: 'Palo Seco', weight: 400, style: 'italic' });
    const perfil = await addFont(ana, orgA, marcaA, { family: 'Titular', weight: 800 });

    let plan = await requestReel(editor, marcaA, [{ text: 'Hola', start: 0, end: 2 }]);
    expect(plan.fontPath).toBe(regular);

    await as(db, ana, `select public.save_brand_profile($1, $2::jsonb)`, [
      marcaA,
      JSON.stringify({ schema_version: 1, visual: { fonts: [{ family: 'titular', usage: 'Títulos' }] } }),
    ]);
    plan = await requestReel(editor, marcaA, [{ text: 'Hola', start: 0, end: 2 }]);
    expect(plan.fontPath).toBe(perfil);
    expect(
      await as(db, editor, `select family, weight, format from public.brand_reel_font_info($1)`, [marcaA]),
    ).toEqual([{ family: 'Titular', weight: 800, format: 'ttf' }]);
  });

  it('sin textos no hace falta tipografía; y el cliente no puede elegir la ruta', async () => {
    const plan = await requestReel(editor, marcaA, []);
    expect(plan.fontPath).toBeUndefined();
    await denied(
      db,
      editor,
      `select public.request_media_job($1, 'media.reel.template', $2::jsonb, 'clave-con-fuente')`,
      [
        marcaA,
        JSON.stringify({
          template: { id: 'fundido-suave' },
          plan: { media: [{ type: 'photo', path: foto }], fontPath: `${orgB}/${marcaB}/fonts/ajena.ttf` },
        }),
      ],
      /solo admite/,
    );
  });

  it('nadie de fuera consulta la tipografía de la marca', async () => {
    await denied(db, berta, `select * from public.brand_reel_font_info($1)`, [marcaA], /No tienes acceso/);
  });
});
