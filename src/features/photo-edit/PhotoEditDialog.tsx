// «Editar foto», desde la ficha de la biblioteca o desde una capa de imagen del
// editor (docs/edicion-fotos.md). Cuatro pestañas:
//   · Mejorar   luz, color y nitidez (automático o a mano) y encuadre, SIN IA;
//   · Recortes  1:1, 4:5 y 9:16 con encuadre inteligente, SIN IA;
//   · Fondo     quitar el fondo (en el navegador, gratis; o con IA si el
//               servidor la tiene) y poner uno liso, de la marca o de la
//               biblioteca, con sombra suave opcional (sin IA);
//   · Ampliar   ×2 o ×4 (IA).
// Lo de IA solo sale con `VITE_AI_PHOTO_EDIT_ENABLED` y si el servidor tiene
// modelo para esa acción. Cada resultado es un recurso NUEVO de la biblioteca,
// con su procedencia; la foto original no se toca nunca.
import { Crop, Eraser, ImagePlus, Maximize2, Sparkles, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Dialog, Notice, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { AiErrorNotice } from '@/features/ai/AiErrorNotice';
import { useGenerationProgress } from '@/features/ai/imageApi';
import { formatMicros } from '@/features/ai/money';
import { useActiveProfile } from '@/features/brand/api';
import { parseProfile } from '@/features/brand/profile';
import { ImagePickerDialog } from '@/features/content/editor/AssetPickerDialog';
import { deleteAssets, useSignedUrls } from '@/features/library/api';
import type { MediaAssetRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import {
  AI_OPERATION_LABEL,
  BACKGROUND_SUGGESTIONS,
  blobToBase64,
  canEditWithAi,
  fetchAsset,
  signedUrlFor,
  upscaleFactors,
  useAiEdit,
  useAiEditEstimate,
  useAiEditOptions,
  useSaveEdit,
  type AiEditChoice,
  type AiEditInput,
  type AiPhotoOperation,
} from './api';
import { encodePixels, loadCoverPixels, loadPixels, paint, PhotoLoadError } from './canvas';
import {
  centeredCrop,
  interestMap,
  NETWORK_ASPECT_LABEL,
  NETWORK_ASPECTS,
  smartCrop,
  type NetworkAspect,
} from './framing';
import {
  analyzeImage,
  applyAdjustments,
  autoAdjustments,
  cropPixels,
  downscale,
  isNeutral,
  NEUTRAL_ADJUSTMENTS,
  type Adjustments,
  type Pixels,
} from './pixels';
import { composeCutout } from './cutout/composition';
import { alphaOf, restorePlate, sameAspect, subjectMaskPixels } from './cutout/plate';
import { removalSupport, describeRemovalError, removeBackground, type CutoutProgress } from './cutout/remover';
import { editedFileName, photoEditProvenance, type PhotoEditStep } from './provenance';

type Tab = 'enhance' | 'crops' | 'background' | 'upscale' | 'ai';

interface PhotoEditDialogProps {
  asset: MediaAssetRow;
  /** Dirección firmada de la foto (si ya se tiene). */
  url?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Qué hacer con un resultado: abrirlo en la biblioteca o usarlo en el diseño. */
  onResult?: (asset: MediaAssetRow) => void;
  resultLabel?: string;
  /**
   * Máscara del sujeto (el plato), OPCIONAL: devuelve un PNG con las MISMAS
   * medidas que la foto original, donde lo opaco es el plato y lo transparente
   * el fondo. La da quien tenga un recorte (en el navegador o en el servidor).
   * Si no se pasa, «Cambiar el fondo con IA» la saca del recorte del navegador
   * (IS-Net, docs/edicion-fotos.md §9) y, además, vuelve a pegar el plato original
   * sobre el resultado. Si se pasa, se usa esa máscara y el plato no se vuelve a
   * pegar (no hay su recorte aquí). Sin recorte posible, avisa de que la IA puede
   * retocar el plato.
   */
  getSubjectMask?: (asset: MediaAssetRow) => Promise<Blob | null>;
  /** Pestaña con la que se abre (por defecto, «Mejorar»). */
  initialTab?: Tab;
}

const PREVIEW_SIDE = 480;
const SLIDERS: Array<{
  key: 'exposure' | 'contrast' | 'saturation' | 'warmth' | 'sharpness';
  label: string;
  min: number;
}> = [
  { key: 'exposure', label: 'Luz', min: -100 },
  { key: 'contrast', label: 'Contraste', min: -100 },
  { key: 'saturation', label: 'Color (saturación)', min: -100 },
  { key: 'warmth', label: 'Temperatura (fría ↔ cálida)', min: -100 },
  { key: 'sharpness', label: 'Nitidez', min: 0 },
];

/** Lienzo que pinta unos píxeles (vista previa). */
function PixelsCanvas({ pixels, className, testId }: { pixels: Pixels | null; className?: string; testId?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && pixels) paint(ref.current, pixels);
  }, [pixels]);
  return <canvas ref={ref} className={cn('block h-auto max-w-full', className)} data-testid={testId} />;
}

