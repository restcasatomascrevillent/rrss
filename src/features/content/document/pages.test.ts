import { describe, expect, it } from 'vitest';
import { getFormatSpec } from '../networks';
import {
  addPage,
  adaptDocument,
  allLayers,
  createEmptyDocument,
  duplicatePage,
  MAX_PAGES,
  movePage,
  pageIndexOfLayer,
  pageLabel,
  pageLimits,
  pageView,
  removePage,
  validateDocument,
  withPageLayers,
  type ContentDocument,
  type Layer,
} from './index';

const shape = (id: string, groupId?: string): Layer => ({
  id,
  type: 'shape',
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
  anchor: { x: 'center', y: 'center' },
  shape: 'rectangle',
  fill: '#112233',
  stroke: null,
  cornerRadius: 0,
  ...(groupId ? { groupId } : {}),
});

function carousel(): ContentDocument {
  const doc = createEmptyDocument({ aspectRatio: '4:5', pages: 3 });
  return withPageLayers(withPageLayers(doc, 0, [shape('a', 'g1'), shape('b', 'g1')]), 2, [shape('c')]);
}

const valid = (document: ContentDocument) => {
  const result = validateDocument(document);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
};

describe('páginas que admite cada formato', () => {
  it('un carrusel de Instagram, de 2 a 10; un post o una historia, una; sin especificación, hasta 10', () => {
    expect(pageLimits(getFormatSpec('instagram', 'carousel'))).toEqual({ min: 2, max: 10 });
    expect(pageLimits(getFormatSpec('instagram', 'post'))).toEqual({ min: 1, max: 1 });
    expect(pageLimits(getFormatSpec('instagram', 'story'))).toEqual({ min: 1, max: 1 });
    expect(pageLimits(undefined)).toEqual({ min: 1, max: MAX_PAGES });
  });
});

describe('leer páginas', () => {
  it('la vista de una página lleva el lienzo, sus capas y el texto de la pieza', () => {
    const doc = carousel();
    expect(pageView(doc, 2)).toEqual({ canvas: doc.canvas, layers: [shape('c')], copy: doc.copy });
    // Fuera de rango: la más cercana.
    expect(pageView(doc, 99).layers).toEqual([shape('c')]);
    expect(pageView(doc).layers.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('todas las capas en orden y en qué página está cada una', () => {
    const doc = carousel();
    expect(allLayers(doc).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(pageIndexOfLayer(doc, 'c')).toBe(2);
    expect(pageIndexOfLayer(doc, 'nada')).toBe(-1);
    expect(pageLabel(doc.pages[1]!, 1)).toBe('Página 2');
    expect(pageLabel({ name: ' Portada ' }, 0)).toBe('Portada');
  });
});

describe('cambiar páginas', () => {
  it('añadir deja una página vacía detrás de la pedida, hasta 10', () => {
    const change = addPage(carousel(), 0)!;
    expect(change.index).toBe(1);
    expect(change.document.pages).toHaveLength(4);
    expect(change.document.pages[1]!.layers).toEqual([]);
    valid(change.document);
    const full = createEmptyDocument({ pages: MAX_PAGES });
    expect(addPage(full)).toBeNull();
  });

  it('duplicar copia las capas con identificadores y grupos nuevos, y el resultado es válido', () => {
    const doc = carousel();
    const change = duplicatePage(doc, 0)!;
    expect(change.index).toBe(1);
    const [original, copy] = change.document.pages;
    expect(copy!.layers).toHaveLength(2);
    expect(copy!.layers.map((l) => l.id)).not.toEqual(original!.layers.map((l) => l.id));
    // Los dos siguen agrupados entre sí, pero en otro grupo.
    expect(copy!.layers[0]!.groupId).toBeTruthy();
    expect(copy!.layers[0]!.groupId).toBe(copy!.layers[1]!.groupId);
    expect(copy!.layers[0]!.groupId).not.toBe('g1');
    expect({ ...copy!.layers[0]!, id: 'a', groupId: 'g1' }).toEqual(original!.layers[0]);
    valid(change.document);
    // El original no cambia.
    expect(doc.pages).toHaveLength(3);
  });

  it('quitar deja al menos una página; mover reordena sin perder nada', () => {
    const doc = carousel();
    const removed = removePage(doc, 2)!;
    expect(removed.document.pages).toHaveLength(2);
    expect(removed.index).toBe(1);
    expect(removePage(createEmptyDocument(), 0)).toBeNull();

    const moved = movePage(doc, 2, 0)!;
    expect(moved.index).toBe(0);
    expect(moved.document.pages.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    expect(movePage(doc, 1, 1)).toBeNull();
  });

  it('cambiar la proporción adapta todas las páginas a la vez', () => {
    const adapted = adaptDocument(carousel(), '1:1');
    expect(adapted.canvas.aspectRatio).toBe('1:1');
    expect(adapted.pages).toHaveLength(3);
    expect(adapted.pages[2]!.layers[0]!.id).toBe('c');
    valid(adapted);
  });
});
