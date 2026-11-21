import { describe, expect, it } from 'vitest';
import { createEmptyDocument, validateDocument, type ContentDocument, type Layer } from '../document';
import {
  alignMoves,
  distributeMoves,
  dropLoneGroups,
  expandGroups,
  layerBounds,
  layersInRect,
  normalizeRect,
  snapBox,
  snapTargets,
  unionBounds,
} from './arrange';
import { activeLayers, editorReducer, initEditor, type EditorAction, type EditorState } from './history';
import { newShapeLayer } from './layers';

const CANVAS = { width: 1080, height: 1080 };

function rect(id: string, x: number, y: number, width = 100, height = 100, extra: Partial<Layer> = {}): Layer {
  const shape = newShapeLayer(createEmptyDocument().canvas, [], 'rectangle');
  return { ...shape, id, x, y, width, height, ...extra } as Layer;
}

function docWith(layers: Layer[]): ContentDocument {
  return { ...createEmptyDocument(), pages: [{ id: 'p1', name: '', layers }] };
}

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

const byId = (state: EditorState, id: string) => activeLayers(state).find((layer) => layer.id === id)!;

describe('cajas envolventes', () => {
  it('sin giro es la caja de la capa; girada 90°, se intercambian ancho y alto alrededor del centro', () => {
    expect(layerBounds({ x: 10, y: 20, width: 100, height: 50, rotation: 0 })).toEqual({
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
    });
    const turned = layerBounds({ x: 0, y: 0, width: 100, height: 50, rotation: 90 });
    expect(turned.left).toBeCloseTo(25);
    expect(turned.right).toBeCloseTo(75);
    expect(turned.top).toBeCloseTo(-25);
    expect(turned.bottom).toBeCloseTo(75);
  });

  it('la unión envuelve a todas; sin capas no hay caja', () => {
    expect(unionBounds([rect('a', 0, 0), rect('b', 300, 500, 50, 50)])).toEqual({
      left: 0,
      top: 0,
      right: 350,
      bottom: 550,
    });
    expect(unionBounds([])).toBeNull();
  });
});

describe('alinear', () => {
  const layers = [rect('a', 100, 100), rect('b', 400, 300, 200, 50), rect('c', 250, 600, 50, 50)];

  it('a la izquierda, derecha y centro de la caja que las envuelve', () => {
    expect(alignMoves(layers, 'left', CANVAS)).toEqual(
      new Map([
        ['b', { dx: -300, dy: 0 }],
        ['c', { dx: -150, dy: 0 }],
      ]),
    );
    const right = alignMoves(layers, 'right', CANVAS);
    expect(right.get('a')).toEqual({ dx: 400, dy: 0 });
    expect(right.has('b')).toBe(false);
    // Caja de 100 a 600: centro en 350.
    const center = alignMoves(layers, 'centerX', CANVAS);
    expect(center.get('a')).toEqual({ dx: 200, dy: 0 });
    expect(center.get('b')).toEqual({ dx: -150, dy: 0 });
  });

  it('arriba, abajo y en medio', () => {
    expect(alignMoves(layers, 'top', CANVAS).get('c')).toEqual({ dx: 0, dy: -500 });
    expect(alignMoves(layers, 'bottom', CANVAS).get('a')).toEqual({ dx: 0, dy: 450 });
    // Caja de 100 a 650: medio en 375.
    expect(alignMoves(layers, 'middle', CANVAS).get('b')).toEqual({ dx: 0, dy: 50 });
  });

  it('una sola capa se alinea al lienzo', () => {
    expect(alignMoves([rect('a', 100, 100)], 'centerX', CANVAS).get('a')).toEqual({ dx: 390, dy: 0 });
    expect(alignMoves([rect('a', 100, 100)], 'bottom', CANVAS).get('a')).toEqual({ dx: 0, dy: 880 });
  });

  it('las bloqueadas no se mueven, pero marcan la referencia', () => {
    const moves = alignMoves([rect('a', 100, 100, 100, 100, { locked: true }), rect('b', 500, 0)], 'left', CANVAS);
    expect(moves).toEqual(new Map([['b', { dx: -400, dy: 0 }]]));
  });

  it('una capa girada se alinea por lo que se ve, no por su caja sin girar', () => {
    const turned = rect('t', 300, 300, 200, 100, { rotation: 90 });
    // Girada, su borde izquierdo visible está en 350.
    expect(alignMoves([rect('a', 100, 0), turned], 'left', CANVAS).get('t')).toEqual({ dx: -250, dy: 0 });
  });
});

