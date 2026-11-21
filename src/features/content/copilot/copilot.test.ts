import { describe, expect, it } from 'vitest';
import { createEmptyDocument, pageView, withLayers, type TextLayer } from '../document';
import { editorReducer, initEditor } from '../editor/history';
import { applyCopilotOperations, backgroundImageOf, needsPhotoPick, withPickedPhoto, type CopilotApplyContext } from './apply';
import { ASSUMED_PHOTO_TONE, colorRole, contrastOf, legibleTextColor, preferredTextColor, toneOfPalette } from './legibility';
import { isDictated, keepDictated, parseCopilotResponse, summarizeDocument, type CopilotOperation } from './operations';

const PHOTO = '11111111-1111-4111-8111-111111111111';
const LOGO = '22222222-2222-4222-8222-222222222222';

const op = (fields: Partial<CopilotOperation> & Pick<CopilotOperation, 'op'>): CopilotOperation => ({
  target: null,
  text: null,
  style: null,
  assetId: null,
  position: null,
  align: null,
  color: null,
  font: null,
  blur: null,
  dx: null,
  dy: null,
  ...fields,
});

const context: CopilotApplyContext = {
  brand: { palette: [{ hex: '#A3122A' }, { hex: '#F4E9D8' }], fonts: ['Marca Titulares', 'Marca Texto'] },
  assets: new Map([
    [PHOTO, { id: PHOTO, name: 'mesa.jpg' }],
    [LOGO, { id: LOGO, name: 'logo.png', width: 400, height: 200 }],
  ]),
  logoIds: [LOGO],
};

const MENU = [
  op({ op: 'set_background_image', assetId: PHOTO, blur: 40 }),
  op({ op: 'add_logo', assetId: LOGO, position: 'top', align: 'center' }),
  op({ op: 'add_text', text: 'Menú de Navidad', style: 'title', position: 'upper' }),
  op({ op: 'add_text', text: 'crema de marisco\ncordero asado\nturrón casero', style: 'body', position: 'middle' }),
  op({ op: 'add_text', text: '45 euros por persona', style: 'small', position: 'lower', color: '#FFFFFF' }),
];

