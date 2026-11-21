import type { Canvas, ImageLayer, Layer, LayerType, LogoLayer, ShapeLayer, TextLayer } from '../document';
import { isSticker, STICKER_LABEL } from './canvas/stickers';

// Capas nuevas con valores de partida razonables para el lienzo en que se
// crean, y nombres legibles para el panel de capas.

export const LAYER_TYPE_LABEL: Record<LayerType, string> = {
  image: 'Imagen',
  text: 'Texto',
  logo: 'Logotipo',
  shape: 'Forma',
};

/** Tipografías que siempre están, por si la marca no ha definido las suyas. */
export const FALLBACK_FONTS = ['sans-serif', 'serif', 'monospace'];

let counter = 0;
/** Identificador de capa nuevo: único en el documento y con el formato que exige el esquema. */
export function newLayerId(existing: readonly Layer[] = []): string {
  const taken = new Set(existing.map((layer) => layer.id));
  let id: string;
  do {
    counter += 1;
    id = `l${Date.now().toString(36)}${counter.toString(36)}`;
  } while (taken.has(id));
  return id;
}

/** Caja centrada en el lienzo que ocupa como mucho `share` del lado menor y respeta la proporción pedida. */
function centeredBox(canvas: Canvas, aspect: number, share: number) {
  const side = Math.min(canvas.width, canvas.height) * share;
  const width = aspect >= 1 ? side : side * aspect;
  const height = aspect >= 1 ? side / aspect : side;
  return {
    x: Math.round((canvas.width - width) / 2),
    y: Math.round((canvas.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

const base = { rotation: 0, opacity: 1, visible: true, locked: false } as const;

/**
 * Imagen de la biblioteca. Con medidas conocidas, ocupa el lienzo entero como
 * fondo (recortando lo que sobre); se ancla a los dos bordes para que, al
 * cambiar la proporción, siga llenándolo.
 */
export function newImageLayer(
  canvas: Canvas,
  layers: readonly Layer[],
  asset: { id: string; name: string },
): ImageLayer {
  return {
    ...base,
    id: newLayerId(layers),
    type: 'image',
    name: asset.name.slice(0, 120),
    x: 0,
    y: 0,
    width: canvas.width,
    height: canvas.height,
    anchor: { x: 'stretch', y: 'stretch' },
    source: { kind: 'asset', assetId: asset.id },
    fit: 'cover',
    focus: { x: 0.5, y: 0.5 },
  };
}

export function newTextLayer(
  canvas: Canvas,
  layers: readonly Layer[],
  style: { fontFamily?: string; color?: string } = {},
): TextLayer {
  const width = Math.round(canvas.width * 0.8);
  const fontSize = Math.round(Math.min(canvas.width, canvas.height) * 0.07);
  const height = Math.round(fontSize * 1.2 * 2);
  return {
    ...base,
    id: newLayerId(layers),
    type: 'text',
    name: '',
    x: Math.round((canvas.width - width) / 2),
    y: Math.round((canvas.height - height) / 2),
    width,
    height,
    anchor: { x: 'center', y: 'center' },
    text: 'Escribe aquí',
    fontFamily: style.fontFamily ?? FALLBACK_FONTS[0]!,
    fontSize,
    fontWeight: 700,
    italic: false,
    color: style.color ?? '#111111',
    align: 'center',
    lineHeight: 1.2,
  };
}

/** Logotipo en la esquina inferior derecha, anclado a ella. */
export function newLogoLayer(
  canvas: Canvas,
  layers: readonly Layer[],
  asset: { id: string; name: string; width?: number | null; height?: number | null },
): LogoLayer {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 1;
  const box = centeredBox(canvas, aspect, 0.18);
  const margin = Math.round(Math.min(canvas.width, canvas.height) * 0.05);
  return {
    ...base,
    id: newLayerId(layers),
    type: 'logo',
    name: asset.name.slice(0, 120),
    x: canvas.width - box.width - margin,
    y: canvas.height - box.height - margin,
    width: box.width,
    height: box.height,
    anchor: { x: 'right', y: 'bottom' },
    assetId: asset.id,
  };
}

export function newShapeLayer(
  canvas: Canvas,
  layers: readonly Layer[],
  shape: ShapeLayer['shape'],
  fill = '#E5E7EB',
): ShapeLayer {
  const aspect = shape === 'rectangle' ? 2 : shape === 'line' || shape === 'arrow' ? 2.5 : 1;
  const box = centeredBox(canvas, aspect, shape === 'line' || shape === 'rectangle' || shape === 'ellipse' ? 0.5 : 0.3);
  if (shape === 'line') {
    // Una línea solo tiene borde: caja baja y trazo grueso, con la misma anchura que se ve.
    const thickness = Math.max(6, Math.round(Math.min(canvas.width, canvas.height) * 0.008));
    const height = thickness * 3;
    return {
      ...base,
      id: newLayerId(layers),
      type: 'shape',
      name: '',
      x: box.x,
      y: Math.round((canvas.height - height) / 2),
      width: box.width,
      height,
      anchor: { x: 'center', y: 'center' },
      shape,
      fill: null,
      stroke: { color: fill, width: thickness },
      cornerRadius: 0,
    };
  }
  return {
    ...base,
    id: newLayerId(layers),
    type: 'shape',
    name: '',
    ...box,
    anchor: { x: 'center', y: 'center' },
    shape,
    fill,
    stroke: null,
    cornerRadius: 0,
  };
}

/** Nombre que se enseña en el panel de capas: el puesto por la persona o uno sacado del contenido. */
export function layerLabel(layer: Layer): string {
  if (layer.name.trim()) return layer.name.trim();
  if (layer.type === 'text') {
    const firstLine = layer.text.trim().split('\n')[0] ?? '';
    return firstLine ? (firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine) : 'Texto vacío';
  }
  if (layer.type === 'shape') {
    if (layer.shape === 'ellipse') return 'Elipse';
    return isSticker(layer.shape) ? STICKER_LABEL[layer.shape] : 'Rectángulo';
  }
  return LAYER_TYPE_LABEL[layer.type];
}
