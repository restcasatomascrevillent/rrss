// Reels: montar un vídeo vertical con fotos y clips de la biblioteca, una
// plantilla, textos con su momento y música opcional. Lo monta el trabajador
// de medios; el resultado aparece en la biblioteca de la marca.
//
// Vive dentro de la Biblioteca (no es un área del menú): parte de sus recursos
// y deja allí el resultado. El área «Crear» (docs/03-experiencia-de-usuario.md)
// no existe todavía; cuando exista, podrá encargar reels con la misma función.
import { ArrowDown, ArrowLeft, ArrowUp, Clapperboard, Film, Images, Plus, Trash2, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Skeleton,
} from '@/components/ui';
import { mediaWorkerEnabled } from '@/config/app';
import { ReelFontLine } from '@/features/brand/BrandFontsCard';
import { useSignedUrls } from '@/features/library/api';
import { useContentMutations } from '@/features/content/api';
import { contentPaths } from '@/features/content/labels';
import { useBrand, useOrg } from '@/features/orgs/context';
import { translateError } from '@/lib/errors';
import { cn, formatBytes, formatDateTime } from '@/lib/utils';
import { useCancelMediaJob, useReelJobs, useReelSources, useRequestReel, type ReelSourceAsset } from './api';
import {
  buildReelInput,
  describeJob,
  estimateDuration,
  formatSeconds,
  isActive,
  jobPieceCount,
  jobTemplateName,
  MAX_PIECES,
  MAX_TEXTS,
  reelProblems,
  type JobTone,
  type ReelPiece,
  type ReelText,
  type TextPosition,
} from './plan';
import { estimateReelSize } from './size';
import { REEL_TEMPLATES } from './templates';

const POSITION_LABEL: Record<TextPosition, string> = { top: 'Arriba', center: 'Centro', bottom: 'Abajo' };
const TONE_BADGE: Record<JobTone, 'neutral' | 'primary' | 'success' | 'danger'> = {
  neutral: 'neutral',
  progress: 'primary',
  success: 'success',
  danger: 'danger',
};

let keySeed = 0;
const nextKey = () => `k${++keySeed}`;
const newRequestKey = () => crypto.randomUUID();

/** Número opcional de un campo: vacío = null. */
function parseOptional(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function ReelsPage() {
  if (!mediaWorkerEnabled()) return <Navigate to=".." relative="path" replace />;
  return <ReelsScreen />;
}

function ReelsScreen() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canEdit = can('edit');
  const navigate = useNavigate();
  const { create } = useContentMutations(org.id, brand.id);
  // El editor de reels trabaja sobre una pieza de formato reel (con versiones y aprobación).
  const openEditor = () =>
    create
      .mutateAsync({ title: 'Reel nuevo', network: 'instagram', format: 'reel' })
      .then((item) => navigate(contentPaths(org.id, brand.id).item(item.id)))
      .catch((error: unknown) => toast.error(translateError(error)));
  return (
    <>
      <PageHeader
        title="Reels"
        description={`Monta un vídeo vertical con fotos y clips de la biblioteca de ${brand.name}.`}
        action={
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <Button onClick={() => void openEditor()} loading={create.isPending} data-testid="reels-open-editor">
                <Clapperboard className="h-4 w-4" aria-hidden />
                Crear con el editor
              </Button>
            )}
            <Link
              to=".."
              relative="path"
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-subtle"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Volver a la biblioteca
            </Link>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {canEdit ? (
          <ReelBuilder brandId={brand.id} />
        ) : (
          <Notice>Solo quien edita la marca puede montar reels. Aquí puedes ver los encargos y su estado.</Notice>
        )}
        <ReelJobs brandId={brand.id} canCancel={canEdit} />
      </div>
    </>
  );
}

