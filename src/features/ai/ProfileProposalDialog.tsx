import { FileText, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Dialog, Notice, Spinner } from '@/components/ui';
import { useActiveProfile } from '@/features/brand/api';
import { parseProfile, type BrandProfileData } from '@/features/brand/profile';
import { cn } from '@/lib/utils';
import { AiErrorNotice } from './AiErrorNotice';
import { useProfileProposal, type ProfileProposalResult, type ProfileSourceText } from './api';
import {
  applyProposal,
  compareProfiles,
  defaultSelection,
  PROPOSAL_MAX_CHARS,
  PROPOSAL_MAX_SOURCES,
  SECTION_LABEL,
  type FieldComparison,
} from './profileProposal';

const number = new Intl.NumberFormat('es-ES');

export interface ProfileProposalDialogProps {
  brandId: string;
  /**
   * Texto YA EXTRAÍDO de las fuentes de la marca. Hoy el producto no extrae
   * texto de PDF ni de webs (brand_knowledge_sources solo guarda el archivo o
   * el enlace), así que quien monta este componente debe aportarlo.
   */
  sources: ProfileSourceText[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Perfil resultante (vigente + campos aceptados). Guardarlo como versión es cosa de quien llama. */
  onAccept: (profile: BrandProfileData, info: { acceptedFields: string[]; generationId: string }) => void;
  /** Perfil vigente. Sin él, se lee el perfil activo de la marca. */
  currentProfile?: BrandProfileData | null;
}

/** Pide a la IA una propuesta de perfil desde las fuentes y deja elegir qué campos aceptar. */
export function ProfileProposalDialog(props: ProfileProposalDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Proponer el perfil con IA"
      description="La IA lee el texto de las fuentes y propone un perfil. Tú eliges, campo a campo, qué aceptar."
    >
      {open && <ProposalBody {...props} />}
    </Dialog>
  );
}

