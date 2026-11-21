import { Check, Images, Sparkles } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Dialog, Field, Notice, Select, Skeleton, Spinner, Textarea } from '@/components/ui';
import { previewPath, useAssets, useSignedUrls } from '@/features/library/api';
import type { MediaAssetRow } from '@/lib/database.types';
import { cn } from '@/lib/utils';
import { AiErrorNotice } from './AiErrorNotice';
import {
  MAX_IMAGE_PROMPT_CHARS,
  MAX_IMAGE_REFERENCES,
  useGenerateImage,
  useGenerationProgress,
  useImageEstimate,
  useImageModels,
  type ImageAspectRatio,
  type ImageModelChoice,
} from './imageApi';
import { formatMicros, moneyEstimateNote } from './money';

const RATIOS: { value: ImageAspectRatio; label: string }[] = [
  { value: '1:1', label: 'Cuadrada (1:1)' },
  { value: '4:5', label: 'Vertical (4:5)' },
  { value: '9:16', label: 'Historia o reel (9:16)' },
  { value: '16:9', label: 'Horizontal (16:9)' },
];
const number = new Intl.NumberFormat('es-ES');

/** Lo que recibe el editor al terminar: el recurso nuevo de la biblioteca. */
export interface GeneratedImage {
  id: string;
  name: string;
}

export interface GenerateImageDialogProps {
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Proporción del lienzo: la de partida. */
  canvasRatio: ImageAspectRatio;
  /** Recibe la imagen ya guardada en la biblioteca, para ponerla como capa. */
  onGenerated: (image: GeneratedImage) => void;
}

function regionLabel(model: ImageModelChoice): string {
  if (model.euProcessing) return 'Procesa en la UE';
  return model.dataRegion === 'unknown' ? 'Región sin confirmar' : 'Fuera de la UE';
}

/** Ventana para generar una imagen con IA y añadirla al diseño. */
export function GenerateImageDialog({
  brandId,
  open,
  onOpenChange,
  canvasRatio,
  onGenerated,
}: GenerateImageDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Generar imagen con IA"
      description="Describe la imagen. Al terminar se guarda en la biblioteca y se añade al diseño como capa."
    >
      {open && <ImageGenerator brandId={brandId} canvasRatio={canvasRatio} onGenerated={onGenerated} />}
    </Dialog>
  );
}

