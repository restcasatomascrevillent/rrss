// Paleta dominante de una imagen. La cuantización es una función pura sobre
// píxeles (`quantizePalette`); `extractPalette` la alimenta con un `canvas`
// reducido del navegador.

import type { PaletteColor } from './types';

export interface QuantizeOptions {
  /** Bits por canal de la cuantización inicial (4 → 16 niveles, 4096 casillas). */
  bitsPerChannel?: number;
  /** Distancia RGB (euclídea, 0-441) por debajo de la cual dos casillas se funden en un mismo color. */
  mergeDistance?: number;
  /** Máximo de colores devueltos. */
  maxColors?: number;
  /** Alfa (0-255) por debajo del cual el píxel se ignora por transparente. */
  minAlpha?: number;
}

export const DEFAULT_QUANTIZE: Required<QuantizeOptions> = {
  bitsPerChannel: 4,
  mergeDistance: 40,
  maxColors: 8,
  minAlpha: 128,
};

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/**
 * Colores dominantes de una imagen RGBA (`Uint8ClampedArray` de `ImageData`).
 * 1. Cada píxel opaco cae en una casilla de `bitsPerChannel` bits por canal.
 * 2. Las casillas, de mayor a menor, se funden con el color ya formado más
 *    cercano si está a menos de `mergeDistance`; si no, forman uno nuevo. Así
 *    un degradado no se reparte en decenas de colores.
 * 3. Se devuelven los `maxColors` mayores, con su color medio real (no el
 *    centro de la casilla) y su peso: fracción de los píxeles opacos (0-1).
 * Orden: por peso descendente y, a igualdad, por color, para que sea estable.
 */
export function quantizePalette(pixels: ArrayLike<number>, options: QuantizeOptions = {}): PaletteColor[] {
  const { bitsPerChannel, mergeDistance, maxColors, minAlpha } = { ...DEFAULT_QUANTIZE, ...options };
  const shift = 8 - Math.min(8, Math.max(1, Math.round(bitsPerChannel)));

  // 1. Casillas.
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < minAlpha) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const key = ((r >> shift) << 16) | ((g >> shift) << 8) | (b >> shift);
    const bin = bins.get(key);
    if (bin) {
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
    } else bins.set(key, { n: 1, r, g, b });
    total++;
  }
  if (total === 0) return [];

  // 2. Fusión de casillas parecidas, de mayor a menor.
  const sorted = [...bins.entries()].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]);
  const clusters: { n: number; r: number; g: number; b: number }[] = [];
  for (const [, bin] of sorted) {
    const mean = { r: bin.r / bin.n, g: bin.g / bin.n, b: bin.b / bin.n };
    let best: (typeof clusters)[number] | undefined;
    let bestDistance = Infinity;
    for (const c of clusters) {
      const d = Math.hypot(c.r / c.n - mean.r, c.g / c.n - mean.g, c.b / c.n - mean.b);
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    if (best && bestDistance <= mergeDistance) {
      best.n += bin.n;
      best.r += bin.r;
      best.g += bin.g;
      best.b += bin.b;
    } else clusters.push({ ...bin });
  }

  // 3. Los mayores.
  return clusters
    .map((c) => ({
      hex: `#${hex(c.r / c.n)}${hex(c.g / c.n)}${hex(c.b / c.n)}`.toUpperCase(),
      weight: Math.round((c.n / total) * 10_000) / 10_000,
    }))
    .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex))
    .slice(0, maxColors);
}

// ── En el navegador ──────────────────────────────────────────────────────

export type PaletteSource = Blob | HTMLImageElement | ImageBitmap | HTMLCanvasElement;

export interface ExtractOptions extends QuantizeOptions {
  /** Lado mayor del lienzo reducido, en píxeles. */
  maxSide?: number;
}

/** Lado mayor al que se reduce la imagen: de sobra para colores dominantes y barato de recorrer. */
export const PALETTE_SAMPLE_SIDE = 64;

/**
 * Colores dominantes de una imagen del navegador, dibujándola reducida en un
 * `canvas`. Una imagen de otro origen sin CORS «mancha» el lienzo y el navegador
 * impide leer sus píxeles: en ese caso se rechaza (el llamador debe tratarlo
 * como «paleta no disponible», no como un fallo de la pieza).
 */
export async function extractPalette(source: PaletteSource, options: ExtractOptions = {}): Promise<PaletteColor[]> {
  const maxSide = options.maxSide ?? PALETTE_SAMPLE_SIDE;
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const width = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const height = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  if (!width || !height) return [];
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('El navegador no permite leer los colores de la imagen.');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (source instanceof Blob && 'close' in bitmap) bitmap.close();
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return quantizePalette(data, options);
}