function ProposalBody({ brandId, sources, onAccept, onOpenChange, currentProfile }: ProfileProposalDialogProps) {
  const active = useActiveProfile(brandId);
  const current = useMemo(
    () => (currentProfile !== undefined ? currentProfile : active.data ? parseProfile(active.data.data) : null),
    [currentProfile, active.data],
  );
  const loadingCurrent = currentProfile === undefined && active.isPending;

  const propose = useProfileProposal(brandId);
  const [result, setResult] = useState<ProfileProposalResult | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  const base = useMemo(() => current ?? parseProfile({}), [current]);
  const comparisons = useMemo(() => (result ? compareProfiles(base, result.proposal) : []), [base, result]);

  const usable = sources.filter((s) => s.title.trim() && s.text.trim());
  const totalChars = usable.reduce((sum, s) => sum + s.text.length, 0);
  const problem =
    usable.length === 0
      ? 'No hay texto de ninguna fuente. Hace falta el texto ya extraído (de un PDF, una web…) para que la IA lo lea.'
      : usable.length > PROPOSAL_MAX_SOURCES
        ? `Se pueden analizar como máximo ${PROPOSAL_MAX_SOURCES} fuentes a la vez.`
        : totalChars > PROPOSAL_MAX_CHARS
          ? `Las fuentes suman ${number.format(totalChars)} caracteres y el máximo es ${number.format(PROPOSAL_MAX_CHARS)}. Analízalas por partes.`
          : null;

  function run() {
    setResult(null);
    propose.mutateAsync(usable.map((s) => ({ title: s.title.trim(), text: s.text }))).then(
      (data) => {
        setResult(data);
        setAccepted(defaultSelection(compareProfiles(base, data.proposal)));
      },
      () => {
        // El error queda en `propose.error`.
      },
    );
  }

  function toggle(id: string) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function accept() {
    if (!result) return;
    const fields = [...accepted].filter((id) => comparisons.some((c) => c.field.id === id && c.status === 'changed'));
    onAccept(applyProposal(base, comparisons, new Set(fields)), {
      acceptedFields: fields,
      generationId: result.generationId,
    });
    onOpenChange(false);
  }

  if (loadingCurrent) return <Spinner label="Cargando el perfil actual…" />;

  const changed = comparisons.filter((c) => c.status === 'changed');

  return (
    <div className="space-y-4">
      <section aria-label="Fuentes" className="space-y-2">
        <h3 className="text-sm font-semibold">Fuentes que se envían</h3>
        {usable.length > 0 && (
          <ul className="space-y-1 text-sm">
            {usable.map((s, i) => (
              <li key={`${s.title}-${i}`} className="flex items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 truncate">{s.title}</span>
                <span className="shrink-0 text-xs text-muted">{number.format(s.text.length)} caracteres</span>
              </li>
            ))}
          </ul>
        )}
        {problem ? (
          <Notice tone="warning">{problem}</Notice>
        ) : (
          <p className="text-xs text-muted">
            La propuesta no se guarda sola: nada cambia hasta que aceptes. Descuenta del cupo de IA de la organización.
          </p>
        )}
        {!current && <p className="text-xs text-muted">La marca aún no tiene perfil: la propuesta parte de cero.</p>}
        <Button onClick={run} disabled={problem !== null} loading={propose.isPending} data-testid="ai-proposal-run">
          <Sparkles className="h-4 w-4" aria-hidden />
          {result ? 'Pedir otra propuesta' : 'Pedir propuesta'}
        </Button>
      </section>

      {propose.isPending && <Spinner label="Leyendo las fuentes…" />}
      {propose.isError && <AiErrorNotice error={propose.error} onRetry={run} />}

      {result && (
        <>
          {result.notes.length > 0 && (
            <section aria-label="Notas de la IA" className="rounded-lg bg-subtle p-3 text-sm">
              <h3 className="mb-1 font-semibold">Para quien revisa</h3>
              <ul className="list-disc space-y-1 pl-5">
                {result.notes.map((n, i) => (
                  <li key={i}>
                    <span className="font-medium">{SECTION_LABEL[n.section] ?? n.section}:</span> {n.note}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {changed.length === 0 ? (
            <Notice>La propuesta no trae nada distinto del perfil actual.</Notice>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {changed.length} {changed.length === 1 ? 'campo cambia' : 'campos cambian'}. Marca los que aceptas.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAccepted(new Set(changed.map((c) => c.field.id)))}>
                  Marcar todos
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAccepted(new Set())}>
                  Ninguno
                </Button>
              </div>
            </div>
          )}

          <ul className="space-y-2" aria-label="Comparación campo a campo">
            {comparisons.map((c) => (
              <ComparisonRow key={c.field.id} comparison={c} checked={accepted.has(c.field.id)} onToggle={toggle} />
            ))}
          </ul>

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Descartar
            </Button>
            <Button onClick={accept} disabled={accepted.size === 0} data-testid="ai-proposal-accept">
              Aceptar {accepted.size > 0 ? `${accepted.size} ${accepted.size === 1 ? 'campo' : 'campos'}` : ''}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

const STATUS_BADGE: Record<FieldComparison['status'], { label: string; tone: 'neutral' | 'primary' | 'warning' }> = {
  changed: { label: 'Cambia', tone: 'primary' },
  same: { label: 'Sin cambios', tone: 'neutral' },
  empty: { label: 'La propuesta no lo trae', tone: 'neutral' },
  invalid: { label: 'No encaja: se ignora', tone: 'warning' },
};

function ComparisonRow({
  comparison: c,
  checked,
  onToggle,
}: {
  comparison: FieldComparison;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  const selectable = c.status === 'changed';
  const inputId = `proposal-${c.field.id}`;
  return (
    <li
      className={cn('rounded-xl border p-3', selectable ? 'border-border' : 'border-border/60 opacity-75')}
      data-testid={`proposal-field-${c.field.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {selectable && (
            <input
              id={inputId}
              type="checkbox"
              className="h-4 w-4"
              checked={checked}
              onChange={() => onToggle(c.field.id)}
            />
          )}
          <label htmlFor={selectable ? inputId : undefined} className="text-sm font-semibold">
            {SECTION_LABEL[c.field.section]} · {c.field.label}
          </label>
        </div>
        <Badge tone={STATUS_BADGE[c.status].tone}>{STATUS_BADGE[c.status].label}</Badge>
      </div>
      {selectable && (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted">Actual</p>
            <FieldValue value={c.current} />
          </div>
          <div>
            <p className="text-xs font-medium text-muted">Propuesta</p>
            <FieldValue value={c.proposed} />
          </div>
        </div>
      )}
    </li>
  );
}

function describeItem(item: unknown): string {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return String(item);
  const r = item as Record<string, string>;
  if ('hex' in r) return [r.name, r.hex, r.role && `(${r.role})`].filter(Boolean).join(' ');
  if ('family' in r) return [r.family, r.usage].filter(Boolean).join(' — ');
  if ('platform' in r) return [r.platform, r.handle, r.url].filter(Boolean).join(' · ');
  return [r.name, r.description].filter(Boolean).join(': ');
}

function FieldValue({ value }: { value: unknown }) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return <p className="text-sm italic text-muted">Vacío</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {value.map((item, i) => (
          <li key={i}>
            {typeof item === 'object' && item !== null && 'hex' in item && (
              <span
                aria-hidden
                className="mr-1.5 inline-block h-3 w-3 rounded-sm border border-border align-middle"
                style={{ backgroundColor: (item as { hex: string }).hex }}
              />
            )}
            {describeItem(item)}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="whitespace-pre-wrap text-sm">{String(value)}</p>;
}
