import { CalendarDays, Check, ChevronDown, ChevronLeft, ExternalLink, MessageSquare, XCircle } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, ConfirmDialog, ErrorState, Notice, Skeleton, Spinner } from '@/components/ui';
import { contentPaths, networkLabel } from '@/features/content/labels';
import { useAssetsByIds } from '@/features/library/api';
import { useBrand, useOrg } from '@/features/orgs/context';
import { REQUEST_STATUS_LABEL, requestPaths } from '@/features/requests/labels';
import type { CampaignRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn, formatDateTime } from '@/lib/utils';
import { useCampaign, useCampaignContents, useCampaignMutations, useCampaignPlan, useCampaignRequest } from './api';
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_STATUS_TONE, campaignPaths } from './labels';
import { campaignPlanSchema, shortDay, validatePlan, type CampaignPiece, type CampaignPlan } from './plan';
import { PieceSheet, WeekStrip, type WeekPiece } from './PlanWeek';
import { usePiecePreviews, type PreviewRequest } from './previews';

export function CampaignDetailPage() {
  const { campaignId = '' } = useParams();
  const { brand } = useBrand();
  const campaign = useCampaign(brand.id, campaignId);
  if (campaign.isPending) return <Spinner />;
  if (campaign.isError) return <ErrorState error={campaign.error} onRetry={() => void campaign.refetch()} />;
  return <CampaignDetail campaign={campaign.data} />;
}

const SOURCE_LABEL = { ai: 'Propuesto por la IA', agency: 'Preparado por la agencia' } as const;

const linkButton =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors';

