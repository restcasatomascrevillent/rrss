import {
  adaptDocument,
  addPage,
  clampPageIndex,
  duplicatePage,
  isNeutralAdjust,
  MAX_IMAGE_BLUR,
  MAX_LAYERS,
  movePage,
  pageIndexOf,
  pageIndexOfLayer,
  removePage,
  withPageLayers,
  type AspectRatio,
  type ContentDocument,
  type ImageLayer,
  type Layer,
  type LogoLayer,
  type PostCopy,
  type ShapeLayer,
  type TextLayer,
} from '../document';
import { isFullCrop } from './imageEffects/imageEdit';
import {
  alignMoves,
  distributeMoves,
  dropLoneGroups,
  expandGroups,
  type AlignTarget,
  type DistributeAxis,
  type Moves,
} from './arrange';

// Estado del editor y sus órdenes, como funciones puras: el documento es la
// fuente de verdad y cada cambio produce un documento nuevo. El lienzo (Konva)
// solo dibuja este estado y avisa de lo que hace la persona; nunca guarda nada
// por su cuenta. Deshacer y rehacer viven aquí y no se guardan en el servidor.
//
// Páginas (documento v4): las órdenes de capas actúan sobre la página activa.
// El historial es uno para todo el documento, pero cada paso recuerda en qué
// página se hizo: deshacer (o rehacer) un cambio de capas vuelve a esa página
// y lo deshace allí; deshacer añadir, duplicar, borrar o reordenar páginas deja
// el documento como estaba y en la página en que se estaba.

/** Pasos de deshacer que se conservan. */
export const HISTORY_LIMIT = 100;

/** Un paso del historial: el documento de antes y la página en que se hizo el cambio. */
export interface HistoryEntry {
  document: ContentDocument;
  pageId: string;
}

export interface EditorState {
  document: ContentDocument;
  /** Página que se ve y se edita. Siempre una del documento. */
  activePageId: string;
  /** Capas seleccionadas (de la página activa), en su orden (del fondo al frente). */
  selectedIds: string[];
  /** La capa seleccionada si hay exactamente una; null si no hay ninguna o hay varias. */
  selectedId: string | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /**
   * Clave del último cambio. Dos cambios seguidos con la misma clave (teclear
   * en un campo, mover con las flechas) cuentan como un solo paso de deshacer.
   */
  lastKey: string | null;
}

type Editable<T> = Partial<Omit<T, 'id' | 'type'>>;
/** Campos que se pueden cambiar de una capa. El tipo y el identificador no cambian nunca. */
export type LayerPatch = Editable<ImageLayer> & Editable<TextLayer> & Editable<LogoLayer> & Editable<ShapeLayer>;

export type ReorderTarget = 'forward' | 'backward' | 'front' | 'back';