describe('copiloto: aplicar operaciones', () => {
  it('monta fondo difuminado, logotipo y textos con la tipografía y los colores de la marca', () => {
    const document = createEmptyDocument({ aspectRatio: '4:5' });
    const result = applyCopilotOperations(document, MENU, context);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [background, logo, title, dishes, price] = result.document.pages[0]!.layers;
    expect(background).toMatchObject({ type: 'image', blur: 40, x: 0, y: 0, width: 1080, height: 1350 });
    expect(backgroundImageOf(pageView(result.document))?.id).toBe(background!.id);
    expect(logo).toMatchObject({ type: 'logo', assetId: LOGO });
    expect(logo!.y).toBeLessThan(title!.y);
    // Sobre la foto (de tono aún desconocido) el granate no se lee: va el color de la marca más legible.
    expect(title).toMatchObject({ type: 'text', text: 'Menú de Navidad', fontFamily: 'Marca Titulares', color: '#F4E9D8', fontWeight: 700 });
    expect(dishes).toMatchObject({ text: 'crema de marisco\ncordero asado\nturrón casero', fontFamily: 'Marca Texto', color: '#F4E9D8' });
    expect(price).toMatchObject({ text: '45 euros por persona', color: '#FFFFFF' });
    // Los textos no se pisan.
    const texts = [title, dishes, price] as TextLayer[];
    for (let i = 1; i < texts.length; i += 1) expect(texts[i]!.y).toBeGreaterThanOrEqual(texts[i - 1]!.y + texts[i - 1]!.height);
    expect(result.changes).toHaveLength(5);
  });

  it('una orden es un solo paso de deshacer', () => {
    const document = createEmptyDocument({ aspectRatio: '4:5' });
    const result = applyCopilotOperations(document, MENU, context);
    if (!result.ok) throw new Error('no aplica');
    let state = editorReducer(initEditor(document), { type: 'replace', document: result.document });
    expect(state.document.pages[0]!.layers).toHaveLength(5);
    const blur = applyCopilotOperations(state.document, [op({ op: 'blur_image', blur: 70 })], context);
    if (!blur.ok) throw new Error('no aplica');
    state = editorReducer(state, { type: 'replace', document: blur.document });
    expect(backgroundImageOf(pageView(state.document))?.blur).toBe(70);
    state = editorReducer(state, { type: 'undo' });
    expect(backgroundImageOf(pageView(state.document))?.blur).toBe(40);
    state = editorReducer(state, { type: 'undo' });
    expect(state.document.pages[0]!.layers).toEqual([]);
  });

  it('cambia la foto de fondo existente en vez de añadir otra, y salta lo que no puede hacer', () => {
    const first = applyCopilotOperations(createEmptyDocument(), [op({ op: 'set_background_image', assetId: PHOTO })], context);
    if (!first.ok) throw new Error('no aplica');
    const other = '33333333-3333-4333-8333-333333333333';
    const second = applyCopilotOperations(
      first.document,
      [
        op({ op: 'set_background_image', assetId: other }),
        op({ op: 'remove_layer', target: 'no-existe' }),
        op({ op: 'set_background_color', color: '#000000' }),
      ],
      context,
    );
    if (!second.ok) throw new Error('no aplica');
    expect(second.document.pages[0]!.layers).toHaveLength(1);
    expect(second.document.pages[0]!.layers[0]).toMatchObject({ source: { kind: 'asset', assetId: other } });
    expect(second.document.canvas.backgroundColor).toBe('#000000');
    expect(second.skipped).toEqual(['No se encuentra la capa que hay que quitar.']);
  });

  it('«esta foto» sin foto elegida: se pide; si no se elige, la operación se quita', () => {
    const ops = [op({ op: 'set_background_image', blur: 40 }), op({ op: 'add_text', text: 'Hola' })];
    expect(needsPhotoPick(ops)).toBe(true);
    expect(withPickedPhoto(ops, PHOTO)[0]).toMatchObject({ assetId: PHOTO, blur: 40 });
    expect(withPickedPhoto(ops, null).map((o) => o.op)).toEqual(['add_text']);
  });

  it('no toca capas bloqueadas', () => {
    const base = applyCopilotOperations(createEmptyDocument(), [op({ op: 'add_text', text: 'Hola' })], context);
    if (!base.ok) throw new Error('no aplica');
    const locked = withLayers(base.document, base.document.pages[0]!.layers.map((l) => ({ ...l, locked: true })));
    const id = locked.pages[0]!.layers[0]!.id;
    const result = applyCopilotOperations(locked, [op({ op: 'remove_layer', target: id }), op({ op: 'update_text', target: id, text: 'Adiós' })], context);
    expect(result.ok && result.document.pages[0]!.layers[0]).toMatchObject({ text: 'Hola' });
    expect(result.ok && result.changes).toEqual([]);
  });
});

