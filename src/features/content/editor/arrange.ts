import type { Layer } from '../document';

// Colocar varias capas a la vez: cajas envolventes, alinear, distribuir,
// selección por rectángulo y grupos. Funciones puras sobre el documento; el
// reductor (history.ts) las usa para producir el documento nuevo.

type Box = Pick<Layer, 'x' | 'y' | 'width' | 'height' | 'rotation'>;

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Caja envolvente de una capa tal y como se ve (con su giro). Sin giro es su
 * caja; girada, el rectángulo horizontal más pequeño que contiene sus esquinas.
 */
export function layerBounds(box: Box): Bounds {
  const rotation = (box.rotation * Math.PI) / 180;
  if (Math.abs(Math.sin(rotation)) < 1e-9 && Math.abs(Math.abs(Math.cos(rotation)) - 1) < 1e-9) {
    return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const halfW = (box.width * cos + box.height * sin) / 2;
  const halfH = (box.width * sin + box.height * cos) / 2;
  return { left: cx - halfW, top: cy - halfH, right: cx + halfW, bottom: cy + halfH };
}

/** Caja que envuelve a todas. `null` si no hay ninguna. */
export function unionBounds(boxes: readonly Box[]): Bounds | null {
  if (boxes.length === 0) return null;
  const all = boxes.map(layerBounds);
  return {
    left: Math.min(...all.map((b) => b.left)),
    top: Math.min(...all.map((b) => b.top)),
    right: Math.max(...all.map((b) => b.right)),
    bottom: Math.max(...all.map((b) => b.bottom)),
  };
}

export type AlignTarget = 'left' | 'centerX' | 'right' | 'top' | 'middle' | 'bottom';

export const ALIGN_LABEL: Record<AlignTarget, string> = {
  left: 'Alinear a la izquierda',
  centerX: 'Centrar en horizontal',
  right: 'Alinear a la derecha',
  top: 'Alinear arriba',
  middle: 'Centrar en vertical',
  bottom: 'Alinear abajo',
};

/** Desplazamiento de cada capa (por id). Las que no se mueven no aparecen. */
export type Moves = Map<string, { dx: number; dy: number }>;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Alinea las capas entre sí: con dos o más, respecto a la caja que las envuelve;
 * con una sola, respecto al lienzo. Las capas bloqueadas no se mueven, pero sí
 * cuentan para la caja de referencia (son el punto fijo natural).
 */
export function alignMoves(
  layers: readonly Layer[],
  target: AlignTarget,
  canvas: { width: number; height: number },
): Moves {
  const moves: Moves = new Map();
  if (layers.length === 0) return moves;
  const reference: Bounds =
    layers.length === 1 ? { left: 0, top: 0, right: canvas.width, bottom: canvas.height } : unionBounds(layers)!;
  for (const layer of layers) {
    if (layer.locked) continue;
    const b = layerBounds(layer);
    let dx = 0;
    let dy = 0;
    if (target === 'left') dx = reference.left - b.left;
    if (target === 'right') dx = reference.right - b.right;
    if (target === 'centerX') dx = (reference.left + reference.right) / 2 - (b.left + b.right) / 2;
    if (target === 'top') dy = reference.top - b.top;
    if (target === 'bottom') dy = reference.bottom - b.bottom;
    if (target === 'middle') dy = (reference.top + reference.bottom) / 2 - (b.top + b.bottom) / 2;
    dx = round(dx);
    dy = round(dy);
    if (dx !== 0 || dy !== 0) moves.set(layer.id, { dx, dy });
  }
  return moves;
}

export type DistributeAxis = 'horizontal' | 'vertical';

/** Hacen falta al menos tres capas para repartir el espacio entre ellas. */
export const MIN_TO_DISTRIBUTE = 3;

/**
 * Reparte las capas con el mismo hueco entre ellas a lo largo de un eje. Las
 * de los extremos (la primera y la última por posición) no se mueven; las
 * bloqueadas tampoco, y su sitio se respeta como si se hubieran movido.
 */
export function distributeMoves(layers: readonly Layer[], axis: DistributeAxis): Moves {
  const moves: Moves = new Map();
  if (layers.length < MIN_TO_DISTRIBUTE) return moves;
  const items = layers
    .map((layer) => {
      const b = layerBounds(layer);
      return axis === 'horizontal'
        ? { layer, start: b.left, size: b.right - b.left }
        : { layer, start: b.top, size: b.bottom - b.top };
    })
    .sort((a, b) => a.start - b.start || a.layer.id.localeCompare(b.layer.id));
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const span = last.start + last.size - first.start;
  const occupied = items.reduce((sum, item) => sum + item.size, 0);
  const gap = (span - occupied) / (items.length - 1);
  let cursor = first.start + first.size + gap;
  for (const item of items.slice(1, -1)) {
    const delta = round(cursor - item.start);
    if (!item.layer.locked && delta !== 0) {
      moves.set(item.layer.id, axis === 'horizontal' ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
    }
    cursor += item.size + gap;
  }
  return moves;
}

/** Normaliza un rectángulo dibujado arrastrando en cualquier dirección. */
export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Bounds {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

/**
 * Capas que toca un rectángulo de selección. Basta con tocarlas, salvo las que
 * lo contienen entero: así una foto de fondo que ocupa todo el lienzo no entra
 * en cada selección por rectángulo. Ocultas y bloqueadas no se eligen así.
 */
export function layersInRect(
  layers: readonly Pick<Layer, 'id' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'visible' | 'locked'>[],
  rect: Bounds,
): string[] {
  if (rect.right - rect.left < 1 && rect.bottom - rect.top < 1) return [];
  return layers
    .filter((layer) => {
      if (!layer.visible || layer.locked) return false;
      const b = layerBounds(layer);
      const touches = b.left < rect.right && b.right > rect.left && b.top < rect.bottom && b.bottom > rect.top;
      const wraps = b.left <= rect.left && b.right >= rect.right && b.top <= rect.top && b.bottom >= rect.bottom;
      return touches && !wraps;
    })
    .map((layer) => layer.id);
}

/** Todas las capas de los grupos de las capas dadas (y las dadas), en el orden del documento. */
export function expandGroups(layers: readonly Layer[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const groups = new Set(layers.filter((l) => wanted.has(l.id) && l.groupId).map((l) => l.groupId!));
  return layers.filter((l) => wanted.has(l.id) || (l.groupId !== undefined && groups.has(l.groupId))).map((l) => l.id);
}

/** Quita el grupo a las capas que se han quedado solas en él (al borrar o desagrupar otras). */
export function dropLoneGroups(layers: Layer[]): Layer[] {
  const counts = new Map<string, number>();
  for (const layer of layers) if (layer.groupId) counts.set(layer.groupId, (counts.get(layer.groupId) ?? 0) + 1);
  if (![...counts.values()].some((n) => n < 2)) return layers;
  return layers.map((layer) => {
    if (!layer.groupId || (counts.get(layer.groupId) ?? 0) >= 2) return layer;
    const rest = { ...layer };
    delete rest.groupId;
    return rest;
  });
}

// ── Guías respecto a otras capas ─────────────────────────────────────────

export interface SnapTargets {
  /** Posiciones x a las que pegarse (bordes y centro del lienzo y de las otras capas). */
  vertical: number[];
  /** Posiciones y. */
  horizontal: number[];
}

/**
 * Líneas a las que se puede pegar una capa al arrastrarla: bordes y centro del
 * lienzo y de las demás capas visibles (las que se arrastran no cuentan).
 */
export function snapTargets(canvas: { width: number; height: number }, others: readonly Box[]): SnapTargets {
  const vertical = new Set([0, canvas.width / 2, canvas.width]);
  const horizontal = new Set([0, canvas.height / 2, canvas.height]);
  for (const other of others) {
    const b = layerBounds(other);
    for (const x of [b.left, (b.left + b.right) / 2, b.right]) vertical.add(round(x));
    for (const y of [b.top, (b.top + b.bottom) / 2, b.bottom]) horizontal.add(round(y));
  }
  return { vertical: [...vertical], horizontal: [...horizontal] };
}

function snapLine(start: number, end: number, targets: number[], threshold: number) {
  const points = [start, (start + end) / 2, end];
  let best: { delta: number; guide: number } | null = null;
  for (const target of targets) {
    for (const point of points) {
      const delta = target - point;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, guide: target };
      }
    }
  }
  return best;
}

export interface BoxSnap {
  dx: number;
  dy: number;
  guides: { vertical: number[]; horizontal: number[] };
}

/**
 * Cuánto mover una capa (por su caja envolvente: bordes y centro) para pegarla
 * a la línea más cercana dentro del umbral, en cada eje. Devuelve las guías
 * usadas para dibujarlas.
 */
export function snapBox(box: Box, targets: SnapTargets, threshold: number): BoxSnap {
  const b = layerBounds(box);
  const x = snapLine(b.left, b.right, targets.vertical, threshold);
  const y = snapLine(b.top, b.bottom, targets.horizontal, threshold);
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    guides: { vertical: x ? [x.guide] : [], horizontal: y ? [y.guide] : [] },
  };
}
