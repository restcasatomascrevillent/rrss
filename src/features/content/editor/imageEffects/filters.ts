// Luz, color y filtros rápidos de una foto del diseño. Traduce los ajustes de la
// capa (brillo, contraste, saturación, temperatura, nitidez y filtro) a los de
// `photo-edit/pixels.ts`, el mismo cálculo de «Editar foto» de la biblioteca, y
// añade los pocos filtros que necesitan un paso más. Todo son funciones puras
// sobre píxeles: se prueban sin navegador.
import type { ImageAdjust, ImageFilter } from '../../document';
import { applyAdjustments, NEUTRAL_ADJUSTMENTS, type Adjustments, type Pixels } from '@/features/photo-edit/pixels';

export const FILTER_LABEL: Record<ImageFilter, string> = {
  bw: 'Blanco y negro',
  sepia: 'Sepia',
  vivid: 'Vivo',
  warm: 'Cálido',
  cool: 'Frío',
  fade: 'Desvaído',
  drama: 'Dramático',
};

/** Paso extra de un filtro, después de los deslizadores. */
export type PostStep = 'sepia' | 'fade';

interface Recipe {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  sharpness?: number;
  post?: PostStep;
}

const RECIPES: Record<ImageFilter, Recipe> = {
  bw: { saturation: -100, contrast: 8 },
  sepia: { saturation: -100, post: 'sepia' },
  vivid: { saturation: 35, contrast: 12 },
  warm: { temperature: 32, saturation: 8 },
  cool: { temperature: -32, saturation: -4 },
  fade: { contrast: -18, brightness: 6, saturation: -22, post: 'fade' },
  drama: { contrast: 30, saturation: -12, brightness: -8, sharpness: 30 },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Los deslizadores de la capa más lo que pone el filtro, en el formato de
 * `applyAdjustments`. La luz es el brillo; la temperatura, el calor.
 */
export function resolveAdjust(adjust: ImageAdjust): { adjustments: Adjustments; post: PostStep | null } {
  const recipe = adjust.filter ? RECIPES[adjust.filter] : {};
  return {
    adjustments: {
      ...NEUTRAL_ADJUSTMENTS,
      exposure: clamp(adjust.brightness + (recipe.brightness ?? 0), -100, 100),
      contrast: clamp(adjust.contrast + (recipe.contrast ?? 0), -100, 100),
      saturation: clamp(adjust.saturation + (recipe.saturation ?? 0), -100, 100),
      warmth: clamp(adjust.temperature + (recipe.temperature ?? 0), -100, 100),
      sharpness: clamp(adjust.sharpness + (recipe.sharpness ?? 0), 0, 100),
    },
    post: recipe.post ?? null,
  };
}

/** Paso final de algunos filtros: tinte sepia (sobre la luminancia) o negros levantados. Devuelve una imagen nueva. */
export function applyPost(image: Pixels, step: PostStep): Pixels {
  const out = new Uint8ClampedArray(image.data);
  for (let i = 0; i < out.length; i += 4) {
    const l = 0.2126 * out[i]! + 0.7152 * out[i + 1]! + 0.0722 * out[i + 2]!;
    if (step === 'sepia') {
      out[i] = l * 1.07 + 8;
      out[i + 1] = l * 0.95 + 4;
      out[i + 2] = l * 0.74;
    } else {
      // Negros levantados y blancos algo bajados: aspecto de copia antigua.
      out[i] = out[i]! * 0.88 + 26;
      out[i + 1] = out[i + 1]! * 0.88 + 26;
      out[i + 2] = out[i + 2]! * 0.88 + 28;
    }
  }
  return { data: out, width: image.width, height: image.height };
}

/** Aplica los ajustes de la capa a unos píxeles y devuelve otros nuevos (los de entrada no cambian). */
export function adjustPixels(image: Pixels, adjust: ImageAdjust): Pixels {
  const { adjustments, post } = resolveAdjust(adjust);
  const adjusted = applyAdjustments(image, adjustments);
  return post ? applyPost(adjusted, post) : adjusted;
}
