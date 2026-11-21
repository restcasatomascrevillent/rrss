import {
  MAX_PAGES,
  type Canvas,
  type ContentDocument,
  type DocumentPage,
  type Layer,
  type PostCopy,
} from './schema';

// Páginas del documento (versión 4): ayudas puras para leerlas y cambiarlas.
// Un post tiene una página; un carrusel, varias, todas con el mismo lienzo y
// el mismo texto de la publicación. Nada de aquí modifica lo que recibe.

/**
 * Lo que se dibuja de UNA página: el lienzo del documento, sus capas y el texto
 * de la publicación. Es lo que leen el lienzo, la exportación, el copiloto y las
 * comprobaciones de una sola imagen (antes leían el documento entero).
 */
export interface PageView {
  canvas: Canvas;
  layers: Layer[];
  copy: PostCopy;
}

/** Cuántas páginas admite un formato. */
export interface PageLimits {
  min: number;
  max: number;
}

/**
 * Páginas que admite un formato, a partir de su especificación: un carrusel,
 * de 2 a `maxItems` (con el techo del documento, 10, que es lo que publica la
 * API de Instagram); cualquier otro formato, una. Sin especificación conocida,
 * no se limita más que el documento.
 */
export function pageLimits(spec: { format: string; maxItems?: { value: number } } | undefined): PageLimits {
  if (!spec) return { min: 1, max: MAX_PAGES };
  if (spec.format === 'carousel') return { min: 2, max: Math.min(MAX_PAGES, spec.maxItems?.value ?? MAX_PAGES) };
  return { min: 1, max: 1 };
}

/** Índice de una página válido: el pedido si existe; si no, el más cercano. */
export function clampPageIndex(document: ContentDocument, index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(document.pages.length - 1, Math.max(0, Math.trunc(index)));
}

/** Vista de una página (la primera si no se dice cuál). */
export function pageView(document: ContentDocument, index = 0): PageView {
  const page = document.pages[clampPageIndex(document, index)]!;
  return { canvas: document.canvas, layers: page.layers, copy: document.copy };
}

/** Posición de una página por su identificador; -1 si no está. */
export function pageIndexOf(document: ContentDocument, pageId: string): number {
  return document.pages.findIndex((page) => page.id === pageId);
}

/** Página en la que está una capa; -1 si no está en ninguna. */
export function pageIndexOfLayer(document: ContentDocument, layerId: string): number {
  return document.pages.findIndex((page) => page.layers.some((layer) => layer.id === layerId));
}

/** Todas las capas del documento, página a página y del fondo al frente. */
export function allLayers(document: ContentDocument): Layer[] {
  return document.pages.flatMap((page) => page.layers);
}

/** Copia del documento con otras capas en una página. */
export function withPageLayers(document: ContentDocument, index: number, layers: Layer[]): ContentDocument {
  const at = clampPageIndex(document, index);
  if (document.pages[at]!.layers === layers) return document;
  return { ...document, pages: document.pages.map((page, i) => (i === at ? { ...page, layers } : page)) };
}

/** Atajo para documentos de una página (o para cambiar la primera). */
export function withLayers(document: ContentDocument, layers: Layer[]): ContentDocument {
  return withPageLayers(document, 0, layers);
}

let counter = 0;
function freshId(prefix: string, taken: ReadonlySet<string>): string {
  let id: string;
  do {
    counter += 1;
    id = `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
  } while (taken.has(id));
  return id;
}

/** Identificador de página nuevo, sin repetir uno del documento. */
export function newPageId(document: ContentDocument): string {
  return freshId('p', new Set(document.pages.map((page) => page.id)));
}

/** Resultado de una operación sobre las páginas: el documento nuevo y la página que queda elegida. */
export interface PageChange {
  document: ContentDocument;
  /** Índice de la página que conviene enseñar después. */
  index: number;
}

/** Añade una página vacía detrás de `after` (al final si no se dice). Null si ya no caben. */
export function addPage(document: ContentDocument, after = document.pages.length - 1): PageChange | null {
  if (document.pages.length >= MAX_PAGES) return null;
  const at = clampPageIndex(document, after) + 1;
  const page: DocumentPage = { id: newPageId(document), name: '', layers: [] };
  const pages = [...document.pages];
  pages.splice(at, 0, page);
  return { document: { ...document, pages }, index: at };
}

/**
 * Duplica una página justo detrás de ella. Las capas copiadas llevan
 * identificadores nuevos (únicos en el documento) y sus grupos también, para
 * que elegir un grupo en una página no elija el de la otra. Null si no caben.
 */
export function duplicatePage(document: ContentDocument, index: number): PageChange | null {
  if (document.pages.length >= MAX_PAGES) return null;
  const at = clampPageIndex(document, index);
  const source = document.pages[at]!;
  const takenLayers = new Set(allLayers(document).map((layer) => layer.id));
  const takenGroups = new Set(allLayers(document).flatMap((layer) => (layer.groupId ? [layer.groupId] : [])));
  const groups = new Map<string, string>();
  const layers = source.layers.map((layer) => {
    const copy = structuredClone(layer);
    copy.id = freshId('l', takenLayers);
    takenLayers.add(copy.id);
    if (layer.groupId) {
      let group = groups.get(layer.groupId);
      if (!group) {
        group = freshId('g', takenGroups);
        takenGroups.add(group);
        groups.set(layer.groupId, group);
      }
      copy.groupId = group;
    }
    return copy;
  });
  const name = source.name ? `${source.name} (copia)`.slice(0, 120) : '';
  const pages = [...document.pages];
  pages.splice(at + 1, 0, { id: newPageId(document), name, layers });
  return { document: { ...document, pages }, index: at + 1 };
}

/** Quita una página. Null si es la única (un documento tiene al menos una). */
export function removePage(document: ContentDocument, index: number): PageChange | null {
  if (document.pages.length <= 1) return null;
  const at = clampPageIndex(document, index);
  const pages = document.pages.filter((_, i) => i !== at);
  return { document: { ...document, pages }, index: Math.min(at, pages.length - 1) };
}

/** Lleva la página `from` a la posición `to` (las demás se corren). Null si no cambia nada. */
export function movePage(document: ContentDocument, from: number, to: number): PageChange | null {
  const a = clampPageIndex(document, from);
  const b = clampPageIndex(document, to);
  if (a === b) return null;
  const pages = [...document.pages];
  const [moved] = pages.splice(a, 1);
  pages.splice(b, 0, moved!);
  return { document: { ...document, pages }, index: b };
}

/** Nombre legible de una página: el suyo o «Página 3». */
export function pageLabel(page: Pick<DocumentPage, 'name'>, index: number): string {
  return page.name.trim() || `Página ${index + 1}`;
}
