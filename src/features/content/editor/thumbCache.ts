import { loadCorsImage } from '@/lib/corsImage';

// Imágenes de las miniaturas de página. Una miniatura mide unos 60 px: no hace
// falta (ni conviene) guardar la foto entera de 2000 px por cada página de cada
// carrusel. Se descarga una vez con `loadCorsImage` (la misma carga que el
// lienzo, para no romper CORS con R2), se reduce a un lado de THUMB_MAX_SIDE px
// y se guarda por dirección. Las peticiones en curso se comparten (dos páginas
// con la misma foto, una sola descarga) y la caché es acotada (LRU).

export const THUMB_MAX_SIDE = 192;
export const THUMB_CACHE_SIZE = 80;

export type ThumbSource = HTMLCanvasElement | HTMLImageElement;

const cache = new Map<string, Promise<ThumbSource | null>>();

function shrink(image: HTMLImageElement): ThumbSource {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longest || longest <= THUMB_MAX_SIDE) return image;
  const scale = THUMB_MAX_SIDE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return image;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** La imagen reducida para una miniatura; `null` si no se ha podido cargar. Nunca lanza. */
export function loadThumbSource(url: string): Promise<ThumbSource | null> {
  const hit = cache.get(url);
  if (hit) {
    // Se vuelve a poner la última: lo más usado es lo último en salir.
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  const pending: Promise<ThumbSource | null> = loadCorsImage(url).then(
    (image) => shrink(image),
    () => {
      // Un fallo no se recuerda: la próxima vez (otra dirección firmada, red) se reintenta.
      if (cache.get(url) === pending) cache.delete(url);
      return null;
    },
  );
  cache.set(url, pending);
  while (cache.size > THUMB_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return pending;
}

/** Solo para las pruebas. */
export function clearThumbCache(): void {
  cache.clear();
}

export function thumbCacheSize(): number {
  return cache.size;
}
