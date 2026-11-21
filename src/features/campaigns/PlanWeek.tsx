import { AlertCircle, ExternalLink, Trash2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Field, Input, Textarea } from '@/components/ui';
import { contentPaths, networkLabel, targetLabel } from '@/features/content/labels';
import { getFormatSpec } from '@/features/content/networks';
import { STATUS_LABEL, STATUS_TONE } from '@/features/content/status';
import { cn } from '@/lib/utils';
import type { CampaignPieceLink } from './api';
import type { CampaignPiece, PlanIssue } from './plan';
import { PiecePreview } from './PiecePreview';
import type { PiecePreviewSource } from './previews';
import { campaignDays, dayParts, longDayLabel } from './week';

// La semana de un plan: una columna por día con la miniatura, el formato y el
// estado de cada pieza. Al pulsar una se abre su ficha debajo (texto, motivo y
// «Abrir en el editor»). Las frases largas viven en la ficha, no en la tira.

export interface WeekPiece {
  key: string;
  /** Posición en el plan (para retocar o quitar), o null si no está en el plan cargado. */
  planIndex: number | null;
  date: string | null;
  network: string;
  format: string;
  /** Idea del plan o, si no se tiene, el título de la pieza. */
  title: string;
  piece: CampaignPiece | null;
  content: CampaignPieceLink | null;
  issues: PlanIssue[];
}

export const PIECE_PANEL_ID = 'campaign-piece-panel';

const formatLabel = (network: string, format: string) => getFormatSpec(network, format)?.label ?? format;

