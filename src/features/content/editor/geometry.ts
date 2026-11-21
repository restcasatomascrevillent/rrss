import type { Layer } from '../document';

// Traducción entre la caja de una capa del documento y el nodo que la dibuja.
//
// En el documento, `x`, `y` son la esquina superior izquierda de la caja sin
// girar y el giro es alrededor de su centro. Un nodo de Konva gira alrededor
// de su punto de origen, así que se coloca en el centro de la caja con un
// desplazamiento (offset) de medio ancho y medio alto. Al redimensionar con
// los tiradores, Konva cambia la escala del nodo; de vuelta al documento la
// escala se convierte en ancho y alto, y el nodo vuelve a escala 1.

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
}

/** Lo que el nodo informa tras moverlo, girarlo o redimensionarlo. */
export interface NodeTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX?: number;
  scaleY?: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function layerToNodeBox(layer: Pick<Layer, 'x' | 'y' | 'width' | 'height' | 'rotation'>): NodeBox {
  return {
    x: layer.x + layer.width / 2,
    y: layer.y + layer.height / 2,
    width: layer.width,
    height: layer.height,
    offsetX: layer.width / 2,
    offsetY: layer.height / 2,
    rotation: layer.rotation,
  };
}

/** Caja del documento a partir de un nodo colocado por su centro. Nunca devuelve medidas menores que 1. */
export function nodeToLayerBox(node: NodeTransform): Pick<Layer, 'x' | 'y' | 'width' | 'height' | 'rotation'> {
  const width = Math.max(1, Math.abs(node.width * (node.scaleX ?? 1)));
  const height = Math.max(1, Math.abs(node.height * (node.scaleY ?? 1)));
  return {
    x: round(node.x - width / 2),
    y: round(node.y - height / 2),
    width: round(width),
    height: round(height),
    rotation: round(node.rotation),
  };
}

// ── Guías de ajuste ──────────────────────────────────────────────────────

export interface Guides {
  /** Posiciones x de las guías verticales que se han usado. */
  vertical: number[];
  /** Posiciones y de las guías horizontales. */
  horizontal: number[];
}

export interface SnapResult {
  x: number;
  y: number;
  guides: Guides;
}

/** Distancia, en unidades del lienzo, a la que una capa se pega a una guía. */
export const SNAP_THRESHOLD = 12;

function snapAxis(start: number, length: number, size: number, threshold: number, edges: boolean) {
  const targets = [size / 2, ...(edges ? [0, size] : [])];
  // Qué punto de la capa se pega: su centro siempre; sus bordes si no está girada.
  const points = [length / 2, ...(edges ? [0, length] : [])];
  let best: { delta: number; guide: number } | null = null;
  for (const target of targets) {
    for (const point of points) {
      const delta = target - (start + point);
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, guide: target };
      }
    }
  }
  return best ? { start: start + best.delta, guides: [best.guide] } : { start, guides: [] as number[] };
}

/**
 * Pega la capa al centro y a los bordes del lienzo si está cerca. Una capa
 * girada solo se pega por su centro (sus bordes ya no son horizontales).
 */
export function snapToCanvas(
  box: Pick<Layer, 'x' | 'y' | 'width' | 'height' | 'rotation'>,
  canvas: { width: number; height: number },
  threshold = SNAP_THRESHOLD,
): SnapResult {
  const edges = Math.abs(box.rotation % 360) < 0.01;
  const x = snapAxis(box.x, box.width, canvas.width, threshold, edges);
  const y = snapAxis(box.y, box.height, canvas.height, threshold, edges);
  return { x: x.start, y: y.start, guides: { vertical: x.guides, horizontal: y.guides } };
}

/** Escala para que un lienzo quepa entero en el espacio disponible (sin agrandarlo nunca por encima de 1). */
export function fitScale(canvas: { width: number; height: number }, available: { width: number; height: number }) {
  if (available.width <= 0 || available.height <= 0) return 0.1;
  return Math.min(1, available.width / canvas.width, available.height / canvas.height);
}

/** Recorte de una imagen para llenar una caja (`cover`) respetando el punto de interés. */
export function coverCrop(
  image: { width: number; height: number },
  box: { width: number; height: number },
  focus: { x: number; y: number },
) {
  const scale = Math.max(box.width / image.width, box.height / image.height);
  const width = box.width / scale;
  const height = box.height / scale;
  const x = Math.min(image.width - width, Math.max(0, focus.x * image.width - width / 2));
  const y = Math.min(image.height - height, Math.max(0, focus.y * image.height - height / 2));
  return { x, y, width, height };
}

/** Caja donde cabe una imagen entera (`contain`), centrada en la caja de la capa. */
export function containBox(image: { width: number; height: number }, box: { width: number; height: number }) {
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}