/** Formato del resultado: PNG si hay transparencia o el original lo era; si no, JPEG. */
function outputFormat(
  transparent: boolean,
  sourceMime: string,
): { mime: 'image/png' | 'image/jpeg'; ext: 'png' | 'jpg' } {
  return transparent || sourceMime === 'image/png'
    ? { mime: 'image/png', ext: 'png' }
    : { mime: 'image/jpeg', ext: 'jpg' };
}

export function PhotoEditDialog({
  asset: initial,
  url: initialUrl,
  open,
  onOpenChange,
  onResult,
  resultLabel,
  getSubjectMask,
  initialTab,
}: PhotoEditDialogProps) {
  // Se puede pasar a editar un resultado (p. ej., la foto sin fondo para ponerle otro).
  const [asset, setAsset] = useState(initial);
  const signed = useSignedUrls(initialUrl && asset.id === initial.id ? [] : [asset.storage_path]);
  const url = asset.id === initial.id && initialUrl ? initialUrl : signed.data?.get(asset.storage_path);

  // Lo cargado va con su dirección: al cambiar de foto, lo anterior deja de valer sin tocar el estado.
  const [load, setLoad] = useState<{
    url: string;
    result?: { pixels: Pixels; reduced: boolean };
    error?: string;
  } | null>(null);
  const loaded = load && load.url === url ? (load.result ?? null) : null;
  const loadError = load && load.url === url ? (load.error ?? null) : null;
  const [tab, setTab] = useState<Tab>(initialTab ?? 'enhance');
  const [results, setResults] = useState<MediaAssetRow[]>([]);
  const save = useSaveEdit(asset.brand_id);
  const aiOptions = useAiEditOptions(asset.brand_id, open && canEditWithAi(asset));
  const aiChoice = (operation: AiPhotoOperation) => aiOptions.data?.find((c) => c.operation === operation);

  useEffect(() => {
    if (!open || !url) return;
    let alive = true;
    loadPixels(url).then(
      (result) => alive && setLoad({ url, result: { pixels: result.pixels, reduced: result.reduced } }),
      (error: unknown) =>
        alive &&
        setLoad({
          url,
          error: error instanceof PhotoLoadError ? error.message : 'No se ha podido abrir la foto para editarla.',
        }),
    );
    return () => {
      alive = false;
    };
  }, [open, url]);

  const stats = useMemo(() => (loaded ? analyzeImage(loaded.pixels) : null), [loaded]);
  const preview = useMemo(() => (loaded ? downscale(loaded.pixels, PREVIEW_SIDE) : null), [loaded]);
  const map = useMemo(() => (loaded ? interestMap(loaded.pixels) : null), [loaded]);

  const addResult = (row: MediaAssetRow) => {
    setResults((current) => [row, ...current.filter((r) => r.id !== row.id)]);
  };

  /** Codifica y guarda en la biblioteca un resultado hecho en el navegador. */
  async function store(pixels: Pixels, steps: PhotoEditStep[]) {
    const transparent = analyzeImage(pixels).transparent;
    const format = outputFormat(transparent, asset.mime_type);
    const blob = await encodePixels(pixels, format.mime);
    const row = await save.mutateAsync({
      source: asset,
      blob,
      fileName: editedFileName(asset.file_name, steps, format.ext),
      width: pixels.width,
      height: pixels.height,
      provenance: photoEditProvenance({ sourceAssetId: asset.id, steps, width: pixels.width, height: pixels.height }),
    });
    addResult(row);
    return row;
  }

  const switchTo = (row: MediaAssetRow) => {
    setAsset(row);
    setTab('background');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Editar foto"
      description={`${asset.file_name}. La foto original no cambia: cada resultado se guarda aparte en la carpeta «Ediciones».`}
      size="lg"
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cerrar
        </Button>
      }
    >
      <div className="space-y-4" data-testid="photo-edit">
        {loadError ? (
          <Notice tone="warning">{loadError}</Notice>
        ) : !loaded || !stats || !preview || !map ? (
          <Spinner label="Abriendo la foto…" />
        ) : (
          <>
            {loaded.reduced && (
              <Notice tone="warning">
                La foto es muy grande: se edita reducida a {loaded.pixels.width} × {loaded.pixels.height} px.
              </Notice>
            )}
            <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
              <TabsList label="Ediciones">
                <TabsTrigger value="enhance">Mejorar</TabsTrigger>
                <TabsTrigger value="crops">Recortes</TabsTrigger>
                <TabsTrigger value="background">Fondo</TabsTrigger>
                {(aiChoice('replace_background') || aiChoice('enhance')) && (
                  <TabsTrigger value="ai">Fondo con IA</TabsTrigger>
                )}
                {aiChoice('upscale') && <TabsTrigger value="upscale">Ampliar</TabsTrigger>}
              </TabsList>
              <TabsContent value="enhance" className="pt-4">
                <EnhanceTab
                  pixels={loaded.pixels}
                  preview={preview}
                  stats={stats}
                  map={map}
                  saving={save.isPending}
                  onSave={(pixels, steps) => store(pixels, steps)}
                />
              </TabsContent>
              <TabsContent value="crops" className="pt-4">
                <CropsTab pixels={loaded.pixels} preview={preview} map={map} saving={save.isPending} onSave={store} />
              </TabsContent>
              <TabsContent value="background" className="pt-4">
                <BackgroundTab
                  key={asset.id}
                  asset={asset}
                  pixels={loaded.pixels}
                  transparent={stats.transparent}
                  saving={save.isPending}
                  onSave={store}
                  ai={aiChoice('remove_background')}
                  onAiResult={(row) => {
                    addResult(row);
                    switchTo(row);
                  }}
                />
              </TabsContent>
              {(aiChoice('replace_background') || aiChoice('enhance')) && (
                <TabsContent value="ai" className="space-y-6 pt-4">
                  {aiChoice('replace_background') && (
                    <AiAction
                      asset={asset}
                      operation="replace_background"
                      choice={aiChoice('replace_background')!}
                      onDone={addResult}
                      getSubjectMask={getSubjectMask}
                      pixels={loaded.pixels}
                    />
                  )}
                  {aiChoice('enhance') && (
                    <AiAction asset={asset} operation="enhance" choice={aiChoice('enhance')!} onDone={addResult} />
                  )}
                </TabsContent>
              )}
              {aiChoice('upscale') && (
                <TabsContent value="upscale" className="pt-4">
                  <AiAction asset={asset} operation="upscale" choice={aiChoice('upscale')!} onDone={addResult} />
                </TabsContent>
              )}
            </Tabs>
          </>
        )}

        {results.length > 0 && (
          <section
            className="space-y-2 rounded-lg border border-border p-3"
            aria-label="Resultados"
            data-testid="photo-edit-results"
          >
            <h3 className="text-sm font-medium">Guardado en la biblioteca</h3>
            <ul className="space-y-1">
              {results.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  data-testid="photo-edit-result"
                >
                  <span className="min-w-0 truncate">{row.file_name}</span>
                  {onResult && (
                    <Button size="sm" variant="ghost" onClick={() => onResult(row)} data-testid="photo-edit-use">
                      {resultLabel ?? 'Abrir'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}

// ─────────────────────────────── Mejorar ───────────────────────────────

function EnhanceTab({
  pixels,
  preview,
  stats,
  map,
  saving,
  onSave,
}: {
  pixels: Pixels;
  preview: Pixels;
  stats: ReturnType<typeof analyzeImage>;
  map: ReturnType<typeof interestMap>;
  saving: boolean;
  onSave: (pixels: Pixels, steps: PhotoEditStep[]) => Promise<unknown>;
}) {
  const [adjustments, setAdjustments] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [auto, setAuto] = useState(false);
  const [framing, setFraming] = useState<NetworkAspect | ''>('');
  const adjusted = useMemo(() => applyAdjustments(preview, adjustments), [preview, adjustments]);
  const unchanged = isNeutral(adjustments) && !framing;

  async function submit() {
    try {
      let result = applyAdjustments(pixels, adjustments);
      const steps: PhotoEditStep[] = [];
      if (!isNeutral(adjustments)) steps.push({ kind: 'adjust', adjustments, auto });
      if (framing) {
        const box = smartCrop(result, framing, map);
        result = cropPixels(result, box);
        steps.push({ kind: 'crop', aspect: framing, box, smart: true });
      }
      await onSave(result, steps);
      toast.success('Foto mejorada guardada en la biblioteca. La original no ha cambiado.');
    } catch (error) {
      toast.error(translateError(error));
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
      <div className="space-y-2">
        <PixelsCanvas pixels={adjusted} className="rounded-lg border border-border" testId="photo-edit-preview" />
        <p className="text-xs text-muted">Vista previa reducida. Se guarda a tamaño completo.</p>
      </div>
      <div className="space-y-3">
        <Button
          variant="secondary"
          onClick={() => {
            setAdjustments(autoAdjustments(stats));
            setAuto(true);
          }}
          data-testid="photo-edit-auto"
        >
          <Wand2 className="h-4 w-4" aria-hidden />
          Mejorar automáticamente
        </Button>
        {SLIDERS.map((slider) => (
          <label key={slider.key} className="block text-xs">
            <span className="flex justify-between">
              {slider.label}
              <span className="tabular-nums text-muted">{adjustments[slider.key]}</span>
            </span>
            <input
              type="range"
              min={slider.min}
              max={100}
              value={adjustments[slider.key]}
              onChange={(e) => setAdjustments((current) => ({ ...current, [slider.key]: Number(e.target.value) }))}
              className="w-full"
              data-testid={`photo-edit-${slider.key}`}
            />
          </label>
        ))}
        <label className="block text-xs">
          Encuadre
          <select
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1 text-sm"
            value={framing}
            onChange={(e) => setFraming(e.target.value as NetworkAspect | '')}
            data-testid="photo-edit-framing"
          >
            <option value="">Como está</option>
            {NETWORK_ASPECTS.map((aspect) => (
              <option key={aspect} value={aspect}>
                {NETWORK_ASPECT_LABEL[aspect]}, encuadre inteligente
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAdjustments(NEUTRAL_ADJUSTMENTS);
              setAuto(false);
              setFraming('');
            }}
          >
            Deshacer cambios
          </Button>
          <Button onClick={() => void submit()} disabled={unchanged} loading={saving} data-testid="photo-edit-save">
            <Sparkles className="h-4 w-4" aria-hidden />
            Guardar copia
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────── Recortes ───────────────────────────────

function CropsTab({
  pixels,
  preview,
  map,
  saving,
  onSave,
}: {
  pixels: Pixels;
  preview: Pixels;
  map: ReturnType<typeof interestMap>;
  saving: boolean;
  onSave: (pixels: Pixels, steps: PhotoEditStep[]) => Promise<unknown>;
}) {
  const [aspects, setAspects] = useState<NetworkAspect[]>([...NETWORK_ASPECTS]);
  const [smart, setSmart] = useState(true);
  const [busy, setBusy] = useState(false);
  const boxes = useMemo(
    () =>
      Object.fromEntries(
        NETWORK_ASPECTS.map((aspect) => [
          aspect,
          smart ? smartCrop(pixels, aspect, map) : centeredCrop(pixels, aspect),
        ]),
      ) as Record<NetworkAspect, ReturnType<typeof smartCrop>>,
    [pixels, map, smart],
  );
  const previews = useMemo(() => {
    const scale = preview.width / pixels.width;
    return Object.fromEntries(
      NETWORK_ASPECTS.map((aspect) => {
        const box = boxes[aspect];
        return [
          aspect,
          cropPixels(preview, {
            x: box.x * scale,
            y: box.y * scale,
            width: box.width * scale,
            height: box.height * scale,
          }),
        ];
      }),
    ) as Record<NetworkAspect, Pixels>;
  }, [preview, pixels.width, boxes]);

  async function submit() {
    setBusy(true);
    try {
      for (const aspect of aspects) {
        const box = boxes[aspect];
        await onSave(cropPixels(pixels, box), [{ kind: 'crop', aspect, box, smart }]);
      }
      toast.success(
        `${aspects.length === 1 ? 'Recorte guardado' : `${aspects.length} recortes guardados`} en la biblioteca. La original no ha cambiado.`,
      );
    } catch (error) {
      toast.error(translateError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        El recorte más grande que cabe en cada formato, colocado donde hay más detalle y color (sin IA: no reconoce
        objetos; con fondos muy cargados, mira la vista previa).
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={smart}
          onChange={(e) => setSmart(e.target.checked)}
          data-testid="photo-edit-smart"
        />
        Encuadre inteligente (si no, centrado)
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        {NETWORK_ASPECTS.map((aspect) => {
          const checked = aspects.includes(aspect);
          const box = boxes[aspect];
          return (
            <label
              key={aspect}
              className={cn(
                'flex cursor-pointer flex-col gap-2 rounded-lg border p-2 text-xs',
                checked ? 'border-primary bg-primary-soft' : 'border-border',
              )}
            >
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setAspects((current) =>
                      checked
                        ? current.filter((a) => a !== aspect)
                        : NETWORK_ASPECTS.filter((a) => a === aspect || current.includes(a)),
                    )
                  }
                  data-testid={`photo-edit-crop-${aspect}`}
                />
                {NETWORK_ASPECT_LABEL[aspect]}
              </span>
              <PixelsCanvas pixels={previews[aspect]} className="max-h-40 rounded" />
              <span className="text-muted">
                {box.width} × {box.height} px
              </span>
            </label>
          );
        })}
      </div>
      <Button
        onClick={() => void submit()}
        disabled={aspects.length === 0}
        loading={busy || saving}
        data-testid="photo-edit-crops-save"
      >
        <Crop className="h-4 w-4" aria-hidden />
        {aspects.length === 0
          ? 'Elige al menos un formato'
          : `Guardar ${aspects.length === 1 ? 'el recorte' : `${aspects.length} recortes`}`}
      </Button>
    </div>
  );
}

// ─────────────────────────────── Fondo ───────────────────────────────

function BackgroundTab({
  asset,
  pixels,
  transparent,
  saving,
  onSave,
  ai,
  onAiResult,
}: {
  asset: MediaAssetRow;
  pixels: Pixels;
  transparent: boolean;
  saving: boolean;
  onSave: (pixels: Pixels, steps: PhotoEditStep[]) => Promise<MediaAssetRow>;
  ai: AiEditChoice | undefined;
  onAiResult: (row: MediaAssetRow) => void;
}) {
  const profile = useActiveProfile(asset.brand_id);
  const brandColors = useMemo(
    () =>
      (profile.data ? parseProfile(profile.data.data).visual.colors : []).map((c) => ({
        hex: c.hex.toUpperCase(),
        name: c.name,
      })),
    [profile.data],
  );
  const support = useMemo(() => removalSupport(), []);
  const [engine, setEngine] = useState<'browser' | 'ai'>(support.ok || !ai ? 'browser' : 'ai');
  // El recorte hecho en el navegador (todavía sin guardar).
  const [cutout, setCutout] = useState<{ pixels: Pixels; model: string } | null>(null);
  const [progress, setProgress] = useState<CutoutProgress | null>(null);
  const [cutting, setCutting] = useState(false);
  const [cutError, setCutError] = useState<string | null>(null);
  const [shadow, setShadow] = useState(false);
  const [color, setColor] = useState('#FFFFFF');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  // La foto con la que se trabaja: la que ya no tiene fondo, o el recorte hecho aquí.
  const subject = transparent ? pixels : (cutout?.pixels ?? null);
  const prefix: PhotoEditStep[] =
    !transparent && cutout ? [{ kind: 'remove_background', engine: 'browser', model: cutout.model }] : [];
  const preview = useMemo(
    () => (subject ? composeCutout(downscale(subject, 360), { kind: 'color', hex: color }, { shadow }) : null),
    [subject, color, shadow],
  );

  async function cut() {
    setCutting(true);
    setCutError(null);
    setProgress(null);
    try {
      const result = await removeBackground(pixels, setProgress);
      setCutout({ pixels: result.pixels, model: result.model });
    } catch (error) {
      setCutError(describeRemovalError(error));
    } finally {
      setCutting(false);
      setProgress(null);
    }
  }

  async function apply(
    background: { type: 'color'; hex: string } | { type: 'asset'; asset: MediaAssetRow; url: string },
  ) {
    if (!subject) return;
    setBusy(true);
    try {
      const backdrop =
        background.type === 'color'
          ? ({ kind: 'color', hex: background.hex } as const)
          : ({
              kind: 'image',
              pixels: await loadCoverPixels(background.url, subject.width, subject.height),
            } as const);
      const result = composeCutout(subject, backdrop, { shadow });
      await onSave(result, [
        ...prefix,
        {
          kind: 'background',
          background:
            background.type === 'color'
              ? { type: 'color', hex: background.hex }
              : { type: 'asset', assetId: background.asset.id },
          ...(shadow ? { shadow: true } : {}),
        },
      ]);
      toast.success('Foto con fondo nuevo guardada en la biblioteca. La original no ha cambiado.');
    } catch (error) {
      toast.error(error instanceof PhotoLoadError ? error.message : translateError(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCutout() {
    if (!subject) return;
    setBusy(true);
    try {
      await onSave(subject, prefix);
      toast.success('Foto sin fondo guardada en la biblioteca (PNG transparente). La original no ha cambiado.');
    } catch (error) {
      toast.error(translateError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {!subject && (
        <div className="space-y-3" data-testid="photo-edit-cutout">
          <p className="text-sm">Para cambiar el fondo, primero hay que quitarlo.</p>
          {ai && (
            <fieldset className="space-y-1 text-sm">
              <legend className="sr-only">Cómo quitar el fondo</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="cutout-engine"
                  checked={engine === 'browser'}
                  onChange={() => setEngine('browser')}
                  data-testid="photo-edit-engine-browser"
                />
                En este navegador (gratis, sin IA)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="cutout-engine"
                  checked={engine === 'ai'}
                  onChange={() => setEngine('ai')}
                  data-testid="photo-edit-engine-ai"
                />
                Con IA (tiene coste)
              </label>
            </fieldset>
          )}
          {engine === 'browser' && (
            <div className="space-y-2" data-testid="photo-edit-cutout-browser">
              {support.ok ? (
                <>
                  <p className="text-xs text-muted">
                    Gratis y sin IA externa: la foto no sale de tu navegador. La primera vez descarga un modelo de unos
                    85 MB (queda guardado); después tarda unos segundos.
                  </p>
                  {cutError && <Notice tone="warning">{cutError}</Notice>}
                  {cutting && <CutoutProgressBar progress={progress} />}
                  <Button onClick={() => void cut()} loading={cutting} data-testid="photo-edit-cutout-run">
                    <Eraser className="h-4 w-4" aria-hidden />
                    Quitar el fondo
                  </Button>
                </>
              ) : (
                <Notice tone="warning">
                  <span data-testid="photo-edit-cutout-unsupported">{support.reason}</span>
                </Notice>
              )}
            </div>
          )}
          {engine === 'ai' && ai && (
            <AiAction asset={asset} operation="remove_background" choice={ai} onDone={onAiResult} />
          )}
        </div>
      )}
      {subject && (
        <div className="space-y-3" data-testid="photo-edit-backgrounds">
          <p className="text-sm">
            {transparent && !cutout ? 'Esta foto ya no tiene fondo.' : 'Fondo quitado.'} Elige uno nuevo (sin IA):
          </p>
          <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
            <PixelsCanvas
              pixels={preview}
              className="rounded-lg border border-border"
              testId="photo-edit-cutout-preview"
            />
            <div className="space-y-3">
              {brandColors.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {brandColors.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-subtle"
                      onClick={() => void apply({ type: 'color', hex: c.hex })}
                      disabled={busy || saving}
                      data-testid="photo-edit-brand-color"
                    >
                      <span
                        className="h-4 w-4 rounded border border-border"
                        style={{ backgroundColor: c.hex }}
                        aria-hidden
                      />
                      {c.name || c.hex}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs">
                  Color liso
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value.toUpperCase())}
                    data-testid="photo-edit-color"
                  />
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void apply({ type: 'color', hex: color })}
                  loading={busy || saving}
                  data-testid="photo-edit-color-apply"
                >
                  Poner este color
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPicking(true)} disabled={busy || saving}>
                  <ImagePlus className="h-4 w-4" aria-hidden />
                  Imagen de la biblioteca
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={shadow}
                  onChange={(e) => setShadow(e.target.checked)}
                  data-testid="photo-edit-shadow"
                />
                Sombra suave (para que no parezca flotar)
              </label>
              {cutout && !transparent && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void saveCutout()}
                  disabled={busy || saving}
                  data-testid="photo-edit-cutout-save"
                >
                  Guardar solo sin fondo (PNG transparente)
                </Button>
              )}
            </div>
          </div>
          <BackgroundPicker
            brandId={asset.brand_id}
            organizationId={asset.organization_id}
            open={picking}
            onOpenChange={setPicking}
            onPick={(row, url) => {
              setPicking(false);
              void apply({ type: 'asset', asset: row, url });
            }}
          />
        </div>
      )}
    </div>
  );
}

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0);

/** Progreso del recorte en el navegador: descarga del modelo (la 1ª vez), preparación y recorte. */
function CutoutProgressBar({ progress }: { progress: CutoutProgress | null }) {
  const downloading = progress?.phase === 'downloading';
  const pct = downloading ? Math.min(100, Math.round((progress.received / Math.max(1, progress.total)) * 100)) : null;
  const label = downloading
    ? `Descargando el modelo (solo la primera vez): ${megabytes(progress.received)} de ${megabytes(progress.total)} MB`
    : progress?.phase === 'running'
      ? 'Quitando el fondo…'
      : 'Preparando el modelo…';
  return (
    <div className="space-y-1" data-testid="photo-edit-cutout-progress">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        className="h-2 overflow-hidden rounded bg-subtle"
      >
        <div
          className={cn('h-full bg-primary', pct === null && 'w-1/3 animate-pulse')}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

/** Elegir la imagen de fondo en la biblioteca y conseguir su dirección firmada. */
function BackgroundPicker({
  brandId,
  organizationId,
  open,
  onOpenChange,
  onPick,
}: {
  brandId: string;
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (asset: MediaAssetRow, url: string) => void;
}) {
  const pick = (asset: MediaAssetRow) => {
    signedUrlFor(asset.storage_path).then(
      (url) => (url ? onPick(asset, url) : toast.error('No se ha podido abrir esa imagen.')),
      (error: unknown) => toast.error(translateError(error)),
    );
  };
  return (
    <ImagePickerDialog
      brandId={brandId}
      libraryPath={`/o/${organizationId}/m/${brandId}/biblioteca`}
      open={open}
      onOpenChange={onOpenChange}
      title="Imagen de fondo"
      onPick={pick}
    />
  );
}

// ─────────────────────────────── Con IA ───────────────────────────────

/** Lo necesario para volver a pegar el plato original sobre el resultado de la IA. */
interface PlateProtection {
  original: Pixels;
  /** Alfa del recorte (0–255) con las medidas de `original`. */
  alpha: Uint8Array;
  maskModel: string;
  prompt: string;
}

/** Una edición con IA: coste máximo, tratamiento de los datos, lanzar y esperar. */
function AiAction({
  asset,
  operation,
  choice,
  onDone,
  getSubjectMask,
  pixels,
}: {
  asset: MediaAssetRow;
  operation: AiPhotoOperation;
  choice: AiEditChoice;
  onDone: (row: MediaAssetRow) => void;
  getSubjectMask?: (asset: MediaAssetRow) => Promise<Blob | null>;
  /** La foto original ya cargada (para sacar el recorte del plato y volver a pegarlo). */
  pixels?: Pixels;
}) {
  const factors = operation === 'upscale' ? upscaleFactors(asset.width, asset.height) : [];
  const [scale, setScale] = useState<2 | 4>(factors[0] ?? 2);
  const [background, setBackground] = useState('');
  const isBackground = operation === 'replace_background';
  // La máscara viene de quien integra el diálogo o, si no, del recorte del navegador.
  const browserCutout = useMemo(() => removalSupport().ok && Boolean(pixels), [pixels]);
  const withMask = isBackground && (Boolean(getSubjectMask) || browserCutout) && choice.usesSubjectMask !== false;
  // Solo se puede volver a pegar el plato con el recorte propio.
  const canProtect = withMask && !getSubjectMask;
  const [protect, setProtect] = useState(true);
  const [maskProgress, setMaskProgress] = useState<CutoutProgress | null>(null);
  const [preparing, setPreparing] = useState(false);
  const plate = useRef<PlateProtection | null>(null);
  const saveEdit = useSaveEdit(asset.brand_id);
  // Para estimar basta un texto cualquiera: el coste no depende de lo que se pida.
  const input = useMemo<AiEditInput>(
    () => ({
      assetId: asset.id,
      operation,
      ...(operation === 'upscale' ? { scale } : {}),
      ...(isBackground ? { prompt: 'fondo', ...(withMask ? { maskPresent: true } : {}) } : {}),
    }),
    [asset.id, operation, scale, isBackground, withMask],
  );
  const possible = operation !== 'upscale' || factors.length > 0;
  const estimate = useAiEditEstimate(asset.brand_id, input, possible);
  const edit = useAiEdit(asset.brand_id);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const progress = useGenerationProgress(asset.brand_id, pendingId);
  const delivered = useRef<string | null>(null);
  const finished = progress.data?.status === 'completed' ? progress.data.asset : null;
  /** Entrega el resultado; si hay plato que proteger, lo vuelve a pegar antes y guarda esa versión. */
  const deliver = useCallback(
    async (row: MediaAssetRow) => {
      const protection = plate.current;
      plate.current = null;
      if (protection) {
        try {
          const url = await signedUrlFor(row.storage_path);
          if (!url) throw new Error('sin dirección');
          const generated = await loadPixels(url);
          if (!sameAspect(generated.pixels, protection.original)) throw new Error('proporción');
          const merged = restorePlate(generated.pixels, protection.original, protection.alpha);
          const format = outputFormat(false, asset.mime_type);
          const steps: PhotoEditStep[] = [
            {
              kind: 'ai_background',
              prompt: protection.prompt,
              model: choice.model,
              maskModel: protection.maskModel,
              plateProtected: true,
            },
          ];
          const saved = await saveEdit.mutateAsync({
            source: asset,
            blob: await encodePixels(merged, format.mime),
            fileName: editedFileName(asset.file_name, steps, format.ext),
            width: merged.width,
            height: merged.height,
            provenance: photoEditProvenance({
              sourceAssetId: asset.id,
              steps,
              width: merged.width,
              height: merged.height,
            }),
          });
          // La versión sin proteger ya sobra; si no se pudiera borrar, queda en la biblioteca.
          await deleteAssets([row.id]).catch(() => undefined);
          toast.success(
            `${AI_OPERATION_LABEL[operation]}: listo, con el plato original intacto. La original no ha cambiado.`,
          );
          onDone(saved);
          return;
        } catch {
          toast.warning(
            'La IA cambió el fondo, pero no se ha podido volver a pegar el plato original. Se deja el resultado de la IA: revisa el plato.',
          );
          onDone(row);
          return;
        }
      }
      toast.success(`${AI_OPERATION_LABEL[operation]}: listo. Está en la biblioteca; la original no ha cambiado.`);
      onDone(row);
    },
    [asset, choice.model, onDone, operation, saveEdit],
  );
  useEffect(() => {
    if (!finished || delivered.current === finished.id) return;
    delivered.current = finished.id;
    void deliver(finished);
  }, [finished, deliver]);
  const running =
    preparing ||
    saveEdit.isPending ||
    edit.isPending ||
    (pendingId !== null && progress.data?.status !== 'completed' && progress.data?.status !== 'failed');

  async function run() {
    setPendingId(null);
    let request: AiEditInput = input;
    plate.current = null;
    if (isBackground) {
      request = { assetId: asset.id, operation, prompt: background.trim() };
      if (withMask) {
        try {
          if (getSubjectMask) {
            const mask = await getSubjectMask(asset);
            if (mask) request = { ...request, subjectMask: await blobToBase64(mask) };
          } else if (pixels) {
            setPreparing(true);
            setMaskProgress(null);
            const cut = await removeBackground(pixels, setMaskProgress);
            const alpha = alphaOf(cut.pixels);
            const mask = subjectMaskPixels(
              alpha,
              cut.pixels.width,
              cut.pixels.height,
              asset.width ?? pixels.width,
              asset.height ?? pixels.height,
            );
            request = { ...request, subjectMask: await blobToBase64(await encodePixels(mask, 'image/png')) };
            if (protect) {
              plate.current = { original: pixels, alpha, maskModel: cut.model, prompt: background.trim() };
            }
          }
        } catch (error) {
          toast.error(
            getSubjectMask
              ? 'No se ha podido preparar la máscara del plato. Inténtalo de nuevo.'
              : `No se ha podido recortar el plato para protegerlo. ${describeRemovalError(error)}`,
          );
          return;
        } finally {
          setPreparing(false);
          setMaskProgress(null);
        }
      }
    }
    edit.mutateAsync(request).then(
      async (result) => {
        if (result.status === 'pending') {
          setPendingId(result.generationId);
          return;
        }
        const row = await fetchAsset(asset.brand_id, result.asset.id).catch(() => null);
        if (!row) {
          plate.current = null;
          toast.error('La foto se editó y está en la biblioteca, pero no se ha podido abrir aquí.');
          return;
        }
        await deliver(row);
      },
      () => undefined,
    );
  }

  const Icon = operation === 'upscale' ? Maximize2 : isBackground || operation === 'enhance' ? Sparkles : Eraser;
  return (
    <div className="space-y-3" data-testid={`photo-edit-ai-${operation}`}>
      {operation === 'upscale' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {factors.length === 0 ? (
            <Notice tone="warning">Esta foto ya es grande: ampliada pasaría de 4096 px por lado.</Notice>
          ) : (
            factors.map((factor) => (
              <label key={factor} className="flex items-center gap-1">
                <input type="radio" name="upscale" checked={scale === factor} onChange={() => setScale(factor)} />×
                {factor} ({(asset.width ?? 0) * factor} × {(asset.height ?? 0) * factor} px)
              </label>
            ))
          )}
        </div>
      )}
      {isBackground && (
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`photo-edit-ai-bg-${asset.id}`}>
            ¿Qué fondo quieres?
          </label>
          <input
            id={`photo-edit-ai-bg-${asset.id}`}
            type="text"
            maxLength={500}
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="Por ejemplo: mesa de mármol blanco con luz cálida"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            data-testid="photo-edit-ai-background-text"
          />
          <div className="flex flex-wrap gap-2" aria-label="Sugerencias de fondo">
            {BACKGROUND_SUGGESTIONS.map((idea) => (
              <button
                key={idea}
                type="button"
                className="rounded-full border border-border px-3 py-1 text-xs hover:bg-subtle"
                onClick={() => setBackground(idea)}
                data-testid="photo-edit-ai-background-idea"
              >
                {idea}
              </button>
            ))}
          </div>
          {withMask ? (
            <div className="space-y-2">
              <Notice tone="info">
                {canProtect && protect
                  ? 'Se recorta el plato en tu navegador y se le dice a la IA que no lo toque. Como la IA lo trata solo como orientación, al terminar se vuelve a pegar encima el plato original.'
                  : 'Se protege el plato con su recorte. La IA lo trata como orientación: revisa el resultado antes de usarlo.'}
              </Notice>
              {canProtect && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={protect}
                    onChange={(e) => setProtect(e.target.checked)}
                    data-testid="photo-edit-ai-protect"
                  />
                  Proteger el plato original
                </label>
              )}
              {preparing && <CutoutProgressBar progress={maskProgress} />}
            </div>
          ) : (
            <Notice tone="warning">
              No hay recorte del plato: la IA puede retocar también el plato (forma, colores, guarnición). Revisa el
              resultado; la original no cambia.
            </Notice>
          )}
        </div>
      )}
      {operation === 'enhance' && (
        <p className="text-sm">
          Mejora la luz y el color con IA. Puede cambiar detalles del plato: revisa el resultado. Si solo quieres
          ajustar luz y color, la pestaña «Mejorar» lo hace sin IA y sin tocar el plato.
        </p>
      )}
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="neutral">Con IA</Badge>
        {!choice.euProcessing && <Badge tone="warning">Se procesa fuera de la UE o en región desconocida</Badge>}
        {choice.untestedAdapter && <Badge tone="neutral">Proveedor sin probar todavía</Badge>}
      </div>
      {possible && (
        <p className="text-xs text-muted" data-testid="photo-edit-ai-cost">
          {estimate.isPending
            ? 'Calculando el coste…'
            : estimate.data
              ? `Coste máximo: ${formatMicros(estimate.data.costMicros)} (se descuenta del cupo de IA de la organización).`
              : null}
        </p>
      )}
      {estimate.isError && <AiErrorNotice error={estimate.error} />}
      {edit.isError && <AiErrorNotice error={edit.error} onRetry={() => void run()} />}
      {progress.data?.status === 'failed' && <Notice tone="warning">{progress.data.message}</Notice>}
      {pendingId && running && (
        <Spinner label="La IA está trabajando. Puedes cerrar: el resultado llegará igualmente a la biblioteca." />
      )}
      <Button
        onClick={() => void run()}
        disabled={!possible || running || (isBackground && background.trim() === '')}
        loading={edit.isPending}
        data-testid={`photo-edit-ai-run-${operation}`}
      >
        <Icon className="h-4 w-4" aria-hidden />
        {operation === 'upscale'
          ? `Ampliar ×${scale}`
          : isBackground
            ? 'Cambiar el fondo'
            : operation === 'enhance'
              ? 'Mejorar con IA'
              : 'Quitar el fondo'}
      </Button>
    </div>
  );
}
