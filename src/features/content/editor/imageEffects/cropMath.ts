// Cuentas del recorte que se hace arrastrando sobre la foto. Todo en fracciones
// de la foto (0–1); puras, sin dibujar nada.
import { MIN_CROP_SIDE, type ImageCrop } from '../../document';
import { clampCrop } from './imageEdit';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Mueve un recorte sin sacarlo de la foto. `dx` y `dy` son fracciones de la foto. */
export function moveCrop(crop: ImageCrop, dx: number, dy: number): ImageCrop {
  return clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy });
}

/**
 * Cambia el tamaño de un recorte arrastrando una esquina: la esquina contraria
 * (`anchor`) se queda quieta y la que se arrastra sigue al puntero (`pointer`),
 * dentro de la foto. Con `ratio` (ancho / alto en píxeles) se conserva la proporción.
 */
export function resizeCrop(
  anchor: { x: number; y: number },
  pointer: { x: number; y: number },
  frame: { width: number; height: number },
  ratio: number | null,
): ImageCrop {
  const sx = pointer.x >= anchor.x ? 1 : -1;
  const sy = pointer.y >= anchor.y ? 1 : -1;
  const maxW = sx > 0 ? 1 - anchor.x : anchor.x;
  const maxH = sy > 0 ? 1 - anchor.y : anchor.y;
  let width = clamp(Math.abs(pointer.x - anchor.x), MIN_CROP_SIDE, Math.max(MIN_CROP_SIDE, maxW));
  let height = clamp(Math.abs(pointer.y - anchor.y), MIN_CROP_SIDE, Math.max(MIN_CROP_SIDE, maxH));
  if (ratio) {
    const wanted = (width * frame.width) / (ratio * frame.height);
    if (wanted > maxH) {
      height = maxH;
      width = (height * ratio * frame.height) / frame.width;
    } else {
      height = Math.max(MIN_CROP_SIDE, wanted);
    }
  }
  return clampCrop({
    x: sx > 0 ? anchor.x : anchor.x - width,
    y: sy > 0 ? anchor.y : anchor.y - height,
    width,
    height,
  });
}

/**
 * Caja más grande de la proporción `ratio` (ancho / alto) que cabe dentro de
 * `box`, con el mismo centro. Si ya tiene esa proporción (con un 1 % de margen),
 * se devuelve igual.
 */
export function fitBoxAround(
  box: { x: number; y: number; width: number; height: number },
  ratio: number,
): { x: number; y: number; width: number; height: number } {
  const current = box.width / box.height;
  if (Math.abs(current - ratio) / ratio < 0.01) return box;
  const width = ratio >= current ? box.width : box.height * ratio;
  const height = ratio >= current ? box.width / ratio : box.height;
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}
