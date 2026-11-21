import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Notice, Spinner } from '@/components/ui';
import { AiErrorNotice } from './AiErrorNotice';
import {
  useBrandCheckAi,
  type BrandCheckCriterion,
  type BrandCheckResult,
  type BrandCheckVerdict,
  type CriterionVerdict,
} from './api';

const MAX_TEXT_CHARS = 20_000;

const CRITERION_LABEL: Record<BrandCheckCriterion, string> = {
  tone: 'Tono y voz de la marca',
  banned_topics: 'Temas y expresiones vetados',
};

const OVERALL: Record<BrandCheckVerdict, { label: string; tone: 'success' | 'danger' | 'warning'; detail: string }> = {
  pass: {
    label: 'Apto',
    tone: 'success',
    detail: 'La IA no ve problemas de tono ni de temas vetados. No es una aprobación: la da una persona.',
  },
  fail: {
    label: 'No apto',
    tone: 'danger',
    detail: 'La IA ve al menos un incumplimiento claro. Revisa los motivos y las citas.',
  },
  review: {
    label: 'Dudoso: que lo revise una persona',
    tone: 'warning',
    detail: 'La IA no puede dar el texto por bueno ni por malo.',
  },
};

const CRITERION: Record<CriterionVerdict, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
  pass: { label: 'Cumple', tone: 'success' },
  fail: { label: 'No cumple', tone: 'danger' },
  uncertain: { label: 'Dudoso', tone: 'warning' },
};

export interface AiBrandCheckProps {
  brandId: string;
  /** Texto de la pieza tal como se publicaría. */
  text: string;
}

/**
 * Comprobación de tono y de temas vetados con IA. Complementa a la
 * comprobación sin IA (reglas literales), que vive aparte.
 */
export function AiBrandCheck({ brandId, text }: AiBrandCheckProps) {
  const check = useBrandCheckAi(brandId);
  const [result, setResult] = useState<{ text: string; data: BrandCheckResult } | null>(null);
  const trimmed = text.trim();
  const tooLong = text.length > MAX_TEXT_CHARS;

  function run() {
    const checked = text;
    check.mutateAsync(checked).then(
      (data) => setResult({ text: checked, data }),
      () => setResult(null),
    );
  }

  const stale = result !== null && result.text !== text;

  return (
    <section aria-label="Comprobación de tono con IA" className="space-y-3" data-testid="ai-brand-check">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={run}
          disabled={!trimmed || tooLong}
          loading={check.isPending}
          data-testid="ai-brand-check-run"
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {result ? 'Volver a comprobar con IA' : 'Comprobar tono con IA'}
        </Button>
        <span className="text-xs text-muted">
          {!trimmed
            ? 'Escribe el texto para poder comprobarlo.'
            : tooLong
              ? 'El texto es demasiado largo para comprobarlo con IA.'
              : 'Descuenta del cupo de IA de la organización.'}
        </span>
      </div>

      {check.isPending && <Spinner label="Comprobando el texto…" className="py-4" />}
      {check.isError && <AiErrorNotice error={check.error} onRetry={run} />}

      {result && !check.isPending && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          {stale && <Notice tone="warning">El texto ha cambiado desde esta comprobación. Vuelve a comprobarlo.</Notice>}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Veredicto de la IA:</span>
              <Badge tone={OVERALL[result.data.verdict].tone}>{OVERALL[result.data.verdict].label}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted">{OVERALL[result.data.verdict].detail}</p>
          </div>
          <ul className="space-y-3">
            {result.data.criteria.map((item) => (
              <li
                key={item.criterion}
                className="border-t border-border pt-3"
                data-testid={`ai-criterion-${item.criterion}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{CRITERION_LABEL[item.criterion] ?? item.criterion}</h3>
                  <Badge tone={CRITERION[item.verdict].tone}>{CRITERION[item.verdict].label}</Badge>
                </div>
                {item.explanation && <p className="mt-1 text-sm">{item.explanation}</p>}
                {item.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1" aria-label="Citas del texto">
                    {item.evidence.map((quote, i) => (
                      <li key={i}>
                        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted">
                          «{quote}»
                        </blockquote>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
