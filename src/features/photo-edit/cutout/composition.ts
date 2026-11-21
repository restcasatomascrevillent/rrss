// Poner un recorte (foto con transparencia) sobre un fondo, con una sombra suave
// opcional para que el sujeto no parezca flotar. Funciones puras sobre `Pixels`:
// no dibujan ni leen nada, así se prueban sin navegador. El resultado tiene
// SIEMPRE el tamaño del recorte y es opaco; la entrada no se modifica.
import { compositeOver, parseHex, type Backdrop, type Pixels } from '../pixels';
import { resizeChannel } from './mask';

export interface ShadowOptions {
  /** Cuánto se desplaza hacia abajo, como fracción del alto (por defecto 0,02). */
  offset?: number;
  /** Radio del desenfoque, como fracción del lado menor (por defecto 0,02). */
  blur?: number;
  /** Opacidad máxima de la sombra, 0–1 (por defecto 0,35). */
  opacity?: number;
}

export interface CompositionOptions {
  /** `true` o ajustes propios: sombra suave bajo el sujeto. */
  shadow?: boolean | ShadowOptions;
}

const DEFAULT_SHADOW = { offset: 0.02, blur: 0.02, opacity: 0.35 };
const SHADOW_WORK_SIDE = 640;

/** Desenfoque de caja separable (tres pasadas ≈ gaussiana) de un canal. */
export function boxBlur(channel: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return channel;
  let src = channel;
  const tmp = new Float32Array(channel.length);
  for (let pass = 0; pass < 3; pass += 1) {
    // Horizontal: src → tmp
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let x = -r; x <= r; x += 1) sum += src[row + Math.min(width - 1, Math.max(0, x))]!;
      for (let x = 0; x < width; x += 1) {
        tmp[row + x] = sum / (2 * r + 1);
        sum += src[row + Math.min(width - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
      }
    }
    // Vertical: tmp → out
    const out = new Float32Array(channel.length);
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -r; y <= r; y += 1) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x]!;
      for (let y = 0; y < height; y += 1) {
        out[y * width + x] = sum / (2 * r + 1);
        sum += tmp[Math.min(height - 1, y + r + 1) * width + x]! - tmp[Math.max(0, y - r) * width + x]!;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Sombra del sujeto: su silueta (el alfa) desplazada hacia abajo y desenfocada,
 * a tamaño completo, con valores 0–1 ya multiplicados por la opacidad. Se calcula
 * en una versión reducida (la sombra es borrosa, no pierde nada) y se amplía.
 */
export function shadowAlpha(foreground: Pixels, options: ShadowOptions = {}): Float32Array {
  const { width, height } = foreground;
  const opts = { ...DEFAULT_SHADOW, ...options };
  const scale = Math.min(1, SHADOW_WORK_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = foreground.data[i * 4 + 3]! / 255;
  const small = scale === 1 ? alpha : resizeChannel(alpha, width, height, w, h);
  const dy = Math.round(opts.offset * h);
  const shifted = new Float32Array(w * h);
  for (let y = dy; y < h; y += 1) shifted.set(small.subarray((y - dy) * w, (y - dy + 1) * w), y * w);
  const blurred = boxBlur(shifted, w, h, (opts.blur * Math.min(w, h)) / 2);
  const full = scale === 1 ? blurred : resizeChannel(blurred, w, h, width, height);
  for (let i = 0; i < full.length; i += 1) full[i] = Math.min(1, Math.max(0, full[i]!)) * opts.opacity;
  return full;
}

/** Fondo ya del tamaño del recorte: el color liso, o la imagen elegida. */
function baseBackdrop(foreground: Pixels, backdrop: Backdrop): Pixels {
  const { width, height } = foreground;
  if (backdrop.kind === 'image') {
    if (backdrop.pixels.width !== width || backdrop.pixels.height !== height) {
      throw new Error('El fondo debe tener el tamaño de la foto');
    }
    return { data: new Uint8ClampedArray(backdrop.pixels.data), width, height };
  }
  const color = parseHex(backdrop.hex);
  if (!color) throw new Error('Color de fondo no válido');
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([color[0], color[1], color[2], 255], i);
  return { data, width, height };
}

/**
 * Recorte sobre un fondo liso, de color o una imagen del mismo tamaño, con
 * sombra opcional. Sin sombra es exactamente `compositeOver`.
 */
export function composeCutout(foreground: Pixels, backdrop: Backdrop, options: CompositionOptions = {}): Pixels {
  if (!options.shadow) return compositeOver(foreground, backdrop);
  const base = baseBackdrop(foreground, backdrop);
  const shadow = shadowAlpha(foreground, options.shadow === true ? {} : options.shadow);
  for (let i = 0; i < shadow.length; i += 1) {
    const k = 1 - shadow[i]!; // la sombra es negra: oscurece el fondo
    base.data[i * 4] = base.data[i * 4]! * k;
    base.data[i * 4 + 1] = base.data[i * 4 + 1]! * k;
    base.data[i * 4 + 2] = base.data[i * 4 + 2]! * k;
  }
  return compositeOver(foreground, { kind: 'image', pixels: base });
}
