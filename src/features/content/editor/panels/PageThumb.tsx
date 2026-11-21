import { useEffect, useRef, useState } from 'react';
import type { Canvas, ImageLayer, Layer } from '../../document';
import type { ImageLookup } from '../canvas/nodes';
import { loadThumbSource, type ThumbSource } from '../thumbCache';

/** Color con que se esboza una capa en la miniatura cuando no hay nada mejor que dibujar. */
function sketchColor(layer: Layer): string {
  if (layer.type === 'shape') return layer.fill ?? 'transparent';
  if (layer.type === 'text') return layer.color;
  if (layer.type === 'logo') return '#9CA3AF';
  return '#CBD5E1';
}

/** Dirección firmada de la imagen o logotipo de la capa, si ya se conoce. */
function imageUrlFor(layer: Layer, images: ImageLookup | undefined): string | null {
  if (!images) return null;
  if (layer.type === 'image') return layer.source.kind === 'asset' ? (images.get(layer.source.assetId) ?? null) : null;
  if (layer.type === 'logo') return images.get(layer.assetId) ?? null;
  return null;
}

/** Dibuja `source` en el lienzo `target` como `cover` (llena recortando, con el punto de interés) o `contain`. */
function drawFitted(
  target: HTMLCanvasElement,
  source: ThumbSource,
  fit: 'cover' | 'contain',
  focus: { x: number; y: number },
): void {
  const context = target.getContext('2d');
  if (!context) return;
  const sw = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const sh = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!sw || !sh) return;
  const { width: tw, height: th } = target;
  context.clearRect(0, 0, tw, th);
  if (fit === 'contain') {
    const scale = Math.min(tw / sw, th / sh);
    const w = sw * scale;
    const h = sh * scale;
    context.drawImage(source, (tw - w) / 2, (th - h) / 2, w, h);
    return;
  }
  const scale = Math.max(tw / sw, th / sh);
  const cw = tw / scale;
  const ch = th / scale;
  const sx = Math.min(sw - cw, Math.max(0, focus.x * sw - cw / 2));
  const sy = Math.min(sh - ch, Math.max(0, focus.y * sh - ch / 2));
  context.drawImage(source, sx, sy, cw, ch, 0, 0, tw, th);
}

type ThumbImageLayer = Pick<ImageLayer, 'fit'> & { focus?: { x: number; y: number } };

/** La foto de una capa, en pequeño: gris mientras carga (o si falla), la imagen real cuando llega. */
function ThumbImage({ url, layer }: { url: string; layer: ThumbImageLayer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const fit = layer.fit;
  const focusX = layer.focus?.x ?? 0.5;
  const focusY = layer.focus?.y ?? 0.5;

  useEffect(() => {
    let cancelled = false;
    void loadThumbSource(url).then((source) => {
      if (cancelled) return;
      const canvas = ref.current;
      if (!source || !canvas) return setState('error');
      drawFitted(canvas, source, fit, { x: focusX, y: focusY });
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [url, fit, focusX, focusY]);

  return (
    <canvas
      ref={ref}
      width={96}
      height={96}
      className="h-full w-full"
      data-testid="page-thumb-image"
      data-state={state}
      aria-hidden
    />
  );
}

/**
 * Miniatura de una página: el fondo del lienzo y una caja por capa visible. Las
 * formas y los textos son un esquema ligero (HTML puro, al momento); las fotos
 * y el logotipo se dibujan de verdad, en pequeño, en cuanto se conoce su
 * dirección (cargadas con `loadCorsImage` y cacheadas en `thumbCache`). Sin
 * dirección o si la carga falla, la caja queda en gris como antes.
 */
export function PageThumb({ canvas, layers, images }: { canvas: Canvas; layers: Layer[]; images?: ImageLookup }) {
  return (
    <span
      className="relative block w-full overflow-hidden rounded"
      style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, background: canvas.backgroundColor }}
      aria-hidden
    >
      {layers
        .filter((layer) => layer.visible && layer.opacity > 0)
        .map((layer) => {
          const url = imageUrlFor(layer, images);
          const height = layer.type === 'text' ? Math.min(layer.height, layer.fontSize * 1.2) : layer.height;
          return (
            <span
              key={layer.id}
              className="absolute overflow-hidden"
              style={{
                left: `${(layer.x / canvas.width) * 100}%`,
                top: `${(layer.y / canvas.height) * 100}%`,
                width: `${(layer.width / canvas.width) * 100}%`,
                height: `${(height / canvas.height) * 100}%`,
                transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
                opacity: layer.type === 'text' ? Math.min(1, layer.opacity) * 0.8 : layer.opacity,
                background: sketchColor(layer),
                borderRadius: layer.type === 'shape' && layer.shape === 'ellipse' ? '9999px' : undefined,
                border: layer.type === 'shape' && layer.stroke ? `1px solid ${layer.stroke.color}` : undefined,
              }}
            >
              {url && layer.type === 'image' && <ThumbImage key={url} url={url} layer={layer} />}
              {url && layer.type === 'logo' && <ThumbImage key={url} url={url} layer={{ fit: 'contain' }} />}
            </span>
          );
        })}
    </span>
  );
}
