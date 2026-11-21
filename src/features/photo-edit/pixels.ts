// Ajustes de una foto SIN IA: luz, color y nitidez, calculados en el navegador
// sobre los píxeles (docs/edicion-fotos.md, §2). Funciones puras sobre una
// imagen en memoria (`Pixels`, la misma forma que `ImageData`): no dibujan ni
// leen nada, así se prueban sin navegador. Nunca modifican la imagen de
// entrada: devuelven otra.

/** Imagen RGBA en memoria: la forma de `ImageData`. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Ajustes. Los deslizadores van de -100 a 100 (nitidez, de 0 a 100); 0 es «sin
 * cambio». `levels` estira el histograma (negro y blanco) y `balance` corrige
 * el tono (ganancia por canal); los rellena «Mejorar automáticamente».
 */
export interface Adjustments {
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
  sharpness: number;
  levels: { black: number; white: number } | null;
  balance: [number, number, number];
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  sharpness: 0,
  levels: null,
  balance: [1, 1, 1],
};

export interface ImageStats {
  /** Luminancia (0–255) por debajo de la cual queda el 0,5 % de los píxeles, y por encima el 0,5 %. */
  black: number;
  white: number;
  /** Luminancia media. */
  meanLuma: number;
  /** Media de cada canal. */
  mean: [number, number, number];
  /** Saturación media (0–1). */
  saturation: number;
  /** Detalle: media del valor absoluto del laplaciano de la luminancia (cuanto menor, más blanda). */
  detail: number;
  /** Algún píxel no es opaco. */
  transparent: boolean;
}

const clampByte = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** ¿Tiene algún píxel transparente o semitransparente? */
export function hasTransparency(image: Pixels): boolean {
  const { data } = image;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

/**
 * Estadísticas para «Mejorar automáticamente». En fotos grandes se mira una
 * muestra (como mucho ~250 000 píxeles): el resultado apenas cambia y es
 * inmediato. Los píxeles transparentes no cuentan.
 */
export function analyzeImage(image: Pixels): ImageStats {
  const { data, width, height } = image;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 250_000)));
  const histogram = new Uint32Array(256);
  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;
  let sumLuma = 0;
  let detail = 0;
  let detailCount = 0;
  let transparent = false;
  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return luma(data[i]!, data[i + 1]!, data[i + 2]!);
  };
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = data[i + 3]!;
      if (a < 255) transparent = true;
      if (a < 128) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const l = luma(r, g, b);
      histogram[Math.round(l)]! += 1;
      sumLuma += l;
      sumR += r;
      sumG += g;
      sumB += b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      sumSat += max === 0 ? 0 : (max - min) / max;
      count += 1;
      if (x > 0 && y > 0 && x < width - 1 && y < height - 1) {
        detail += Math.abs(4 * l - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1));
        detailCount += 1;
      }
    }
  }
  if (!transparent) transparent = hasTransparency(image);
  if (count === 0) {
    return { black: 0, white: 255, meanLuma: 128, mean: [128, 128, 128], saturation: 0, detail: 0, transparent };
  }
  const percentile = (fraction: number) => {
    const target = count * fraction;
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += histogram[v]!;
      if (seen >= target) return v;
    }
    return 255;
  };
  return {
    black: percentile(0.005),
    white: percentile(0.995),
    meanLuma: sumLuma / count,
    mean: [sumR / count, sumG / count, sumB / count],
    saturation: sumSat / count,
    detail: detailCount ? detail / detailCount : 0,
    transparent,
  };
}

/**
 * «Mejorar automáticamente»: ajustes moderados a partir de las estadísticas.
 * Estira el histograma si no llega a negro y blanco, corrige la mitad de la
 * dominante de color (mundo gris), aclara las fotos oscuras, aviva un poco las
 * apagadas y da algo de nitidez a las blandas. Nada de esto inventa contenido.
 */
export function autoAdjustments(stats: ImageStats): Adjustments {
  const range = stats.white - stats.black;
  const levels = range < 220 && range > 20 ? { black: stats.black, white: stats.white } : null;
  const gray = (stats.mean[0] + stats.mean[1] + stats.mean[2]) / 3;
  const gain = (channel: number) => (channel <= 0 ? 1 : clamp(1 + (gray / channel - 1) * 0.5, 0.85, 1.18));
  const balance: [number, number, number] = [gain(stats.mean[0]), gain(stats.mean[1]), gain(stats.mean[2])];
  // Luminancia media tras estirar, para no aclarar dos veces.
  const stretched = levels ? ((stats.meanLuma - levels.black) * 255) / (levels.white - levels.black) : stats.meanLuma;
  const exposure = stretched < 95 ? Math.round(clamp((110 - stretched) / 2, 0, 25)) : stretched > 175 ? -8 : 0;
  const saturation = stats.saturation < 0.18 ? 15 : stats.saturation < 0.3 ? 8 : 0;
  const sharpness = stats.detail < 6 ? 35 : stats.detail < 12 ? 20 : 10;
  return {
    exposure,
    contrast: levels ? 0 : 6,
    saturation,
    warmth: 0,
    sharpness,
    levels,
    balance: balance.map((g) => Math.round(g * 1000) / 1000) as [number, number, number],
  };
}

/** ¿Los ajustes cambian algo? */
export function isNeutral(adjustments: Adjustments): boolean {
  return (
    adjustments.exposure === 0 &&
    adjustments.contrast === 0 &&
    adjustments.saturation === 0 &&
    adjustments.warmth === 0 &&
    adjustments.sharpness === 0 &&
    adjustments.levels === null &&
    adjustments.balance.every((g) => g === 1)
  );
}

/**
 * Tabla de cada canal (niveles, balance, exposición, contraste) para no
 * repetir la cuenta en cada píxel.
 */
