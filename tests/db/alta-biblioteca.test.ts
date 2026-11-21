// Alta en la biblioteca de lo copiado a R2 (scripts/alta-biblioteca.ts) y marca
// en modo agencia (scripts/crear-marca-agencia.sql): mapeo marca → brand_id,
// nombre legible, etiquetas, dimensiones, recuento en seco y, contra las
// migraciones reales (PGlite), idempotencia, huérfanos y almacén `r2`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectStorage } from '../../supabase/functions/_shared/storage/contract.ts';
import {
  checkImported,
  defaultCategoryRule,
  draftAsset,
  formatAltaSummary,
  imageSize,
  isCameraName,
  normalizeTag,
  parseAltaMapping,
  planAlta,
  provenanceFor,
  readableName,
  runAlta,
  tagsFor,
  type AssetRow,
  type LibraryDb,
} from '../../scripts/alta-biblioteca.ts';
import {
  buildPlan,
  IMPORT_FOLDER,
  parseCsv,
  resolveBrandOrganizations,
  type InventoryMeta,
  type PlanItem,
} from '../../scripts/migrar-a-r2.ts';
import { as, asService, createBrand, createDb, createOrg, createUser, join, type Db, type TestUser } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MARCA_A = '22222222-2222-4222-8222-222222222222';
const MARCA_B = '33333333-3333-4333-8333-333333333333';

const CSV = [
  'id;nombre;mimeType;formato;bytes;ruta;marca;categoria;subcategoria;estado;jpeg_id;jpeg_estado',
  'vinoHeic000000001;Collet Rosé - IMG_0142.HEIC;image/heic;HEIC;3000;Fotos/Vinos/Espumosos/Collet Rosé;Marca Uno;vinos/botellas;Espumosos;incluida;jpegDeDrive00001;convertida',
  'platoJpeg00000001;ORIGINAL - Anchoa elaborada.jpg;image/jpeg;JPEG;1500;Fotos/Platos/03 Entrantes fríos/Anchoa elaborada;Marca Uno;platos;03 Entrantes fríos;incluida;;',
  'coctelVideo000001;clover club - IMG_0397.MOV;video/quicktime;MOV;900000;Bar/Cócteles/Clover Club;Marca Dos;cócteles;Clover Club;incluida;;',
  'botella0000000001;Jameson - IMG_0454.jpg;image/jpeg;JPEG;2500;Bar/Botellas/Whiskies;marca dos;licores/botellas de barra;Whiskies;incluida;;',
  'sinDestino0000001;IMG_1.jpg;image/jpeg;JPEG;100;Otra/Cosas;Marca Tres;local y ambiente;Sala;incluida;;',
  'factura0000000001;factura.jpeg;image/jpeg;JPEG;100;FACTURAS;(administración);documento;Proveedor;excluida: facturas;;',
].join('\n');

const MAPEO = {
  marcas: { 'Marca Uno': MARCA_A, 'Marca Dos': { brand_id: MARCA_B } },
  categorias: {
    'vinos/botellas': { etiquetas: ['Vinos', 'botellas'], carpeta: 'Vinos' },
    'licores/botellas de barra': ['licores', 'botellas'],
  },
};

const meta = (over: Partial<InventoryMeta>): InventoryMeta => ({
  driveId: 'archivoDeDrive0001',
  jpegDriveId: null,
  name: 'IMG_0001.HEIC',
  path: 'Carpeta',
  brand: 'Marca',
  category: 'local y ambiente',
  subcategory: '',
  originalMime: 'image/heic',
  fromHeic: false,
  ...over,
});