function CampaignDetail({ campaign }: { campaign: CampaignRow }) {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const paths = campaignPaths(org.id, brand.id);
  const mutations = useCampaignMutations(brand.id);
  const plan = useCampaignPlan(brand.id, campaign.id, campaign.current_plan_version);
  const accepted = campaign.status === 'accepted';
  const contents = useCampaignContents(brand.id, campaign.id, accepted);
  const request = useCampaignRequest(brand.id, campaign.id, campaign.origin === 'agency');
  const canDecide = can('edit') || (campaign.origin === 'agency' && can('approve'));
  const waitingAgency =
    campaign.origin === 'agency' && campaign.status === 'proposed' && request.data?.status !== 'delivered';
  const editable = campaign.status === 'proposed' && canDecide && !waitingAgency;

  const parsed = useMemo(() => (plan.data ? campaignPlanSchema.safeParse(plan.data.data) : null), [plan.data]);
  // Lo que la persona retoca vale para la versión del plan que tenía abierta.
  const [edits, setEdits] = useState<{ planId: string; plan: CampaignPlan } | null>(null);
  const draft: CampaignPlan | null =
    edits && edits.planId === plan.data?.id ? edits.plan : parsed?.success ? parsed.data : null;
  function setDraft(change: (current: CampaignPlan) => CampaignPlan) {
    if (!draft || !plan.data) return;
    setEdits({ planId: plan.data.id, plan: change(draft) });
  }
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const closeSheet = useCallback(() => setSelected(null), []);

  const check = useMemo(() => (draft ? validatePlan(draft, campaign) : null), [draft, campaign]);
  const issues = useMemo(() => (check && !check.ok ? check.issues : []), [check]);

  function updatePiece(index: number, patch: Partial<CampaignPiece>) {
    setDraft((current) => ({
      ...current,
      pieces: current.pieces.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    }));
  }
  function removePiece(index: number) {
    setSelected(null);
    setDraft((current) => ({ ...current, pieces: current.pieces.filter((_, i) => i !== index) }));
  }

  async function accept() {
    try {
      await mutations.accept.mutateAsync({ campaign, plan: draft });
      setConfirmAccept(false);
      setSelected(null);
      toast.success('Plan aceptado: sus piezas están en Contenidos como borradores');
    } catch (error) {
      setConfirmAccept(false);
      toast.error(translateError(error));
    }
  }

  async function discard() {
    try {
      await mutations.discard.mutateAsync(campaign.id);
      setConfirmDiscard(false);
      toast.success('Campaña descartada');
    } catch (error) {
      setConfirmDiscard(false);
      toast.error(translateError(error));
    }
  }

  // Las piezas de la tira: las creadas (campaña aceptada) o las del plan.
  const pieces: WeekPiece[] = useMemo(() => {
    if (accepted) {
      return (contents.data ?? []).map((link) => {
        const piece =
          draft && link.plan_version === campaign.current_plan_version
            ? (draft.pieces[link.piece_index] ?? null)
            : null;
        return {
          key: link.content_id,
          planIndex: null,
          date: piece?.date ?? null,
          network: link.network || piece?.network || '',
          format: link.format || piece?.format || '',
          title: piece?.idea ?? link.title,
          piece,
          content: link,
          issues: [],
        };
      });
    }
    return (draft?.pieces ?? []).map((piece, index) => ({
      key: `pieza-${index}`,
      planIndex: index,
      date: piece.date,
      network: piece.network,
      format: piece.format,
      title: piece.idea,
      piece,
      content: null,
      issues: issues.filter((i) => i.path.startsWith(`pieces.${index}.`)),
    }));
  }, [accepted, contents.data, draft, campaign.current_plan_version, issues]);

  const previewRequests: PreviewRequest[] = useMemo(
    () =>
      pieces.map((p) => ({
        key: p.key,
        ...(p.content ? { contentId: p.content.content_id, version: p.content.current_version } : {}),
        ...(p.piece?.assetIds[0] ? { assetId: p.piece.assetIds[0] } : {}),
      })),
    [pieces],
  );
  const previews = usePiecePreviews(brand.id, previewRequests);
  const assetIds = useMemo(() => [...new Set((draft?.pieces ?? []).flatMap((p) => p.assetIds))].sort(), [draft]);
  const assets = useAssetsByIds(brand.id, assetIds);
  const assetNames = useMemo(() => new Map((assets.data ?? []).map((a) => [a.id, a.file_name])), [assets.data]);

  const current = pieces.find((p) => p.key === selected) ?? null;
  const nextPiece = accepted ? (contents.data ?? []).find((c) => c.status !== 'approved') : undefined;
  const showDiscard = canDecide && (campaign.status === 'proposed' || campaign.status === 'requested');
  const askChanges =
    canDecide && campaign.origin === 'agency' && campaign.status === 'proposed' && !waitingAgency && request.data;
  const agencyNoticeIsWarning = campaign.status === 'requested' || waitingAgency;

  const agencyNotice =
    campaign.origin === 'agency' && request.data ? (
      <span data-testid="campaign-agency-notice">
        {campaign.status === 'requested'
          ? 'La agencia está preparando el plan. Lo verás aquí en cuanto lo entregue.'
          : waitingAgency
            ? 'Has pedido cambios a la agencia: el plan se podrá aceptar cuando entregue la versión nueva.'
            : `Encargo a la agencia: ${REQUEST_STATUS_LABEL[request.data.status].toLowerCase()}.`}{' '}
        <Link className="underline" to={requestPaths(org.id, brand.id).item(request.data.id)}>
          Ver el encargo
        </Link>
      </span>
    ) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link to={paths.list} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Campañas
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <h1 className="text-2xl" data-testid="campaign-title-heading">
              {campaign.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
              <Badge tone={CAMPAIGN_STATUS_TONE[campaign.status]}>
                <span data-testid="campaign-status">{CAMPAIGN_STATUS_LABEL[campaign.status]}</span>
              </Badge>
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4" aria-hidden />
                {shortDay(campaign.starts_on)} – {shortDay(campaign.ends_on)}
              </span>
              <span>{campaign.networks.map(networkLabel).join(', ')}</span>
              <span>{SOURCE_LABEL[campaign.origin]}</span>
            </div>
            {draft && (
              <p className="line-clamp-2 max-w-3xl text-sm lg:line-clamp-1" title={draft.objective}>
                <span className="text-muted">Objetivo: </span>
                <span data-testid="campaign-objective">{draft.objective}</span>
              </p>
            )}
            {agencyNotice && !agencyNoticeIsWarning && <p className="text-xs text-muted">{agencyNotice}</p>}
          </div>

          {(editable || showDiscard || askChanges || nextPiece) && (
            <div className="flex flex-wrap gap-2 lg:justify-end">
              {editable && draft && (
                <Button
                  onClick={() => setConfirmAccept(true)}
                  disabled={!check?.ok}
                  title={check && !check.ok ? 'Revisa las piezas marcadas' : undefined}
                  data-testid="campaign-accept"
                >
                  <Check className="h-4 w-4" aria-hidden />
                  Aceptar y crear {draft.pieces.length} borradores
                </Button>
              )}
              {askChanges && request.data && (
                <Link
                  to={requestPaths(org.id, brand.id).item(request.data.id)}
                  className={cn(linkButton, 'border border-border bg-surface text-fg hover:bg-subtle')}
                  data-testid="campaign-ask-changes"
                >
                  <MessageSquare className="h-4 w-4" aria-hidden />
                  Pedir cambios
                </Link>
              )}
              {nextPiece && (
                <Link
                  to={contentPaths(org.id, brand.id).item(nextPiece.content_id)}
                  className={cn(linkButton, 'bg-primary text-primary-fg shadow-card hover:bg-primary/90')}
                  data-testid="campaign-open-next"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Abrir la siguiente pieza
                </Link>
              )}
              {showDiscard && (
                <Button variant="ghost" onClick={() => setConfirmDiscard(true)} data-testid="campaign-discard">
                  <XCircle className="h-4 w-4" aria-hidden />
                  Descartar
                </Button>
              )}
            </div>
          )}
        </div>
      </header>

      {agencyNotice && agencyNoticeIsWarning && <Notice tone="warning">{agencyNotice}</Notice>}

      {campaign.current_plan_version > 0 &&
        (plan.isPending ? (
          <Skeleton className="h-48" />
        ) : plan.isError ? (
          <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
        ) : !draft ? (
          <Notice tone="warning">Este plan no tiene el formato esperado y no se puede mostrar.</Notice>
        ) : null)}

      {(draft || accepted) && (
        <section className="space-y-3" aria-labelledby="campaign-week-heading" data-testid="campaign-plan">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="campaign-week-heading" className="text-lg">
              {accepted ? 'Piezas creadas' : 'Piezas del plan'}
              <span className="ml-2 text-sm font-normal text-muted">{pieces.length}</span>
            </h2>
            {pieces.length > 0 && (
              <p className="text-xs text-muted">
                {accepted ? 'Borradores en Contenidos. ' : ''}Pulsa una pieza para ver su texto.
              </p>
            )}
          </div>
          {issues.some((i) => i.path.startsWith('pieces.')) && (
            <Notice tone="warning">Hay piezas marcadas en rojo: ábrelas y corrígelas antes de aceptar.</Notice>
          )}
          {!accepted && draft && draft.pieces.length === 0 && (
            <Notice tone="warning">
              Has quitado todas las piezas: no hay nada que aceptar. Descarta la campaña o vuelve a abrirla.
            </Notice>
          )}
          {accepted && contents.isPending ? (
            <Skeleton className="h-48" />
          ) : accepted && contents.isError ? (
            <ErrorState error={contents.error} onRetry={() => void contents.refetch()} />
          ) : (
            <WeekStrip
              start={campaign.starts_on}
              end={campaign.ends_on}
              pieces={pieces}
              previews={previews}
              selected={selected}
              onSelect={setSelected}
              accepted={accepted}
            />
          )}
          {current && (
            <PieceSheet
              item={current}
              preview={previews.get(current.key)}
              orgId={org.id}
              brandId={brand.id}
              editable={editable}
              assetNames={assetNames}
              onChange={updatePiece}
              onRemove={removePiece}
              onClose={closeSheet}
            />
          )}
        </section>
      )}

      <div className="space-y-3">
        {draft && plan.data && (
          <WhyThisPlan plan={draft} version={campaign.current_plan_version} createdAt={plan.data.created_at} />
        )}
        <Fold
          title="Lo que se pidió"
          summary={campaign.instruction}
          defaultOpen={campaign.current_plan_version === 0}
          testId="campaign-instruction"
        >
          <p className="max-w-prose whitespace-pre-wrap text-sm" data-testid="campaign-instruction-text">
            {campaign.instruction}
          </p>
        </Fold>
      </div>

      <ConfirmDialog
        open={confirmAccept}
        onOpenChange={setConfirmAccept}
        title="¿Aceptar el plan?"
        description={`Se crearán ${draft?.pieces.length ?? 0} piezas como borradores en Contenidos. No se aprueba, no se programa y no se publica nada.`}
        confirmLabel="Aceptar y crear borradores"
        destructive={false}
        loading={mutations.accept.isPending}
        onConfirm={() => void accept()}
      />
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="¿Descartar la campaña?"
        description={
          campaign.origin === 'agency'
            ? 'No se creará ninguna pieza y el encargo a la agencia quedará cancelado.'
            : 'No se creará ninguna pieza. El plan se conserva para consultarlo.'
        }
        confirmLabel="Descartar"
        loading={mutations.discard.isPending}
        onConfirm={() => void discard()}
      />
    </div>
  );
}

