// El plato en una edición con IA (docs/edicion-fotos.md, §9). Funciones puras
// sobre `Pixels`, sin DOM ni modelo, para probarlas con vitest:
//
//   subjectMaskPixels  recorte → máscara que se manda a OpenAI
//   restorePlate       resultado de la IA + foto original + recorte → el plato original vuelto a pegar
//
// Convenio de la máscara (el que espera el adaptador de OpenAI,
// `supabase/functions/_shared/ai/media/openai-image.ts` y `ImageEditRequest.subjectMask`):
// PNG RGBA con las medidas EXACTAS de la foto original; el plato es OPACO
// (alfa 255) y el fondo TRANSPARENTE (alfa 0). OpenAI repinta solo lo
// transparente. Sin grises en el alfa: el borde es duro (el suavizado se aplica
// al volver a pegar el plato, no a la máscara).
import type { Pixels } from '../pixels';
import { boxBlur } from './composition';

/** Alfa del recorte (0–255), un valor por píxel. */
export function alphaOf(cutout: Pixels): Uint8Array {
  const out = new Uint8Array(cutout.width * cutout.height);
  for (let i = 0; i < out.length; i += 1) out[i] = cutout.data[i * 4 + 3]!;
  return out;
}

/** Muestra bilineal de un canal 0–255 con coordenadas de píxel centradas. */
function sampler(width: number, height: number, read: (index: number) => number) {
  return (fx: number, fy: number) => {
    const x = Math.max(0, Math.min(width - 1, fx));
    const y = Math.max(0, Math.min(height - 1, fy));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const wx = x - x0;
    const wy = y - y0;
    const top = read(y0 * width + x0) * (1 - wx) + read(y0 * width + x1) * wx;
    const bottom = read(y1 * width + x0) * (1 - wx) + read(y1 * width + x1) * wx;
    return top * (1 - wy) + bottom * wy;
  };
}

/** Alfa 0–255 escalado (bilineal) a otro tamaño. */
export function resizeAlpha(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  toWidth: number,
  toHeight: number,
): Float32Array {
  const at = sampler(width, height, (i) => alpha[i]!);
  const out = new Float32Array(toWidth * toHeight);
  for (let y = 0; y < toHeight; y += 1) {
    const fy = (y + 0.5) * (height / toHeight) - 0.5;
    for (let x = 0; x < toWidth; x += 1) out[y * toWidth + x] = at((x + 0.5) * (width / toWidth) - 0.5, fy);
  }
  return out;
}

/**
 * Máscara para la IA: PNG RGBA de `width × height` (las medidas de la foto
 * original) con el plato opaco y el fondo transparente. `alpha` es el alfa del
 * recorte (a las medidas con que se recortó, que pueden ser menores que las de
 * la foto si era enorme); se escala y se endurece a 0 o 255.
 */
export function subjectMaskPixels(
  alpha: ArrayLike<number>,
  alphaWidth: number,
  alphaHeight: number,
  width: number,
  height: number,
): Pixels {
  const at = sampler(alphaWidth, alphaHeight, (i) => alpha[i]!);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const fy = (y + 0.5) * (alphaHeight / height) - 0.5;
    for (let x = 0; x < width; x += 1) {
      data[(y * width + x) * 4 + 3] = at((x + 0.5) * (alphaWidth / width) - 0.5, fy) >= 128 ? 255 : 0;
    }
  }
  return { data, width, height };
}

/** Diferencia máxima de proporción entre el resultado de la IA y la foto para poder volver a pegar el plato. */
export const MAX_ASPECT_DRIFT = 0.03;

export interface RestorePlateOptions {
  /** Radio del suavizado del borde, como fracción del lado menor (por defecto 0,004). */
  feather?: number;
}

/** ¿Tienen resultado y foto la misma proporción (dentro de lo que redondea la IA)? */
export function sameAspect(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width / a.height / (b.width / b.height) - 1) <= MAX_ASPECT_DRIFT;
}

/**
 * Vuelve a pegar el plato ORIGINAL sobre el resultado de la IA. El original y
 * su alfa se escalan (bilineal) al tamaño del resultado, el alfa se suaviza un
 * poco para que el borde no se note y se mezcla: donde el alfa es 1 queda el
 * original, donde es 0, la IA. Devuelve una imagen nueva, opaca y con las
 * medidas del resultado; ninguna entrada se modifica.
 */
export function restorePlate(
  result: Pixels,
  original: Pixels,
  subjectAlpha: ArrayLike<number>,
  options: RestorePlateOptions = {},
): Pixels {
  if (!sameAspect(result, original)) {
    throw new Error('El resultado de la IA no tiene la proporción de la foto: no se puede pegar el plato.');
  }
  const { width, height } = result;
  const alpha = resizeAlpha(subjectAlpha, original.width, original.height, width, height);
  const radius = Math.max(1, Math.round((options.feather ?? 0.004) * Math.min(width, height)));
  const soft = boxBlur(alpha, width, height, radius);
  const reads = [0, 1, 2].map((c) => sampler(original.width, original.height, (i) => original.data[i * 4 + c]!));
  const out = new Uint8ClampedArray(result.data);
  for (let y = 0; y < height; y += 1) {
    const fy = (y + 0.5) * (original.height / height) - 0.5;
    for (let x = 0; x < width; x += 1) {
      const k = Math.min(1, Math.max(0, soft[y * width + x]! / 255));
      if (k === 0) continue;
      const fx = (x + 0.5) * (original.width / width) - 0.5;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) out[i + c] = reads[c]!(fx, fy) * k + result.data[i + c]! * (1 - k);
      out[i + 3] = 255;
    }
  }
  return { data: out, width, height };
}
