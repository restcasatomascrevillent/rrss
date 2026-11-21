import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Dialog, Field, Input, Notice } from '@/components/ui';
import { assetKeys, uploadAsset } from '@/features/library/api';
import { translateError } from '@/lib/errors';
import { formatBytes } from '@/lib/utils';
import { pageView, type ContentDocument } from '../document';
import type { ImageLookup } from '../editor/canvas/nodes';
import { downloadBlob } from './download';
import {
  availablePixelRatios,
  buildProvenance,
  clampQuality,
  DEFAULT_QUALITY,
  EXPORT_FOLDER,
  EXPORT_FORMATS,
  EXPORT_TAG,
  ExportError,
  exportSize,
  normalizeFileName,
  pageFileName,
  suggestFileName,
  type ExportFormat,
} from './options';

interface ExportImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lo que se ve en el lienzo, con los cambios sin guardar. */
  document: ContentDocument;
  /** Carga las tipografías de la marca antes de dibujar (si no, se exportaría con la de reserva). */
  prepareFonts?: () => Promise<void>;
  images: ImageLookup;
  title: string;
  contentId: string;
  orgId: string;
  brandId: string;
  /** Versión guardada sobre la que se trabaja (0 si la pieza no se ha guardado nunca). */
  version: number;
  /** El documento tiene cambios sin guardar. */
  dirty: boolean;
  /** Se puede crear un recurso en la biblioteca (permiso de edición). */
  canSaveToLibrary: boolean;
  /** Se puede guardar una versión (permiso de edición y pieza no archivada). */
  canSaveVersion: boolean;
  /** Guarda una versión y devuelve su número; null si no se ha podido (el editor ya ha avisado). */
  onSaveVersion: (note: string) => Promise<number | null>;
  libraryPath: string;
}

type Step = 'idle' | 'saving' | 'rendering' | 'uploading' | 'done';

const STEP_LABEL: Record<Exclude<Step, 'idle' | 'done'>, string> = {
  saving: 'Guardando la versión…',
  rendering: 'Preparando las tipografías y dibujando…',
  uploading: 'Guardando en la biblioteca…',
};