function ImageGenerator({
  brandId,
  canvasRatio,
  onGenerated,
}: {
  brandId: string;
  canvasRatio: ImageAspectRatio;
  onGenerated: (image: GeneratedImage) => void;
}) {
  const models = useImageModels(brandId);
  const generate = useGenerateImage(brandId);
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState<ImageAspectRatio>(canvasRatio);
  const [modelId, setModelId] = useState<string>('');
  const [references, setReferences] = useState<string[]>([]);
  const [pickingReferences, setPickingReferences] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const progress = useGenerationProgress(brandId, pendingId);

  const choices = useMemo(() => models.data ?? [], [models.data]);
  const selected = choices.find((m) => m.id === modelId) ?? choices.find((m) => m.default) ?? choices[0];
  const request = useMemo(
    () => ({ prompt: '', aspectRatio: ratio, model: selected?.id, referenceAssetIds: references }),
    [ratio, selected?.id, references],
  );
  const estimate = useImageEstimate(brandId, request, Boolean(selected));

  // Asíncrono: al terminar, se entrega la imagen (una sola vez por generación).
  const finished = progress.data?.status === 'completed' ? progress.data.asset : null;
  const delivered = useRef<string | null>(null);
  useEffect(() => {
    if (!finished || delivered.current === finished.id) return;
    delivered.current = finished.id;
    onGenerated({ id: finished.id, name: finished.file_name });
  }, [finished, onGenerated]);

  const trimmed = prompt.trim();
  const busy = generate.isPending || (pendingId !== null && progress.data?.status !== 'failed');
  const canSubmit = trimmed.length > 0 && prompt.length <= MAX_IMAGE_PROMPT_CHARS && Boolean(selected) && !busy;

  function run() {
    setPendingId(null);
    generate
      .mutateAsync({ prompt: trimmed, aspectRatio: ratio, model: selected?.id, referenceAssetIds: references })
      .then(
        (result) => {
          if (result.status === 'completed') {
            onGenerated({ id: result.asset.id, name: `IA · ${trimmed.slice(0, 60)}` });
          } else {
            setPendingId(result.generationId);
          }
        },
        () => {
          // El error queda en `generate.error` y se enseña abajo.
        },
      );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit) run();
  }

  if (models.isPending) return <Spinner label="Consultando los modelos de imagen…" />;
  if (models.isError) return <AiErrorNotice error={models.error} onRetry={() => void models.refetch()} />;
  if (choices.length === 0) {
    return (
      <Notice tone="warning">
        No hay ningún modelo de imagen disponible: falta configurarlo en la plataforma. Avisa a quien la administra.
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Encargo"
          hint={`Qué debe mostrar la imagen. ${number.format(prompt.length)} / ${number.format(MAX_IMAGE_PROMPT_CHARS)}`}
          error={prompt.length > MAX_IMAGE_PROMPT_CHARS ? 'El encargo es demasiado largo.' : null}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Por ejemplo: mesa de madera con un plato de temporada, luz cálida de ventana, sin personas ni texto."
              data-testid="ai-image-prompt"
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Proporción" hint={ratio === canvasRatio ? 'La del lienzo.' : 'Distinta de la del lienzo.'}>
            {(p) => (
              <Select
                {...p}
                value={ratio}
                disabled={busy}
                onChange={(e) => setRatio(e.target.value as ImageAspectRatio)}
                data-testid="ai-image-ratio"
              >
                {RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Modelo" hint={selected ? regionLabel(selected) : undefined}>
            {(p) => (
              <Select
                {...p}
                value={selected?.id ?? ''}
                disabled={busy}
                onChange={(e) => setModelId(e.target.value)}
                data-testid="ai-image-model"
              >
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {selected?.untestedAdapter && (
          <p className="text-xs text-muted" data-testid="ai-image-untested">
            Este modelo todavía no se ha probado en la plataforma contra el servicio real.
          </p>
        )}

        <section aria-label="Imágenes de referencia" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              Imágenes de referencia{' '}
              <span className="font-normal text-muted">(opcional, hasta {MAX_IMAGE_REFERENCES})</span>
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setPickingReferences((v) => !v)}
              data-testid="ai-image-references-toggle"
            >
              <Images className="h-4 w-4" aria-hidden />
              {pickingReferences
                ? 'Listo'
                : references.length
                  ? `Elegidas: ${references.length}`
                  : 'Elegir de la biblioteca'}
            </Button>
          </div>
          {pickingReferences && (
            <ReferencePicker
              brandId={brandId}
              selected={references}
              onToggle={(id) =>
                setReferences((current) =>
                  current.includes(id)
                    ? current.filter((x) => x !== id)
                    : current.length < MAX_IMAGE_REFERENCES
                      ? [...current, id]
                      : current,
                )
              }
            />
          )}
        </section>

        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-subtle px-3.5 py-3"
          data-testid="ai-image-estimate"
        >
          <div className="text-sm">
            {estimate.isPending ? (
              <span className="text-muted">Calculando el coste…</span>
            ) : estimate.isError ? (
              <span className="text-danger">No se ha podido calcular el coste.</span>
            ) : (
              <>
                <span className="font-medium">Coste máximo: {formatMicros(estimate.data.costMicros)}</span>
                <span className="block text-xs text-muted">{moneyEstimateNote()}</span>
              </>
            )}
          </div>
          <Button type="submit" disabled={!canSubmit} loading={generate.isPending} data-testid="ai-image-generate">
            <Sparkles className="h-4 w-4" aria-hidden />
            Generar
          </Button>
        </div>
        <p className="text-xs text-muted">
          Cada imagen descuenta del cupo de IA de la organización. Una imagen generada no es una foto real: no la
          presentes como tal.
        </p>
      </form>

      {generate.isPending && (
        <Spinner label={selected?.delivery === 'async' ? 'Enviando el encargo…' : 'Generando la imagen…'} />
      )}
      {pendingId && progress.data?.status !== 'failed' && progress.data?.status !== 'completed' && (
        <div data-testid="ai-image-running">
          <Spinner label="Generando la imagen. Puede tardar un par de minutos: si cierras esta ventana, la imagen aparecerá igualmente en la biblioteca." />
        </div>
      )}
      {progress.data?.status === 'failed' && (
        <div role="alert" className="rounded-lg bg-danger-soft px-3.5 py-3 text-sm text-danger" data-testid="ai-error">
          <p>{progress.data.message}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={run} disabled={!canSubmit}>
            Reintentar
          </Button>
        </div>
      )}
      {generate.isError && <AiErrorNotice error={generate.error} onRetry={run} />}
    </div>
  );
}

function ReferencePicker({
  brandId,
  selected,
  onToggle,
}: {
  brandId: string;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const filters = useMemo(() => ({ kind: 'image' as const, tag: '', folder: '', search: '' }), []);
  const assets = useAssets(brandId, filters);
  const rows = useDeferredValue(useMemo(() => assets.data?.pages.flat() ?? [], [assets.data]));
  const paths = useMemo(() => rows.map((a: MediaAssetRow) => previewPath(a)), [rows]);
  const urls = useSignedUrls(paths);
  const full = selected.length >= MAX_IMAGE_REFERENCES;

  if (assets.isPending) return <Spinner />;
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No hay imágenes en la biblioteca de la marca.</p>;
  }
  return (
    <ul
      className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4"
      data-testid="ai-image-reference-list"
    >
      {rows.map((asset) => {
        const url = urls.data?.get(previewPath(asset));
        const checked = selected.includes(asset.id);
        return (
          <li key={asset.id}>
            <button
              type="button"
              aria-pressed={checked}
              disabled={!checked && full}
              onClick={() => onToggle(asset.id)}
              className={cn(
                'relative block w-full overflow-hidden rounded-lg border text-left disabled:opacity-50',
                checked ? 'border-primary ring-2 ring-primary' : 'border-border',
              )}
              title={asset.file_name}
              data-testid="ai-image-reference"
            >
              <span className="block aspect-square bg-subtle">
                {url ? (
                  <img src={url} alt={asset.file_name} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <Skeleton className="h-full w-full rounded-none" />
                )}
              </span>
              {checked && (
                <span className="absolute left-1 top-1">
                  <Badge tone="success">
                    <Check className="h-3 w-3" aria-hidden /> Elegida
                  </Badge>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
