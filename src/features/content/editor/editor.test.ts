import { describe, expect, it } from 'vitest';
import { createEmptyDocument, validateDocument, type ContentDocument, type TextLayer } from '../document';
import { getFormatSpec } from '../networks';
import { statusActions } from '../status';
import { assetIdsOf, describeDocument, describeLayer, fontStyleOf } from './canvas/nodes';
import { copyCounters, formatTagList, parseTagList } from './copy';
import { containBox, coverCrop, fitScale, layerToNodeBox, nodeToLayerBox, snapToCanvas } from './geometry';
import {
  editorReducer,
  HISTORY_LIMIT,
  activeLayers,
  initEditor,
  normalizeRotation,
  reorderLayers,
  type EditorAction,
  type EditorState,
} from './history';
import { layerLabel, newImageLayer, newLayerId, newLogoLayer, newShapeLayer, newTextLayer } from './layers';

const ASSET = '11111111-1111-4111-8111-111111111111';
const LOGO = '22222222-2222-4222-8222-222222222222';

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function withText(): { state: EditorState; text: TextLayer } {
  const doc = createEmptyDocument();
  const text = newTextLayer(doc.canvas, []);
  return { state: run(initEditor(doc), { type: 'add', layer: text }), text };
}

describe('capas nuevas', () => {
  it('cumplen el esquema del documento', () => {
    const doc = createEmptyDocument({ aspectRatio: '4:5' });
    const layers = [
      newTextLayer(doc.canvas, []),
      newImageLayer(doc.canvas, [], { id: ASSET, name: 'foto.jpg' }),
      newLogoLayer(doc.canvas, [], { id: LOGO, name: 'logo.png', width: 400, height: 200 }),
      newShapeLayer(doc.canvas, [], 'rectangle'),
      newShapeLayer(doc.canvas, [], 'ellipse'),
    ];
    const ids = new Set<string>();
    for (const layer of layers) ids.add(layer.id);
    expect(ids.size).toBe(layers.length);
    const result = validateDocument({ ...doc, pages: [{ id: 'p1', layers }] });
    expect(result.ok).toBe(true);
  });

  it('la imagen llena el lienzo y se estira con él; el logotipo va a la esquina inferior derecha', () => {
    const doc = createEmptyDocument();
    const image = newImageLayer(doc.canvas, [], { id: ASSET, name: 'foto.jpg' });
    expect(image).toMatchObject({ x: 0, y: 0, width: 1080, height: 1080, anchor: { x: 'stretch', y: 'stretch' } });
    const logo = newLogoLayer(doc.canvas, [], { id: LOGO, name: 'logo', width: 200, height: 100 });
    expect(logo.anchor).toEqual({ x: 'right', y: 'bottom' });
    expect(logo.width / logo.height).toBeCloseTo(2);
    expect(logo.x + logo.width).toBeLessThan(1080);
    expect(logo.y + logo.height).toBeLessThan(1080);
  });

  it('el identificador no repite uno existente', () => {
    const doc = createEmptyDocument();
    const first = newTextLayer(doc.canvas, []);
    expect(newLayerId([first])).not.toBe(first.id);
    expect(newLayerId([first])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('el nombre del panel sale del contenido si no tiene uno propio', () => {
    const doc = createEmptyDocument();
    const text = { ...newTextLayer(doc.canvas, []), text: 'Menú del día\nsegunda línea' };
    expect(layerLabel(text)).toBe('Menú del día');
    expect(layerLabel({ ...text, text: '  ' })).toBe('Texto vacío');
    expect(layerLabel({ ...text, name: 'Titular' })).toBe('Titular');
    expect(layerLabel(newShapeLayer(doc.canvas, [], 'ellipse'))).toBe('Elipse');
  });
});

describe('órdenes del editor', () => {
  it('añadir selecciona la capa nueva y se puede deshacer y rehacer', () => {
    const { state, text } = withText();
    expect(state.selectedId).toBe(text.id);
    expect(activeLayers(state)).toHaveLength(1);
    const undone = run(state, { type: 'undo' });
    expect(activeLayers(undone)).toHaveLength(0);
    expect(undone.selectedId).toBeNull();
    const redone = run(undone, { type: 'redo' });
    expect(activeLayers(redone)[0]?.id).toBe(text.id);
  });

  it('escribir seguido en un campo es un solo paso de deshacer; un punto de control lo corta', () => {
    const { state, text } = withText();
    const typed = run(
      state,
      { type: 'update', id: text.id, patch: { text: 'H' }, key: 'text' },
      { type: 'update', id: text.id, patch: { text: 'Ho' }, key: 'text' },
      { type: 'update', id: text.id, patch: { text: 'Hola' }, key: 'text' },
    );
    expect(typed.past).toHaveLength(2);
    const undone = run(typed, { type: 'undo' });
    expect((activeLayers(undone)[0] as TextLayer).text).toBe('Escribe aquí');

    const split = run(
      state,
      { type: 'update', id: text.id, patch: { text: 'Uno' }, key: 'text' },
      { type: 'checkpoint' },
      { type: 'update', id: text.id, patch: { text: 'Dos' }, key: 'text' },
      { type: 'undo' },
    );
    expect((activeLayers(split)[0] as TextLayer).text).toBe('Uno');
  });

  it('un cambio nuevo borra lo que se podía rehacer', () => {
    const { state, text } = withText();
    const next = run(
      state,
      { type: 'update', id: text.id, patch: { x: 10 } },
      { type: 'undo' },
      { type: 'update', id: text.id, patch: { y: 10 } },
    );
    expect(next.future).toHaveLength(0);
    expect(activeLayers(next)[0]).toMatchObject({ x: text.x, y: 10 });
  });

  it('mover con las flechas agrupa los toques y no mueve capas bloqueadas', () => {
    const { state, text } = withText();
    const moved = run(
      state,
      { type: 'nudge', id: text.id, dx: 1, dy: 0 },
      { type: 'nudge', id: text.id, dx: 10, dy: -1 },
    );
    expect(activeLayers(moved)[0]).toMatchObject({ x: text.x + 11, y: text.y - 1 });
    expect(moved.past).toHaveLength(2);
    const locked = run(
      state,
      { type: 'update', id: text.id, patch: { locked: true } },
      {
        type: 'nudge',
        id: text.id,
        dx: 5,
        dy: 5,
      },
    );
    expect(activeLayers(locked)[0]).toMatchObject({ x: text.x, y: text.y });
  });

  it('respeta los límites del documento al cambiar una capa', () => {
    const { state, text } = withText();
    const next = run(state, {
      type: 'update',
      id: text.id,
      patch: { width: -5, height: 0, rotation: 450, opacity: 3, x: 1e9 },
    });
    expect(activeLayers(next)[0]).toMatchObject({ width: 1, height: 1, rotation: 90, opacity: 1, x: 100_000 });
    expect(validateDocument(next.document).ok).toBe(true);
  });

  it('borrar quita la selección; deshacer la recupera', () => {
    const { state, text } = withText();
    const removed = run(state, { type: 'remove', id: text.id });
    expect(activeLayers(removed)).toHaveLength(0);
    expect(removed.selectedId).toBeNull();
    expect(activeLayers(run(removed, { type: 'undo' }))).toHaveLength(1);
  });

  it('ordena capas: adelante, atrás, al frente y al fondo', () => {
    const doc = createEmptyDocument();
    const [a, b, c] = [
      newShapeLayer(doc.canvas, [], 'rectangle'),
      newTextLayer(doc.canvas, []),
      newShapeLayer(doc.canvas, [], 'ellipse'),
    ];
    const layers = [a, b, c];
    expect(reorderLayers(layers, a.id, 'forward').map((l) => l.id)).toEqual([b.id, a.id, c.id]);
    expect(reorderLayers(layers, a.id, 'front').map((l) => l.id)).toEqual([b.id, c.id, a.id]);
    expect(reorderLayers(layers, c.id, 'back').map((l) => l.id)).toEqual([c.id, a.id, b.id]);
    expect(reorderLayers(layers, a.id, 'backward')).toBe(layers);
  });

  it('cambiar la proporción adapta el documento y se puede deshacer', () => {
    const { state } = withText();
    const adapted = run(state, { type: 'setRatio', ratio: '9:16' });
    expect(adapted.document.canvas).toMatchObject({ aspectRatio: '9:16', width: 1080, height: 1920 });
    expect(validateDocument(adapted.document).ok).toBe(true);
    expect(run(adapted, { type: 'undo' }).document.canvas.aspectRatio).toBe('1:1');
  });

  it('el texto de la publicación y el fondo también se deshacen', () => {
    const state = run(
      initEditor(createEmptyDocument()),
      { type: 'setCopy', patch: { caption: 'Hola' }, key: 'caption' },
      { type: 'setBackground', color: '#000000' },
    );
    expect(state.document.copy.caption).toBe('Hola');
    expect(state.document.canvas.backgroundColor).toBe('#000000');
    const back = run(state, { type: 'undo' }, { type: 'undo' });
    expect(back.document.copy.caption).toBe('');
    expect(back.document.canvas.backgroundColor).toBe('#FFFFFF');
  });

  it('el historial tiene un tope', () => {
    const start = withText();
    const { text } = start;
    let state = start.state;
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      state = editorReducer(state, { type: 'update', id: text.id, patch: { x: i } });
    }
    expect(state.past).toHaveLength(HISTORY_LIMIT);
  });

  it('cargar un documento empieza el historial de cero', () => {
    const { state } = withText();
    const loaded = run(state, { type: 'load', document: createEmptyDocument() });
    expect(loaded.past).toHaveLength(0);
    expect(activeLayers(loaded)).toHaveLength(0);
  });

  it('normaliza el giro a (-180, 180]', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(270)).toBe(-90);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(540)).toBe(180);
  });
});