describe('copiloto: validación en el navegador', () => {
  it('solo acepta respuestas que cumplen el contrato estricto', () => {
    const good = { action: 'editor.copilot', generationId: PHOTO, operations: MENU, discarded: [], note: 'Hecho' };
    expect(parseCopilotResponse(good)?.operations).toHaveLength(5);
    expect(parseCopilotResponse({ ...good, operations: [{ ...MENU[0], op: 'publish' }] })).toBeNull();
    expect(parseCopilotResponse({ ...good, operations: [{ ...MENU[0], approve: true }] })).toBeNull();
    expect(parseCopilotResponse({ ...good, extra: 1 })).toBeNull();
    expect(parseCopilotResponse({ ...good, operations: [{ ...MENU[0], blur: 500 }] })).toBeNull();
  });

  it('los textos deben estar en lo dictado (se perdonan mayúsculas y puntuación, no palabras)', () => {
    const dictado = 'Título: menú de Navidad. Platos: crema de marisco, cordero asado.';
    expect(isDictated('Menú de Navidad', dictado)).toBe(true);
    expect(isDictated('crema de marisco\ncordero asado', dictado)).toBe(true);
    expect(isDictated('Menu de Navidad', dictado)).toBe(false);
    expect(isDictated('Delicioso menú de Navidad', dictado)).toBe(false);
    expect(isDictated('', dictado)).toBe(false);
    const kept = keepDictated([op({ op: 'add_text', text: 'APROBADO' }), op({ op: 'blur_image', blur: 10 })], dictado);
    expect(kept).toMatchObject({ removed: 1, operations: [{ op: 'blur_image' }] });
  });

  it('el resumen del documento no lleva el texto de la publicación ni las fuentes de las imágenes', () => {
    const result = applyCopilotOperations(createEmptyDocument(), MENU, context);
    if (!result.ok) throw new Error('no aplica');
    const summary = summarizeDocument(pageView({ ...result.document, copy: { ...result.document.copy, caption: 'secreto' } }));
    expect(JSON.stringify(summary)).not.toContain('secreto');
    expect(JSON.stringify(summary)).not.toContain(PHOTO);
    expect(summary.layers[0]).toMatchObject({ type: 'image', blur: 40 });
  });

  it('dx/dy: el servidor solo los manda si se usan (sin ellos, null) y van acotados', () => {
    const base = { action: 'editor.copilot', generationId: PHOTO, discarded: [], note: '' };
    const sinPasos: Partial<CopilotOperation> = op({ op: 'move_layer', target: 'titulo', position: 'top' });
    delete sinPasos.dx;
    delete sinPasos.dy;
    const parsed = parseCopilotResponse({ ...base, operations: [sinPasos] });
    expect(parsed?.operations[0]).toMatchObject({ dx: null, dy: null });
    expect(parseCopilotResponse({ ...base, operations: [op({ op: 'move_layer', target: 'a', dy: -2 })] })).not.toBeNull();
    expect(parseCopilotResponse({ ...base, operations: [op({ op: 'move_layer', target: 'a', dy: 7 })] })).toBeNull();
    expect(parseCopilotResponse({ ...base, operations: [op({ op: 'move_layer', target: 'a', dx: 1.5 })] })).toBeNull();
  });
});

// Perfil con usos: el orden de la paleta NO es el de los usos (prueba que no se elige por posición).
const ROLES: CopilotApplyContext = {
  ...context,
  brand: {
    palette: [
      { hex: '#F5EBDD', role: 'Fondo' },
      { hex: '#2B2B2B', role: 'texto' },
      { hex: '#A3122A', role: 'Principal' },
    ],
    fonts: ['Marca Titulares', 'Marca Texto'],
  },
};
const texts = (document: { pages: { layers: { type: string }[] }[] }) =>
  document.pages[0]!.layers.filter((l) => l.type === 'text') as TextLayer[];