export type EditorAction =
  /** Abre un documento y empieza el historial de cero (en su primera página). */
  | { type: 'load'; document: ContentDocument }
  /**
   * Elige una capa. Si está en un grupo, se elige el grupo entero salvo con
   * `exact` (desde el panel de capas, para cambiar una sola). Con `toggle` se
   * añade a la selección o se quita (Mayúsculas o Ctrl al hacer clic). Si la
   * capa es de otra página, se pasa a esa página.
   */
  | { type: 'select'; id: string | null; toggle?: boolean; exact?: boolean }
  /** Elige varias (rectángulo de selección). Con `additive` se suman a las que ya había. */
  | { type: 'selectMany'; ids: string[]; additive?: boolean }
  | { type: 'add'; layer: Layer }
  | { type: 'update'; id: string; patch: LayerPatch; key?: string }
  /** Varios cambios de capa como un solo paso de deshacer (mover o transformar varias a la vez). */
  | { type: 'updateMany'; changes: { id: string; patch: LayerPatch }[]; key?: string }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; id: string; to: ReorderTarget }
  | { type: 'nudge'; id: string; dx: number; dy: number }
  /** Mueve todas las capas elegidas (las bloqueadas no). */
  | { type: 'nudgeSelection'; dx: number; dy: number }
  /** Borra las capas elegidas que no estén bloqueadas. */
  | { type: 'removeSelection' }
  /** Alinea las capas elegidas entre sí (o una sola respecto al lienzo). */
  | { type: 'align'; to: AlignTarget }
  /** Reparte el espacio entre tres o más capas elegidas. */
  | { type: 'distribute'; axis: DistributeAxis }
  /** Agrupa las capas elegidas (dos o más). */
  | { type: 'group' }
  /** Deshace los grupos de las capas elegidas. */
  | { type: 'ungroup' }
  /** Cambia la proporción del lienzo: todas las páginas a la vez. */
  | { type: 'setRatio'; ratio: AspectRatio }
  /** Color de fondo del lienzo (común a todas las páginas). */
  | { type: 'setBackground'; color: string; key?: string }
  | { type: 'setCopy'; patch: Partial<PostCopy>; key?: string }
  /** Cambia de página (no es un paso de deshacer). Por identificador o por posición. */
  | { type: 'selectPage'; pageId?: string; index?: number }
  /** Página vacía detrás de la activa; pasa a ser la activa. */
  | { type: 'addPage' }
  /** Copia de una página (la activa si no se dice) detrás de ella; pasa a ser la activa. */
  | { type: 'duplicatePage'; pageId?: string }
  /** Quita una página (la activa si no se dice). La única que queda no se puede quitar. */
  | { type: 'removePage'; pageId?: string }
  /** Lleva una página a otra posición (arrastrar en la tira de miniaturas). */
  | { type: 'movePage'; pageId: string; to: number }
  /**
   * Sustituye el documento entero en UN solo paso de deshacer (lo usa el
   * copiloto por voz: una orden dictada = un paso). Quien lo envía ya lo ha
   * validado con el esquema; aquí no se comprueba otra vez. La página activa
   * no cambia (si sigue existiendo).
   */
  | { type: 'replace'; document: ContentDocument; select?: string[] }
  /** Corta la agrupación: el próximo cambio será un paso nuevo aunque tenga la misma clave. */
  | { type: 'checkpoint' }
  | { type: 'undo' }
  | { type: 'redo' };

export function initEditor(document: ContentDocument): EditorState {
  return {
    document,
    activePageId: document.pages[0]!.id,
    selectedIds: [],
    selectedId: null,
    past: [],
    future: [],
    lastKey: null,
  };
}

/** Posición de la página activa en el documento. */
export function activePageIndex(state: Pick<EditorState, 'document' | 'activePageId'>): number {
  return Math.max(0, pageIndexOf(state.document, state.activePageId));
}

/** Capas de la página activa. */
export function activeLayers(state: Pick<EditorState, 'document' | 'activePageId'>): Layer[] {
  return state.document.pages[activePageIndex(state)]!.layers;
}

/** La página pedida si existe en el documento; si no, la que ocupa su lugar (o la más cercana). */
function existingPage(document: ContentDocument, pageId: string, fallbackIndex = 0): string {
  if (pageIndexOf(document, pageId) >= 0) return pageId;
  return document.pages[clampPageIndex(document, fallbackIndex)]!.id;
}

const COORD_LIMIT = 100_000;
const clampCoord = (value: number) => Math.min(COORD_LIMIT, Math.max(-COORD_LIMIT, value));

/** Giro llevado a (-180, 180], que es lo que admite el documento sin perder nada. */
export function normalizeRotation(degrees: number): number {
  const turned = ((((degrees + 180) % 360) + 360) % 360) - 180;
  const result = turned === -180 ? 180 : turned;
  return Math.round(result * 100) / 100;
}

