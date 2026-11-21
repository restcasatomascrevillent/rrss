// Recortes de una foto, dentro de su ficha en la biblioteca: elegir formatos y
// punto de interés, encargarlos al trabajador de medios, ver el estado y abrir
// los recortes. Solo aparece con `VITE_MEDIA_WORKER_ENABLED` (sin trabajador,
// el encargo se quedaría en cola para siempre).
import { Crop, XCircle } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { Badge, Button } from '@/components/ui';
import { useCancelMediaJob } from '@/features/reels/api';
import { describeJob, isActive, type JobTone } from '@/features/reels/plan';
import type { MediaAssetRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn, formatDateTime } from '@/lib/utils';
import {
  buildCropInput,
  CROP_ASPECT_LABEL,
  CROP_ASPECTS,
  cropResults,
  previewPosition,
  useCropJobs,
  useRequestCrops,
  type CropAspect,
  type FocalPoint,
} from './crops';

const TONE_BADGE: Record<JobTone, 'neutral' | 'primary' | 'success' | 'danger'> = {
  neutral: 'neutral',
  progress: 'primary',
  success: 'success',
  danger: 'danger',
};
const ASPECT_STYLE: Record<CropAspect, string> = { '1:1': '1 / 1', '4:5': '4 / 5', '9:16': '9 / 16', '16:9': '16 / 9' };
const newKey = () => crypto.randomUUID();

interface CropPanelProps {
  asset: MediaAssetRow;
  url: string | undefined;
  canEdit: boolean;
  onOpenAsset: (assetId: string) => void;
}

export function CropPanel({ asset, url, canEdit, onOpenAsset }: CropPanelProps) {
  const jobs = useCropJobs(asset.brand_id, asset.storage_path);
  const request = useRequestCrops(asset.brand_id);
  const cancel = useCancelMediaJob(asset.brand_id);
  const [aspects, setAspects] = useState<CropAspect[]>(['1:1', '4:5', '9:16']);
  const [focal, setFocal] = useState<FocalPoint>({ x: 0.5, y: 0.5 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(
    asset.width && asset.height ? { width: asset.width, height: asset.height } : null,
  );
  const imageRef = useRef<HTMLImageElement>(null);
  // La misma clave mientras no cambie el encargo: un doble clic no encarga dos veces.
  const requestKey = useRef(newKey());
  const touch = () => {
    requestKey.current = newKey();
  };

  const setPoint = (point: FocalPoint) => {
    touch();
    setFocal({ x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) });
  };
  const pick = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    setPoint({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
  };
  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setPoint({ x: focal.x + move[0], y: focal.y + move[1] });
  };
  const toggle = (aspect: CropAspect) => {
    touch();
    setAspects((current) =>
      current.includes(aspect)
        ? current.filter((a) => a !== aspect)
        : CROP_ASPECTS.filter((a) => a === aspect || current.includes(a)),
    );
  };

  const submit = () => {
    if (aspects.length === 0) return;
    request.mutate(
      {
        request: buildCropInput(asset.storage_path, asset.mime_type, focal, aspects),
        idempotencyKey: requestKey.current,
      },
      {
        onSuccess: () => {
          touch();
          toast.success('Recortes encargados. Aparecerán en la carpeta «Recortes» de la biblioteca.');
        },
        onError: (error) => toast.error(translateError(error)),
      },
    );
  };

  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-labelledby="crop-title" data-testid="crops">
      <div>
        <h3 id="crop-title" className="text-sm font-medium">
          Recortes para redes
        </h3>
        <p className="mt-1 text-xs text-muted">
          Copias de esta foto en otras proporciones, centradas en el punto de interés. La foto original no cambia.
        </p>
      </div>

      {canEdit && (
        <>
          {url ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Toca la foto donde está lo importante (o usa las flechas del teclado sobre ella).
              </p>
              <button
                type="button"
                className="relative block w-full max-w-sm overflow-hidden rounded-lg border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                onClick={pick}
                onKeyDown={nudge}
                aria-label={`Punto de interés: ${percent(focal.x)} desde la izquierda, ${percent(focal.y)} desde arriba`}
                data-testid="crop-focal"
              >
                <img
                  ref={imageRef}
                  src={url}
                  alt=""
                  className="block h-auto w-full"
                  onLoad={(e) =>
                    setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
                  }
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary/60 shadow"
                  style={{ left: percent(focal.x), top: percent(focal.y) }}
                />
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted">Sin vista previa: el punto de interés queda en el centro.</p>
          )}

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Formatos</legend>
            <div className="grid gap-3 sm:grid-cols-4">
              {CROP_ASPECTS.map((aspect) => {
                const checked = aspects.includes(aspect);
                return (
                  <label
                    key={aspect}
                    className={cn(
                      'flex cursor-pointer flex-col gap-2 rounded-lg border p-2 text-xs',
                      checked ? 'border-primary bg-primary-soft' : 'border-border hover:bg-subtle',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(aspect)}
                        data-testid={`crop-aspect-${aspect}`}
                      />
                      {CROP_ASPECT_LABEL[aspect]}
                    </span>
                    {url && natural && (
                      <span
                        className="block max-h-28 w-full overflow-hidden rounded bg-subtle"
                        style={{ aspectRatio: ASPECT_STYLE[aspect] }}
                      >
                        <img
                          src={url}
                          alt=""
                          className="h-full w-full object-cover"
                          style={{ objectPosition: previewPosition(natural, aspect, focal) }}
                          data-testid={`crop-preview-${aspect}`}
                        />
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Button
            variant="secondary"
            onClick={submit}
            disabled={aspects.length === 0}
            loading={request.isPending}
            data-testid="crop-submit"
          >
            <Crop className="h-4 w-4" aria-hidden />
            {aspects.length === 0
              ? 'Elige al menos un formato'
              : `Hacer ${aspects.length === 1 ? 'el recorte' : `${aspects.length} recortes`}`}
          </Button>
        </>
      )}

      {jobs.data && jobs.data.length > 0 && (
        <ul className="divide-y divide-border" data-testid="crop-jobs">
          {jobs.data.map((job) => {
            const view = describeJob(job);
            const results = cropResults(job);
            return (
              <li key={job.id} className="space-y-1 py-2 first:pt-0 last:pb-0" data-testid="crop-job">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-xs text-muted">{formatDateTime(job.created_at)}</span>
                  <Badge tone={TONE_BADGE[view.tone]}>
                    <span data-testid="crop-job-status">{view.label}</span>
                  </Badge>
                </div>
                {view.detail && (
                  <p className={cn('text-xs', job.status === 'failed' ? 'text-danger' : 'text-muted')}>{view.detail}</p>
                )}
                {job.status === 'succeeded' && results.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {results.map((result) => (
                      <Button
                        key={result.id}
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenAsset(result.id)}
                        data-testid="crop-open"
                      >
                        Abrir {result.aspect}
                      </Button>
                    ))}
                  </div>
                )}
                {canEdit && isActive(job) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={cancel.isPending && cancel.variables === job.id}
                    onClick={() =>
                      cancel.mutate(job.id, {
                        onSuccess: () => toast.success('Recortes cancelados.'),
                        onError: (error) => toast.error(translateError(error)),
                      })
                    }
                    data-testid="crop-cancel"
                  >
                    <XCircle className="h-4 w-4" aria-hidden />
                    Cancelar
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
