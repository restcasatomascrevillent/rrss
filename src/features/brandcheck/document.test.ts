import { brandProfileSchema } from '@/features/brand/profile';
import { contentDocumentSchema, DOCUMENT_SCHEMA_VERSION, type ContentDocument, type LayerInput } from '@/features/content/document';
import { getFormatSpec } from '@/features/content/networks';
import { backgroundBehind, buildBrandCheckInput, limitsFromSpec, textLayersFromDocument } from './document';
import { verifyPiece } from './verify';

const base = { x: 0, y: 0, width: 1080, height: 1080 };
const ID = '3f2b6c1e-8a4d-4c7b-9e2f-1a2b3c4d5e6f';

function doc(layers: LayerInput[], copy: object = {}, backgroundColor = '#FFFFFF'): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor },
    pages: [{ id: 'p1', name: '', layers }],
    copy,
  });
}
const text = (id: string, extra: object = {}): LayerInput =>
  ({
    id,
    type: 'text',
    x: 100,
    y: 100,
    width: 400,
    height: 100,
    text: 'Hola',
    fontFamily: 'Inter',
    fontSize: 80,
    color: '#000000',
    ...extra,
  }) as LayerInput;
const rect = (id: string, extra: object = {}): LayerInput =>
  ({ id, type: 'shape', shape: 'rectangle', ...base, fill: '#112233', ...extra }) as LayerInput;
const image = (id: string, extra: object = {}): LayerInput =>
  ({ id, type: 'image', ...base, source: { kind: 'asset', assetId: ID }, ...extra }) as LayerInput;

describe('fondo de un texto', () => {
  it('sin nada debajo es el fondo del lienzo', () => {
    expect(backgroundBehind(doc([text('t')], {}, '#ffeedd'), 0)).toBe('#FFEEDD');
  });
  it('una forma que cubre el texto es su fondo; una que solo lo cubre en parte, desconocido', () => {
    expect(backgroundBehind(doc([rect('r'), text('t')]), 1)).toBe('#112233');
    const partial = rect('r', { x: 300, y: 0, width: 500, height: 1080 });
    expect(backgroundBehind(doc([partial, text('t')]), 1)).toBeNull();
  });
  it('una imagen debajo hace el fondo desconocido', () => {
    expect(backgroundBehind(doc([image('i'), text('t')]), 1)).toBeNull();
    const far = image('i', { x: 700, y: 700, width: 300, height: 300 });
    expect(backgroundBehind(doc([far, text('t')]), 1)).toBe('#FFFFFF');
  });
  it('ignora formas ocultas, sin relleno y las que quedan encima', () => {
    expect(backgroundBehind(doc([rect('r', { visible: false }), text('t')]), 1)).toBe('#FFFFFF');
    expect(backgroundBehind(doc([rect('r', { fill: null }), text('t')]), 1)).toBe('#FFFFFF');
    expect(backgroundBehind(doc([text('t'), rect('r')]), 0)).toBe('#FFFFFF');
  });
  it('una forma translúcida se mezcla con lo que hay debajo', () => {
    expect(backgroundBehind(doc([rect('r', { fill: '#000000', opacity: 0.5 }), text('t')]), 1)).toBe('#808080');
    expect(backgroundBehind(doc([image('i'), rect('r', { opacity: 0.5 }), text('t')]), 2)).toBeNull();
  });
  it('la elipse solo cubre lo que cae dentro', () => {
    const ellipse = rect('e', { shape: 'ellipse' });
    const inside = text('t', { x: 400, y: 450, width: 280, height: 100 });
    const corner = text('t', { x: 20, y: 20, width: 200, height: 100 });
    expect(backgroundBehind(doc([ellipse, inside]), 1)).toBe('#112233');
    expect(backgroundBehind(doc([ellipse, corner]), 1)).toBeNull();
  });
});

describe('capas de texto', () => {
  it('lleva color, fondo, negrita y tamaño en puntos; salta las ocultas y vacías', () => {
    const layers = textLayersFromDocument(
      doc([
        text('a', { fontSize: 108, fontWeight: 700, opacity: 0.5 }),
        text('b', { visible: false }),
        text('c', { text: '   ' }),
      ]),
    );
    expect(layers).toHaveLength(1);
    // 108 u × 390/1080 px/u × 0,75 pt/px = 29,25 pt
    expect(layers[0]).toMatchObject({ id: 'a', color: '#00000080', background: '#FFFFFF', bold: true });
    expect(layers[0]!.fontSizePt).toBeCloseTo(29.3, 1);
  });
});