describe('traducción documento ↔ nodos', () => {
  it('ida y vuelta: el nodo se coloca por el centro y vuelve a la misma caja', () => {
    const layer = { x: 100, y: 200, width: 300, height: 100, rotation: 30 };
    const node = layerToNodeBox(layer);
    expect(node).toMatchObject({ x: 250, y: 250, offsetX: 150, offsetY: 50, rotation: 30 });
    expect(nodeToLayerBox(node)).toEqual(layer);
  });

  it('la escala de los tiradores se convierte en ancho y alto alrededor del mismo centro', () => {
    const box = nodeToLayerBox({ x: 250, y: 250, width: 300, height: 100, rotation: 0, scaleX: 2, scaleY: 0.5 });
    expect(box).toEqual({ x: -50, y: 225, width: 600, height: 50, rotation: 0 });
    expect(nodeToLayerBox({ x: 0, y: 0, width: 10, height: 10, rotation: 0, scaleX: 0 }).width).toBe(1);
  });

  it('describe cada tipo de capa como lo que hay que dibujar', () => {
    const doc = createEmptyDocument();
    const text = { ...newTextLayer(doc.canvas, []), italic: true, fontWeight: 700 };
    const image = newImageLayer(doc.canvas, [], { id: ASSET, name: 'foto' });
    const logo = newLogoLayer(doc.canvas, [], { id: LOGO, name: 'logo' });
    const ellipse = { ...newShapeLayer(doc.canvas, [], 'ellipse'), cornerRadius: 20 };
    const locked = { ...newShapeLayer(doc.canvas, [], 'rectangle'), locked: true, cornerRadius: 12 };
    const document: ContentDocument = { ...doc, pages: [{ id: 'p1', name: '', layers: [image, text, logo, ellipse, locked] }] };
    const images = new Map([[ASSET, 'https://example.test/foto.jpg']]);
    const nodes = describeDocument(document.pages[0]!, images);

    expect(nodes.map((n) => n.kind)).toEqual(['image', 'text', 'image', 'ellipse', 'rect']);
    expect(nodes[0]).toMatchObject({ url: 'https://example.test/foto.jpg', fit: 'cover', editable: true });
    expect(nodes[1]).toMatchObject({ fontStyle: 'italic 700', text: 'Escribe aquí' });
    // Sin dirección todavía: se dibuja el marcador; el logotipo siempre entero.
    expect(nodes[2]).toMatchObject({ url: null, fit: 'contain', placeholder: 'Logotipo' });
    expect(nodes[3]).toMatchObject({ cornerRadius: 0 });
    expect(nodes[4]).toMatchObject({ editable: false, cornerRadius: 12 });
    // En solo lectura nada se puede mover.
    expect(describeDocument(document.pages[0]!, images, true).every((n) => !n.editable)).toBe(true);
    expect(assetIdsOf(document)).toEqual([ASSET, LOGO].sort());
  });

  it('una imagen generada por IA sin conectar se dibuja como marcador', () => {
    const doc = createEmptyDocument();
    const image = newImageLayer(doc.canvas, [], { id: ASSET, name: 'x' });
    const generated = { ...image, source: { kind: 'generation' as const, generationId: ASSET } };
    expect(describeLayer(generated, new Map([[ASSET, 'u']]))).toMatchObject({
      url: null,
      placeholder: 'Imagen generada',
    });
    expect(fontStyleOf(400, false)).toBe('400');
  });
});

