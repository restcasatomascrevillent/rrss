import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Badge, ErrorState, Notice, Spinner } from '@/components/ui';
import { useActiveProfile } from '@/features/brand/api';
import { parseProfile } from '@/features/brand/profile';
import type { ContentDocument } from '@/features/content/document';
import { getFormatSpec } from '@/features/content/networks';
import { cn } from '@/lib/utils';
import { buildBrandCheckInput } from '../document';
import type { BrandCheckResult, Finding, FindingTarget, PaletteColor, Severity, Verdict } from '../types';
import { verifyPiece } from '../verify';
import { describeMeasure } from './measure';

export interface BrandCheckPanelProps {
  document: ContentDocument;
  /** Red de destino (`content_items.network`). */
  network: string;
  /** Formato dentro de la red (`content_items.format`). */
  format: string;
  brandId: string;
  /** Se llama al pulsar un hallazgo, para que el editor resalte la capa o la parte afectada. */
  onSelectTarget?: (target: FindingTarget, finding: Finding) => void;
  /** Paleta dominante de la imagen ya extraída (`extractPalette`); sin ella no se comprueba la paleta. */
  imagePalette?: PaletteColor[];
}

const VERDICTS: Record<
  Verdict,
  { label: string; summary: string; tone: 'success' | 'warning' | 'danger'; icon: LucideIcon }
> = {
  pass: { label: 'Apto', summary: 'No se ha encontrado ningún problema.', tone: 'success', icon: CheckCircle2 },
  pass_with_warnings: {
    label: 'Apto con avisos',
    summary: 'Se puede publicar, pero conviene revisar los avisos.',
    tone: 'warning',
    icon: AlertTriangle,
  },
  fail: {
    label: 'No apto',
    summary: 'Hay problemas que impiden publicar tal como está.',
    tone: 'danger',
    icon: XCircle,
  },
};

const GROUPS: { severity: Severity; title: string; icon: LucideIcon; tone: string }[] = [
  { severity: 'block', title: 'Hay que corregir', icon: XCircle, tone: 'text-danger' },
  { severity: 'warn', title: 'Conviene revisar', icon: AlertTriangle, tone: 'text-warning' },
  { severity: 'info', title: 'Para tu información', icon: Info, tone: 'text-muted' },
];

const TONE_BOX: Record<'success' | 'warning' | 'danger', string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

function FindingRow({ finding, onSelect }: { finding: Finding; onSelect?: BrandCheckPanelProps['onSelectTarget'] }) {
  const measure = describeMeasure(finding);
  const body = (
    <>
      <span className="block text-sm">{finding.message}</span>
      {measure && <span className="mt-0.5 block text-xs text-muted">{measure}</span>}
    </>
  );
  return (
    <li>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(finding.target, finding)}
          className="w-full rounded-lg px-3 py-2 text-left hover:bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          data-testid={`brandcheck-finding-${finding.code}`}
        >
          {body}
        </button>
      ) : (
        <div className="px-3 py-2" data-testid={`brandcheck-finding-${finding.code}`}>
          {body}
        </div>
      )}
    </li>
  );
}

/** Veredicto y hallazgos ya calculados (sin carga de datos). */
export function BrandCheckResultView({
  result,
  onSelectTarget,
}: {
  result: BrandCheckResult;
  onSelectTarget?: BrandCheckPanelProps['onSelectTarget'];
}) {
  const verdict = VERDICTS[result.verdict];
  const Icon = verdict.icon;
  const real = result.findings.filter((f) => !f.omitted);
  const omitted = result.findings.filter((f) => f.omitted);
  return (
    <div className="space-y-4">
      <div
        role="status"
        className={cn('flex items-start gap-3 rounded-lg px-3.5 py-3', TONE_BOX[verdict.tone])}
        data-testid="brandcheck-verdict"
        data-verdict={result.verdict}
      >
        <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div>
          <p className="font-semibold">{verdict.label}</p>
          <p className="text-sm">{verdict.summary}</p>
        </div>
      </div>

      {GROUPS.map(({ severity, title, icon: GroupIcon, tone }) => {
        const items = real.filter((f) => f.severity === severity);
        if (items.length === 0) return null;
        return (
          <section key={severity} aria-labelledby={`brandcheck-${severity}`}>
            <h3
              id={`brandcheck-${severity}`}
              className={cn('mb-1 flex items-center gap-2 text-sm font-semibold', tone)}
            >
              <GroupIcon className="h-4 w-4" aria-hidden />
              {title}
              <Badge>{items.length}</Badge>
            </h3>
            <ul className="divide-y divide-border">
              {items.map((finding, i) => (
                <FindingRow key={`${finding.code}-${i}`} finding={finding} onSelect={onSelectTarget} />
              ))}
            </ul>
          </section>
        );
      })}

      {omitted.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="brandcheck-omitted">
          <summary className="cursor-pointer font-medium">
            Comprobaciones que no se han podido hacer ({omitted.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            {omitted.map((finding, i) => (
              <li key={`${finding.code}-${i}`}>{finding.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Panel del verificador de marca: carga el perfil vigente de la marca, comprueba
 * la publicación (texto, límites de la red, contraste, hashtags, emojis…) y
 * muestra el veredicto con sus hallazgos. No usa IA: cada hallazgo lleva el dato
 * medido y el umbral que lo exige.
 */
export function BrandCheckPanel({
  document: doc,
  network,
  format,
  brandId,
  onSelectTarget,
  imagePalette,
}: BrandCheckPanelProps) {
  const active = useActiveProfile(brandId);
  const profile = useMemo(() => (active.data ? parseProfile(active.data.data) : null), [active.data]);
  const spec = useMemo(() => getFormatSpec(network, format), [network, format]);
  const result = useMemo(
    () => (active.isSuccess ? verifyPiece(buildBrandCheckInput(doc, spec, profile, { imagePalette })) : null),
    [active.isSuccess, doc, spec, profile, imagePalette],
  );

  return (
    <section aria-labelledby="brandcheck-title" className="space-y-4" data-testid="brandcheck-panel">
      <h2 id="brandcheck-title" className="text-base font-semibold">
        Verificador de marca
      </h2>
      {active.isPending && <Spinner label="Cargando el perfil de la marca…" />}
      {active.isError && <ErrorState error={active.error} onRetry={() => void active.refetch()} />}
      {result && (
        <>
          {!profile && (
            <Notice tone="warning">
              La marca todavía no tiene un perfil guardado: las comprobaciones que dependen de él se omiten.
            </Notice>
          )}
          {!spec && (
            <Notice tone="warning">
              No hay especificación para este formato de red: no se pueden comprobar sus límites.
            </Notice>
          )}
          <BrandCheckResultView result={result} onSelectTarget={onSelectTarget} />
        </>
      )}
    </section>
  );
}
