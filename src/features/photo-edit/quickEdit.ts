// Ediciones de fondo que hacen un archivo nuevo, para el panel de fotos del
// editor: quitar el fondo y poner la propia foto desenfocada detrás. Cada
// resultado es un recurso NUEVO de la biblioteca (la original no se toca) y se
// guarda con su procedencia, igual que en «Editar foto».
import type { MediaAssetRow } from '@/lib/database.types';
import type { SaveEditInput } from './api';
import { encodePixels, loadPixels } from './canvas';
import { boxBlur, composeCutout } from './cutout/composition';
import { removeBackground, type CutoutProgress } from './cutout/remover';
import { editedFileName, photoEditProvenance, type PhotoEditStep } from './provenance';
import { analyzeImage, type Pixels } from './pixels';

/** Desenfoca los colores de una foto (el alfa no cambia). `radius` en píxeles. Devuelve otra foto. */
export function blurPixels(image: Pixels, radius: number): Pixels {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  for (let channel = 0; channel < 3; channel += 1) {
    const plane = new Float32Array(width * height);
    for (let p = 0; p < plane.length; p += 1) plane[p] = data[p * 4 + channel]!;
    const blurred = boxBlur(plane, width, height, radius);
    for (let p = 0; p < blurred.length; p += 1) out[p * 4 + channel] = blurred[p]!;
  }
  return { data: out, width, height };
}

/** Radio del desenfoque (px) para una intensidad de 1 a 100: hasta el 4 % del lado mayor. */
export function backgroundBlurRadius(image: Pixels, amount: number): number {
  return (Math.min(100, Math.max(1, amount)) / 100) * 0.04 * Math.max(image.width, image.height);
}

export type QuickEdit =
  | { kind: 'cutout' }
  | { kind: 'blur_background'; amount: number; shadow: boolean };

type Saver = (input: SaveEditInput) => Promise<MediaAssetRow>;

/**
 * Quita el fondo (o lo desenfoca, dejando el plato nítido) y guarda el
 * resultado en la biblioteca. Devuelve el recurso nuevo.
 */
export async function runQuickEdit(options: {
  asset: MediaAssetRow;
  url: string;
  edit: QuickEdit;
  save: Saver;
  onProgress?: (progress: CutoutProgress) => void;
}): Promise<MediaAssetRow> {
  const { asset, url, edit, save, onProgress } = options;
  const { pixels } = await loadPixels(url);
  const cut = await removeBackground(pixels, onProgress);
  let result = cut.pixels;
  const steps: PhotoEditStep[] = [{ kind: 'remove_background', engine: 'browser', model: cut.model }];
  if (edit.kind === 'blur_background') {
    const backdrop = blurPixels(pixels, backgroundBlurRadius(pixels, edit.amount));
    result = composeCutout(cut.pixels, { kind: 'image', pixels: backdrop }, { shadow: edit.shadow });
    steps.push({ kind: 'blur_background', amount: Math.round(edit.amount), ...(edit.shadow ? { shadow: true } : {}) });
  }
  const transparent = analyzeImage(result).transparent;
  const png = transparent || asset.mime_type === 'image/png';
  const blob = await encodePixels(result, png ? 'image/png' : 'image/jpeg');
  return save({
    source: asset,
    blob,
    fileName: editedFileName(asset.file_name, steps, png ? 'png' : 'jpg'),
    width: result.width,
    height: result.height,
    provenance: photoEditProvenance({ sourceAssetId: asset.id, steps, width: result.width, height: result.height }),
  });
}