describe('límites de la red', () => {
  it('lee los límites de la especificación', () => {
    expect(limitsFromSpec(getFormatSpec('instagram', 'post'))).toMatchObject({
      label: 'Instagram',
      maxCaptionLength: 2200,
      maxHashtags: 30,
      maxMentions: 20,
      maxAltTextLength: 1000,
    });
    expect(limitsFromSpec(undefined)).toEqual({});
  });
  it('cuenta con la unidad común del producto (UTF-16), también si la red dice «caracteres»', () => {
    expect(limitsFromSpec(getFormatSpec('instagram', 'post')).lengthUnit).toBe('utf16');
  });
});

describe('entrada completa', () => {
  const profile = brandProfileSchema.parse({
    voice: {
      forbiddenPhrases: ['barato'],
      hashtags: { required: ['MiMarca'] },
      callsToAction: ['reserva'],
      emojis: { allowed: false },
    },
    visual: { colors: [{ hex: '#112233' }] },
  });

  it('une texto, límites, reglas del perfil y capas', () => {
    const input = buildBrandCheckInput(
      doc([rect('r'), text('t', { color: '#FFFFFF' })], { caption: 'Muy barato 😀', hashtags: ['x'], altText: 'Mesa' }),
      getFormatSpec('instagram', 'post'),
      profile,
    );
    expect(input.text).toMatchObject({ caption: 'Muy barato 😀', hashtags: ['x'], altText: 'Mesa' });
    expect(input.brand.requiredHashtags).toEqual(['MiMarca']);
    expect(input.brand.emojiPolicy).toEqual({ allowed: false });
    expect(input.hasImage).toBe(true);
    expect(input.imageKind).toBe('graphic');
    const result = verifyPiece(input);
    expect(result.verdict).toBe('fail');
    const codes = result.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['FORBIDDEN_PHRASE', 'BRAND_HASHTAG_MISSING', 'EMOJIS_NOT_ALLOWED']));
    expect(codes).not.toContain('CONTRAST_TOO_LOW');
  });

  it('un texto oscuro sobre fondo oscuro bloquea el contraste, apuntando a su capa', () => {
    const input = buildBrandCheckInput(doc([rect('r'), text('t', { color: '#223344' })]), undefined, profile);
    const finding = verifyPiece(input).findings.find((f) => f.code === 'CONTRAST_TOO_LOW');
    expect(finding?.target).toEqual({ part: 'textLayer', layerId: 't' });
  });

  it('con imagen es una foto y el texto sobre ella no se comprueba; sin capas no hay imagen', () => {
    const withPhoto = buildBrandCheckInput(doc([image('i'), text('t')]), undefined, null);
    expect(withPhoto.imageKind).toBe('photo');
    expect(withPhoto.textLayers![0]!.background).toBeNull();
    const empty = buildBrandCheckInput(doc([]), undefined, null);
    expect(empty).toMatchObject({ hasImage: false, imageKind: undefined });
  });

  it('en un formato sin texto alternativo no lo exige', () => {
    const input = buildBrandCheckInput(doc([rect('r')]), getFormatSpec('instagram', 'reel'), null);
    expect(input.hasImage).toBe(false);
  });
});

describe('documentos de varias páginas', () => {
  const carousel = (pages: LayerInput[][]) =>
    contentDocumentSchema.parse({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
      pages: pages.map((layers, i) => ({ id: `p${i + 1}`, layers })),
      copy: { caption: 'Hola', altText: 'Fotos' },
    });

  it('revisa los textos de todas las páginas y dice en cuál está cada uno', () => {
    const layers = textLayersFromDocument(carousel([[text('a')], [], [text('b', { color: '#FAFAFA' })]]));
    expect(layers.map((l) => [l.id, l.page])).toEqual([
      ['a', 1],
      ['b', 3],
    ]);
    const result = verifyPiece(
      buildBrandCheckInput(carousel([[text('a')], [text('b', { color: '#FAFAFA' })]]), getFormatSpec('instagram', 'carousel'), null),
    );
    const contrast = result.findings.find((f) => f.code === 'CONTRAST_TOO_LOW');
    expect(contrast?.message).toMatch(/página 2/);
    expect(contrast?.target).toMatchObject({ part: 'textLayer', layerId: 'b' });
  });

  it('bloquea un carrusel de una página y un post de varias', () => {
    const one = verifyPiece(buildBrandCheckInput(carousel([[text('a')]]), getFormatSpec('instagram', 'carousel'), null));
    expect(one.findings.find((f) => f.check === 'pages')).toMatchObject({ code: 'PAGES_TOO_FEW', severity: 'block' });
    const many = verifyPiece(buildBrandCheckInput(carousel([[text('a')], []]), getFormatSpec('instagram', 'post'), null));
    expect(many.findings.find((f) => f.check === 'pages')).toMatchObject({ code: 'PAGES_TOO_MANY', severity: 'block' });
    const ok = verifyPiece(buildBrandCheckInput(carousel([[text('a')], []]), getFormatSpec('instagram', 'carousel'), null));
    expect(ok.checks.find((c) => c.id === 'pages')?.status).toBe('passed');
  });
});
