import { describe, expect, it } from 'vitest';
import {
  blurRadius,
  ASPECT_RATIOS,
  CANVAS_SIZES,
  DOCUMENT_MIGRATIONS,
  DOCUMENT_SCHEMA_VERSION,
  DocumentError,
  aspectRatioValue,
  createEmptyDocument,
  MAX_LAYERS,
  MAX_PAGES,
  migrateDocument,
  runMigrations,
  validateDocument,
  validateDocumentFromAnyVersion,
  type ContentDocumentInput,
  type DocumentMigration,
  isNeutralAdjust,
} from './index';

const ASSET = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';

type LayersInput = NonNullable<NonNullable<ContentDocumentInput['pages']>[number]['layers']>;

/** Capas de ejemplo, una de cada tipo, escritas como las escribiría un editor o la IA. */
function sampleLayers(): LayersInput {
  return [
      {
        id: 'fondo',
        type: 'image',
        x: 0,
        y: 0,
        width: 1080,
        height: 1350,
        source: { kind: 'asset', assetId: ASSET },
        anchor: { x: 'stretch', y: 'stretch' },
      },
      { id: 'banda', type: 'shape', shape: 'rectangle', x: 0, y: 1100, width: 1080, height: 250, fill: '#000000' },
      {
        id: 'titular',
        type: 'text',
        x: 80,
        y: 1130,
        width: 920,
        height: 120,
        text: 'Menú de otoño',
        fontFamily: 'Inter',
        fontSize: 72,
        color: '#FFFFFF',
      },
      { id: 'logo', type: 'logo', x: 900, y: 60, width: 120, height: 120, assetId: ASSET },
  ];
}

const CANVAS = { aspectRatio: '4:5', width: 1080, height: 1350, backgroundColor: '#101010' } as const;
const COPY = { caption: 'Ya está aquí.', hashtags: ['#otoño', 'menu_del_dia'], mentions: ['@proveedor.local'] };

/** Documento de ejemplo (versión actual) de una página con esas capas. */
function sample(layers: LayersInput = sampleLayers()): ContentDocumentInput {
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, canvas: { ...CANVAS }, pages: [{ id: 'p1', layers }], copy: COPY };
}

/** El mismo documento tal y como lo guardaban las versiones 1 a 3 (sin páginas: una lista de capas). */
function savedBefore(version: 1 | 2 | 3) {
  return { schemaVersion: version, canvas: { ...CANVAS }, layers: sampleLayers(), copy: COPY };
}

const pageLayersOf = (input: ContentDocumentInput) => input.pages![0]!.layers!;

const issuesOf = (input: unknown) => {
  const result = validateDocument(input);
  return result.ok ? [] : result.issues;
};

describe('lienzo', () => {
  it('cada proporción tiene un lienzo lógico que la cumple', () => {
    for (const ratio of ASPECT_RATIOS) {
      const { width, height } = CANVAS_SIZES[ratio];
      expect(width / height, ratio).toBeCloseTo(aspectRatioValue(ratio), 6);
    }
    expect(aspectRatioValue('9:16')).toBeCloseTo(0.5625, 6);
  });
});

