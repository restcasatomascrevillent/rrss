import { ExternalLink, MessageSquare, RefreshCw, RotateCcw, Send, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ActionNotice, Badge, Button, Dialog, Field, Input, LinkButton, Notice, Textarea } from '@/components/ui';
import { contentPaths, targetLabel } from '@/features/content/labels';
import { STATUS_LABEL } from '@/features/content/status';
import type { PublicationAttemptOutcome } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatDateTime } from '@/lib/utils';
import {
  approvedVersionPlan,
  useApproveContents,
  useCancelPublication,
  useCommentContent,
  useContentComments,
  usePublicationAttempts,
  usePublishableMedia,
  useRequestChanges,
  useReschedulePublication,
  useRetryPublication,
  useSavePublication,
  useSocialAccounts,
  type CalendarEntry,
} from './api';
import {
  DISPLAY_LABEL,
  DISPLAY_TONE,
  displayState,
  fromLocalInput,
  HOLD_REASON_TEXT,
  isEditable,
  toLocalInput,
} from './calendar';
import { useFeature } from '@/features/platform/integrations/useFeature';
import { activeAccountOf, holdAdvice } from './holdAdvice';
import { connectedAccountsPath, exportPath } from './links';
import { PublicationPreview } from './preview';

const OUTCOME_LABEL: Record<PublicationAttemptOutcome, string> = {
  started: 'En curso',
  waiting: 'Esperando a que la red procese el medio',
  deferred: 'Aplazada',
  published: 'Publicada',
  recovered: 'Ya estaba publicada: no se repitió',
  retrying: 'Falló; se reintentará',
  failed: 'Falló',
  not_ready: 'No se publicó: no estaba aprobada',
};

const COMMENT_KIND: Record<string, string> = {
  approved: 'aprobó',
  unapproved: 'retiró la aprobación',
  changes_requested: 'pidió cambios',
  comment: 'comentó',
};

interface PublicationDialogProps {
  orgId: string;
  brandId: string;
  entry: CalendarEntry | null;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  canApprove: boolean;
  canComment: boolean;
  /** «Publicar ahora»: lo abre quien monta la ficha (la ficha se vuelve a montar al cambiar la hora). */
  onPublishNow: (entry: CalendarEntry) => void;
}

