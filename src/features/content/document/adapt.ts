import { CANVAS_SIZES, type AspectRatio, type ContentDocument, type Layer } from './schema';

// Adaptar un documento a otra proporción (1:1 → 4:5 → 9:16…) con reglas fijas,
// sin IA. El resultado es un punto de partida que una persona revisa y retoca.
//
// 1. Las capas se escalan todas por igual, con el factor que hace que el
//    lienzo de origen quepa entero en el de destino. Así, lo que cabía sigue
//    cabiendo y nada se deforma.
// 2. Cada eje se recoloca según el anclaje de la capa:
//      left / top       conserva la distancia a ese borde (escalada)
//      right / bottom   conserva la distancia al borde contrario (escalada)
//      center           conserva la posición relativa de su centro
//      stretch          conserva la distancia relativa a los dos bordes: la
//                       capa se estira con el lienzo (fondos, bandas)
// 3. El cuerpo de letra, el trazo y el radio de las esquinas se escalan con el
//    mismo factor. Giro, opacidad, orden, contenido y texto de la publicación
//    no cambian. El recorte de una imagen estirada lo resuelve quien dibuja con
//    `fit` y `focus`.

type AxisAnchor = 'start' | 'center' | 'end' | 'stretch';

const AXIS: Record<Layer['anchor']['x'] | Layer['anchor']['y'], AxisAnchor> = {
  left: 'start',
  top: 'start',
  center: 'center',
  right: 'end',
  bottom: 'end',
  stretch: 'stretch',
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function adaptAxis(
  start: number,
  length: number,
  from: number,
  to: number,
  anchor: AxisAnchor,
  scale: number,
): [start: number, length: number] {
  const scaled = length * scale;
  switch (anchor) {
    case 'start':
      return [start * scale, scaled];
    case 'end':
      return [to - (from - start - length) * scale - scaled, scaled];
    case 'center':
      return [((start + length / 2) / from) * to - scaled / 2, scaled];
    case 'stretch':
      return [(start / from) * to, (length / from) * to];
  }
}

/** Factor con el que se escalan las capas al pasar de un lienzo a otro. */
export function adaptScale(from: { width: number; height: number }, to: { width: number; height: number }): number {
  return Math.min(to.width / from.width, to.height / from.height);
}

/** Recoloca una capa de un lienzo en otro según su anclaje. No modifica la capa recibida. */
export function adaptLayer<T extends Layer>(
  layer: T,
  from: { width: number; height: number },
  to: { width: number; height: number },
): T {
  const scale = adaptScale(from, to);
  const [x, width] = adaptAxis(layer.x, layer.width, from.width, to.width, AXIS[layer.anchor.x], scale);
  const [y, height] = adaptAxis(layer.y, layer.height, from.height, to.height, AXIS[layer.anchor.y], scale);
  const adapted: Layer = {
    ...structuredClone(layer as Layer),
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
  };
  if (adapted.type === 'text') {
    adapted.fontSize = round(adapted.fontSize * scale);
  } else if (adapted.type === 'shape') {
    adapted.cornerRadius = round(adapted.cornerRadius * scale);
    if (adapted.stroke) adapted.stroke.width = round(adapted.stroke.width * scale);
  }
  return adapted as T;
}

/**
 * Devuelve una copia del documento en otra proporción, con las capas
 * recolocadas según su anclaje. El documento recibido no se modifica.
 */
export function adaptDocument(document: ContentDocument, target: AspectRatio): ContentDocument {
  const from = { width: document.canvas.width, height: document.canvas.height };
  const to = CANVAS_SIZES[target];
  return {
    ...structuredClone(document),
    canvas: { ...document.canvas, aspectRatio: target, ...to },
    // Todas las páginas a la vez: comparten el lienzo.
    pages: document.pages.map((page) => ({
      ...structuredClone(page),
      layers: page.layers.map((layer) => adaptLayer(layer, from, to)),
    })),
  };
}
