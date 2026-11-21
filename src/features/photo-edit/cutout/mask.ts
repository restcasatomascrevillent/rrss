// Matemática pura del recorte en el navegador: de la foto a la entrada del
// modelo, y de la máscara del modelo al canal alfa de la foto. Sin DOM ni
// onnxruntime, para probarla con vitest. Nunca modifica la imagen de entrada.
import type { Pixels } from '../pixels';
import { MODEL_SIDE } from './model';

/** Ninguna parte de la foto se ha reconocido como sujeto. */
export class NoSubjectError extends Error {
  constructor() {
    super('No se ha encontrado nada que recortar en la foto.');
    this.name = 'NoSubjectError';
  }
}

/** Interpolación bilinear de un solo canal (0–255 o float) a otro tamaño. */
export function resizeChannel(
  source: ArrayLike<number>,
  width: number,
  height: number,
  toWidth: number,
  toHeight: number,
): Float32Array {
  const out = new Float32Array(toWidth * toHeight);
  const sx = width / toWidth;
  const sy = height / toHeight;
  for (let y = 0; y < toHeight; y += 1) {
    const fy = Math.max(0, Math.min(height - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < toWidth; x += 1) {
      const fx = Math.max(0, Math.min(width - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      const top = source[y0 * width + x0]! * (1 - wx) + source[y0 * width + x1]! * wx;
      const bottom = source[y1 * width + x0]! * (1 - wx) + source[y1 * width + x1]! * wx;
      out[y * toWidth + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/**
 * Foto → tensor CHW float32 de 1×3×lado×lado, como espera IS-Net (el mismo
 * preproceso que rembg): se encaja la foto, deformándola, a lado × lado, se
 * divide entre el valor máximo y se resta 0,5. El alfa se ignora (sobre blanco
 * si la foto ya tenía transparencia).
 */
export function toModelInput(image: Pixels, side = MODEL_SIDE): Float32Array {
  const n = side * side;
  const planes: Float32Array[] = [];
  for (let c = 0; c < 3; c += 1) {
    const channel = new Float32Array(image.width * image.height);
    for (let i = 0; i < channel.length; i += 1) {
      const a = image.data[i * 4 + 3]! / 255;
      channel[i] = image.data[i * 4 + c]! * a + 255 * (1 - a);
    }
    planes[c] = resizeChannel(channel, image.width, image.height, side, side);
  }
  let max = 0;
  for (const plane of planes) for (let i = 0; i < n; i += 1) if (plane[i]! > max) max = plane[i]!;
  const divisor = Math.max(max, 1e-6);
  const tensor = new Float32Array(3 * n);
  for (let c = 0; c < 3; c += 1) {
    const plane = planes[c]!;
    for (let i = 0; i < n; i += 1) tensor[c * n + i] = plane[i]! / divisor - 0.5;
  }
  return tensor;
}

/** Salida del modelo (cualquier rango) → 0–255 normalizada entre su mínimo y su máximo. */
export function normalizeMask(prediction: ArrayLike<number>): Uint8Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < prediction.length; i += 1) {
    const v = prediction[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Uint8Array(prediction.length);
  const range = max - min;
  if (!(range > 0)) return out;
  for (let i = 0; i < prediction.length; i += 1) out[i] = Math.floor(((prediction[i]! - min) / range) * 255);
  return out;
}

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Fracción mínima de la foto que tiene que ser sujeto para dar el recorte por bueno. */
export const MIN_SUBJECT_FRACTION = 0.005;

/**
 * Pone la máscara del modelo como alfa de la foto. La máscara se escala (bilinear)
 * al tamaño de la foto y se endurece un poco con una curva suave (el modelo da
 * bordes borrosos): por debajo de ~0,25 es fondo y por encima de ~0,75 es sujeto,
 * con degradado entre medias para no dejar escalera. Si la foto ya tenía algo
 * de transparencia, se multiplica. Devuelve una imagen nueva.
 */
export function applyMask(image: Pixels, mask: ArrayLike<number>, maskSide = MODEL_SIDE): Pixels {
  const scaled = resizeChannel(mask, maskSide, maskSide, image.width, image.height);
  const out = new Uint8ClampedArray(image.data);
  let opaque = 0;
  for (let i = 0; i < scaled.length; i += 1) {
    const alpha = smoothstep(0.25, 0.75, scaled[i]! / 255);
    if (alpha > 0.5) opaque += 1;
    out[i * 4 + 3] = Math.round(out[i * 4 + 3]! * alpha);
  }
  if (opaque < scaled.length * MIN_SUBJECT_FRACTION) throw new NoSubjectError();
  return { data: out, width: image.width, height: image.height };
}