describe('createEmptyDocument', () => {
  it('crea un documento válido, cuadrado y blanco por defecto', () => {
    const document = createEmptyDocument();
    expect(document).toEqual({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
      pages: [{ id: 'p1', name: '', layers: [] }],
      copy: { caption: '', hashtags: [], mentions: [], altText: '', callToAction: { label: '', url: '' } },
    });
    expect(validateDocument(document)).toEqual({ ok: true, document });
  });

  it('respeta la proporción y el color de fondo pedidos', () => {
    for (const ratio of ASPECT_RATIOS) {
      const { canvas } = createEmptyDocument({ aspectRatio: ratio, backgroundColor: '#112233' });
      expect(canvas).toEqual({ aspectRatio: ratio, ...CANVAS_SIZES[ratio], backgroundColor: '#112233' });
    }
  });

  it('no admite un color que no sea #RRGGBB', () => {
    expect(() => createEmptyDocument({ backgroundColor: 'rojo' })).toThrow(/#RRGGBB/);
  });
});

describe('validateDocument', () => {
  it('acepta un documento con las cuatro clases de capa y pone los valores por defecto', () => {
    const result = validateDocument(sample());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [fondo, banda, titular, logo] = result.document.pages[0]!.layers;

    expect(fondo).toMatchObject({
      type: 'image',
      fit: 'cover',
      focus: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      name: '',
    });
    expect(banda).toMatchObject({ type: 'shape', stroke: null, cornerRadius: 0, anchor: { x: 'center', y: 'center' } });
    expect(titular).toMatchObject({ type: 'text', fontWeight: 400, italic: false, align: 'left', lineHeight: 1.2 });
    expect(logo).toMatchObject({ type: 'logo', assetId: ASSET });
    // El orden de las capas es el orden de apilado y se conserva.
    expect(result.document.pages[0]!.layers.map((l) => l.id)).toEqual(['fondo', 'banda', 'titular', 'logo']);
  });

  it('una imagen puede venir de la biblioteca o de una generación, nunca incrustada', () => {
    const withSource = (source: unknown) => {
      const document = sample();
      (pageLayersOf(document)[0] as { source: unknown }).source = source;
      return issuesOf(document);
    };
    expect(withSource({ kind: 'generation', generationId: GENERATION })).toEqual([]);
    expect(withSource({ kind: 'asset', assetId: 'no-es-uuid' })).not.toEqual([]);
    expect(withSource({ kind: 'url', url: 'https://x.test/a.jpg' })).not.toEqual([]);
    expect(withSource('data:image/png;base64,AAAA')).not.toEqual([]);
  });

  it('normaliza hashtags y menciones: sin almohadilla ni arroba', () => {
    const result = validateDocument(sample());
    if (!result.ok) throw new Error('inválido');
    expect(result.document.copy.hashtags).toEqual(['otoño', 'menu_del_dia']);
    expect(result.document.copy.mentions).toEqual(['proveedor.local']);
  });

  it('rechaza hashtags y menciones mal formados, y enlaces que no son http', () => {
    const withCopy = (copy: ContentDocumentInput['copy']) => issuesOf({ ...sample(), copy });
    expect(withCopy({ hashtags: ['dos palabras'] })[0]).toMatchObject({ path: 'copy.hashtags.0' });
    expect(withCopy({ hashtags: ['#'] })[0]).toMatchObject({ path: 'copy.hashtags.0' });
    expect(withCopy({ mentions: ['con espacio'] })[0]).toMatchObject({ path: 'copy.mentions.0' });
    expect(withCopy({ callToAction: { label: 'Reserva', url: 'javascript:alert(1)' } })[0]).toMatchObject({
      path: 'copy.callToAction.url',
    });
    expect(withCopy({ callToAction: { label: 'Reserva', url: 'https://x.test/reservas' } })).toEqual([]);
    expect(withCopy({ callToAction: { label: 'Reserva' } })).toEqual([]);
  });

  it('dice qué falla y dónde', () => {
    const document = sample();
    (pageLayersOf(document)[2] as { fontSize: number }).fontSize = 0;
    (pageLayersOf(document)[3] as { opacity: number }).opacity = 1.5;
    expect(issuesOf(document).map((issue) => issue.path)).toEqual([
      'pages.0.layers.2.fontSize',
      'pages.0.layers.3.opacity',
    ]);
  });

  it('rechaza capas de un tipo desconocido, sin tamaño o con identificador repetido', () => {
    const withLayers = (layers: unknown[]) => issuesOf(sample(layers as LayersInput));
    expect(withLayers([{ id: 'v', type: 'video', x: 0, y: 0, width: 1, height: 1 }])[0]?.path).toBe(
      'pages.0.layers.0.type',
    );
    expect(withLayers([{ id: 'a', type: 'logo', x: 0, y: 0, width: 0, height: 10, assetId: ASSET }])[0]?.path).toBe(
      'pages.0.layers.0.width',
    );
    const repeated = { id: 'a', type: 'logo', x: 0, y: 0, width: 10, height: 10, assetId: ASSET };
    expect(withLayers([repeated, repeated])).toEqual([
      { path: 'pages.0.layers.1.id', message: 'Hay dos capas con el mismo identificador' },
    ]);
  });

  it('rechaza un lienzo cuyo tamaño no corresponde a su proporción, o una proporción que no existe', () => {
    const base = sample();
    expect(issuesOf({ ...base, canvas: { aspectRatio: '1:1', width: 1080, height: 1350 } })).toEqual([
      { path: 'canvas.width', message: 'El tamaño del lienzo no corresponde a su proporción' },
    ]);
    expect(issuesOf({ ...base, canvas: { aspectRatio: '2:3', width: 1000, height: 1500 } })[0]?.path).toBe(
      'canvas.aspectRatio',
    );
    // Otro tamaño lógico con la misma proporción sí vale.
    expect(issuesOf({ ...sample([]), canvas: { aspectRatio: '4:5', width: 2160, height: 2700 } })).toEqual([]);
  });

  it('no migra: un documento de otra versión del esquema no es válido tal cual', () => {
    expect(issuesOf({ ...sample(), schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 })[0]?.path).toBe('schemaVersion');
    expect(issuesOf(null)).not.toEqual([]);
    expect(issuesOf('texto')).not.toEqual([]);
  });
});

describe('migrar entre versiones del esquema', () => {
  // Migraciones de ejemplo, solo para probar el mecanismo: hoy el esquema
  // real tiene una única versión.
  const toV2: DocumentMigration = (d) => ({ ...d, pie: d.texto, texto: undefined });
  const toV3: DocumentMigration = (d) => ({ ...d, etiquetas: [] });

  it('aplica en orden las migraciones que faltan y deja la versión de destino', () => {
    const v1 = { schemaVersion: 1, texto: 'hola' };
    expect(runMigrations(v1, 3, { 1: toV2, 2: toV3 })).toEqual({
      schemaVersion: 3,
      pie: 'hola',
      texto: undefined,
      etiquetas: [],
    });
    expect(runMigrations({ schemaVersion: 2, pie: 'x' }, 3, { 1: toV2, 2: toV3 })).toEqual({
      schemaVersion: 3,
      pie: 'x',
      etiquetas: [],
    });
    // No toca el original.
    expect(v1).toEqual({ schemaVersion: 1, texto: 'hola' });
  });

  it('un documento ya en la versión de destino se devuelve igual, en una copia', () => {
    const v1 = { schemaVersion: 1, a: { b: 1 } };
    const result = runMigrations(v1, 1, {});
    expect(result).toEqual(v1);
    expect(result).not.toBe(v1);
    expect(result.a).not.toBe(v1.a);
  });

  const reasonOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DocumentError) return error.reason;
      throw error;
    }
    return 'sin error';
  };

  it('distingue por qué no se puede leer un documento', () => {
    expect(reasonOf(() => runMigrations(null))).toBe('not_a_document');
    expect(reasonOf(() => runMigrations([]))).toBe('not_a_document');
    expect(reasonOf(() => runMigrations({ canvas: {} }))).toBe('not_a_document');
    expect(reasonOf(() => runMigrations({ schemaVersion: '1' }))).toBe('not_a_document');
    expect(reasonOf(() => runMigrations({ schemaVersion: 0 }))).toBe('not_a_document');
    expect(reasonOf(() => runMigrations({ schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 }))).toBe('newer_version');
    expect(reasonOf(() => runMigrations({ schemaVersion: 1 }, 3, { 1: toV2 }))).toBe('missing_migration');
  });

  it('hay una migración por cada versión anterior a la actual', () => {
    for (let version = 1; version < DOCUMENT_SCHEMA_VERSION; version += 1) {
      expect(DOCUMENT_MIGRATIONS[version], `falta la migración de la versión ${version}`).toBeTypeOf('function');
    }
  });

  it('migrateDocument devuelve el documento actual validado y normalizado', () => {
    const document = migrateDocument(sample());
    expect(document.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(document.copy.hashtags).toEqual(['otoño', 'menu_del_dia']);
    // Lo ya normalizado se lee igual: guardar y volver a abrir no cambia nada.
    expect(migrateDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });

  it('migrateDocument falla con los problemas concretos si el documento no cumple el esquema', () => {
    let error: unknown;
    try {
      migrateDocument({ schemaVersion: 1, canvas: { aspectRatio: '1:1', width: 10, height: 10 }, layers: [{}] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).reason).toBe('invalid');
    expect((error as DocumentError).issues[0]?.path).toBe('pages.0.layers.0.type');
    expect((error as DocumentError).message).toBe('El documento no es válido.');
    expect(reasonOf(() => migrateDocument({ schemaVersion: 99 }))).toBe('newer_version');
  });
});

describe('versión 2: grupos de capas', () => {
  /** Un documento tal y como lo guardaba la versión 1 de la aplicación (sin grupos). */
  const savedV1 = () => savedBefore(1);

  it('un documento guardado con la versión 1 se lee igual, sin grupos', () => {
    const document = migrateDocument(savedV1());
    expect(document.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(document.pages[0]!.layers).toHaveLength(sampleLayers().length);
    expect(document.pages[0]!.layers.every((layer) => layer.groupId === undefined)).toBe(true);
    // Lo demás no cambia: mismo resultado que validar el de la versión actual.
    const current = validateDocument(sample());
    expect(current.ok && current.document).toEqual(document);
  });

  it('la migración 1 → 2 no agrupa nada que no estuviera agrupado y no toca el original', () => {
    const raw = savedV1() as unknown as Record<string, unknown> & { layers: Record<string, unknown>[] };
    raw.layers[0] = { ...raw.layers[0], groupId: 'colado' };
    const migrated = runMigrations(raw, 2) as { layers: Record<string, unknown>[] };
    expect(migrated.layers[0]).not.toHaveProperty('groupId');
    expect(raw.layers[0]).toHaveProperty('groupId', 'colado');
  });

  it('acepta capas con grupo y rechaza un identificador de grupo mal formado', () => {
    const layers = sampleLayers().map((layer) => ({ ...layer, groupId: 'g1' }));
    const ok = validateDocument(sample(layers));
    expect(ok.ok && ok.document.pages[0]!.layers.every((layer) => layer.groupId === 'g1')).toBe(true);
    const bad = validateDocument(sample([{ ...layers[0]!, groupId: 'con espacio' }]));
    expect(bad.ok).toBe(false);
  });

  it('validateDocumentFromAnyVersion migra lo antiguo y dice por qué no puede con lo más nuevo', () => {
    expect(validateDocumentFromAnyVersion(savedV1()).ok).toBe(true);
    const newer = validateDocumentFromAnyVersion({ ...sample(), schemaVersion: DOCUMENT_SCHEMA_VERSION + 1 });
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.issues[0]?.path).toBe('schemaVersion');
  });
});

describe('versión 3: desenfoque de imágenes', () => {
  const savedV2 = () => savedBefore(2);

  it('un documento de la versión 2 se lee igual, con las imágenes nítidas', () => {
    const document = migrateDocument(savedV2());
    expect(document.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(document.pages[0]!.layers.every((layer) => layer.type !== 'image' || layer.blur === undefined)).toBe(true);
  });

  it('la migración 2 → 3 quita un desenfoque colado y no toca el original', () => {
    const raw = savedV2() as unknown as Record<string, unknown> & { layers: Record<string, unknown>[] };
    raw.layers[0] = { ...raw.layers[0], blur: 50 };
    const migrated = runMigrations(raw, 3) as { layers: Record<string, unknown>[] };
    expect(migrated.layers[0]).not.toHaveProperty('blur');
    expect(raw.layers[0]).toHaveProperty('blur', 50);
  });

  it('acepta un desenfoque de 0 a 100 en las imágenes y rechaza lo que se sale', () => {
    const image = sampleLayers().find((layer) => layer.type === 'image')!;
    const ok = validateDocument(sample([{ ...image, blur: 40 }]));
    expect(ok.ok && ok.document.pages[0]!.layers[0]).toMatchObject({ blur: 40 });
    expect(validateDocument(sample([{ ...image, blur: 101 }])).ok).toBe(false);
    expect(validateDocument(sample([{ ...image, blur: -1 }])).ok).toBe(false);
  });

  it('el radio del desenfoque es relativo a la caja', () => {
    expect(blurRadius(undefined, { width: 1080, height: 1080 })).toBe(0);
    expect(blurRadius(0, { width: 1080, height: 1080 })).toBe(0);
    expect(blurRadius(100, { width: 1080, height: 1350 })).toBeCloseTo(54);
    expect(blurRadius(50, { width: 540, height: 540 })).toBeCloseTo(13.5);
  });
});

describe('versión 4: páginas', () => {
  const page = (id: string, layers: LayersInput = []) => ({ id, layers });

  it('un documento de la versión 3 se lee como uno de una sola página con las mismas capas', () => {
    const document = migrateDocument(savedBefore(3));
    expect(document.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0]).toMatchObject({ id: 'p1', name: '' });
    expect(document.pages[0]!.layers.map((l) => l.id)).toEqual(['fondo', 'banda', 'titular', 'logo']);
    // El resto no cambia: mismo resultado que el documento actual de una página.
    const current = validateDocument(sample());
    expect(current.ok && current.document).toEqual(document);
    expect(document).not.toHaveProperty('layers');
  });

  it('la migración 3 → 4 no toca el original y descarta unas `pages` coladas', () => {
    const raw = { ...savedBefore(3), pages: [{ id: 'colada', layers: [] }] };
    const migrated = runMigrations(raw) as { pages: { id: string; layers: unknown[] }[]; layers?: unknown };
    expect(migrated.pages).toHaveLength(1);
    expect(migrated.pages[0]!.id).toBe('p1');
    expect(migrated.pages[0]!.layers).toHaveLength(4);
    expect(migrated.layers).toBeUndefined();
    expect(raw.layers).toHaveLength(4);
  });

  it('un documento de la versión 3 sin capas queda con una página vacía', () => {
    const document = migrateDocument({ schemaVersion: 3, canvas: { ...CANVAS } });
    expect(document.pages).toEqual([{ id: 'p1', name: '', layers: [] }]);
  });

  it('acepta varias páginas, cada una con sus capas, compartiendo lienzo y texto', () => {
    const result = validateDocument({
      ...sample(),
      pages: [page('portada', sampleLayers()), page('dos'), page('tres', [{ ...sampleLayers()[1]!, id: 'otra' }])],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.document.pages.map((p) => p.id)).toEqual(['portada', 'dos', 'tres']);
    expect(result.document.pages[1]).toEqual({ id: 'dos', name: '', layers: [] });
    expect(result.document.copy.caption).toBe('Ya está aquí.');
  });

  it('sin páginas, una vacía; con más de 10 o ninguna, no es válido', () => {
    const rest = { ...sample() };
    delete rest.pages;
    const empty = validateDocument(rest);
    expect(empty.ok && empty.document.pages).toEqual([{ id: 'p1', name: '', layers: [] }]);
    expect(issuesOf({ ...sample(), pages: [] })[0]?.path).toBe('pages');
    const eleven = Array.from({ length: MAX_PAGES + 1 }, (_, i) => page(`p${i + 1}`));
    expect(issuesOf({ ...sample(), pages: eleven })[0]).toMatchObject({ path: 'pages' });
    expect(issuesOf({ ...sample(), pages: eleven.slice(0, MAX_PAGES) })).toEqual([]);
  });

  it('los identificadores de capa son únicos en todo el documento y los de página también', () => {
    const layer = sampleLayers()[1]!;
    expect(issuesOf({ ...sample(), pages: [page('a', [layer]), page('b', [layer])] })).toEqual([
      { path: 'pages.1.layers.0.id', message: 'Hay dos capas con el mismo identificador' },
    ]);
    expect(issuesOf({ ...sample(), pages: [page('a'), page('a')] })).toEqual([
      { path: 'pages.1.id', message: 'Hay dos páginas con el mismo identificador' },
    ]);
    expect(issuesOf({ ...sample(), pages: [page('con espacio')] })[0]?.path).toBe('pages.0.id');
  });

  it('el máximo de capas es por página', () => {
    const many = (prefix: string) =>
      Array.from({ length: MAX_LAYERS }, (_, i) => ({ ...sampleLayers()[1]!, id: `${prefix}${i}` }));
    expect(issuesOf({ ...sample(), pages: [page('a', many('a')), page('b', many('b'))] })).toEqual([]);
    expect(issuesOf(sample([...many('a'), { ...sampleLayers()[1]!, id: 'sobra' }]))[0]?.path).toBe('pages.0.layers');
  });

  it('createEmptyDocument crea las páginas pedidas (de 1 a 10)', () => {
    expect(createEmptyDocument({ pages: 3 }).pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(createEmptyDocument({ pages: 0 }).pages).toHaveLength(1);
    expect(createEmptyDocument({ pages: 50 }).pages).toHaveLength(MAX_PAGES);
  });
});

describe('versión 5: ediciones sencillas', () => {
  /** Un documento tal y como lo guardaba la versión 4 (con páginas, sin ediciones). */
  const savedV4 = () => ({
    schemaVersion: 4,
    canvas: { ...CANVAS },
    pages: [{ id: 'p1', name: '', layers: sampleLayers() }],
    copy: COPY,
  });
  const image = () => sampleLayers().find((layer) => layer.type === 'image')!;
  const text = () => sampleLayers().find((layer) => layer.type === 'text')!;
  const firstLayer = (layers: LayersInput) => {
    const result = validateDocument(sample(layers));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.document.pages[0]!.layers[0]!;
  };

  it('un documento de la versión 4 se lee igual, sin ediciones', () => {
    const document = migrateDocument(savedV4());
    expect(document.schemaVersion).toBe(5);
    const layer = document.pages[0]!.layers[0]!;
    for (const field of ['adjust', 'turn', 'crop', 'backdrop', 'shadow', 'outline', 'background']) {
      expect(layer, field).not.toHaveProperty(field);
    }
    const current = validateDocument(sample());
    expect(current.ok && current.document).toEqual(document);
  });

  it('la migración 4 → 5 quita ediciones coladas en cualquier página, no toca el borde de una forma ni el original', () => {
    const raw = {
      ...savedV4(),
      pages: [
        {
          id: 'p1',
          layers: [
            { ...image(), adjust: { brightness: 50 }, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
            { ...sampleLayers()[1]!, stroke: { color: '#000000', width: 4 }, shadow: { color: '#000000', blur: 3 } },
          ],
        },
        { id: 'p2', layers: [{ ...text(), id: 't2', outline: { color: '#000000', width: 3 }, background: { color: '#FFFFFF' } }] },
      ],
    } as unknown as Record<string, unknown>;
    const migrated = runMigrations(raw) as { pages: { layers: Record<string, unknown>[] }[] };
    expect(migrated.pages[0]!.layers[0]).not.toHaveProperty('adjust');
    expect(migrated.pages[0]!.layers[0]).not.toHaveProperty('crop');
    expect(migrated.pages[0]!.layers[1]).not.toHaveProperty('shadow');
    expect(migrated.pages[0]!.layers[1]).toHaveProperty('stroke');
    expect(migrated.pages[1]!.layers[0]).not.toHaveProperty('outline');
    expect(migrated.pages[1]!.layers[0]).not.toHaveProperty('background');
    expect((raw.pages as { layers: Record<string, unknown>[] }[])[0]!.layers[0]).toHaveProperty('adjust');
  });

  it('acepta los ajustes, el giro y el recorte de una imagen y rellena lo que falta', () => {
    const layer = firstLayer([
      {
        ...image(),
        adjust: { brightness: 20, filter: 'warm' },
        turn: 90,
        flipX: true,
        straighten: -3.5,
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
        backdrop: { kind: 'gradient', from: '#FF0000', to: '#0000FF' },
        shadow: { color: '#000000', blur: 30 },
      },
    ]);
    expect(layer).toMatchObject({
      adjust: { brightness: 20, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, filter: 'warm' },
      turn: 90,
      flipX: true,
      straighten: -3.5,
      backdrop: { kind: 'gradient', angle: 180 },
      shadow: { blur: 30, offsetX: 0, offsetY: 0, opacity: 0.4 },
    });
  });

  it('rechaza lo que se sale de los límites', () => {
    const bad = (extra: Record<string, unknown>) => validateDocument(sample([{ ...image(), ...extra } as never])).ok;
    expect(bad({ adjust: { brightness: 101 } })).toBe(false);
    expect(bad({ adjust: { sharpness: -1 } })).toBe(false);
    expect(bad({ adjust: { filter: 'inventado' } })).toBe(false);
    expect(bad({ turn: 45 })).toBe(false);
    expect(bad({ straighten: 46 })).toBe(false);
    expect(bad({ crop: { x: 0.6, y: 0, width: 0.6, height: 1 } })).toBe(false);
    expect(bad({ crop: { x: 0, y: 0, width: 0.001, height: 1 } })).toBe(false);
    expect(bad({ backdrop: { kind: 'color', color: 'rojo' } })).toBe(false);
    expect(bad({ backdrop: { kind: 'blur', blur: 0 } })).toBe(false);
    expect(bad({ shadow: { color: '#000000', blur: 1000 } })).toBe(false);
  });

  it('acepta contorno, sombra y fondo en un texto, y las figuras nuevas', () => {
    const layer = firstLayer([
      {
        ...text(),
        outline: { color: '#000000', width: 4 },
        shadow: { color: '#000000', blur: 8, offsetY: 4 },
        background: { color: '#FFD700' },
      },
    ]);
    expect(layer).toMatchObject({
      outline: { width: 4 },
      background: { opacity: 1, padding: 16, radius: 0 },
      shadow: { opacity: 0.4 },
    });
    for (const shape of ['triangle', 'star', 'heart', 'arrow', 'burst', 'speech', 'line']) {
      const result = validateDocument(sample([{ ...sampleLayers()[1]!, shape } as never]));
      expect(result.ok, shape).toBe(true);
    }
    expect(validateDocument(sample([{ ...sampleLayers()[1]!, shape: 'hexagono' } as never])).ok).toBe(false);
  });

  it('un ajuste a cero y sin filtro es neutro', () => {
    expect(isNeutralAdjust(undefined)).toBe(true);
    expect(isNeutralAdjust({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0 })).toBe(true);
    expect(isNeutralAdjust({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0, filter: 'bw' })).toBe(
      false,
    );
    expect(isNeutralAdjust({ brightness: 1, contrast: 0, saturation: 0, temperature: 0, sharpness: 0 })).toBe(false);
  });
});
