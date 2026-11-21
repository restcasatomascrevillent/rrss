// Prepara una foto del diseño ya editada (girada, volteada, enderezada,
// recortada y con luz y color) como un lienzo listo para dibujar. Lo usan el
// lienzo del editor y la exportación: es el MISMO código, así lo que se ve es lo
// que sale. En una sola pasada se hace la geometría (una transformación y un
// recorte) y después se aplican los ajustes de color a los píxeles.
import { adjustPixels } from './filters';
import { editNeedsPixels, planBitmap, type ImageEdit } from './imageEdit';

/** Lado mayor de la foto preparada para el editor (se ve en pantalla: no hace falta más). */
export const EDITOR_BITMAP_SIDE = 1280;
/** Lado mayor para exportar (una pieza llega a 2160 px). */
export const EXPORT_BITMAP_SIDE = 2400;

export type Source = HTMLImageElement | HTMLCanvasElement;

export const sourceSize = (source: Source) =>
  source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };

type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

const defaultCanvas: CanvasFactory = (width, height) => {
  const canvas = window.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * Foto con la edición aplicada. Lanza si el navegador no deja leer los
 * píxeles (foto de otro origen sin permiso) y hacen falta para la luz y el
 * color; quien llama entonces dibuja la foto sin editar.
 */
export function prepareBitmap(
  source: Source,
  edit: ImageEdit | null,
  maxSide: number,
  createCanvas: CanvasFactory = defaultCanvas,
): HTMLCanvasElement {
  const natural = sourceSize(source);
  const plan = planBitmap(natural.width, natural.height, edit, maxSide);
  const canvas = createCanvas(plan.crop.width, plan.crop.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('El navegador no puede preparar la foto');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  // Una sola transformación: lleva el centro de la foto al centro del cuadro
  // (restando el recorte), la endereza y amplía lo justo, voltea y la gira de 90 en 90.
  context.translate(-plan.crop.x, -plan.crop.y);
  context.translate(plan.frame.width / 2, plan.frame.height / 2);
  if (edit?.straighten) {
    context.rotate((edit.straighten * Math.PI) / 180);
    context.scale(plan.straightenScale, plan.straightenScale);
  }
  context.scale(edit?.flipX ? -1 : 1, edit?.flipY ? -1 : 1);
  if (edit?.turn) context.rotate((edit.turn * Math.PI) / 180);
  const width = natural.width * plan.scale;
  const height = natural.height * plan.scale;
  context.drawImage(source, -width / 2, -height / 2, width, height);

  if (editNeedsPixels(edit) && edit?.adjust) {
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    const adjusted = adjustPixels({ data: data.data, width: data.width, height: data.height }, edit.adjust);
    data.data.set(adjusted.data);
    context.putImageData(data, 0, 0);
  }
  return canvas;
}

/**
 * Caché pequeña de fotos preparadas (por dirección + edición + tamaño). Guarda
 * las últimas, que son las que se están tocando.
 */
export class BitmapCache {
  private readonly entries = new Map<string, HTMLCanvasElement>();

  constructor(private readonly limit = 12) {}

  get(key: string): HTMLCanvasElement | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, canvas: HTMLCanvasElement): void {
    this.entries.set(key, canvas);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
