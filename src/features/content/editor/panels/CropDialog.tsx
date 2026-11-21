import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Dialog, Notice, Spinner } from '@/components/ui';
import { loadCorsImage } from '@/lib/corsImage';
import type { ImageCrop, ImageLayer } from '../../document';
import { fitBoxAround, moveCrop, resizeCrop } from '../imageEffects/cropMath';
import { CROP_RATIOS, cropRatioOf, isFullCrop, largestCrop, orientedSize } from '../imageEffects/imageEdit';
import { prepareBitmap } from '../imageEffects/prepare';
import type { LayerPatch } from '../history';

const PREVIEW_SIDE = 900;
const LAYER_RATIO = 'layer';

type Drag =
  | { mode: 'move'; startPointer: { x: number; y: number }; startCrop: ImageCrop }
  | { mode: 'resize'; anchor: { x: number; y: number } };

/** Esquinas del recorte: la de arriba a la izquierda arrastra desde la de abajo a la derecha, etc. */
const CORNERS = [
  { id: 'nw', left: 0, top: 0 },
  { id: 'ne', left: 1, top: 0 },
  { id: 'sw', left: 0, top: 1 },
  { id: 'se', left: 1, top: 1 },
] as const;

/**
 * Recortar una foto del diseño: se ve la foto ya girada y enderezada, con un
 * marco que se mueve y se agranda arrastrando las esquinas, libre o con una
 * proporción. Al aplicar, la caja de la capa toma la proporción del recorte
 * (sin crecer) para que se vea entero.
 */
export function CropDialog({
  layer,
  url,
  onApply,
  onClose,
}: {
  layer: ImageLayer;
  url: string;
  onApply: (patch: LayerPatch) => void;
  onClose: () => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [ratioId, setRatioId] = useState(LAYER_RATIO);
  const [draft, setCrop] = useState<ImageCrop | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    let alive = true;
    loadCorsImage(url).then(
      (loaded) => alive && setImage(loaded),
      () => alive && setLoadFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [url]);

  const layerRatio = layer.width / layer.height;
  const frame = useMemo(
    () => (image ? orientedSize(image.naturalWidth, image.naturalHeight, layer.turn) : null),
    [image, layer.turn],
  );

  // La foto como se verá antes de recortar: girada, volteada y enderezada.
  const bitmap = useMemo(() => {
    if (!image) return null;
    try {
      return prepareBitmap(
        image,
        { turn: layer.turn, flipX: layer.flipX, flipY: layer.flipY, straighten: layer.straighten },
        PREVIEW_SIDE,
      );
    } catch {
      return null;
    }
  }, [image, layer.turn, layer.flipX, layer.flipY, layer.straighten]);
  const error = loadFailed || (image !== null && bitmap === null);

  useEffect(() => {
    const canvas = preview.current;
    if (!bitmap || !canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  }, [bitmap, frame]);

  // Recorte de partida: el que ya tiene la capa o el mayor con la proporción de su caja.
  const crop = draft ?? layer.crop ?? (frame ? largestCrop(frame, layerRatio) : null);

  const ratio = ratioId === LAYER_RATIO ? layerRatio : (CROP_RATIOS.find((r) => r.id === ratioId)?.ratio ?? null);

  const choose = (id: string) => {
    setRatioId(id);
    if (!frame) return;
    const next = id === LAYER_RATIO ? layerRatio : (CROP_RATIOS.find((r) => r.id === id)?.ratio ?? null);
    if (next) setCrop(largestCrop(frame, next, crop ? { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 } : undefined));
  };

  const pointerFraction = (event: ReactPointerEvent) => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };

  const begin = (event: ReactPointerEvent, next: Drag) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag.current = next;
  };

  const onMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || !frame) return;
    const point = pointerFraction(event);
    if (current.mode === 'move') {
      setCrop(moveCrop(current.startCrop, point.x - current.startPointer.x, point.y - current.startPointer.y));
    } else {
      setCrop(resizeCrop(current.anchor, point, frame, ratio));
    }
  };

  const apply = () => {
    if (!frame || !crop) return;
    const cropRatio = cropRatioOf(crop, frame);
    const box = fitBoxAround({ x: layer.x, y: layer.y, width: layer.width, height: layer.height }, cropRatio);
    onApply({ crop: isFullCrop(crop) ? undefined : crop, ...box });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Recortar la foto"
      description="Mueve el marco o arrastra una esquina. Se puede deshacer con Ctrl+Z."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={apply} disabled={!crop} data-testid="crop-apply">
            Aplicar recorte
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="crop-dialog">
        {error ? (
          <Notice tone="warning">No se ha podido abrir la foto para recortarla.</Notice>
        ) : !image || !crop || !frame ? (
          <Spinner label="Abriendo la foto…" />
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Proporción del recorte">
              <Button
                size="sm"
                variant={ratioId === LAYER_RATIO ? 'primary' : 'secondary'}
                aria-pressed={ratioId === LAYER_RATIO}
                onClick={() => choose(LAYER_RATIO)}
              >
                Como la capa
              </Button>
              {CROP_RATIOS.map((option) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={ratioId === option.id ? 'primary' : 'secondary'}
                  aria-pressed={ratioId === option.id}
                  onClick={() => choose(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div
              ref={wrapper}
              className="relative mx-auto max-h-[60vh] w-fit max-w-full touch-none select-none overflow-hidden rounded-md bg-black/5"
              onPointerMove={onMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
            >
              <canvas ref={preview} className="block max-h-[60vh] max-w-full" aria-label="Foto que se recorta" role="img" />
              <div
                className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.width * 100}%`,
                  height: `${crop.height * 100}%`,
                }}
                data-testid="crop-box"
                onPointerDown={(event) => begin(event, { mode: 'move', startPointer: pointerFraction(event), startCrop: crop })}
              >
                {CORNERS.map((corner) => (
                  <span
                    key={corner.id}
                    className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border-2 border-primary bg-white"
                    style={{ left: `${corner.left * 100}%`, top: `${corner.top * 100}%` }}
                    data-testid={`crop-handle-${corner.id}`}
                    onPointerDown={(event) =>
                      begin(event, {
                        mode: 'resize',
                        anchor: {
                          x: crop.x + (1 - corner.left) * crop.width,
                          y: crop.y + (1 - corner.top) * crop.height,
                        },
                      })
                    }
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