function channelTable(adjustments: Adjustments, channel: 0 | 1 | 2): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256);
  const { levels } = adjustments;
  const c = clamp(adjustments.contrast, -100, 100) * 1.28;
  const contrast = (259 * (c + 255)) / (255 * (259 - c));
  const exposure = Math.pow(2, clamp(adjustments.exposure, -100, 100) / 100);
  const warm = clamp(adjustments.warmth, -100, 100) * 0.25;
  const shift = channel === 0 ? warm : channel === 2 ? -warm : 0;
  for (let v = 0; v < 256; v += 1) {
    // Primero el balance (sobre el color tal cual) y después los niveles.
    let x = v * adjustments.balance[channel];
    x = levels ? ((x - levels.black) * 255) / Math.max(1, levels.white - levels.black) : x;
    x = x * exposure;
    x = contrast * (x - 128) + 128;
    table[v] = clampByte(x + shift);
  }
  return table;
}

/** Desenfoque de caja 3×3 de la luminancia (para la máscara de enfoque). */
function blurredLuma(source: Uint8ClampedArray, width: number, height: number): Float32Array {
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; p < lum.length; i += 4, p += 1) lum[p] = luma(source[i]!, source[i + 1]!, source[i + 2]!);
  const horizontal = new Float32Array(lum.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = lum[row + Math.max(0, x - 1)]!;
      const right = lum[row + Math.min(width - 1, x + 1)]!;
      horizontal[row + x] = (left + lum[row + x]! + right) / 3;
    }
  }
  const out = new Float32Array(lum.length);
  for (let y = 0; y < height; y += 1) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x += 1)
      out[row + x] = (horizontal[up + x]! + horizontal[row + x]! + horizontal[down + x]!) / 3;
  }
  return out;
}

/** Aplica los ajustes y devuelve una imagen NUEVA del mismo tamaño (la de entrada no cambia). */
export function applyAdjustments(image: Pixels, adjustments: Adjustments): Pixels {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  const tables = [channelTable(adjustments, 0), channelTable(adjustments, 1), channelTable(adjustments, 2)] as const;
  const saturation = 1 + clamp(adjustments.saturation, -100, 100) / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = tables[0][data[i]!]!;
    let g = tables[1][data[i + 1]!]!;
    let b = tables[2][data[i + 2]!]!;
    if (saturation !== 1) {
      const l = luma(r, g, b);
      r = l + (r - l) * saturation;
      g = l + (g - l) * saturation;
      b = l + (b - l) * saturation;
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = data[i + 3]!;
  }
  const amount = (clamp(adjustments.sharpness, 0, 100) / 100) * 1.2;
  if (amount > 0 && width * height > 1) {
    // Máscara de enfoque sobre la luminancia: suma el detalle sin cambiar el color.
    const blur = blurredLuma(out, width, height);
    for (let i = 0, p = 0; i < out.length; i += 4, p += 1) {
      const l = luma(out[i]!, out[i + 1]!, out[i + 2]!);
      const delta = (l - blur[p]!) * amount;
      out[i] = out[i]! + delta;
      out[i + 1] = out[i + 1]! + delta;
      out[i + 2] = out[i + 2]! + delta;
    }
  }
  return { data: out, width, height };
}

/** Fondo para una foto recortada (con transparencia): un color liso o una imagen del mismo tamaño. */
export type Backdrop = { kind: 'color'; hex: string } | { kind: 'image'; pixels: Pixels };

export function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Pone la foto encima de un fondo (mezcla «normal» con su alfa). El resultado
 * es opaco. La imagen de fondo tiene que tener el mismo tamaño que la foto
 * (quien llama la ha encajado antes).
 */
export function compositeOver(foreground: Pixels, backdrop: Backdrop): Pixels {
  const { data, width, height } = foreground;
  const out = new Uint8ClampedArray(data.length);
  let color: [number, number, number] | null = null;
  if (backdrop.kind === 'color') {
    color = parseHex(backdrop.hex);
    if (!color) throw new Error('Color de fondo no válido');
  } else if (backdrop.pixels.width !== width || backdrop.pixels.height !== height) {
    throw new Error('El fondo debe tener el tamaño de la foto');
  }
  const bg = backdrop.kind === 'image' ? backdrop.pixels.data : null;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    const br = color ? color[0] : bg![i]!;
    const bgG = color ? color[1] : bg![i + 1]!;
    const bb = color ? color[2] : bg![i + 2]!;
    out[i] = data[i]! * a + br * (1 - a);
    out[i + 1] = data[i + 1]! * a + bgG * (1 - a);
    out[i + 2] = data[i + 2]! * a + bb * (1 - a);
    out[i + 3] = 255;
  }
  return { data: out, width, height };
}

/** Recorta una zona (en píxeles enteros) y devuelve una imagen nueva. */
export function cropPixels(image: Pixels, box: { x: number; y: number; width: number; height: number }): Pixels {
  const x0 = clamp(Math.round(box.x), 0, image.width - 1);
  const y0 = clamp(Math.round(box.y), 0, image.height - 1);
  const w = clamp(Math.round(box.width), 1, image.width - x0);
  const h = clamp(Math.round(box.height), 1, image.height - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4;
    out.set(image.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Reduce unos píxeles (para la vista previa): vecino más próximo, suficiente para ver el efecto. */
export function downscale(pixels: Pixels, maxSide: number): Pixels {
  const scale = Math.min(1, maxSide / Math.max(pixels.width, pixels.height));
  if (scale === 1) return pixels;
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(pixels.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(pixels.width - 1, Math.floor(x / scale));
      const from = (sy * pixels.width + sx) * 4;
      out.set(pixels.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data: out, width, height };
}
