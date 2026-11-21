// Encuadre inteligente SIN IA para los recortes por red (docs/edicion-fotos.md,
// §3). No reconoce objetos: busca dónde se concentra lo que suele importar en
// una foto (bordes y detalle, color vivo) con algo de preferencia por el
// centro, y coloca ahí el recorte más grande que cabe con esa proporción.
// Funciona bien con un plato, un producto o una persona sobre un fondo más
// liso; con una foto llena de detalle por igual, el recorte sale centrado.
import type { Pixels } from './pixels';

export const NETWORK_ASPECTS = ['1:1', '4:5', '9:16'] as const;
export type NetworkAspect = (typeof NETWORK_ASPECTS)[number];

export const NETWORK_ASPECT_LABEL: Record<NetworkAspect, string> = {
  '1:1': 'Cuadrado 1:1 (feed)',
  '4:5': 'Vertical 4:5 (feed de Instagram)',
  '9:16': 'Historia o reel 9:16',
};

const RATIO: Record<NetworkAspect, [number, number]> = { '1:1': [1, 1], '4:5': [4, 5], '9:16': [9, 16] };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Lado mayor del mapa de interés: basta para decidir el encuadre y es inmediato. */
const MAP_SIDE = 96;

export interface InterestMap {
  values: Float32Array;
  width: number;
  height: number;
  /** Escala del mapa respecto a la foto (mapa = foto × escala). */
  scale: number;
}

/**
 * Mapa de interés reducido: gradiente de la luminancia (Sobel) más
 * saturación, multiplicado por una campana suave centrada. Los píxeles
 * transparentes no interesan.
 */
export function interestMap(image: Pixels): InterestMap {
  const scale = Math.min(1, MAP_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const lum = new Float32Array(width * height);
  const sat = new Float32Array(width * height);
  const alpha = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) / scale));
      const sy = Math.min(image.height - 1, Math.floor((y + 0.5) / scale));
      const i = (sy * image.width + sx) * 4;
      const r = image.data[i]!;
      const g = image.data[i + 1]!;
      const b = image.data[i + 2]!;
      const max = Math.max(r, g, b);
      const p = y * width + x;
      lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sat[p] = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
      alpha[p] = image.data[i + 3]! / 255;
    }
  }
  const values = new Float32Array(width * height);
  const at = (x: number, y: number) =>
    lum[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const edge = Math.min(1, Math.hypot(gx, gy) / 400);
      const dx = (x + 0.5) / width - 0.5;
      const dy = (y + 0.5) / height - 0.5;
      const center = 0.6 + 0.4 * Math.exp(-(dx * dx + dy * dy) / 0.18);
      const p = y * width + x;
      values[p] = (edge + 0.6 * sat[p]!) * center * alpha[p]!;
    }
  }
  return { values, width, height, scale };
}

/** Caja más grande con esa proporción que cabe en la foto (sin ampliar). */
export function largestBox(
  source: { width: number; height: number },
  aspect: NetworkAspect,
): { width: number; height: number } {
  const [aw, ah] = RATIO[aspect];
  const wide = source.width * ah > source.height * aw;
  return wide
    ? { width: Math.round((source.height * aw) / ah), height: source.height }
    : { width: source.width, height: Math.round((source.width * ah) / aw) };
}

/**
 * Recorte con encuadre inteligente: la caja más grande con esa proporción,
 * desplazada (solo por el eje que sobra) hasta donde reúne más interés. A
 * igualdad, la más centrada. Devuelve la caja en píxeles de la foto.
 */
export function smartCrop(image: Pixels, aspect: NetworkAspect, map: InterestMap = interestMap(image)): Box {
  const size = largestBox(image, aspect);
  const horizontal = size.width < image.width;
  const free = horizontal ? image.width - size.width : image.height - size.height;
  if (free <= 0) return { x: 0, y: 0, ...size };

  // Interés acumulado por columnas (o filas) del mapa.
  const lines = horizontal ? map.width : map.height;
  const totals = new Float64Array(lines + 1);
  for (let i = 0; i < lines; i += 1) {
    let sum = 0;
    if (horizontal) for (let y = 0; y < map.height; y += 1) sum += map.values[y * map.width + i]!;
    else for (let x = 0; x < map.width; x += 1) sum += map.values[i * map.width + x]!;
    totals[i + 1] = totals[i]! + sum;
  }
  const window = Math.max(1, Math.round((horizontal ? size.width : size.height) * map.scale));
  const positions = Math.max(0, lines - window);
  let best = Math.round(positions / 2);
  let bestScore = -Infinity;
  for (let start = 0; start <= positions; start += 1) {
    const score = totals[start + window]! - totals[start]!;
    const centred = Math.abs(start - positions / 2) < Math.abs(best - positions / 2);
    if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && centred)) {
      bestScore = score;
      best = start;
    }
  }
  const offset = positions === 0 ? free / 2 : (best / positions) * free;
  const at = Math.round(Math.min(free, Math.max(0, offset)));
  return horizontal ? { x: at, y: 0, ...size } : { x: 0, y: at, ...size };
}

/** Recorte centrado (para comparar y para el «sin encuadre inteligente»). */
export function centeredCrop(source: { width: number; height: number }, aspect: NetworkAspect): Box {
  const size = largestBox(source, aspect);
  return {
    x: Math.round((source.width - size.width) / 2),
    y: Math.round((source.height - size.height) / 2),
    ...size,
  };
}