/** Ficha de una publicación del calendario: estado, motivo, intentos, comentarios y acciones. */
export function PublicationDialog({
  orgId,
  brandId,
  entry,
  onOpenChange,
  canEdit,
  canApprove,
  canComment,
  onPublishNow,
}: PublicationDialogProps) {
  const attempts = usePublicationAttempts(brandId, entry?.id ?? null);
  const comments = useContentComments(brandId, entry?.content_id ?? null);
  const reschedule = useReschedulePublication(brandId);
  const cancel = useCancelPublication(brandId);
  const retry = useRetryPublication(brandId);
  const approve = useApproveContents(brandId);
  const changes = useRequestChanges(brandId);
  const comment = useCommentContent(brandId);
  const rearm = useSavePublication(brandId);
  const accounts = useSocialAccounts(brandId);
  // Solo hace falta la biblioteca si la publicación está detenida porque la pieza cambió.
  const changed = Boolean(entry && entry.status === 'planned' && entry.hold_reason === 'content_changed');
  const media = usePublishableMedia(brandId, changed);
  // El calendario monta el diálogo con una clave por publicación y fecha: el estado nace con ella.
  const [when, setWhen] = useState(() => (entry ? toLocalInput(entry.scheduled_at) : ''));
  const [body, setBody] = useState('');
  const publishing = useFeature('publishing');

  if (!entry) return null;
  const state = displayState(entry, entry.content?.status ?? null);
  const content = entry.content;
  const editable = canEdit && isEditable(entry.status);
  const done = (message: string) => () => toast.success(message);
  const failed = (error: unknown) => toast.error(translateError(error));
  const plan =
    changed && editable && content && media.data
      ? approvedVersionPlan(content, media.data, entry.media_asset_ids)
      : null;
  const held = entry.status === 'planned' && entry.hold_reason ? entry.hold_reason : null;
  const account = activeAccountOf(accounts.data, entry.network);
  const advice = held ? holdAdvice(held, account) : null;

  const approvedButton = plan && content && (
    <Button
      size="sm"
      disabled={!plan.ok}
      loading={rearm.isPending}
      onClick={() => {
        if (!plan.ok) return;
        rearm.mutate(
          {
            publicationId: entry.id,
            contentId: content.id,
            scheduledAt: entry.scheduled_at,
            accountId: entry.social_account_id,
            mediaAssetIds: plan.mediaAssetIds,
            contentVersion: plan.version,
          },
          {
            onSuccess: (pub) =>
              pub.status === 'scheduled'
                ? toast.success(`Programada con la versión ${plan.version}`)
                : toast.info(
                    `Guardada, pero aún no se publicará. ${pub.hold_reason ? HOLD_REASON_TEXT[pub.hold_reason] : ''}`,
                  ),
            onError: failed,
          },
        );
      }}
      data-testid="publication-use-approved"
    >
      <RefreshCw className="h-4 w-4" aria-hidden />
      Usar la versión aprobada
    </Button>
  );

  /** El botón que arregla el motivo de la detención. */
  const fix = (() => {
    if (!advice) return null;
    switch (advice.fix) {
      case 'connect':
        return (
          <LinkButton to={connectedAccountsPath(orgId, brandId)} data-testid="publication-hold-fix">
            {advice.label}
          </LinkButton>
        );
      case 'use_account': {
        const live = (accounts.data ?? []).find((a) => a.network === entry.network && a.status === 'active');
        return editable && live ? (
          <Button
            size="sm"
            loading={rearm.isPending}
            onClick={() =>
              rearm.mutate(
                {
                  publicationId: entry.id,
                  contentId: entry.content_id,
                  scheduledAt: entry.scheduled_at,
                  accountId: live.id,
                  mediaAssetIds: entry.media_asset_ids,
                  contentVersion: entry.content_version,
                },
                {
                  onSuccess: (pub) =>
                    pub.status === 'scheduled'
                      ? toast.success('Programada')
                      : toast.info(
                          `Cuenta elegida, pero aún no se publicará. ${pub.hold_reason ? HOLD_REASON_TEXT[pub.hold_reason] : ''}`,
                        ),
                  onError: failed,
                },
              )
            }
            data-testid="publication-hold-fix"
          >
            {advice.label}
          </Button>
        ) : null;
      }
      case 'use_approved':
        return approvedButton || null;
      case 'export':
        return (
          <LinkButton to={exportPath(orgId, brandId, entry.content_id)} data-testid="publication-hold-fix">
            {advice.label}
          </LinkButton>
        );
      case 'open_editor':
        return (
          <LinkButton
            to={contentPaths(orgId, brandId).item(entry.content_id)}
            variant="secondary"
            data-testid="publication-hold-fix"
          >
            {advice.label}
          </LinkButton>
        );
      case 'none':
        return null;
    }
  })();

  return (
    <Dialog
      open={Boolean(entry)}
      onOpenChange={onOpenChange}
      title={content?.title ?? 'Publicación'}
      description={
        content ? `${targetLabel(entry.network, entry.format)} · ${formatDateTime(entry.scheduled_at)}` : undefined
      }
      size="lg"
    >
      <div className="space-y-4" data-testid="publication-dialog">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={DISPLAY_TONE[state]}>
            <span data-testid="publication-state">{DISPLAY_LABEL[state]}</span>
          </Badge>
          {content && (
            <span className="text-xs text-muted">
              Pieza: {STATUS_LABEL[content.status]}
              {entry.content_version ? ` · versión programada ${entry.content_version}` : ''}
            </span>
          )}
          {content && (
            <Link to={contentPaths(orgId, brandId).item(content.id)} className="text-xs text-primary underline">
              Abrir en el editor
            </Link>
          )}
        </div>

        {content && <PublicationPreview brandId={brandId} entry={entry} />}

        {entry.status === 'published' && entry.external_id && (
          <Notice>
            Publicada el {formatDateTime(entry.published_at!)} · identificador en la red{' '}
            <code data-testid="publication-external-id">{entry.external_id}</code>
            {entry.external_url && (
              <>
                {' · '}
                <a
                  href={entry.external_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-primary underline"
                  data-testid="publication-link"
                >
                  Ver en la red <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </>
            )}
          </Notice>
        )}
        {held && advice && (
          <ActionNotice
            tone={state === 'held' ? 'warning' : 'info'}
            title={advice.short}
            action={fix}
            why={<span data-testid="publication-hold">{HOLD_REASON_TEXT[held]}</span>}
            data-testid="publication-hold-notice"
          />
        )}
        {entry.last_error && entry.status !== 'published' && (
          <Notice tone="warning">
            {entry.status === 'failed' ? 'Falló: ' : 'Último aviso: '}
            <span data-testid="publication-error">{entry.last_error}</span>
          </Notice>
        )}

        {editable && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Mover a" className="min-w-[14rem] flex-1">
              {(props) => (
                <Input {...props} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              )}
            </Field>
            <Button
              variant="secondary"
              loading={reschedule.isPending}
              onClick={() => {
                const at = fromLocalInput(when);
                if (!at) return toast.error('Indica el día y la hora.');
                reschedule.mutate(
                  { publicationId: entry.id, scheduledAt: at },
                  { onSuccess: done('Movida'), onError: failed },
                );
              }}
            >
              Mover
            </Button>
          </div>
        )}

        {plan && content && !plan.ok && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="publication-rearm">
            <span data-testid="publication-rearm-problem">
              {plan.reason === 'not_approved'
                ? 'Antes hay que aprobar la pieza: luego podrás usar su versión aprobada.'
                : content.format === 'carousel'
                  ? `Antes hay que exportar todas las páginas de la versión ${plan.version}.`
                  : `Antes hay que exportar la versión ${plan.version}.`}
            </span>
            {plan.reason === 'no_exports' && (
              <Link
                to={exportPath(orgId, brandId, content.id)}
                className="font-medium text-primary underline"
                data-testid="publication-rearm-editor"
              >
                Exportar
              </Link>
            )}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {canApprove && content?.status === 'in_review' && (
            <Button
              loading={approve.isPending}
              onClick={() =>
                approve.mutate([{ contentId: content.id, version: content.current_version }], {
                  onSuccess: (r) =>
                    r[0]?.ok ? toast.success('Aprobada') : toast.error(r[0]?.message ?? 'No se pudo aprobar'),
                  onError: failed,
                })
              }
              data-testid="publication-approve"
            >
              Aprobar la versión {content.current_version}
            </Button>
          )}
          {publishing && editable && entry.status === 'scheduled' && (
            <Button onClick={() => onPublishNow(entry)} data-testid="publication-publish-now">
              <Send className="h-4 w-4" aria-hidden />
              Publicar ahora
            </Button>
          )}
          {canEdit && entry.status === 'failed' && (
            <Button
              variant="secondary"
              loading={retry.isPending}
              onClick={() => retry.mutate(entry.id, { onSuccess: done('Se reintentará'), onError: failed })}
              data-testid="publication-retry"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Reintentar
            </Button>
          )}
          {editable && (
            <Button
              variant="ghost"
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(entry.id, {
                  onSuccess: () => {
                    toast.success('Cancelada');
                    onOpenChange(false);
                  },
                  onError: failed,
                })
              }
              data-testid="publication-cancel"
            >
              <XCircle className="h-4 w-4" aria-hidden />
              Cancelar la publicación
            </Button>
          )}
        </div>

        <section aria-label="Intentos">
          <h3 className="mb-1 text-sm font-semibold">Intentos</h3>
          {(attempts.data ?? []).length === 0 ? (
            <p className="text-xs text-muted">Todavía no se ha intentado publicar.</p>
          ) : (
            <ul className="space-y-1 text-xs" data-testid="publication-attempts">
              {attempts.data!.map((a) => (
                <li key={a.id}>
                  {formatDateTime(a.started_at)} · intento {a.attempt_no} · {OUTCOME_LABEL[a.outcome]}
                  {a.error_message ? ` · ${a.error_message}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Comentarios">
          <h3 className="mb-1 flex items-center gap-1 text-sm font-semibold">
            <MessageSquare className="h-4 w-4" aria-hidden /> Comentarios y aprobaciones
          </h3>
          <ul className="max-h-48 space-y-2 overflow-y-auto text-sm" data-testid="publication-comments">
            {(comments.data ?? []).map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.author}</span>{' '}
                <span className="text-muted">
                  {COMMENT_KIND[c.kind]}
                  {c.version ? ` (versión ${c.version})` : ''} · {formatDateTime(c.created_at)}
                </span>
                {c.body && <p className="whitespace-pre-wrap">{c.body}</p>}
              </li>
            ))}
          </ul>
          {canComment && content && (
            <div className="mt-2 space-y-2">
              <Textarea
                aria-label="Comentario"
                rows={2}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                data-testid="publication-comment-body"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!body.trim()}
                  loading={comment.isPending}
                  onClick={() =>
                    comment.mutate({ contentId: content.id, body }, { onSuccess: () => setBody(''), onError: failed })
                  }
                  data-testid="publication-comment-send"
                >
                  Comentar
                </Button>
                {canApprove && (content.status === 'in_review' || content.status === 'approved') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!body.trim()}
                    loading={changes.isPending}
                    onClick={() =>
                      changes.mutate(
                        { contentId: content.id, message: body },
                        { onSuccess: () => (setBody(''), toast.success('Cambios pedidos')), onError: failed },
                      )
                    }
                  >
                    Pedir cambios
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
