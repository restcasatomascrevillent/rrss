import { useEffect, useState } from 'react';
import { extractPalette } from '@/features/brandcheck/palette';
import type { PaletteColor } from '@/features/brandcheck/types';
import type { ImageLayer, PageView } from '../document';
import type { ImageLookup } from './canvas/nodes';

// Paleta dominante de la imagen de la pieza, para el verificador de marca.
// Se lee la imagen de la capa (no el lienzo entero): la comprobación de paleta
// es sobre la foto. Si el navegador no deja leer sus píxeles (imagen de otro
// origen sin CORS: el lienzo queda «manchado»), no hay paleta y el verificador
// omite esa comprobación con su aviso; no es un fallo de la pieza.

export type ImagePaletteState =
  { status: 'none' } | { status: 'loading' } | { status: 'ready'; palette: PaletteColor[] } | { status: 'unavailable' };

/** La capa de imagen visible más grande: la que manda en los colores de la pieza. */
export function mainImageLayer(document: Pick<PageView, 'layers'>): ImageLayer | null {
  let best: ImageLayer | null = null;
  for (const layer of document.layers) {
    if (layer.type !== 'image' || !layer.visible || layer.opacity <= 0) continue;
    if (!best || layer.width * layer.height > best.width * best.height) best = layer;
  }
  return best;
}

/** Dirección de la imagen de una capa, si es de la biblioteca y ya está firmada. */
export function imageUrlOf(layer: ImageLayer | null, images: ImageLookup): string | null {
  if (!layer || layer.source.kind !== 'asset') return null;
  return images.get(layer.source.assetId) ?? null;
}

/** Carga la imagen con CORS y extrae su paleta. */
export function useImagePalette(url: string | null): ImagePaletteState {
  const [state, setState] = useState<{ url: string; result: ImagePaletteState } | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const settle = (result: ImagePaletteState) => {
      if (!cancelled) setState({ url, result });
    };
    image.onload = () => {
      extractPalette(image).then(
        (palette) => settle(palette.length ? { status: 'ready', palette } : { status: 'unavailable' }),
        () => settle({ status: 'unavailable' }),
      );
    };
    image.onerror = () => settle({ status: 'unavailable' });
    image.src = url;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);

  if (!url) return { status: 'none' };
  return state?.url === url ? state.result : { status: 'loading' };
}
