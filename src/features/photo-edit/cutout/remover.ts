// Punto único para quitar el fondo de una foto en el navegador: foto → la misma
// foto con el fondo transparente. Todo lo que necesite un recorte (el diálogo
// «Editar foto» y el panel de fotos del editor) pasa por aquí, así el motor
// (hoy IS-Net, ver engine.ts) se puede cambiar sin tocar a quien lo usa.
import type { Pixels } from '../pixels';
import {
  cutoutSupport,
  describeCutoutError,
  removeBackgroundInBrowser,
  type CutoutProgress,
  type CutoutSupport,
} from './engine';

export interface BackgroundRemoval {
  /** Misma foto con el fondo transparente (mismas medidas que la entrada). */
  pixels: Pixels;
  /** Nombre del motor, para la procedencia del resultado. */
  model: string;
}

/** ¿Puede este navegador quitar el fondo? Si no, el botón no sale. */
export function removalSupport(): CutoutSupport {
  return cutoutSupport();
}

export function canRemoveBackground(): boolean {
  return cutoutSupport().ok;
}

export function describeRemovalError(error: unknown): string {
  return describeCutoutError(error);
}

export async function removeBackground(
  image: Pixels,
  onProgress?: (progress: CutoutProgress) => void,
): Promise<BackgroundRemoval> {
  const result = await removeBackgroundInBrowser(image, onProgress);
  return { pixels: result.pixels, model: result.model };
}

export type { CutoutProgress };