function ReelBuilder({ brandId }: { brandId: string }) {
  const sources = useReelSources(brandId);
  const request = useRequestReel(brandId);
  const [templateId, setTemplateId] = useState(REEL_TEMPLATES[0]?.id ?? '');
  const [pieces, setPieces] = useState<ReelPiece[]>([]);
  const [texts, setTexts] = useState<ReelText[]>([]);
  const [musicPath, setMusicPath] = useState('');
  // La misma clave mientras no cambie el encargo: un reintento no duplica el trabajo.
  const requestKey = useRef(newRequestKey());

  const template = REEL_TEMPLATES.find((t) => t.id === templateId);
  const visual = useMemo(() => (sources.data ?? []).filter((a) => a.kind !== 'audio'), [sources.data]);
  const audios = useMemo(() => (sources.data ?? []).filter((a) => a.kind === 'audio'), [sources.data]);
  const thumbPaths = useMemo(
    () => visual.filter((a) => a.mime_type.startsWith('image/')).map((a) => a.storage_path),
    [visual],
  );
  const urls = useSignedUrls(thumbPaths);
  const estimate = template ? estimateDuration(template, pieces) : { total: 0 };
  const size = template ? estimateReelSize(template, pieces) : null;
  const problems = [
    ...reelProblems(template, pieces, texts),
    // Si ni en el caso favorable cabe, el trabajador lo rechazará seguro: no se encarga.
    ...(size?.verdict === 'exceeds'
      ? [
          `El reel pesaría al menos ${formatBytes(size.low)} y el almacenamiento admite ${formatBytes(size.limit)} por archivo. Acórtalo o usa menos clips.`,
        ]
      : []),
  ];
  const maxSeconds = template?.timing.maxTotalSeconds ?? 0;

  const touch = () => {
    requestKey.current = newRequestKey();
  };
  const addPiece = (asset: ReelSourceAsset) => {
    touch();
    setPieces((current) => [
      ...current,
      {
        key: nextKey(),
        assetId: asset.id,
        path: asset.storage_path,
        fileName: asset.file_name,
        type: asset.kind === 'video' ? 'video' : 'photo',
        seconds: null,
        clipSeconds: asset.duration_ms !== null ? asset.duration_ms / 1000 : null,
      },
    ]);
  };
  const updatePiece = (key: string, patch: Partial<ReelPiece>) => {
    touch();
    setPieces((current) => current.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };
  const movePiece = (index: number, delta: -1 | 1) => {
    touch();
    setPieces((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(index + delta, 0, moved!);
      return next;
    });
  };
  const updateText = (key: string, patch: Partial<ReelText>) => {
    touch();
    setTexts((current) => current.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  };
  const addText = () => {
    touch();
    const end = Math.max(1, Math.min(3, estimate.total || 3));
    setTexts((current) => [...current, { key: nextKey(), text: '', start: 0, end, position: null }]);
  };

  const submit = () => {
    if (!template || problems.length > 0) return;
    request.mutate(
      { request: buildReelInput(template, pieces, texts, musicPath || null), idempotencyKey: requestKey.current },
      {
        onSuccess: () => {
          touch();
          toast.success('Reel encargado. Su estado aparece en «Encargos recientes».');
        },
        onError: (error) => toast.error(translateError(error)),
      },
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="1. Plantilla" description="Cómo se monta: ritmo, transiciones y estilo del texto." />
        <CardBody>
          <fieldset>
            <legend className="sr-only">Plantilla</legend>
            <div className="grid gap-3 sm:grid-cols-3" data-testid="reel-templates">
              {REEL_TEMPLATES.map((t) => (
                <label
                  key={t.id}
                  className={cn(
                    'block cursor-pointer rounded-xl border p-3 text-sm transition-colors',
                    t.id === templateId ? 'border-primary bg-primary-soft' : 'border-border hover:bg-subtle',
                  )}
                >
                  <input
                    type="radio"
                    name="reel-template"
                    value={t.id}
                    checked={t.id === templateId}
                    onChange={() => {
                      touch();
                      setTemplateId(t.id);
                    }}
                    className="sr-only"
                    data-testid={`reel-template-${t.id}`}
                  />
                  <span className="block font-medium">{t.name}</span>
                  <span className="mt-1 block text-xs text-muted">{t.description}</span>
                  <span className="mt-2 block text-xs text-muted">
                    Hasta {formatSeconds(t.timing.maxTotalSeconds)} · foto {formatSeconds(t.timing.photoSeconds)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="2. Fotos y clips"
          description={`En el orden en que salen. Hasta ${MAX_PIECES}. Deja los segundos vacíos para usar los de la plantilla.`}
        />
        <CardBody className="space-y-4">
          {pieces.length > 0 && (
            <ol className="space-y-2" data-testid="reel-pieces">
              {pieces.map((piece, index) => (
                <li
                  key={piece.key}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
                  data-testid="reel-piece"
                >
                  <span className="w-6 text-sm font-medium text-muted">{index + 1}</span>
                  {piece.type === 'video' ? (
                    <Film className="h-4 w-4 text-muted" aria-label="Clip" />
                  ) : (
                    <Images className="h-4 w-4 text-muted" aria-label="Foto" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{piece.fileName}</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0.5}
                    max={piece.type === 'video' ? 30 : 10}
                    step={0.5}
                    className="h-9 w-24"
                    aria-label={`Segundos de la pieza ${index + 1}`}
                    placeholder={
                      template
                        ? String(piece.type === 'video' ? template.timing.maxClipSeconds : template.timing.photoSeconds)
                        : ''
                    }
                    value={piece.seconds ?? ''}
                    onChange={(e) => updatePiece(piece.key, { seconds: parseOptional(e.target.value) })}
                  />
                  {piece.type === 'photo' && (
                    <label className="flex items-center gap-1 text-xs text-muted">
                      Desenfoque
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        className="w-24"
                        aria-label={`Desenfoque de la pieza ${index + 1}`}
                        value={piece.blur ?? 0}
                        onChange={(e) => updatePiece(piece.key, { blur: Number(e.target.value) })}
                      />
                      <span className="w-8 tabular-nums" data-testid={`reel-blur-value-${index + 1}`}>
                        {piece.blur ?? 0}
                      </span>
                    </label>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Subir la pieza ${index + 1}`}
                    disabled={index === 0}
                    onClick={() => movePiece(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Bajar la pieza ${index + 1}`}
                    disabled={index === pieces.length - 1}
                    onClick={() => movePiece(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Quitar la pieza ${index + 1}`}
                    onClick={() => {
                      touch();
                      setPieces((current) => current.filter((p) => p.key !== piece.key));
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
          )}

          <div>
            <p className="mb-2 text-sm font-medium">Añadir de la biblioteca</p>
            {sources.isPending ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="aspect-square" />
                ))}
              </div>
            ) : sources.isError ? (
              <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
            ) : visual.length === 0 ? (
              <EmptyState
                icon={Images}
                title="No hay fotos ni clips"
                description="Sube primero a la biblioteca las fotos y los clips que quieras usar."
              />
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="reel-sources">
                {visual.map((asset) => {
                  const url = urls.data?.get(asset.storage_path);
                  return (
                    <li key={asset.id}>
                      <button
                        type="button"
                        className="block w-full overflow-hidden rounded-lg border border-border bg-subtle text-left hover:shadow-pop disabled:opacity-50"
                        onClick={() => addPiece(asset)}
                        disabled={pieces.length >= MAX_PIECES}
                        aria-label={`Añadir «${asset.file_name}»`}
                        data-testid="reel-source"
                      >
                        <span className="flex aspect-square items-center justify-center overflow-hidden">
                          {asset.mime_type.startsWith('image/') && url ? (
                            <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <Film className="h-6 w-6 text-muted" aria-hidden />
                          )}
                        </span>
                        <span className="block truncate px-2 py-1 text-xs">{asset.file_name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="3. Textos"
          description="Opcionales. Cada uno con el segundo en que aparece y en el que se va."
          action={
            <Button variant="secondary" size="sm" onClick={addText} disabled={texts.length >= MAX_TEXTS}>
              <Plus className="h-4 w-4" aria-hidden />
              Añadir texto
            </Button>
          }
        />
        {texts.length > 0 && (
          <CardBody className="space-y-3">
            {/* Tipografía de los textos: la de la marca (.ttf/.otf) o la de reserva, dicho antes de encargar. */}
            <ReelFontLine brandId={brandId} />
            <ul className="space-y-3" data-testid="reel-texts">
              {texts.map((text, index) => (
                <li key={text.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_5rem_7rem_auto]">
                  <Input
                    aria-label={`Texto ${index + 1}`}
                    placeholder="Lo que se lee en el vídeo"
                    maxLength={200}
                    value={text.text}
                    onChange={(e) => updateText(text.key, { text: e.target.value })}
                    data-testid="reel-text"
                  />
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.5}
                    aria-label={`Segundo en que aparece el texto ${index + 1}`}
                    value={text.start}
                    onChange={(e) => updateText(text.key, { start: parseOptional(e.target.value) ?? 0 })}
                  />
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.5}
                    aria-label={`Segundo en que se va el texto ${index + 1}`}
                    value={text.end}
                    onChange={(e) => updateText(text.key, { end: parseOptional(e.target.value) ?? 0 })}
                  />
                  <Select
                    aria-label={`Posición del texto ${index + 1}`}
                    value={text.position ?? ''}
                    onChange={(e) =>
                      updateText(text.key, { position: (e.target.value || null) as TextPosition | null })
                    }
                  >
                    <option value="">La de la plantilla</option>
                    {(Object.keys(POSITION_LABEL) as TextPosition[]).map((p) => (
                      <option key={p} value={p}>
                        {POSITION_LABEL[p]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Quitar el texto ${index + 1}`}
                    onClick={() => {
                      touch();
                      setTexts((current) => current.filter((t) => t.key !== text.key));
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="4. Música" description="Opcional. Si es más corta que el vídeo, se repite." />
        <CardBody>
          <Field
            label="Pista de la biblioteca"
            optional
            hint={audios.length === 0 ? 'No hay audios en la biblioteca.' : undefined}
          >
            {(props) => (
              <Select
                {...props}
                value={musicPath}
                onChange={(e) => {
                  touch();
                  setMusicPath(e.target.value);
                }}
                disabled={audios.length === 0}
                data-testid="reel-music"
              >
                <option value="">Sin música</option>
                {audios.map((a) => (
                  <option key={a.id} value={a.storage_path}>
                    {a.file_name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">Duración</span>
            <span data-testid="reel-duration">
              {formatSeconds(estimate.total)} de {formatSeconds(maxSeconds)} como máximo
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Duración frente al máximo de la plantilla"
            aria-valuemin={0}
            aria-valuemax={maxSeconds}
            aria-valuenow={Number(estimate.total.toFixed(1))}
            className="h-2 overflow-hidden rounded-full bg-subtle"
          >
            <div
              className={cn('h-full', estimate.total > maxSeconds ? 'bg-danger' : 'bg-primary')}
              style={{ width: `${maxSeconds ? Math.min(100, (estimate.total / maxSeconds) * 100) : 0}%` }}
            />
          </div>
          {size && pieces.length > 0 && (
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">Peso estimado</span>
              <span data-testid="reel-size">
                {formatBytes(size.low)} – {formatBytes(size.high)}
              </span>
            </div>
          )}
          {size?.verdict === 'maybe' && (
            <div data-testid="reel-size-warning">
              <Notice tone="warning">
                Puede pasar de {formatBytes(size.limit)}, el máximo que admite el almacenamiento por archivo; si pasa,
                el montaje fallará al final. Para asegurarlo, acorta el reel o usa menos segundos de clip.
              </Notice>
            </div>
          )}
          {problems.length > 0 && pieces.length > 0 && (
            <ul className="space-y-1 text-sm text-danger" data-testid="reel-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <Button
            className="w-full"
            onClick={submit}
            disabled={problems.length > 0}
            loading={request.isPending}
            data-testid="reel-submit"
          >
            <Clapperboard className="h-4 w-4" aria-hidden />
            Montar reel
          </Button>
          <p className="text-xs text-muted">
            El vídeo se monta en segundo plano: puedes salir de esta pantalla. Al terminar aparece en la carpeta «Reels»
            de la biblioteca.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function ReelJobs({ brandId, canCancel }: { brandId: string; canCancel: boolean }) {
  const jobs = useReelJobs(brandId);
  const cancel = useCancelMediaJob(brandId);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const confirmCancel = () => {
    if (!cancelling) return;
    cancel.mutate(cancelling, {
      onSuccess: () => toast.success('Reel cancelado. No se montará ni llegará a la biblioteca.'),
      onError: (error) => toast.error(translateError(error)),
      onSettled: () => setCancelling(null),
    });
  };
  return (
    <Card className="self-start">
      <CardHeader title="Encargos recientes" />
      <CardBody>
        {jobs.isPending ? (
          <Skeleton className="h-24" />
        ) : jobs.isError ? (
          <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : jobs.data.length === 0 ? (
          <p className="text-sm text-muted">Todavía no se ha encargado ningún reel.</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="reel-jobs">
            {jobs.data.map((job) => {
              const view = describeJob(job);
              return (
                <li key={job.id} className="space-y-1 py-3 first:pt-0 last:pb-0" data-testid="reel-job">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {jobTemplateName(job, REEL_TEMPLATES)} · {jobPieceCount(job)} piezas
                    </span>
                    <Badge tone={TONE_BADGE[view.tone]}>
                      <span data-testid="reel-job-status">{view.label}</span>
                    </Badge>
                  </div>
                  <p className="text-xs text-muted">{formatDateTime(job.created_at)}</p>
                  {view.detail && (
                    <p
                      className={cn('text-xs', job.status === 'failed' ? 'text-danger' : 'text-muted')}
                      data-testid="reel-job-error"
                    >
                      {view.detail}
                    </p>
                  )}
                  {canCancel && isActive(job) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCancelling(job.id)}
                      data-testid="reel-job-cancel"
                    >
                      <XCircle className="h-4 w-4" aria-hidden />
                      {job.status === 'running' ? 'Detener el montaje' : 'Cancelar el encargo'}
                    </Button>
                  )}
                  {view.assetId && (
                    <Link
                      to={`..?recurso=${view.assetId}`}
                      relative="path"
                      className="text-sm font-medium text-primary hover:underline"
                      data-testid="reel-job-open"
                    >
                      Abrir en la biblioteca
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && !cancel.isPending && setCancelling(null)}
        title="¿Cancelar este reel?"
        description="Si ya se está montando, se detiene. No se podrá retomar: para tenerlo habrá que encargarlo otra vez."
        confirmLabel="Sí, cancelarlo"
        onConfirm={confirmCancel}
        loading={cancel.isPending}
      />
    </Card>
  );
}