describe('guías y encaje', () => {
  const canvas = { width: 1000, height: 1000 };

  it('pega el centro de la capa al centro del lienzo', () => {
    const result = snapToCanvas({ x: 405, y: 100, width: 200, height: 100, rotation: 0 }, canvas, 10);
    expect(result.x).toBe(400);
    expect(result.guides.vertical).toEqual([500]);
    expect(result.guides.horizontal).toEqual([]);
  });

  it('pega los bordes de la capa a los bordes del lienzo', () => {
    const result = snapToCanvas({ x: 6, y: 795, width: 200, height: 200, rotation: 0 }, canvas, 10);
    expect(result).toMatchObject({ x: 0, y: 800 });
    expect(result.guides).toEqual({ vertical: [0], horizontal: [1000] });
  });

  it('una capa girada solo se pega por el centro', () => {
    const result = snapToCanvas({ x: 4, y: 300, width: 200, height: 200, rotation: 15 }, canvas, 10);
    expect(result.x).toBe(4);
    expect(result.guides.vertical).toEqual([]);
  });

  it('escala el lienzo al hueco sin agrandarlo', () => {
    expect(fitScale({ width: 1080, height: 1920 }, { width: 540, height: 540 })).toBeCloseTo(540 / 1920);
    expect(fitScale({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });

  it('recorta respetando el punto de interés y encaja sin deformar', () => {
    const crop = coverCrop({ width: 2000, height: 1000 }, { width: 100, height: 100 }, { x: 1, y: 0.5 });
    expect(crop).toEqual({ x: 1000, y: 0, width: 1000, height: 1000 });
    expect(containBox({ width: 200, height: 100 }, { width: 100, height: 100 })).toEqual({
      x: 0,
      y: 25,
      width: 100,
      height: 50,
    });
  });
});

describe('texto de la publicación', () => {
  it('cuenta frente a los límites de Instagram', () => {
    const spec = getFormatSpec('instagram', 'post');
    const copy = {
      caption: 'Hola #pasta',
      hashtags: ['comida', 'pasta'],
      mentions: ['casa'],
      altText: 'Un plato',
      callToAction: { label: '', url: '' },
    };
    const counters = copyCounters(copy, spec);
    const byField = Object.fromEntries(counters.map((c) => [c.field, c]));
    expect(byField.caption).toMatchObject({ value: 'Hola #pasta\n\n#comida'.length, max: 2200, over: false });
    expect(byField.hashtags).toMatchObject({ value: 2, max: 30 });
    expect(byField.mentions).toMatchObject({ value: 1, max: 20 });
    expect(byField.altText).toMatchObject({ value: 8, max: 1000 });
  });

  it('avisa al pasarse y no inventa límites que la red no publica', () => {
    const over = copyCounters(
      { caption: 'x'.repeat(2201), hashtags: [], mentions: [], altText: '', callToAction: { label: '', url: '' } },
      getFormatSpec('instagram', 'reel'),
    );
    expect(over.find((c) => c.field === 'caption')).toMatchObject({ over: true });
    expect(over.find((c) => c.field === 'altText')?.note).toMatch(/no admite/);
    const unknown = copyCounters(
      { caption: 'hola', hashtags: [], mentions: [], altText: '', callToAction: { label: '', url: '' } },
      getFormatSpec('facebook', 'page_post'),
    );
    expect(unknown.every((c) => c.max === undefined && !c.over)).toBe(true);
  });

  it('lee y escribe listas de hashtags y menciones', () => {
    expect(parseTagList('#uno, dos  #uno ##tres', '#')).toEqual(['uno', 'dos', 'tres']);
    expect(parseTagList('@ana @luis', '@')).toEqual(['ana', 'luis']);
    expect(formatTagList(['uno', 'dos'], '#')).toBe('#uno #dos');
  });
});

describe('cambios de estado según el rol', () => {
  const item = (status: 'idea' | 'draft' | 'in_review' | 'approved', archived = false) => ({
    status,
    archived_at: archived ? '2026-11-17T10:00:00Z' : null,
  });
  const labels = (...args: Parameters<typeof statusActions>) => statusActions(...args).map((a) => a.label);

  it('quien edita envía a revisión y retira aprobaciones, pero no aprueba', () => {
    const edit = { edit: true, approve: false };
    expect(labels(item('draft'), edit)).toEqual(['Enviar a revisión', 'Devolver a idea']);
    expect(labels(item('in_review'), edit)).toEqual(['Devolver a borrador']);
    expect(labels(item('approved'), edit)).toEqual(['Retirar la aprobación']);
  });

  it('quien solo aprueba aprueba lo que está en revisión y puede devolverlo a borrador', () => {
    const approve = { edit: false, approve: true };
    expect(labels(item('draft'), approve)).toEqual([]);
    expect(labels(item('in_review'), approve)).toEqual(['Aprobar', 'Devolver a borrador']);
    expect(labels(item('approved'), approve)).toEqual(['Retirar la aprobación']);
  });

  it('quien edita y aprueba puede aprobar un borrador; nadie cambia una pieza archivada', () => {
    expect(labels(item('draft'), { edit: true, approve: true })).toContain('Aprobar');
    expect(labels(item('draft', true), { edit: true, approve: true })).toEqual([]);
    expect(labels(item('in_review'), { edit: false, approve: false })).toEqual([]);
  });
});

describe('editor: páginas de un carrusel', () => {
  const carousel = () => initEditor(createEmptyDocument({ aspectRatio: '4:5', pages: 2 }));
  const textOn = (state: EditorState) => newTextLayer(state.document.canvas, state.document.pages.flatMap((p) => p.layers));

  it('las capas se añaden y se cambian en la página activa', () => {
    let state = carousel();
    expect(state.activePageId).toBe('p1');
    state = run(state, { type: 'add', layer: textOn(state) });
    state = run(state, { type: 'selectPage', index: 1 });
    expect(state.activePageId).toBe('p2');
    expect(state.selectedIds).toEqual([]);
    expect(activeLayers(state)).toEqual([]);
    state = run(state, { type: 'add', layer: textOn(state) });
    expect(state.document.pages.map((p) => p.layers.length)).toEqual([1, 1]);
    // Cambiar de página no es un paso de deshacer.
    expect(state.past).toHaveLength(2);
    expect(validateDocument(state.document).ok).toBe(true);
  });

  it('deshacer vuelve a la página donde se hizo el cambio y lo deshace allí', () => {
    let state = carousel();
    const first = textOn(state);
    state = run(state, { type: 'add', layer: first }, { type: 'selectPage', index: 1 });
    state = run(state, { type: 'add', layer: textOn(state) }, { type: 'selectPage', index: 0 });
    // Estoy en la página 1; el último cambio fue en la 2.
    const undone = run(state, { type: 'undo' });
    expect(undone.activePageId).toBe('p2');
    expect(undone.document.pages.map((p) => p.layers.length)).toEqual([1, 0]);
    const again = run(undone, { type: 'undo' });
    expect(again.activePageId).toBe('p1');
    expect(again.document.pages.map((p) => p.layers.length)).toEqual([0, 0]);
    const redone = run(again, { type: 'redo' }, { type: 'redo' });
    expect(redone.document.pages.map((p) => p.layers.length)).toEqual([1, 1]);
    expect(redone.activePageId).toBe('p2');
  });

  it('añadir, duplicar, borrar y reordenar páginas son pasos de deshacer', () => {
    let state = carousel();
    state = run(state, { type: 'add', layer: textOn(state) });
    state = run(state, { type: 'duplicatePage' });
    expect(state.document.pages).toHaveLength(3);
    expect(state.activePageId).toBe(state.document.pages[1]!.id);
    expect(activeLayers(state)).toHaveLength(1);
    expect(validateDocument(state.document).ok).toBe(true);

    state = run(state, { type: 'addPage' });
    expect(state.document.pages).toHaveLength(4);
    expect(activeLayers(state)).toEqual([]);

    const moved = run(state, { type: 'movePage', pageId: 'p1', to: 3 });
    expect(moved.document.pages[3]!.id).toBe('p1');
    expect(run(moved, { type: 'undo' }).document.pages[0]!.id).toBe('p1');

    const removed = run(state, { type: 'removePage' });
    expect(removed.document.pages).toHaveLength(3);
    const back = run(removed, { type: 'undo' });
    expect(back.document.pages).toHaveLength(4);
    expect(back.activePageId).toBe(state.activePageId);

    // La única página no se borra.
    const single = initEditor(createEmptyDocument());
    expect(run(single, { type: 'removePage' })).toBe(single);
  });

  it('elegir una capa de otra página lleva a esa página', () => {
    let state = carousel();
    const layer = textOn(state);
    state = run(state, { type: 'add', layer }, { type: 'selectPage', index: 1 });
    state = run(state, { type: 'select', id: layer.id, exact: true });
    expect(state.activePageId).toBe('p1');
    expect(state.selectedIds).toEqual([layer.id]);
  });

  it('cambiar la proporción adapta todas las páginas en un solo paso', () => {
    let state = carousel();
    state = run(state, { type: 'add', layer: textOn(state) }, { type: 'selectPage', index: 1 });
    state = run(state, { type: 'add', layer: textOn(state) });
    const square = run(state, { type: 'setRatio', ratio: '1:1' });
    expect(square.document.canvas.aspectRatio).toBe('1:1');
    expect(square.document.pages.every((p) => p.layers[0]!.width <= 1080)).toBe(true);
    expect(run(square, { type: 'undo' }).document.canvas.aspectRatio).toBe('4:5');
  });
});