/** Aplica un cambio a una capa respetando los límites del documento. */
export function applyLayerPatch(layer: Layer, patch: LayerPatch): Layer {
  const next = { ...layer, ...patch } as Layer;
  next.x = clampCoord(next.x);
  next.y = clampCoord(next.y);
  next.width = Math.min(COORD_LIMIT, Math.max(1, next.width));
  next.height = Math.min(COORD_LIMIT, Math.max(1, next.height));
  next.rotation = normalizeRotation(next.rotation);
  next.opacity = Math.min(1, Math.max(0, next.opacity));
  if (next.type === 'image' && next.blur !== undefined) {
    const blur = Math.min(MAX_IMAGE_BLUR, Math.max(0, Number.isFinite(next.blur) ? next.blur : 0));
    if (blur > 0) next.blur = blur;
    else delete next.blur;
  }
  if (next.type === 'image') {
    // Una edición que no cambia nada no se guarda: la capa queda como si no se hubiera tocado.
    if (isNeutralAdjust(next.adjust)) delete next.adjust;
    if (isFullCrop(next.crop)) delete next.crop;
    if (!next.straighten || Math.abs(next.straighten) < 0.01) delete next.straighten;
  }
  // Lo que se quita de una capa se pone a `undefined` en el cambio: no debe quedar en el documento.
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

/** Nuevo orden de apilado. La primera capa del array queda al fondo. */
export function reorderLayers(layers: Layer[], id: string, to: ReorderTarget): Layer[] {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index < 0) return layers;
  const target =
    to === 'front'
      ? layers.length - 1
      : to === 'back'
        ? 0
        : Math.min(layers.length - 1, Math.max(0, index + (to === 'forward' ? 1 : -1)));
  if (target === index) return layers;
  const next = [...layers];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

let groupCounter = 0;
/** Identificador de grupo nuevo, con el formato que exige el esquema y sin repetir uno existente. */
export function newGroupId(layers: readonly Layer[]): string {
  const taken = new Set(layers.map((layer) => layer.groupId).filter(Boolean));
  let id: string;
  do {
    groupCounter += 1;
    id = `g${Date.now().toString(36)}${groupCounter.toString(36)}`;
  } while (taken.has(id));
  return id;
}

/** Selección normalizada: solo capas que existen en la página, en su orden, y la única si hay una. */
function selection(layers: readonly Layer[], ids: readonly string[]): Pick<EditorState, 'selectedIds' | 'selectedId'> {
  const wanted = new Set(ids);
  const selectedIds = layers.filter((layer) => wanted.has(layer.id)).map((layer) => layer.id);
  return { selectedIds, selectedId: selectedIds.length === 1 ? selectedIds[0]! : null };
}

function layersOfPage(document: ContentDocument, pageId: string): Layer[] {
  return document.pages[Math.max(0, pageIndexOf(document, pageId))]!.layers;
}

/**
 * Guarda un paso: el documento de antes y la página en que se hace el cambio
 * (la activa). `pageId` es la página que queda activa después (por omisión, la
 * misma, o la que ocupe su lugar si ya no existe).
 */
function commit(
  state: EditorState,
  document: ContentDocument,
  key: string | null,
  selectedIds: readonly string[] = state.selectedIds,
  pageId: string = state.activePageId,
): EditorState {
  if (document === state.document) return state;
  const grouped = key !== null && key === state.lastKey && state.past.length > 0;
  const past = grouped
    ? state.past
    : [...state.past, { document: state.document, pageId: state.activePageId }].slice(-HISTORY_LIMIT);
  const activePageId = existingPage(document, pageId, activePageIndex(state));
  return {
    document,
    activePageId,
    ...selection(layersOfPage(document, activePageId), selectedIds),
    past,
    future: [],
    lastKey: key,
  };
}

/** Cambia las capas de la página activa como un paso (o nada, si no cambian). */
function commitLayers(
  state: EditorState,
  layers: Layer[],
  key: string | null,
  selectedIds: readonly string[] = state.selectedIds,
): EditorState {
  return commit(state, withPageLayers(state.document, activePageIndex(state), layers), key, selectedIds);
}

function mapLayer(layers: Layer[], id: string, change: (layer: Layer) => Layer): Layer[] {
  let changed = false;
  const next = layers.map((layer) => {
    if (layer.id !== id) return layer;
    changed = true;
    return change(layer);
  });
  return changed ? next : layers;
}

/** Aplica desplazamientos a varias capas, respetando los límites del documento. */
function moveLayers(layers: Layer[], moves: Moves): Layer[] {
  if (moves.size === 0) return layers;
  return layers.map((layer) => {
    const move = moves.get(layer.id);
    return move ? applyLayerPatch(layer, { x: layer.x + move.dx, y: layer.y + move.dy }) : layer;
  });
}

function selectedLayers(state: EditorState): Layer[] {
  const ids = new Set(state.selectedIds);
  return activeLayers(state).filter((layer) => ids.has(layer.id));
}

function withoutGroup(layer: Layer): Layer {
  const rest = { ...layer };
  delete rest.groupId;
  return rest;
}

/** Pasa a otra página: sin selección y sin agrupar el paso siguiente con el anterior. */
function goToPage(state: EditorState, pageId: string): EditorState {
  if (pageId === state.activePageId) return state;
  return { ...state, activePageId: pageId, selectedIds: [], selectedId: null, lastKey: null };
}

/** Deshacer y rehacer: vuelve a la página del paso (si existe) y conserva la selección si no se cambia de página. */
function travel(state: EditorState, entry: HistoryEntry): Pick<EditorState, 'document' | 'activePageId' | 'selectedIds' | 'selectedId'> {
  const activePageId = existingPage(entry.document, entry.pageId, activePageIndex(state));
  const keep = activePageId === state.activePageId ? state.selectedIds : [];
  return {
    document: entry.document,
    activePageId,
    ...selection(layersOfPage(entry.document, activePageId), keep),
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const layers = activeLayers(state);
  switch (action.type) {
    case 'load':
      return initEditor(action.document);
    case 'select': {
      if (action.id === null) return { ...state, ...selection(layers, []), lastKey: null };
      // Una capa de otra página (un hallazgo del verificador, por ejemplo): se va a su página.
      if (!layers.some((layer) => layer.id === action.id)) {
        const at = pageIndexOfLayer(state.document, action.id);
        if (at < 0) return state;
        return editorReducer(goToPage(state, state.document.pages[at]!.id), { ...action, toggle: false });
      }
      const ids = action.exact ? [action.id] : expandGroups(layers, [action.id]);
      if (!action.toggle) return { ...state, ...selection(layers, ids), lastKey: null };
      const next = state.selectedIds.includes(action.id)
        ? state.selectedIds.filter((id) => !ids.includes(id))
        : [...state.selectedIds, ...ids];
      return { ...state, ...selection(layers, next), lastKey: null };
    }
    case 'selectMany': {
      const ids = expandGroups(layers, action.ids);
      return {
        ...state,
        ...selection(layers, action.additive ? [...state.selectedIds, ...ids] : ids),
        lastKey: null,
      };
    }
    case 'replace':
      return commit(state, action.document, null, action.select ?? state.selectedIds);
    case 'checkpoint':
      return state.lastKey === null ? state : { ...state, lastKey: null };
    case 'add': {
      if (layers.length >= MAX_LAYERS) return state;
      if (pageIndexOfLayer(state.document, action.layer.id) >= 0) return state;
      return commitLayers(state, [...layers, action.layer], null, [action.layer.id]);
    }
    case 'update':
      return commitLayers(
        state,
        mapLayer(layers, action.id, (layer) => applyLayerPatch(layer, action.patch)),
        action.key ?? null,
      );
    case 'updateMany': {
      const patches = new Map(action.changes.map((change) => [change.id, change.patch]));
      let changed = false;
      const next = layers.map((layer) => {
        const patch = patches.get(layer.id);
        if (!patch) return layer;
        changed = true;
        return applyLayerPatch(layer, patch);
      });
      return changed ? commitLayers(state, next, action.key ?? null) : state;
    }
    case 'nudge': {
      const next = mapLayer(layers, action.id, (layer) =>
        layer.locked ? layer : applyLayerPatch(layer, { x: layer.x + action.dx, y: layer.y + action.dy }),
      );
      return commitLayers(state, next, `nudge:${action.id}`);
    }
    case 'nudgeSelection': {
      const moves: Moves = new Map();
      for (const layer of selectedLayers(state)) {
        if (!layer.locked) moves.set(layer.id, { dx: action.dx, dy: action.dy });
      }
      return commitLayers(state, moveLayers(layers, moves), `nudge:${state.selectedIds.join(',')}`);
    }
    case 'remove': {
      if (!layers.some((layer) => layer.id === action.id)) return state;
      return commitLayers(
        state,
        dropLoneGroups(layers.filter((layer) => layer.id !== action.id)),
        null,
        state.selectedIds.filter((id) => id !== action.id),
      );
    }
    case 'removeSelection': {
      const doomed = new Set(
        selectedLayers(state)
          .filter((layer) => !layer.locked)
          .map((layer) => layer.id),
      );
      if (doomed.size === 0) return state;
      return commitLayers(
        state,
        dropLoneGroups(layers.filter((layer) => !doomed.has(layer.id))),
        null,
        state.selectedIds.filter((id) => !doomed.has(id)),
      );
    }
    case 'align':
      return commitLayers(
        state,
        moveLayers(layers, alignMoves(selectedLayers(state), action.to, state.document.canvas)),
        null,
      );
    case 'distribute':
      return commitLayers(state, moveLayers(layers, distributeMoves(selectedLayers(state), action.axis)), null);
    case 'group': {
      if (state.selectedIds.length < 2) return state;
      const groupId = newGroupId(state.document.pages.flatMap((page) => page.layers));
      const ids = new Set(state.selectedIds);
      return commitLayers(
        state,
        dropLoneGroups(layers.map((layer) => (ids.has(layer.id) ? { ...layer, groupId } : layer))),
        null,
      );
    }
    case 'ungroup': {
      const ids = new Set(state.selectedIds);
      if (!layers.some((layer) => ids.has(layer.id) && layer.groupId)) return state;
      return commitLayers(
        state,
        dropLoneGroups(layers.map((layer) => (ids.has(layer.id) && layer.groupId ? withoutGroup(layer) : layer))),
        null,
      );
    }
    case 'reorder': {
      const next = reorderLayers(layers, action.id, action.to);
      if (next === layers) return state;
      return commitLayers(state, next, null);
    }
    case 'setRatio': {
      if (action.ratio === state.document.canvas.aspectRatio) return state;
      return commit(state, adaptDocument(state.document, action.ratio), null);
    }
    case 'setBackground': {
      if (action.color === state.document.canvas.backgroundColor) return state;
      const document = { ...state.document, canvas: { ...state.document.canvas, backgroundColor: action.color } };
      return commit(state, document, action.key ?? null);
    }
    case 'setCopy': {
      const document = { ...state.document, copy: { ...state.document.copy, ...action.patch } };
      return commit(state, document, action.key ?? null);
    }
    case 'selectPage': {
      const at =
        action.pageId !== undefined
          ? pageIndexOf(state.document, action.pageId)
          : (action.index ?? activePageIndex(state));
      if (at < 0 || at >= state.document.pages.length) return state;
      return goToPage(state, state.document.pages[at]!.id);
    }
    case 'addPage': {
      const change = addPage(state.document, activePageIndex(state));
      if (!change) return state;
      return commit(state, change.document, null, [], change.document.pages[change.index]!.id);
    }
    case 'duplicatePage': {
      const at = action.pageId ? pageIndexOf(state.document, action.pageId) : activePageIndex(state);
      if (at < 0) return state;
      const change = duplicatePage(state.document, at);
      if (!change) return state;
      return commit(state, change.document, null, [], change.document.pages[change.index]!.id);
    }
    case 'removePage': {
      const at = action.pageId ? pageIndexOf(state.document, action.pageId) : activePageIndex(state);
      if (at < 0) return state;
      const change = removePage(state.document, at);
      if (!change) return state;
      // Si se quita otra página, se sigue en la misma; si es la activa, se pasa a la que ocupa su lugar.
      const stays = action.pageId !== undefined && action.pageId !== state.activePageId;
      const next = stays ? state.activePageId : change.document.pages[change.index]!.id;
      return commit(state, change.document, null, stays ? state.selectedIds : [], next);
    }
    case 'movePage': {
      const from = pageIndexOf(state.document, action.pageId);
      if (from < 0) return state;
      const change = movePage(state.document, from, action.to);
      if (!change) return state;
      return commit(state, change.document, null);
    }
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...travel(state, previous),
        past: state.past.slice(0, -1),
        future: [{ document: state.document, pageId: previous.pageId }, ...state.future],
        lastKey: null,
      };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        ...travel(state, next),
        past: [...state.past, { document: state.document, pageId: next.pageId }].slice(-HISTORY_LIMIT),
        future: rest,
        lastKey: null,
      };
    }
  }
}