function planFor(orgs: Record<string, string | null> = {}, localSizes = new Map<string, number>()) {
  const mapping = parseAltaMapping(MAPEO);
  for (const [label, t] of mapping.brands) mapping.brands.set(label, { ...t, organizationId: orgs[t.brandId] ?? null });
  const plan = buildPlan({
    brands: mapping.brands,
    org: null,
    brand: null,
    brandMedia: null,
    driveRows: parseCsv(CSV),
    estado: 'incluida',
    jpegDir: '/jpeg',
    jpegList: [{ id: 'vinoHeic000000001' }, { id: 'jpegSinInventario', title: 'Suelto.jpg' }],
    localSize: (file) => localSizes.get(file.replace(/\\/g, '/')) ?? null,
  });
  return { mapping, plan };
}

describe('alta en la biblioteca: mapeo y recuento en seco', () => {
  it('lee el mapeo y rechaza lo que no es un uuid o está repetido', () => {
    const m = parseAltaMapping(MAPEO);
    expect(m.brands.get('marca uno')).toEqual({ brandId: MARCA_A, organizationId: null });
    expect(m.categories.get('vinos/botellas')).toEqual({ tags: ['vinos', 'botellas'], folder: 'Vinos' });
    expect(m.categories.get('licores/botellas de barra')).toEqual({ tags: ['licores', 'botellas'], folder: 'Licores' });
    expect(() => parseAltaMapping({ marcas: { X: 'no-es-uuid' } })).toThrow(/brand_id/);
    expect(() => parseAltaMapping({ marcas: { 'Marca Uno': MARCA_A, 'marca  uno': MARCA_B } })).toThrow(/dos veces/);
    expect(() => parseAltaMapping({ marcas: {} })).toThrow(/ninguna marca/);
    expect(() => parseAltaMapping({})).toThrow(/marcas/);
    expect(() => parseAltaMapping({ marcas: { X: MARCA_A }, categorias: { a: { etiquetas: 'x' } } })).toThrow(
      /etiquetas/,
    );
  });

  it('cada fila va a la marca de su columna «marca»; sin destino, no se copia', () => {
    const { plan } = planFor(
      { [MARCA_A]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      new Map([['/jpeg/vinoHeic000000001.jpg', 2000]]),
    );
    const keys = plan.items.map((i) => `${i.brandId} ${i.key}`);
    expect(keys).toEqual([
      `${MARCA_A} aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${MARCA_A}/${IMPORT_FOLDER}/vinoHeic000000001-Collet-Rose-IMG_0142.jpg`,
      `${MARCA_A} aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${MARCA_A}/${IMPORT_FOLDER}/platoJpeg00000001-ORIGINAL-Anchoa-elaborada.jpg`,
      `${MARCA_B} <org>/${MARCA_B}/${IMPORT_FOLDER}/coctelVideo000001-clover-club-IMG_0397.mov`,
      `${MARCA_B} <org>/${MARCA_B}/${IMPORT_FOLDER}/botella0000000001-Jameson-IMG_0454.jpg`,
    ]);
    // Nunca bajo «/drive/»: la biblioteca reserva esa carpeta para las referencias de Drive.
    expect(plan.items.every((i) => !i.key.includes('/drive/'))).toBe(true);
    expect(plan.skipped).toMatchObject({
      'marca sin destino en --marcas: Marca Tres': 1,
      'JPEG sin fila en el inventario (no se sabe su marca)': 1,
    });
    expect(plan.items[0]!.meta).toMatchObject({
      driveId: 'vinoHeic000000001',
      jpegDriveId: 'jpegDeDrive00001',
      fromHeic: true,
    });
  });

  it('la organización de cada marca sale de la base de datos y tiene que cuadrar con el mapeo', async () => {
    const m = parseAltaMapping({ marcas: { A: MARCA_A, B: { brand_id: MARCA_B, organization_id: MARCA_A } } });
    const lookup = async () =>
      new Map([
        [MARCA_A, 'org-a'],
        [MARCA_B, 'org-b'],
      ]);
    await expect(resolveBrandOrganizations(m.brands, lookup)).rejects.toThrow(/organización org-b/);
    const solo = parseAltaMapping({ marcas: { A: MARCA_A } });
    expect((await resolveBrandOrganizations(solo.brands, lookup)).get('a')?.organizationId).toBe('org-a');
    await expect(resolveBrandOrganizations(solo.brands, async () => new Map())).rejects.toThrow(/no existe/);
  });

  it('nombre legible: el plato o el vino de la carpeta, la botella del archivo, la carpeta si no hay más', () => {
    expect(
      readableName(
        meta({ name: 'Collet Rosé - IMG_0142.HEIC', path: 'F/Vinos/Espumosos/Collet Rosé', subcategory: 'Espumosos' }),
      ),
    ).toBe('Collet Rosé');
    expect(readableName(meta({ name: 'x.jpg', path: 'F/Vinos/Blancos/200 Cestos', subcategory: 'Blancos' }))).toBe(
      '200 Cestos',
    );
    expect(
      readableName(
        meta({
          name: 'ORIGINAL - Anchoa.jpg',
          path: 'F/Platos/03 Entrantes fríos/Anchoa',
          subcategory: '03 Entrantes fríos',
        }),
      ),
    ).toBe('Anchoa');
    expect(
      readableName(
        meta({ name: 'clover club 1 - C018.jpg', path: 'B/Cócteles/Clover Club', subcategory: 'Clover Club' }),
      ),
    ).toBe('Clover Club');
    expect(
      readableName(
        meta({ name: 'VIDEO-2026-11-16-18-04-35.mp4', path: 'B/Cócteles/Flower Spritz', subcategory: 'Flower Spritz' }),
      ),
    ).toBe('Flower Spritz');
    expect(
      readableName(meta({ name: 'Jameson - IMG_0454.HEIC', path: 'B/Botellas/Whiskies', subcategory: 'Whiskies' })),
    ).toBe('Jameson');
    expect(
      readableName(meta({ name: 'elaboracion - IMG_0249.HEIC', path: 'B/Cócteles/Elaboración', subcategory: 'x' })),
    ).toBe('Elaboración');
    expect(
      readableName(meta({ name: 'IMG_0031.HEIC', path: 'F/Local y ambiente/Terraza', subcategory: 'Terraza' })),
    ).toBe('Terraza');
    expect(readableName(meta({ name: 'FullSizeRender.heic', path: 'F/_Sin revisar' }))).toBe('Sin revisar');
    expect(
      readableName(meta({ name: 'setas-de-temporada-366a1ac5-fc92-44cb-b4d2-488e63b5f1c2.jpg', path: 'F/carta/app' })),
    ).toBe('Setas de temporada');
    expect(isCameraName('IMG_0411 2')).toBe(true);
    expect(isCameraName('Jameson')).toBe(false);
  });

  it('etiquetas: categoría y subcategoría, sin rutas, marcadores ni el nombre de la marca', () => {
    const rule = defaultCategoryRule('vinos/botellas');
    expect(rule).toEqual({ tags: ['vinos', 'botellas'], folder: 'Vinos' });
    expect(normalizeTag('03 Entrantes fríos')).toBe('entrantes fríos');
    expect(normalizeTag('200 Cestos')).toBe('200 cestos');
    expect(tagsFor(meta({ subcategory: 'Espumosos', path: 'F/Vinos/Espumosos/X' }), rule)).toEqual([
      'vinos',
      'botellas',
      'espumosos',
    ]);
    expect(tagsFor(meta({ subcategory: 'carta/app', path: 'F/carta/app' }), rule)).toEqual(['vinos', 'botellas']);
    expect(tagsFor(meta({ subcategory: '(raíz)', path: 'B/Botellas' }), rule)).toEqual(['vinos', 'botellas']);
    expect(tagsFor(meta({ subcategory: 'Marca', brand: 'Marca' }), rule)).toEqual(['vinos', 'botellas']);
  });

  it('procedencia con el id y la ruta de Drive, siempre por debajo del límite de la base de datos', () => {
    const p = provenanceFor(meta({ fromHeic: true, jpegDriveId: 'jpegDeDrive00001', path: 'x/'.repeat(2000) }), 't');
    expect(p).toMatchObject({
      type: 'import',
      source: 'google_drive',
      drive_file_id: 'archivoDeDrive0001',
      converted_from: 'image/heic',
    });
    expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(2048);
  });

  it('lee ancho y alto de JPEG (con la orientación EXIF) y de PNG', () => {
    const jpeg = (orientation: number) => {
      const exif = [
        0xff,
        0xe1,
        0x00,
        0x22,
        0x45,
        0x78,
        0x69,
        0x66,
        0x00,
        0x00, // APP1 «Exif\0\0»
        0x4d,
        0x4d,
        0x00,
        0x2a,
        0x00,
        0x00,
        0x00,
        0x08, // TIFF big-endian, IFD0 en 8
        0x00,
        0x01,
        0x01,
        0x12,
        0x00,
        0x03,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        orientation,
        0x00,
        0x00, // orientación
        0x00,
        0x00,
        0x00,
        0x00,
      ];
      const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x0f, 0xc0, 0x0b, 0xd0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      return new Uint8Array([0xff, 0xd8, ...exif, ...sof]);
    };
    expect(imageSize(jpeg(1))).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(6))).toEqual({ width: 4032, height: 3024 });
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0, 0, 4, 56, 0, 0, 5, 70], 16);
    expect(imageSize(png)).toEqual({ width: 1080, height: 1350 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('en seco cuenta por marca y categoría; con --state, solo lo copiado; la misma huella no se repite', () => {
    const { mapping, plan } = planFor({}, new Map([['/jpeg/vinoHeic000000001.jpg', 2000]]));
    const dry = planAlta({
      items: plan.items,
      mapping,
      copied: new Map(),
      inR2: null,
      library: null,
      assumeCopied: true,
      importedAt: 't',
    });
    expect(dry.create).toHaveLength(4);
    const text = formatAltaSummary(dry);
    expect(text).toMatch(/Marca Uno \| vinos\/botellas \| 1 \| 0 \| .* \| Vinos/);
    expect(text).toMatch(/Marca Dos \| cócteles \| 0 \| 1 \|/);
    expect(text).toMatch(/TOTAL \| 4 recursos/);

    const [vino, plato, coctel] = plan.items;
    const copied = new Map([
      [vino!.key, { bytes: 2000, sha256: 'a'.repeat(64) }],
      [plato!.key, { bytes: 1500, sha256: 'a'.repeat(64) }],
      [coctel!.key, { bytes: 900000, sha256: 'b'.repeat(64) }],
    ]);
    const withState = planAlta({
      items: plan.items,
      mapping,
      copied,
      inR2: null,
      library: null,
      assumeCopied: false,
      importedAt: 't',
    });
    expect(withState.create.map((d) => d.item.key)).toEqual([vino!.key, coctel!.key]);
    expect(withState.skipped).toMatchObject({
      'repetida en esta pasada (misma huella)': 1,
      'sin copiar a R2 todavía': 1,
    });

    const library = new Map([[MARCA_B, { paths: new Set<string>(), hashes: new Set(['b'.repeat(64)]) }]]);
    const again = planAlta({
      items: plan.items,
      mapping,
      copied,
      inR2: null,
      library,
      assumeCopied: false,
      importedAt: 't',
    });
    expect(again.skipped['la misma foto ya está en la biblioteca de la marca (misma huella)']).toBe(1);
  });
});

// ─────────────────────── Contra las migraciones reales ───────────────────────

/** R2 en memoria. */
function memoryR2(): ObjectStorage & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    backend: 'r2',
    objects,
    signGet: async (key) => `https://r2.test/${key}`,
    signPut: async (key, contentType, bytes, seconds) => ({
      url: `https://r2.test/${key}`,
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

/** La base de datos del alta, con la clave de servicio, sobre PGlite. */
function pgliteLibraryDb(db: Db): LibraryDb & { registered: string[] } {
  const registered: string[] = [];
  return {
    registered,
    brandAssets: (brandId) =>
      asService(
        db,
        `select storage_path, sha256, bytes, storage_backend from public.media_assets where brand_id = $1`,
        [brandId],
      ) as never,
    async registerR2(p) {
      registered.push(p);
      await asService(db, `select public.media_storage_register_upload(null, $1)`, [p]);
    },
    async insertAssets(rows: AssetRow[]) {
      const inserted = await asService(
        db,
        `insert into public.media_assets (brand_id, organization_id, kind, origin, source, storage_backend, storage_path,
           file_name, mime_type, bytes, width, height, duration_ms, sha256, folder, tags, provenance)
         select brand_id, organization_id, kind, origin, source, storage_backend, storage_path, file_name, mime_type,
                bytes, width, height, duration_ms, sha256, folder, tags, provenance
         from jsonb_to_recordset($1::jsonb) as r(brand_id uuid, organization_id uuid, kind public.asset_kind,
           origin public.asset_origin, source text, storage_backend text, storage_path text, file_name text,
           mime_type text, bytes bigint, width int, height int, duration_ms int, sha256 text, folder text,
           tags text[], provenance jsonb)
         on conflict (storage_path) do nothing
         returning id`,
        [JSON.stringify(rows)],
      );
      return inserted.length;
    },
  };
}

describe('alta en la biblioteca contra la base de datos', () => {
  let db: Db;
  let ana: TestUser, berta: TestUser, gestora: TestUser;
  let org: string, orgB: string, marcaUno: string, marcaDos: string, marcaAjena: string;

  beforeAll(async () => {
    db = await createDb();
    ana = await createUser(db, 'ana@alta.test');
    berta = await createUser(db, 'berta@alta.test');
    gestora = await createUser(db, 'gestora@alta.test');
    org = await createOrg(db, ana, 'Agencia');
    marcaUno = await createBrand(db, ana, org, 'Uno');
    marcaDos = await createBrand(db, ana, org, 'Dos');
    orgB = await createOrg(db, berta, 'Otra');
    marcaAjena = await createBrand(db, berta, orgB, 'Ajena');
    await join(db, ana, gestora, org, 'member', marcaUno, 'editor');
  });
  afterAll(async () => {
    await db?.close();
  });

  function realPlan() {
    const mapping = parseAltaMapping({ ...MAPEO, marcas: { 'Marca Uno': marcaUno, 'Marca Dos': marcaDos } });
    for (const [label, t] of mapping.brands) mapping.brands.set(label, { ...t, organizationId: org });
    const plan = buildPlan({
      brands: mapping.brands,
      org: null,
      brand: null,
      brandMedia: null,
      driveRows: parseCsv(CSV),
      estado: 'incluida',
      jpegDir: '/jpeg',
      jpegList: null,
      localSize: (file) => (file.replace(/\\/g, '/') === '/jpeg/vinoHeic000000001.jpg' ? 2000 : null),
    });
    return { mapping, items: plan.items };
  }

  it('da de alta lo copiado en la marca de cada fila, en R2, y relanzarlo no duplica nada', async () => {
    const { mapping, items } = realPlan();
    const r2 = memoryR2();
    const [vino, plato, coctel, botella] = items as [PlanItem, PlanItem, PlanItem, PlanItem];
    for (const it of [vino, plato, coctel]) r2.objects.set(it.key, it.bytes || 100);
    const copied = new Map([
      [vino.key, { bytes: 2000, sha256: '1'.repeat(64) }],
      [plato.key, { bytes: 1500, sha256: '2'.repeat(64) }],
      // El vídeo se subió pero la copia se cortó antes de anotarlo: huérfano.
    ]);
    const ldb = pgliteLibraryDb(db);
    const first = await runAlta({
      items,
      mapping,
      copied,
      r2,
      db: ldb,
      dimsFor: async (it) => (it.mime.startsWith('image/') ? { width: 3024, height: 4032, durationMs: null } : null),
      now: () => '2026-11-20T00:00:00.000Z',
    });
    expect(first.failed).toEqual([]);
    expect(first.created).toBe(3);
    expect(first.plan.orphans).toEqual([coctel.key]);
    expect(first.plan.skipped['sin copiar a R2 todavía']).toBe(1); // la botella

    const rows = await asService<{
      brand_id: string;
      storage_path: string;
      storage_backend: string;
      origin: string;
      kind: string;
      file_name: string;
      folder: string;
      tags: string[];
      width: number | null;
      provenance: Record<string, unknown>;
    }>(db, `select * from public.media_assets where storage_path like '%/' || $1 || '/%' order by storage_path`, [
      IMPORT_FOLDER,
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.storage_backend === 'r2' && r.origin === 'import')).toBe(true);
    const byKey = new Map(rows.map((r) => [r.storage_path, r]));
    expect(byKey.get(vino.key)).toMatchObject({
      brand_id: marcaUno,
      kind: 'image',
      file_name: 'Collet Rosé.jpg',
      folder: 'Vinos',
      tags: ['vinos', 'botellas', 'espumosos'],
      width: 3024,
    });
    expect(byKey.get(vino.key)!.provenance).toMatchObject({
      drive_file_id: 'vinoHeic000000001',
      drive_path: 'Fotos/Vinos/Espumosos/Collet Rosé',
    });
    expect(byKey.get(plato.key)).toMatchObject({
      brand_id: marcaUno,
      file_name: 'Anchoa elaborada.jpg',
      tags: ['platos', 'entrantes fríos'],
    });
    expect(byKey.get(coctel.key)).toMatchObject({
      brand_id: marcaDos,
      kind: 'video',
      file_name: 'Clover Club.mov',
      folder: 'Cócteles',
    });
    // Apuntados como objetos de R2, igual que las subidas de media-storage.
    const [located] = await db.query<{ n: number }>(
      `select count(*)::int as n from private.media_object_locations where storage_path = any($1)`,
      [[vino.key, plato.key, coctel.key]],
    );
    expect(located!.n).toBe(3);

    // Relanzar: nada nuevo, nada duplicado.
    const again = await runAlta({ items, mapping, copied, r2, db: ldb });
    expect(again.created).toBe(0);
    expect(again.plan.create).toHaveLength(0);
    expect(again.plan.skipped['ya en la biblioteca']).toBe(3);

    // La botella llega a R2 más tarde: la siguiente pasada la completa.
    r2.objects.set(botella.key, 2500);
    const later = await runAlta({ items, mapping, copied, r2, db: ldb });
    expect(later.created).toBe(1);
    const [count] = await asService<{ n: number }>(
      db,
      `select count(*)::int as n from public.media_assets where storage_path like '%/' || $1 || '/%'`,
      [IMPORT_FOLDER],
    );
    expect(count!.n).toBe(4);

    // Comprobar: todo cuadra; un objeto suelto sale como huérfano y un tamaño distinto, como error.
    const assets = await asService<{
      storage_path: string;
      sha256: string | null;
      bytes: number;
      storage_backend: string;
    }>(db, `select storage_path, sha256, bytes, storage_backend from public.media_assets where brand_id = any($1)`, [
      [marcaUno, marcaDos],
    ]);
    const inR2 = new Map(r2.objects);
    expect(checkImported(assets, inR2)).toMatchObject({ ok: 4, missing: [], sizeMismatch: [], orphans: [] });
    inR2.set(`${org}/${marcaUno}/${IMPORT_FOLDER}/suelto.jpg`, 1);
    inR2.set(vino.key, 1);
    expect(checkImported(assets, inR2)).toMatchObject({
      ok: 3,
      sizeMismatch: [vino.key],
      orphans: [`${org}/${marcaUno}/${IMPORT_FOLDER}/suelto.jpg`],
    });
  });

  it('la marca sigue aislada: quien no es de la organización no ve lo importado', async () => {
    const [visible] = await as<{ n: number }>(
      db,
      berta,
      `select count(*)::int as n from public.media_assets where brand_id = any($1)`,
      [[marcaUno, marcaDos]],
    );
    expect(visible!.n).toBe(0);
    const [propias] = await as<{ n: number }>(
      db,
      gestora,
      `select count(*)::int as n from public.media_assets where brand_id = $1`,
      [marcaUno],
    );
    expect(propias!.n).toBe(2);
    // Un mapeo con la marca de otra organización no cuadra con la organización de sus claves.
    const r2 = memoryR2();
    const bad = parseAltaMapping({ marcas: { 'Marca Uno': marcaAjena } });
    for (const [label, t] of bad.brands) bad.brands.set(label, { ...t, organizationId: org });
    const plan = buildPlan({
      brands: bad.brands,
      org: null,
      brand: null,
      brandMedia: null,
      driveRows: parseCsv(CSV),
      estado: 'incluida',
      jpegDir: null,
      jpegList: null,
      localSize: () => null,
    });
    for (const it of plan.items) r2.objects.set(it.key, 10);
    const result = await runAlta({ items: plan.items, mapping: bad, copied: new Map(), r2, db: pgliteLibraryDb(db) });
    expect(result.created).toBe(0);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.failed[0]!.error).toMatch(/ninguna marca/);
    void orgB;
  });

  it('la ruta antigua «import/drive/» no vale para la biblioteca (por eso la copia usa import/google-drive)', async () => {
    await expect(
      asService(
        db,
        `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
         values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
        [marcaUno, org, `${org}/${marcaUno}/import/drive/x.jpg`],
      ),
    ).rejects.toThrow(/reservada/);
  });

  it('el SQL de marca en modo agencia crea la marca con los miembros de la de referencia y es repetible', async () => {
    const template = await readFile(path.join(ROOT, 'scripts/crear-marca-agencia.sql'), 'utf8');
    // Sin rellenar, no hace nada.
    await expect(db.exec(template)).rejects.toThrow(/uuid/);
    await db.exec('rollback').catch(() => undefined);
    const sql = template
      .replace("'<organization_id>'", `'${org}'`)
      .replace("'<nombre de la marca>'", "'Marca Nueva'")
      .replace("'<brand_id de referencia o vacío>'", `'${marcaUno}'`);
    await db.exec(sql);
    await db.exec(sql);
    const brands = await db.query<{ id: string; ai_mode: string }>(
      `select id, ai_mode from public.brands where organization_id = $1 and name = 'Marca Nueva'`,
      [org],
    );
    expect(brands).toHaveLength(1);
    expect(brands[0]!.ai_mode).toBe('agency');
    const members = await db.query<{ user_id: string; role: string }>(
      `select user_id, role::text from public.brand_members where brand_id = $1 order by role`,
      [brands[0]!.id],
    );
    const reference = await db.query<{ user_id: string; role: string }>(
      `select user_id, role::text from public.brand_members where brand_id = $1 order by role`,
      [marcaUno],
    );
    expect(members).toEqual(reference);
    expect(members.some((m) => m.user_id === gestora.id && m.role === 'editor')).toBe(true);
    // La gestora la ve con su sesión; alguien de otra organización, no.
    expect(await as(db, gestora, `select id from public.brands where id = $1`, [brands[0]!.id])).toHaveLength(1);
    expect(await as(db, berta, `select id from public.brands where id = $1`, [brands[0]!.id])).toHaveLength(0);
  });

  it('draftAsset nunca sobrepasa los límites de la tabla', () => {
    const { mapping, items } = realPlan();
    const d = draftAsset(items[0]!, mapping, { bytes: 1, sha256: null }, 't');
    expect(d.row.file_name.length).toBeLessThanOrEqual(255);
    expect(d.row.folder.length).toBeLessThanOrEqual(200);
    expect(d.row.tags.length).toBeLessThanOrEqual(50);
  });
});