export function ExportImageDialog(props: ExportImageDialogProps) {
  const { document, title, contentId, orgId, brandId, version, dirty } = props;
  const queryClient = useQueryClient();
  // Un carrusel (varias páginas) se exporta entero y en JPEG: es lo que se publica.
  const pageCount = document.pages.length;
  const multi = pageCount > 1;
  const [chosenFormat, setFormat] = useState<ExportFormat>('png');
  const format: ExportFormat = multi ? 'jpeg' : chosenFormat;
  const [renderingPage, setRenderingPage] = useState(0);
  const [quality, setQuality] = useState(DEFAULT_QUALITY);
  const [pixelRatio, setPixelRatio] = useState(1);
  const [customName, setCustomName] = useState<string | null>(null);
  const [download, setDownload] = useState(true);
  const [toLibrary, setToLibrary] = useState(props.canSaveToLibrary);
  const [saveFirst, setSaveFirst] = useState(true);
  const [step, setStep] = useState<Step>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<ExportError | string | null>(null);
  const [result, setResult] = useState<{
    fileName: string;
    files: number;
    bytes: number;
    downloaded: boolean;
    saved: boolean;
  } | null>(null);

  const ratios = useMemo(() => availablePixelRatios(document.canvas), [document.canvas]);
  const ratio = ratios.includes(pixelRatio) ? pixelRatio : 1;
  const size = exportSize(document.canvas, ratio);
  const busy = step !== 'idle' && step !== 'done';
  // Con cambios sin guardar, la procedencia solo es exacta si antes se guarda una versión.
  const willSaveVersion = dirty && props.canSaveVersion && toLibrary && saveFirst;
  const previewVersion = willSaveVersion ? version + 1 : version > 0 ? version : null;
  const previewUnsaved = dirty && !willSaveVersion;
  const nameOptions = { title, format, width: size.width, height: size.height };
  const suggested = suggestFileName({
    ...nameOptions,
    version: previewVersion,
    unsaved: previewUnsaved,
    page: multi ? 1 : undefined,
  });

  function reset() {
    setStep('idle');
    setProgress(0);
    setError(null);
    setResult(null);
  }

  function close(next: boolean) {
    if (busy) return;
    if (!next) reset();
    props.onOpenChange(next);
  }

  async function run() {
    if (!download && !toLibrary) return;
    setError(null);
    setResult(null);
    let exportedVersion: number | null = version > 0 ? version : null;
    let unsaved = dirty;
    try {
      if (willSaveVersion) {
        setStep('saving');
        const saved = await props.onSaveVersion('Guardada antes de exportar la imagen');
        if (saved === null) {
          setError('No se ha guardado la versión, así que no se ha exportado nada. Revisa el aviso del editor.');
          setStep('idle');
          return;
        }
        exportedVersion = saved;
        unsaved = false;
      }

      setStep('rendering');
      await props.prepareFonts?.();
      const { renderDocument } = await import('../editor/canvas/exporter');
      let bytes = 0;
      let firstName = '';
      let saved = false;
      // Página a página y en orden: la procedencia de cada imagen dice su número.
      for (let index = 0; index < pageCount; index++) {
        setStep('rendering');
        setRenderingPage(index + 1);
        const rendered = await renderDocument(pageView(document, index), props.images, {
          format,
          quality: clampQuality(quality),
          pixelRatio: ratio,
        });
        const page = multi ? index + 1 : undefined;
        const base =
          customName !== null
            ? normalizeFileName(customName, format)
            : suggestFileName({ ...nameOptions, version: exportedVersion, unsaved, page });
        const fileName = customName !== null && page ? pageFileName(base, page, format) : base;
        if (index === 0) firstName = fileName;
        bytes += rendered.blob.size;

        if (download) downloadBlob(rendered.blob, fileName);

        if (toLibrary) {
          setStep('uploading');
          setProgress(0);
          const file = new File([rendered.blob], fileName, { type: EXPORT_FORMATS[format].mime });
          await uploadAsset({
            organizationId: orgId,
            brandId,
            file,
            dimensions: { width: rendered.width, height: rendered.height, durationMs: null },
            folder: EXPORT_FOLDER,
            tags: [EXPORT_TAG],
            provenance: buildProvenance({
              contentId,
              version: exportedVersion,
              unsavedChanges: unsaved,
              format,
              width: rendered.width,
              height: rendered.height,
              pixelRatio: ratio,
              exportedAt: new Date(),
              page: page ? { number: page, count: pageCount } : undefined,
            }),
            onProgress: setProgress,
          });
          saved = true;
        }
      }
      if (saved) await queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
      setResult({ fileName: firstName, files: pageCount, bytes, downloaded: download, saved });
      setStep('done');
      if (multi) {
        toast.success(`${pageCount} imágenes exportadas${saved ? ' y guardadas en la biblioteca' : ''}`);
      } else {
        toast.success(saved ? 'Imagen exportada y guardada en la biblioteca' : 'Imagen exportada');
      }
    } catch (caught) {
      setError(caught instanceof ExportError ? caught : translateError(caught));
      setStep('idle');
    }
  }

  const message = error instanceof ExportError ? error.message : error;

  return (
    <Dialog
      open={props.open}
      onOpenChange={close}
      title={multi ? 'Exportar el carrusel' : 'Exportar imagen'}
      description={
        multi
          ? `Una imagen JPEG por página (${pageCount}), en orden, a ${document.canvas.width}×${document.canvas.height} px a escala 1.`
          : `Se genera a tamaño real del lienzo: ${document.canvas.width}×${document.canvas.height} px a escala 1.`
      }
      footer={
        step === 'done' ? (
          <Button onClick={() => close(false)} data-testid="export-close">
            Cerrar
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => close(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              onClick={() => void run()}
              loading={busy}
              disabled={!download && !toLibrary}
              data-testid="export-confirm"
            >
              Exportar
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {dirty && (
          <Notice tone="warning">
            <span data-testid="export-dirty-notice">
              Tienes cambios sin guardar: se exporta lo que ves ahora, no la versión{' '}
              {version > 0 ? version : 'guardada'}.
            </span>
          </Notice>
        )}

        {multi && (
          <Notice>
            <span data-testid="export-pages-notice">
              Es un carrusel de {pageCount} páginas: se exportan todas, en JPEG (lo que publica Instagram), cada una con
              su número de página en el nombre y en la procedencia.
            </span>
          </Notice>
        )}

        {!multi && (
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="text-sm font-medium">Formato</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(EXPORT_FORMATS) as ExportFormat[]).map((value) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <input
                  type="radio"
                  name="export-format"
                  value={value}
                  checked={format === value}
                  onChange={() => setFormat(value)}
                  data-testid={`export-format-${value}`}
                />
                <span>
                  <span className="font-medium">{EXPORT_FORMATS[value].label}</span>
                  <span className="block text-xs text-muted">{EXPORT_FORMATS[value].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        )}

        {format === 'jpeg' && (
          <Field label={`Calidad: ${Math.round(quality * 100)} %`} hint="Más calidad, más peso.">
            {(fieldProps) => (
              <input
                {...fieldProps}
                type="range"
                min={50}
                max={100}
                step={1}
                value={Math.round(quality * 100)}
                disabled={busy}
                onChange={(e) => setQuality(clampQuality(Number(e.target.value) / 100))}
                className="w-full"
                data-testid="export-quality"
              />
            )}
          </Field>
        )}

        {ratios.length > 1 && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="text-sm font-medium">Tamaño</legend>
            <div className="flex flex-wrap gap-2">
              {ratios.map((value) => {
                const s = exportSize(document.canvas, value);
                return (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="export-ratio"
                      checked={ratio === value}
                      onChange={() => setPixelRatio(value)}
                      data-testid={`export-ratio-${value}`}
                    />
                    <span>
                      {value === 1 ? 'Tamaño real' : 'Doble'} · {s.width}×{s.height} px
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        <Field
          label="Nombre del archivo"
          hint={
            multi
              ? `Cada página añade su número (-p1, -p2…) y se guarda como .${EXPORT_FORMATS[format].extension}.`
              : `Se guarda como .${EXPORT_FORMATS[format].extension}.`
          }
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={customName ?? suggested}
              maxLength={120}
              disabled={busy}
              onChange={(e) => setCustomName(e.target.value)}
              data-testid="export-name"
            />
          )}
        </Field>

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="text-sm font-medium">Qué hacer con la imagen</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={download}
              onChange={(e) => setDownload(e.target.checked)}
              data-testid="export-download"
            />
            Descargar el archivo
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={toLibrary}
              disabled={!props.canSaveToLibrary}
              onChange={(e) => setToLibrary(e.target.checked)}
              data-testid="export-library"
            />
            Guardarla en la biblioteca de la marca
          </label>
          {!props.canSaveToLibrary && (
            <p className="text-xs text-muted">Con tu rol no puedes añadir recursos a la biblioteca.</p>
          )}
          {dirty && props.canSaveToLibrary && toLibrary && props.canSaveVersion && (
            <label className="ml-6 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={saveFirst}
                onChange={(e) => setSaveFirst(e.target.checked)}
                className="mt-1"
                data-testid="export-save-first"
              />
              <span>
                Guardar antes una versión nueva
                <span className="block text-xs text-muted">
                  Así el recurso indica exactamente de qué versión sale. Si no, quedará anotado «con cambios sin
                  guardar» sobre la versión {version > 0 ? version : 'inicial'}.
                </span>
              </span>
            </label>
          )}
          {dirty && toLibrary && !props.canSaveVersion && (
            <p className="ml-6 text-xs text-muted">
              Con tu rol o con la pieza archivada no se puede guardar versión: el recurso quedará anotado «con cambios
              sin guardar».
            </p>
          )}
        </fieldset>

        {busy && (
          <div className="space-y-2" aria-live="polite" data-testid="export-progress">
            <p className="text-sm">
              {STEP_LABEL[step as keyof typeof STEP_LABEL]}
              {multi && step !== 'saving' && ` Página ${renderingPage} de ${pageCount}.`}
            </p>
            {step === 'uploading' && (
              <div
                role="progressbar"
                aria-label="Subida a la biblioteca"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                className="h-2 overflow-hidden rounded-full bg-subtle"
              >
                <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        )}

        {message && (
          <div
            role="alert"
            className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
            data-testid="export-error"
          >
            {message}
          </div>
        )}

        {step === 'done' && result && (
          <div role="status" className="rounded-lg bg-subtle px-3 py-2 text-sm" data-testid="export-done">
            <p className="font-medium">
              {result.files > 1 ? `${result.files} imágenes (${result.fileName}…)` : result.fileName}
            </p>
            <p className="text-muted">
              {size.width}×{size.height} px · {formatBytes(result.bytes)}
              {result.downloaded && ' · descargada'}
              {result.saved && ' · guardada en la biblioteca'}
            </p>
            {result.saved && (
              <Link to={props.libraryPath} className="text-primary underline" onClick={() => close(false)}>
                Ver en la biblioteca
              </Link>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
