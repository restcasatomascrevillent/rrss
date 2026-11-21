// Miniaturas ligeras de las fotos de la biblioteca (migración 20261209010000).
// Se generan en el navegador al subir: WebP (o JPEG si el navegador no sabe
// codificar WebP) con el lado largo de unos 400 px. Solo sirven para pintar
// cuadrículas; editar, exportar y publicar usan siempre el original.

export const THUMB_MAX_SIDE = 400;
export const THUMB_QUALITY = 0.8;
/** Por debajo de este tamaño el original ya es una miniatura: no se genera otra. */
export const THUMB_SKIP_BYTES = 40 * 1024;
const THUMB_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export interface Thumbnail {
  blob: Blob;
  width: number;
  height: number;
  /** `image/webp` o `image/jpeg`. */
  type: string;
  extension: 'webp' | 'jpg';
}

/** Medidas de la miniatura: el lado largo a `max` y nunca más grande que el original. */
export function thumbSize(width: number, height: number, max = THUMB_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** ¿Merece la pena generar miniatura de este archivo? */
export function needsThumbnail(file: { type: string; size: number }): boolean {
  return (THUMB_MIMES as readonly string[]).includes(file.type) && file.size > THUMB_SKIP_BYTES;
}

/** Ruta de la miniatura de un recurso: `<org>/<marca>/thumbs/<id>.<ext>`. */
export function buildThumbPath(organizationId: string, brandId: string, id: string, extension = 'webp'): string {
  return `${organizationId}/${brandId}/thumbs/${id}.${extension}`;
}

export interface ThumbnailDeps {
  /** Descodifica la imagen (respetando la orientación EXIF). */
  decode(file: Blob): Promise<{ width: number; height: number; draw: (ctx: unknown, w: number, h: number) => void }>;
  /** Pinta y codifica; null si el navegador no sabe ese tipo. */
  encode(
    source: { draw: (ctx: unknown, w: number, h: number) => void },
    width: number,
    height: number,
    type: string,
    quality: number,
  ): Promise<Blob | null>;
}

const browserDeps: ThumbnailDeps = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => {
        (ctx as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, w, h);
      },
    };
  },
  async encode(source, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    source.draw(ctx, width, height);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  },
};

/**
 * Genera la miniatura de una imagen. Devuelve null (sin lanzar) si no hace
 * falta, si el navegador no puede, o si la miniatura no pesaría menos que el
 * original: la subida sigue sin ella.
 */
export async function createThumbnail(file: File | Blob, deps: ThumbnailDeps = browserDeps): Promise<Thumbnail | null> {
  if (!needsThumbnail(file)) return null;
  try {
    const decoded = await deps.decode(file);
    const { width, height } = thumbSize(decoded.width, decoded.height);
    if (!width || !height) return null;
    let blob = await deps.encode(decoded, width, height, 'image/webp', THUMB_QUALITY);
    if (blob && blob.type !== 'image/webp') blob = null; // Safari devuelve PNG si no sabe WebP.
    let type = 'image/webp';
    if (!blob) {
      blob = await deps.encode(decoded, width, height, 'image/jpeg', THUMB_QUALITY);
      type = 'image/jpeg';
    }
    if (!blob || blob.size === 0 || blob.size >= file.size) return null;
    return { blob, width, height, type, extension: type === 'image/webp' ? 'webp' : 'jpg' };
  } catch {
    return null;
  }
}
