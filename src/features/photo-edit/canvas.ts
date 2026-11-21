// Lectura y escritura de píxeles con el lienzo del navegador. Es la única
// parte de la edición de fotos que necesita un navegador de verdad (jsdom no
// dibuja): las pruebas de componentes la sustituyen, y la lógica de verdad
// (pixels.ts, framing.ts) se prueba aparte.
import { loadCorsImage } from '../../lib/corsImage';
import type { Pixels } from './pixels';

/** Tope de lo que se edita en el navegador: 24 MP (6000 × 4000). Lo mayor se reduce y se avisa. */
export const MAX_EDIT_PIXELS = 24_000_000;

export class PhotoLoadError extends Error {
  constructor(
    message: string,
    readonly reason: 'load' | 'tainted' | 'canvas',
  ) {
    super(message);
    this.name = 'PhotoLoadError';
  }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  // Con `fetch` sin caché y no con `crossOrigin` directo: la miniatura de la
  // biblioteca deja en caché la misma URL sin cabeceras CORS (ver lib/corsImage).
  try {
    return await loadCorsImage(url);
  } catch {
    throw new PhotoLoadError(
      'No se ha podido cargar la foto. Cierra y vuelve a abrirla (el enlace caduca en 1 h).',
      'load',
    );
  }
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new PhotoLoadError('Este navegador no deja editar fotos (sin lienzo 2D).', 'canvas');
  return ctx;
}

/** Medidas a las que se dibuja una foto para que no pase de `maxPixels`. */
export function fitPixels(width: number, height: number, maxPixels: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Píxeles de una foto (orientación EXIF ya aplicada por el navegador). Con
 * `maxPixels`, reducida si hace falta; `reduced` lo dice.
 */
export async function loadPixels(
  url: string,
  maxPixels = MAX_EDIT_PIXELS,
): Promise<{ pixels: Pixels; reduced: boolean; natural: { width: number; height: number } }> {
  const image = await loadImage(url);
  const natural = { width: image.naturalWidth, height: image.naturalHeight };
  const size = fitPixels(natural.width, natural.height, maxPixels);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = context(canvas);
  ctx.drawImage(image, 0, 0, size.width, size.height);
  try {
    const data = ctx.getImageData(0, 0, size.width, size.height);
    return {
      pixels: { data: data.data, width: size.width, height: size.height },
      reduced: size.width !== natural.width,
      natural,
    };
  } catch {
    throw new PhotoLoadError(
      'El navegador no deja leer esta foto (copia en caché sin permiso de origen). Recarga la página sin caché y vuelve a probar.',
      'tainted',
    );
  }
}

/**
 * Una imagen encajada (como «llenar») en un tamaño dado: para usarla de fondo
 * detrás de una foto recortada.
 */
export async function loadCoverPixels(url: string, width: number, height: number): Promise<Pixels> {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = context(canvas);
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  try {
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } catch {
    throw new PhotoLoadError('El navegador no deja leer la imagen de fondo.', 'tainted');
  }
}

/** Pinta unos píxeles en un lienzo de la página (vista previa). */
export function paint(canvas: HTMLCanvasElement, pixels: Pixels): void {
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
}

/** Codifica unos píxeles como archivo (PNG sin pérdida, o JPEG al 92 %). */
export async function encodePixels(pixels: Pixels, mimeType: 'image/png' | 'image/jpeg'): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  context(canvas).putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.92));
  if (!blob) throw new PhotoLoadError('El navegador no ha podido crear el archivo.', 'canvas');
  return blob;
}