describe('distribuir', () => {
  it('reparte el mismo hueco entre las capas; los extremos no se mueven', () => {
    const layers = [rect('a', 0, 0), rect('b', 150, 0), rect('c', 900, 0)];
    // Ocupan 300 de 1000: huecos de 350.
    expect(distributeMoves(layers, 'horizontal')).toEqual(new Map([['b', { dx: 300, dy: 0 }]]));
    const vertical = [rect('a', 0, 0, 100, 100), rect('b', 0, 120, 100, 300), rect('c', 0, 800, 100, 100)];
    // Ocupan 500 de 900: huecos de 200 → b empieza en 300.
    expect(distributeMoves(vertical, 'vertical')).toEqual(new Map([['b', { dx: 0, dy: 180 }]]));
  });

  it('con menos de tres no hace nada; las bloqueadas se quedan en su sitio', () => {
    expect(distributeMoves([rect('a', 0, 0), rect('b', 500, 0)], 'horizontal').size).toBe(0);
    const layers = [rect('a', 0, 0), rect('b', 150, 0, 100, 100, { locked: true }), rect('c', 900, 0)];
    expect(distributeMoves(layers, 'horizontal').size).toBe(0);
  });
});

describe('rectángulo de selección', () => {
  const layers = [
    rect('fondo', 0, 0, 1080, 1080),
    rect('a', 100, 100),
    rect('b', 600, 600),
    rect('oculta', 120, 120, 50, 50, { visible: false }),
    rect('bloqueada', 150, 150, 50, 50, { locked: true }),
  ];

  it('elige lo que toca, sin el fondo que lo envuelve todo, ni ocultas ni bloqueadas', () => {
    expect(layersInRect(layers, normalizeRect({ x: 250, y: 250 }, { x: 50, y: 50 }))).toEqual(['a']);
    expect(layersInRect(layers, { left: 150, top: 150, right: 650, bottom: 650 })).toEqual(['a', 'b']);
  });

  it('un clic sin arrastrar no elige nada', () => {
    expect(layersInRect(layers, { left: 120, top: 120, right: 120.5, bottom: 120.5 })).toEqual([]);
  });
});

describe('guías respecto a otras capas', () => {
  it('ofrece bordes y centro del lienzo y de las demás capas', () => {
    const targets = snapTargets(CANVAS, [rect('a', 100, 200, 300, 100)]);
    expect(targets.vertical).toEqual(expect.arrayContaining([0, 540, 1080, 100, 250, 400]));
    expect(targets.horizontal).toEqual(expect.arrayContaining([0, 540, 1080, 200, 250, 300]));
  });

  it('pega el borde de la capa al borde de otra y dice qué guía usó', () => {
    const targets = snapTargets(CANVAS, [rect('a', 100, 200, 300, 100)]);
    const snap = snapBox({ x: 405, y: 700, width: 100, height: 100, rotation: 0 }, targets, 8);
    // Su borde izquierdo (405) se pega al derecho de la otra (400).
    expect(snap).toEqual({ dx: -5, dy: 0, guides: { vertical: [400], horizontal: [] } });
  });

  it('pega centro con centro y no hace nada lejos de todo', () => {
    const targets = snapTargets(CANVAS, [rect('a', 100, 200, 300, 100)]);
    const snap = snapBox({ x: 203, y: 600, width: 100, height: 100, rotation: 0 }, targets, 8);
    expect(snap.dx).toBe(-3);
    expect(snap.guides.vertical).toEqual([250]);
    expect(snapBox({ x: 700, y: 700, width: 30, height: 30, rotation: 0 }, targets, 8)).toEqual({
      dx: 0,
      dy: 0,
      guides: { vertical: [], horizontal: [] },
    });
  });
});

describe('grupos', () => {
  it('expandGroups añade el resto del grupo, en el orden del documento', () => {
    const layers = [
      rect('a', 0, 0, 10, 10, { groupId: 'g' }),
      rect('b', 0, 0),
      rect('c', 0, 0, 10, 10, { groupId: 'g' }),
    ];
    expect(expandGroups(layers, ['c'])).toEqual(['a', 'c']);
    expect(expandGroups(layers, ['b'])).toEqual(['b']);
  });

  it('dropLoneGroups quita el grupo a quien se queda solo en él', () => {
    const layers = dropLoneGroups([
      rect('a', 0, 0, 10, 10, { groupId: 'g' }),
      rect('b', 0, 0, 10, 10, { groupId: 'h' }),
      rect('c', 0, 0, 10, 10, { groupId: 'h' }),
    ]);
    expect(layers.map((l) => l.groupId)).toEqual([undefined, 'h', 'h']);
    expect(layers[0]).not.toHaveProperty('groupId');
  });
});

