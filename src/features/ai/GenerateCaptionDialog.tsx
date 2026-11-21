import { Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Dialog, Field, Notice, Select, Spinner, Textarea } from '@/components/ui';
import type { PostCopy } from '@/features/content/document';
import { LENGTH_UNIT_NOTE } from '@/features/content/textUnits';
import { cn } from '@/lib/utils';
import { AiErrorNotice } from './AiErrorNotice';
import { useGeneratePostCaption, type PostCaptionResult, type PostCaptionVariant } from './api';
import {
  captionLimits,
  variantFits,
  variantLength,
  variantToPostCopy,
  DOCUMENT_CAPTION_MAX,
  type CaptionLimits,
} from './networkLimits';

export const MAX_BRIEF_CHARS = 2000;
const MAX_VARIANTS = 5;
const number = new Intl.NumberFormat('es-ES');

export interface GenerateCaptionDialogProps {
  brandId: string;
  /** Red y formato de la pieza (identificadores de networks.ts). */
  network: string;
  format: string;
  /** Recibe el texto elegido. Menciones, texto alternativo y llamada a la acción salen de `currentCopy`. */
  onApply: (copy: PostCopy) => void;
  /** Texto actual de la pieza: se conserva lo que la IA no redacta. */
  currentCopy?: PostCopy;
  /** Control externo de la ventana. Sin él, el componente pinta su propio botón «Redactar con IA». */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Ventana para redactar el texto de una publicación con IA y elegir una variante. */
export function GenerateCaptionDialog({
  brandId,
  network,
  format,
  onApply,
  currentCopy,
  open: controlledOpen,
  onOpenChange,
}: GenerateCaptionDialogProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (value: boolean) => {
    if (!controlled) setOwnOpen(value);
    onOpenChange?.(value);
  };

  return (
    <>
      {!controlled && (
        <Button variant="secondary" onClick={() => setOpen(true)} data-testid="ai-caption-open">
          <Sparkles className="h-4 w-4" aria-hidden />
          Redactar con IA
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title="Redactar el texto con IA"
        description="Describe la publicación y elige una de las propuestas. Puedes editarla después."
      >
        {open && (
          <CaptionGenerator
            brandId={brandId}
            limits={captionLimits(network, format)}
            onChoose={(variant) => {
              onApply(variantToPostCopy(variant, currentCopy));
              setOpen(false);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function LimitsNotice({ limits }: { limits: CaptionLimits }) {
  const target = limits.formatLabel ? `${limits.networkLabel} · ${limits.formatLabel}` : limits.networkLabel;
  if (limits.maxChars === null) {
    return (
      <Notice tone="warning">
        No se conoce el límite de texto de {target}. La IA usará como tope el máximo del documento (
        {number.format(DOCUMENT_CAPTION_MAX)} caracteres): revisa la longitud antes de publicar.
      </Notice>
    );
  }
  return (
    <Notice>
      {target}: hasta {number.format(limits.maxChars)} caracteres contando los hashtags
      {limits.maxHashtags !== null ? ` y ${limits.maxHashtags} hashtags como máximo` : ''}.
      {limits.provenance === 'unverified' ? ' Dato sin confirmar en la documentación oficial de la red.' : ''}
      {` ${LENGTH_UNIT_NOTE}`}
    </Notice>
  );
}

function CaptionGenerator({
  brandId,
  limits,
  onChoose,
}: {
  brandId: string;
  limits: CaptionLimits;
  onChoose: (variant: PostCaptionVariant) => void;
}) {
  const generate = useGeneratePostCaption(brandId);
  const [brief, setBrief] = useState('');
  const [variants, setVariants] = useState(3);
  const [result, setResult] = useState<PostCaptionResult | null>(null);

  const trimmed = brief.trim();
  const canSubmit = trimmed.length > 0 && brief.length <= MAX_BRIEF_CHARS && !generate.isPending;

  function run() {
    setResult(null);
    generate.mutateAsync({ brief: trimmed, network: limits.request, variants }).then(setResult, () => {
      // El error queda en `generate.error` y se enseña abajo.
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit) run();
  }

  return (
    <div className="space-y-4">
      <LimitsNotice limits={limits} />
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Encargo"
          hint={`De qué va la publicación, en pocas frases. ${number.format(brief.length)} / ${number.format(MAX_BRIEF_CHARS)}`}
          error={brief.length > MAX_BRIEF_CHARS ? 'El encargo es demasiado largo.' : null}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Por ejemplo: anunciar el menú de otoño, con platos de temporada y reserva por teléfono."
              data-testid="ai-caption-brief"
            />
          )}
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Variantes" className="w-36">
            {(p) => (
              <Select
                {...p}
                value={variants}
                onChange={(e) => setVariants(Number(e.target.value))}
                data-testid="ai-caption-variants"
              >
                {Array.from({ length: MAX_VARIANTS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" disabled={!canSubmit} loading={generate.isPending} data-testid="ai-caption-generate">
            <Sparkles className="h-4 w-4" aria-hidden />
            {result ? 'Generar otras' : 'Generar'}
          </Button>
        </div>
        <p className="text-xs text-muted">Cada generación descuenta del cupo de IA de la organización.</p>
      </form>

      {generate.isPending && <Spinner label="Redactando propuestas…" />}
      {generate.isError && <AiErrorNotice error={generate.error} onRetry={run} />}
      {result && <VariantList result={result} limits={limits} onChoose={onChoose} />}
    </div>
  );
}

function VariantList({
  result,
  limits,
  onChoose,
}: {
  result: PostCaptionResult;
  limits: CaptionLimits;
  onChoose: (variant: PostCaptionVariant) => void;
}) {
  if (result.variants.length === 0) {
    return <Notice tone="warning">La IA no ha devuelto ninguna propuesta. Vuelve a probar o cambia el encargo.</Notice>;
  }
  return (
    <section aria-label="Propuestas" className="space-y-3">
      {result.variants.length < result.requestedVariants && (
        <Notice tone="warning">
          La IA ha devuelto {result.variants.length} de las {result.requestedVariants} propuestas pedidas.
        </Notice>
      )}
      <ol className="space-y-3">
        {result.variants.map((variant, index) => {
          const length = variantLength(variant, limits);
          const fits = variantFits(variant, limits);
          return (
            <li
              key={index}
              className={cn('rounded-xl border p-4', fits === false ? 'border-danger/50' : 'border-border')}
              data-testid="ai-caption-variant"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Propuesta {index + 1}</h3>
                <Badge tone={fits === false ? 'danger' : fits ? 'success' : 'neutral'}>
                  {limits.maxChars === null
                    ? `${number.format(length)} caracteres · límite desconocido`
                    : `${number.format(length)} / ${number.format(limits.maxChars)} caracteres`}
                </Badge>
              </div>
              <p className="whitespace-pre-wrap text-sm">{variant.text}</p>
              {variant.hashtags.length > 0 && (
                <p className="mt-2 text-sm text-primary">
                  {variant.hashtags.join(' ')}
                  {limits.maxHashtags !== null && (
                    <span className="ml-2 text-xs text-muted">
                      ({variant.hashtags.length} de {limits.maxHashtags} hashtags)
                    </span>
                  )}
                </p>
              )}
              {fits === false && (
                <p className="mt-2 text-xs font-medium text-danger">
                  No cabe en {limits.networkLabel}: si la usas, tendrás que acortarla.
                </p>
              )}
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant={fits === false ? 'secondary' : 'primary'} onClick={() => onChoose(variant)}>
                  Usar esta
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