export function WeekStrip({
  start,
  end,
  pieces,
  previews,
  selected,
  onSelect,
  accepted,
}: {
  start: string;
  end: string;
  pieces: WeekPiece[];
  previews: Map<string, PiecePreviewSource>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  accepted: boolean;
}) {
  const days = campaignDays(start, end);
  const byDay = new Map<string, WeekPiece[]>();
  const undated: WeekPiece[] = [];
  for (const piece of pieces) {
    if (piece.date && days.includes(piece.date)) byDay.set(piece.date, [...(byDay.get(piece.date) ?? []), piece]);
    else undated.push(piece);
  }
  const columns = [
    ...days.map((day) => ({ key: day, day, items: byDay.get(day) ?? [] })),
    ...(undated.length ? [{ key: 'otros', day: null, items: undated }] : []),
  ];

  return (
    <ol
      className={cn(
        // En el móvil, una tira que se desliza; desde tableta, la semana en siete columnas.
        '-mx-4 grid snap-x snap-mandatory scroll-px-4 auto-cols-[minmax(7.5rem,42%)] grid-flow-col gap-2 overflow-x-auto px-4 pb-2',
        'sm:mx-0 sm:auto-cols-auto sm:grid-flow-row sm:grid-cols-4 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-7',
      )}
      aria-label="Piezas por día"
      data-testid={accepted ? 'campaign-piece-list' : 'campaign-plan-pieces'}
    >
      {columns.map(({ key, day, items }) => {
        const parts = day ? dayParts(day) : null;
        return (
          // En el móvil los días sin piezas no ocupan sitio en la tira.
          <li
            key={key}
            className={cn('min-w-0 snap-start flex-col gap-2', items.length ? 'flex' : 'hidden sm:flex')}
            data-testid="campaign-day"
          >
            <h3 className="flex items-baseline gap-1.5 px-0.5 text-sm" aria-label={day ? longDayLabel(day) : 'Sin fecha'}>
              {parts ? (
                <>
                  <span className="font-normal capitalize text-muted">{parts.weekday}</span>
                  <span className="text-base font-semibold tabular-nums">{parts.day}</span>
                </>
              ) : (
                <span className="font-normal text-muted">Sin fecha</span>
              )}
            </h3>
            {items.length === 0 ? (
              <div className="hidden min-h-24 flex-1 rounded-lg border border-dashed border-border sm:block">
                <span className="sr-only">Sin piezas</span>
              </div>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.key}>
                    <PieceTile
                      item={item}
                      preview={previews.get(item.key)}
                      selected={selected === item.key}
                      onSelect={() => onSelect(selected === item.key ? null : item.key)}
                      accepted={accepted}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PieceTile({
  item,
  preview,
  selected,
  onSelect,
  accepted,
}: {
  item: WeekPiece;
  preview: PiecePreviewSource | undefined;
  selected: boolean;
  onSelect: () => void;
  accepted: boolean;
}) {
  const status = item.content?.status ?? null;
  const flagged = item.issues.length > 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      aria-controls={selected ? PIECE_PANEL_ID : undefined}
      className={cn(
        'group block w-full overflow-hidden rounded-lg border bg-surface text-left transition-colors',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted',
        flagged && !selected && 'border-danger',
      )}
      data-testid={accepted ? 'campaign-piece-row' : 'campaign-plan-piece'}
    >
      <span className="block aspect-[4/5] w-full">
        <PiecePreview source={preview} format={item.format} />
      </span>
      <span className="block space-y-1 px-2 py-1.5">
        <span className="block truncate text-xs font-medium">{formatLabel(item.network, item.format)}</span>
        <span className="block truncate text-[11px] text-muted">{networkLabel(item.network)}</span>
        <span className="sr-only">, {item.title}</span>
        {status ? (
          <Badge tone={STATUS_TONE[status]} className="px-2 py-0 text-[11px]">
            <span data-testid="campaign-piece-status">{STATUS_LABEL[status]}</span>
          </Badge>
        ) : flagged ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-danger">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden />
            Revisar
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Ficha de la pieza elegida: su texto, su motivo y el enlace al editor (o, mientras se revisa, sus campos). */
export function PieceSheet({
  item,
  preview,
  orgId,
  brandId,
  editable,
  assetNames,
  onChange,
  onRemove,
  onClose,
}: {
  item: WeekPiece;
  preview: PiecePreviewSource | undefined;
  orgId: string;
  brandId: string;
  editable: boolean;
  assetNames: Map<string, string>;
  onChange: (index: number, patch: Partial<CampaignPiece>) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // En el móvil la ficha queda debajo de la tira: se trae a la vista al abrirla.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [item.key]);
  // Escape cierra la ficha, esté el foco en ella o en la pieza de la tira.
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const { piece, content, planIndex } = item;
  const canEdit = editable && piece !== null && planIndex !== null;
  const heading = `${item.date ? longDayLabel(item.date) : 'Sin fecha'} · ${targetLabel(item.network, item.format)}`;

  return (
    <section
      ref={ref}
      id={PIECE_PANEL_ID}
      aria-label={`Ficha: ${heading}`}
      className="scroll-mt-4 rounded-xl border border-border bg-surface shadow-card"
      data-testid="campaign-piece-panel"
    >
      <div className="grid gap-4 p-4 sm:grid-cols-[9rem_1fr] sm:p-5">
        <div className="mx-auto aspect-[4/5] w-32 overflow-hidden rounded-lg border border-border sm:w-full">
          <PiecePreview source={preview} format={item.format} alt={`Vista previa de «${item.title}»`} size={288} />
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base first-letter:uppercase">{heading}</h3>
              {content?.status && (
                <Badge tone={STATUS_TONE[content.status]} className="mt-1">
                  {STATUS_LABEL[content.status]}
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar la ficha" className="-mr-2 -mt-2">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>

          {canEdit ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <Field label="Fecha">
                  {(props) => (
                    <Input
                      {...props}
                      type="date"
                      value={piece.date}
                      onChange={(e) => onChange(planIndex, { date: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Idea">
                  {(props) => (
                    <Input
                      {...props}
                      maxLength={300}
                      value={piece.idea}
                      onChange={(e) => onChange(planIndex, { idea: e.target.value })}
                      data-testid="campaign-piece-idea"
                    />
                  )}
                </Field>
              </div>
              <Field label="Texto (borrador)">
                {(props) => (
                  <Textarea
                    {...props}
                    rows={5}
                    maxLength={5000}
                    value={piece.caption}
                    onChange={(e) => onChange(planIndex, { caption: e.target.value })}
                    data-testid="campaign-piece-caption"
                  />
                )}
              </Field>
            </div>
          ) : piece ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{piece.idea}</p>
              <p className="max-w-prose whitespace-pre-wrap text-sm" data-testid="campaign-piece-caption-text">
                {piece.caption}
              </p>
              {content && <p className="text-xs text-muted">Es el texto del plan; el vigente está en el editor.</p>}
            </div>
          ) : (
            <p className="text-sm font-medium">{item.title}</p>
          )}

          {piece && piece.hashtags.length > 0 && (
            <p className="text-sm text-muted">{piece.hashtags.map((tag) => `#${tag}`).join(' ')}</p>
          )}
          {piece?.why && (
            <p className="max-w-prose text-sm">
              <span className="font-medium">Motivo: </span>
              <span className="text-muted">{piece.why}</span>
            </p>
          )}
          {piece && piece.assetIds.length > 0 && (
            <p className="text-xs text-muted">
              Recursos sugeridos:{' '}
              {piece.assetIds.map((id) => assetNames.get(id) ?? 'recurso de la biblioteca').join(', ')}
            </p>
          )}
          {item.issues.map((issue) => (
            <p key={issue.path} role="alert" className="text-xs font-medium text-danger">
              {issue.message}
            </p>
          ))}

          {(content || canEdit) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {content && (
                <Link
                  to={contentPaths(orgId, brandId).item(content.content_id)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-fg shadow-card hover:bg-primary/90"
                  data-testid="campaign-piece-open"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Abrir en el editor
                </Link>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(planIndex)}
                  data-testid="campaign-piece-remove"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Quitar del plan
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