describe('editor: varias capas', () => {
  const start = () => initEditor(docWith([rect('a', 100, 100), rect('b', 400, 300), rect('c', 700, 600)]));

  it('Mayúsculas/Ctrl añade y quita de la selección; con varias no hay «capa única»', () => {
    let state = run(start(), { type: 'select', id: 'a' }, { type: 'select', id: 'c', toggle: true });
    expect(state.selectedIds).toEqual(['a', 'c']);
    expect(state.selectedId).toBeNull();
    state = run(state, { type: 'select', id: 'a', toggle: true });
    expect(state.selectedIds).toEqual(['c']);
    expect(state.selectedId).toBe('c');
    expect(run(state, { type: 'select', id: null }).selectedIds).toEqual([]);
  });

  it('el rectángulo elige varias, o las suma con Mayúsculas', () => {
    expect(run(start(), { type: 'selectMany', ids: ['b', 'a'] }).selectedIds).toEqual(['a', 'b']);
    const added = run(start(), { type: 'select', id: 'c' }, { type: 'selectMany', ids: ['a'], additive: true });
    expect(added.selectedIds).toEqual(['a', 'c']);
  });

  it('mueve, alinea y borra varias, cada orden en un solo paso de deshacer', () => {
    let state = run(start(), { type: 'selectMany', ids: ['a', 'b', 'c'] });
    state = run(state, { type: 'nudgeSelection', dx: 10, dy: 0 }, { type: 'nudgeSelection', dx: 10, dy: 0 });
    expect(activeLayers(state).map((l) => l.x)).toEqual([120, 420, 720]);
    expect(state.past).toHaveLength(1);
    state = run(state, { type: 'align', to: 'top' });
    expect(activeLayers(state).map((l) => l.y)).toEqual([100, 100, 100]);
    state = run(state, { type: 'distribute', axis: 'horizontal' });
    state = run(state, { type: 'removeSelection' });
    expect(activeLayers(state)).toHaveLength(0);
    expect(state.selectedIds).toEqual([]);
    const back = run(state, { type: 'undo' });
    expect(activeLayers(back)).toHaveLength(3);
    expect(back.selectedIds).toEqual([]);
  });

  it('borrar varias respeta las bloqueadas', () => {
    const state = run(
      start(),
      { type: 'update', id: 'b', patch: { locked: true } },
      { type: 'selectMany', ids: ['a', 'b'] },
      { type: 'removeSelection' },
    );
    expect(activeLayers(state).map((l) => l.id)).toEqual(['b', 'c']);
    expect(state.selectedIds).toEqual(['b']);
  });

  it('updateMany aplica a la vez lo que devuelve el lienzo al arrastrar varias', () => {
    const state = run(start(), {
      type: 'updateMany',
      changes: [
        { id: 'a', patch: { x: 0 } },
        { id: 'c', patch: { y: 0 } },
      ],
    });
    expect([byId(state, 'a').x, byId(state, 'c').y]).toEqual([0, 0]);
    expect(state.past).toHaveLength(1);
  });

  it('agrupar: un clic elige el grupo entero; desde el panel, una sola; el documento sigue siendo válido', () => {
    let state = run(start(), { type: 'selectMany', ids: ['a', 'b'] }, { type: 'group' });
    const groupId = byId(state, 'a').groupId;
    expect(groupId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(byId(state, 'b').groupId).toBe(groupId);
    expect(byId(state, 'c').groupId).toBeUndefined();
    expect(validateDocument(state.document).ok).toBe(true);

    state = run(state, { type: 'select', id: 'b' });
    expect(state.selectedIds).toEqual(['a', 'b']);
    state = run(state, { type: 'select', id: 'b', exact: true });
    expect(state.selectedIds).toEqual(['b']);

    state = run(state, { type: 'select', id: 'a' }, { type: 'ungroup' });
    expect(activeLayers(state).every((l) => l.groupId === undefined)).toBe(true);
    expect(activeLayers(run(state, { type: 'undo' }))[0]!.groupId).toBe(groupId);
  });

  it('agrupar exige dos capas; al borrar una de un grupo de dos, la otra se queda sin grupo', () => {
    expect(run(start(), { type: 'select', id: 'a' }, { type: 'group' }).past).toHaveLength(0);
    const state = run(start(), { type: 'selectMany', ids: ['a', 'b'] }, { type: 'group' }, { type: 'remove', id: 'a' });
    expect(byId(state, 'b').groupId).toBeUndefined();
  });
});