describe('copiloto: color de los textos por uso y legible', () => {
  it('lee el uso de cada color del perfil (texto libre, sin mayúsculas ni tildes)', () => {
    expect(colorRole('Principal')).toBe('primary');
    expect(colorRole('FONDO')).toBe('background');
    expect(colorRole('Texto')).toBe('text');
    expect(colorRole('Títulos')).toBe('title');
    expect(colorRole('acento')).toBeNull();
    expect(colorRole('')).toBeNull();
    expect(preferredTextColor(ROLES.brand.palette, true)).toBe('#A3122A');
    expect(preferredTextColor(ROLES.brand.palette, false)).toBe('#2B2B2B');
    // Sin usos, por orden (como antes): el primero para títulos, el segundo para el resto.
    expect(preferredTextColor([{ hex: '#111111' }, { hex: '#222222' }], true)).toBe('#111111');
    expect(preferredTextColor([{ hex: '#111111' }, { hex: '#222222' }], false)).toBe('#222222');
  });

  it('sobre el lienzo blanco: título en el principal y texto en el de texto, aunque estén en otro orden', () => {
    const result = applyCopilotOperations(
      createEmptyDocument(),
      [op({ op: 'add_text', text: 'Abrimos el domingo', style: 'title' }), op({ op: 'add_text', text: 'de 13 a 16', style: 'body' })],
      ROLES,
    );
    if (!result.ok) throw new Error('no aplica');
    expect(texts(result.document).map((t) => t.color)).toEqual(['#A3122A', '#2B2B2B']);
  });

  it('si el color de la marca no se lee sobre el fondo, usa el de la marca más legible', () => {
    // Fondo granate (el principal): el carbón del texto no llega a 3:1; la crema sí.
    expect(contrastOf('#2B2B2B', '#A3122A')).toBeLessThan(3);
    const result = applyCopilotOperations(
      createEmptyDocument(),
      [op({ op: 'set_background_color', color: '#A3122A' }), op({ op: 'add_text', text: 'de 13 a 16', style: 'body' })],
      ROLES,
    );
    if (!result.ok) throw new Error('no aplica');
    const [text] = texts(result.document);
    expect(text!.color).toBe('#F5EBDD');
    expect(contrastOf(text!.color, '#A3122A')).toBeGreaterThanOrEqual(3);
  });

  it('si ningún color de la marca vale, blanco o negro (el que más contraste)', () => {
    const grises = [{ hex: '#777777', role: 'principal' }];
    expect(legibleTextColor(grises, true, { hex: '#808080', kind: 'color', required: 3 })).toBe('#000000');
    expect(legibleTextColor(grises, true, { hex: '#303030', kind: 'color', required: 3 })).toBe('#FFFFFF');
    expect(legibleTextColor([], false, { hex: '#FFFFFF', kind: 'color', required: 3 })).toBe('#000000');
  });

  it('sobre una foto: con su tono conocido decide el contraste; sin tono, se supone media oscura', () => {
    const ops = [op({ op: 'set_background_image', assetId: PHOTO, blur: 40 }), op({ op: 'add_text', text: 'Menú', style: 'title' })];
    const color = (tones?: Map<string, string>) => {
      const result = applyCopilotOperations(createEmptyDocument(), ops, { ...ROLES, imageTones: tones });
      if (!result.ok) throw new Error('no aplica');
      return texts(result.document)[0]!.color;
    };
    expect(color(new Map([[PHOTO, '#EEEEEE']]))).toBe('#A3122A'); // foto clara: el principal se lee
    expect(color(new Map([[PHOTO, '#202020']]))).toBe('#F5EBDD'); // foto oscura: la crema de la marca
    expect(color()).toBe('#F5EBDD');
    expect(contrastOf('#F5EBDD', ASSUMED_PHOTO_TONE)).toBeGreaterThanOrEqual(4.5);
    expect(toneOfPalette([{ hex: '#000000', weight: 0.5 }, { hex: '#FFFFFF', weight: 0.5 }])).toMatch(/^#([0-9A-F]{2})\1\1$/);
    expect(toneOfPalette([])).toBeNull();
  });

  it('al cambiar el color de fondo, los textos sin color dictado que dejan de leerse cambian; los dictados y bloqueados, no', () => {
    const first = applyCopilotOperations(
      createEmptyDocument(),
      [
        op({ op: 'add_text', text: 'Abrimos', style: 'body' }),
        op({ op: 'add_text', text: 'el domingo', style: 'body' }),
        op({ op: 'add_text', text: 'fijo', style: 'body' }),
      ],
      ROLES,
    );
    if (!first.ok) throw new Error('no aplica');
    const [auto, , fijo] = texts(first.document);
    expect(auto!.color).toBe('#2B2B2B');
    const locked = withLayers(first.document, first.document.pages[0]!.layers.map((l) => (l.id === fijo!.id ? { ...l, locked: true } : l)));
    const second = applyCopilotOperations(
      locked,
      [
        op({ op: 'update_text', target: texts(locked)[1]!.id, color: '#2B2B2B' }),
        op({ op: 'set_background_color', color: '#2B2B2B' }),
      ],
      ROLES,
    );
    if (!second.ok) throw new Error('no aplica');
    expect(texts(second.document).map((t) => t.color)).toEqual(['#F5EBDD', '#2B2B2B', '#2B2B2B']);
    expect(second.changes).toContain('Texto «Abrimos» en #F5EBDD para que se lea sobre el fondo');
  });
});

describe('copiloto: movimiento relativo', () => {
  const doc = () => {
    const base = createEmptyDocument({ aspectRatio: '4:5' });
    const result = applyCopilotOperations(base, [op({ op: 'add_text', text: 'Menú de Navidad', style: 'title', position: 'lower' })], context);
    if (!result.ok) throw new Error('no aplica');
    return { document: result.document, id: result.document.pages[0]!.layers[0]!.id, layer: result.document.pages[0]!.layers[0]! };
  };

  it('«sube» y «a la derecha» mueven pasos del 5 % del lienzo', () => {
    const { document, id, layer } = doc();
    const result = applyCopilotOperations(document, [op({ op: 'move_layer', target: id, dy: -2, dx: 1 })], context);
    if (!result.ok) throw new Error('no aplica');
    const moved = result.document.pages[0]!.layers[0]!;
    expect(moved.y).toBe(Math.round(layer.y - 2 * 0.05 * 1350));
    expect(moved.x).toBe(Math.min(Math.round(layer.x + 0.05 * 1080), 1080 - layer.width));
  });

  it('no se sale del lienzo y, si ya está en el borde, lo dice sin cambiar nada', () => {
    const { document, id, layer } = doc();
    const down = applyCopilotOperations(document, [op({ op: 'move_layer', target: id, dy: 6 }), op({ op: 'move_layer', target: id, dy: 6 })], context);
    if (!down.ok) throw new Error('no aplica');
    expect(down.document.pages[0]!.layers[0]!.y).toBe(1350 - layer.height);
    expect(down.changes).toHaveLength(1);
    expect(down.skipped).toEqual(['«Menú de Navidad» ya está en el borde.']);
  });

  it('en un mismo eje manda el sitio concreto', () => {
    const { document, id } = doc();
    const result = applyCopilotOperations(document, [op({ op: 'move_layer', target: id, position: 'top', dy: 3 })], context);
    if (!result.ok) throw new Error('no aplica');
    expect(result.document.pages[0]!.layers[0]!.y).toBe(Math.round(1350 * 0.05));
  });
});

describe('copiloto: el logotipo no pisa los textos', () => {
  it('si choca con un texto, se reduce hacia su borde para caber; si no cabe, se avisa', () => {
    const canvas = createEmptyDocument({ aspectRatio: '9:16' });
    const conTexto = (y: number) => {
      const result = applyCopilotOperations(canvas, [op({ op: 'add_text', text: 'Casa Tomás', style: 'title', position: 'top' })], context);
      if (!result.ok) throw new Error('no aplica');
      return withLayers(result.document, result.document.pages[0]!.layers.map((l) => ({ ...l, y })));
    };
    const logo = op({ op: 'add_logo', assetId: LOGO, position: 'top', align: 'center' });

    const hueco = applyCopilotOperations(conTexto(200), [logo], context);
    if (!hueco.ok) throw new Error('no aplica');
    const [texto, puesto] = hueco.document.pages[0]!.layers;
    expect(puesto!.y + puesto!.height).toBeLessThanOrEqual(texto!.y);
    expect(puesto!.x + puesto!.width / 2).toBeCloseTo(540, 0);
    expect(hueco.skipped).toEqual([]);

    const sinHueco = applyCopilotOperations(conTexto(60), [logo], context);
    if (!sinHueco.ok) throw new Error('no aplica');
    expect(sinHueco.document.pages[0]!.layers).toHaveLength(2);
    expect(sinHueco.skipped).toEqual(['El logotipo pisa «Casa Tomás»: muévelo o quita ese texto.']);
  });
});

describe('copiloto: orden ambigua', () => {
  it('sin operaciones y con una pregunta en la nota: no cambia nada', () => {
    const response = parseCopilotResponse({
      action: 'editor.copilot',
      generationId: PHOTO,
      operations: [],
      discarded: [],
      note: '¿Qué texto es el título: «Antiguo» o «Precio: 45 euros»?',
    });
    expect(response?.note).toContain('¿Qué texto es el título');
    const result = applyCopilotOperations(createEmptyDocument(), response!.operations, context);
    expect(result.ok && result.changes).toEqual([]);
  });
});