/** Bloque plegable con su resumen de una línea a la vista. */
function Fold({
  title,
  summary,
  defaultOpen = false,
  testId,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <details
      className="group rounded-xl border border-border bg-surface shadow-card"
      open={defaultOpen || undefined}
      data-testid={testId}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block truncate text-sm text-muted group-open:hidden">{summary}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border px-4 py-4 sm:px-5">{children}</div>
    </details>
  );
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Observado, datos e hipótesis: separados siempre, y plegados para no tapar la semana. */
function WhyThisPlan({ plan, version, createdAt }: { plan: CampaignPlan; version: number; createdAt: string }) {
  const { observed, dataBacked, hypotheses, dataNote } = plan.reasoning;
  const summary = [
    count(observed.length, 'cosa observada', 'cosas observadas'),
    dataBacked.length ? count(dataBacked.length, 'dato', 'datos') : 'sin datos de resultados',
    count(hypotheses.length, 'suposición', 'suposiciones'),
  ].join(', ');
  return (
    <Fold title="Por qué este plan" summary={`${summary[0]!.toUpperCase()}${summary.slice(1)}.`} testId="campaign-why">
      <div className="space-y-4">
        {plan.summary && <p className="max-w-prose text-sm">{plan.summary}</p>}
        <div className="grid gap-4 md:grid-cols-3">
          <ReasonList
            title="Lo observado"
            hint="Lo que se ve en la marca y en lo pedido."
            items={observed}
            empty="Nada anotado."
            testId="reason-observed"
            className="border-border"
          />
          <ReasonList
            title="Respaldado por datos"
            hint="Medido en las cuentas de la marca."
            items={dataBacked}
            empty={dataNote || 'Nada respaldado por datos.'}
            testId="reason-data"
            className="border-success"
          />
          <ReasonList
            title="Hipótesis"
            hint="Por comprobar: no son datos."
            items={hypotheses}
            empty="Ninguna."
            testId="reason-hypotheses"
            className="border-dashed border-warning"
          />
        </div>
        <p className="text-xs text-muted">
          Versión {version} del plan, {formatDateTime(createdAt)}
        </p>
      </div>
    </Fold>
  );
}

function ReasonList({
  title,
  hint,
  items,
  empty,
  testId,
  className,
}: {
  title: string;
  hint: string;
  items: string[];
  empty: string;
  testId: string;
  className: string;
}) {
  return (
    <div className={cn('space-y-1.5 border-l-2 pl-3', className)} data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted">{hint}</p>
      {items.length ? (
        <ul className="list-disc space-y-1 pl-4 text-sm">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
    </div>
  );
}
