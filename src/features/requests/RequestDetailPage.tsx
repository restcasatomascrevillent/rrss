import { Check, ChevronLeft, ExternalLink, MessageSquare, RotateCcw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  Notice,
  Skeleton,
  Spinner,
  Textarea,
} from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { contentPaths, targetLabel } from '@/features/content/labels';
import { campaignPaths } from '@/features/campaigns/labels';
import { useAssetsByIds, useSignedUrls } from '@/features/library/api';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { CampaignRequestRow, ContentRequestRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useRequest, useRequestMutations, useRequestThread } from './api';
import {
  MEDIA_KIND_LABEL,
  REQUEST_EVENT_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  requestActions,
  requestPaths,
} from './labels';
import { RequestPreparePanel } from './RequestPreparePanel';
import { unreadByRequest, useMarkRequestNotificationsRead, useUnreadRequestNotifications } from './notifications';

/** Al abrir el encargo, sus avisos sin leer (nuevo o entregado) se dan por leídos. */
function useReadOnOpen(brandId: string, requestId: string) {
  const unread = useUnreadRequestNotifications(brandId);
  const markRead = useMarkRequestNotificationsRead(brandId);
  const pending = unreadByRequest(unread.data).has(requestId);
  const { mutate, isPending } = markRead;
  useEffect(() => {
    if (pending && !isPending) mutate(requestId);
  }, [pending, isPending, mutate, requestId]);
}

export function RequestDetailPage() {
  const { requestId = '' } = useParams();
  const { brand } = useBrand();
  const request = useRequest(brand.id, requestId);
  if (request.isPending) return <Spinner />;
  if (request.isError) return <ErrorState error={request.error} onRetry={() => void request.refetch()} />;
  return <RequestDetail request={request.data} />;
}

function References({ brandId, ids }: { brandId: string; ids: string[] }) {
  const assets = useAssetsByIds(brandId, ids);
  const paths = useMemo(() => (assets.data ?? []).map((a) => a.storage_path), [assets.data]);
  const urls = useSignedUrls(paths);
  if (!ids.length) return <p className="text-sm text-muted">Sin recursos de referencia.</p>;
  if (assets.isPending) return <Skeleton className="h-20" />;
  const missing = ids.length - (assets.data?.length ?? 0);
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-3" data-testid="request-reference-list">
        {(assets.data ?? []).map((asset) => {
          const url = urls.data?.get(asset.storage_path);
          return (
            <li key={asset.id} className="w-24">
              <span className="block aspect-square overflow-hidden rounded-lg border border-border bg-subtle">
                {url && asset.kind !== 'video' ? (
                  <img src={url} alt={asset.file_name} loading="lazy" className="h-full w-full object-cover" />
                ) : null}
              </span>
              <span className="mt-1 block truncate text-xs text-muted">{asset.file_name}</span>
            </li>
          );
        })}
      </ul>
      {missing > 0 && <p className="text-xs text-muted">{missing} recurso(s) ya no están en la biblioteca.</p>}
    </div>
  );
}

function RequestDetail({ request }: { request: ContentRequestRow }) {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const user = useUser();
  const paths = requestPaths(org.id, brand.id);
  const thread = useRequestThread(brand.id, request.id);
  const mutations = useRequestMutations(brand.id);
  useReadOnOpen(brand.id, request.id);
  const actions = requestActions(request, {
    comment: can('comment'),
    approve: can('approve'),
    manage: can('manage'),
    userId: user.id,
  });
  // Encargo de un plan de campaña (modo agencia): se revisa y se acepta en Campañas.
  const planCampaignId =
    (request as Partial<CampaignRequestRow>).kind === 'plan'
      ? ((request as Partial<CampaignRequestRow>).campaign_id ?? null)
      : null;
  const [comment, setComment] = useState('');
  const [changesOpen, setChangesOpen] = useState(false);
  const [changes, setChanges] = useState('');
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  function sendComment(event: FormEvent) {
    event.preventDefault();
    mutations.comment.mutate(
      { requestId: request.id, body: comment },
      {
        onSuccess: () => setComment(''),
        onError: (e) => toast.error(translateError(e)),
      },
    );
  }

  function sendChanges(event: FormEvent) {
    event.preventDefault();
    mutations.requestChanges.mutate(
      { requestId: request.id, message: changes },
      {
        onSuccess: () => {
          setChangesOpen(false);
          setChanges('');
          toast.success('Cambios pedidos');
        },
        onError: (e) => toast.error(translateError(e)),
      },
    );
  }

  function accept() {
    mutations.accept.mutate(request.id, {
      onSuccess: () => {
        setConfirmAccept(false);
        toast.success('Entrega aceptada: la pieza queda aprobada');
      },
      onError: (e) => {
        setConfirmAccept(false);
        toast.error(translateError(e));
      },
    });
  }

  function cancel() {
    mutations.cancel.mutate(
      { requestId: request.id, reason: '' },
      {
        onSuccess: () => {
          setConfirmCancel(false);
          toast.success('Encargo cancelado');
        },
        onError: (e) => {
          setConfirmCancel(false);
          toast.error(translateError(e));
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={paths.list} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Encargos
          </Link>
          <h1 className="text-2xl" data-testid="request-detail-title">
            {request.title}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={REQUEST_STATUS_TONE[request.status]}>
              <span data-testid="request-status">{REQUEST_STATUS_LABEL[request.status]}</span>
            </Badge>
            <span>{targetLabel(request.network, request.format)}</span>
            {request.media_kind && <span>· {MEDIA_KIND_LABEL[request.media_kind]}</span>}
            {request.desired_date && <span>· para el {formatDate(request.desired_date)}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.requestChanges && (
            <Button variant="secondary" onClick={() => setChangesOpen(true)} data-testid="request-changes">
              <RotateCcw className="h-4 w-4" aria-hidden />
              Pedir cambios
            </Button>
          )}
          {actions.accept && !planCampaignId && (
            <Button onClick={() => setConfirmAccept(true)} data-testid="request-accept">
              <Check className="h-4 w-4" aria-hidden />
              Aceptar
            </Button>
          )}
          {actions.cancel && (
            <Button variant="ghost" onClick={() => setConfirmCancel(true)} data-testid="request-cancel">
              <XCircle className="h-4 w-4" aria-hidden />
              Cancelar encargo
            </Button>
          )}
        </div>
      </div>

      {/* Un plan de campaña no se entrega como pieza: lo entrega la agencia en Campañas. */}
      {can('edit') && !planCampaignId && <RequestPreparePanel request={request} />}
      {planCampaignId && (
        <Card data-testid="request-plan">
          <CardHeader
            title="Plan de campaña"
            description={
              request.status === 'delivered'
                ? 'La agencia ha entregado el plan: revísalo y acéptalo en Campañas, o pide cambios aquí.'
                : 'Este encargo es un plan de campaña: se revisa y se acepta en Campañas.'
            }
            action={
              <Link to={campaignPaths(org.id, brand.id).item(planCampaignId)} data-testid="request-open-campaign">
                <Button variant="secondary">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Abrir la campaña
                </Button>
              </Link>
            }
          />
        </Card>
      )}

      {request.content_id && (
        <Card data-testid="request-delivery">
          <CardHeader
            title={request.delivered_version ? `Borrador entregado (versión ${request.delivered_version})` : 'Pieza'}
            description={
              request.status === 'delivered'
                ? 'Ábrelo en el editor para revisarlo. Después, acéptalo o pide cambios.'
                : request.status === 'accepted'
                  ? 'Aceptado: la pieza quedó aprobada en esta versión.'
                  : 'La pieza a la que se refiere este encargo.'
            }
            action={
              <Link to={contentPaths(org.id, brand.id).item(request.content_id)} data-testid="request-open-content">
                <Button variant="secondary">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Abrir en el editor
                </Button>
              </Link>
            }
          />
        </Card>
      )}

      <Card>
        <CardHeader title="Encargo" />
        <CardBody className="space-y-4">
          <p className="whitespace-pre-wrap text-sm" data-testid="request-brief-text">
            {request.brief}
          </p>
          <References brandId={brand.id} ids={request.reference_asset_ids} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Conversación" />
        <CardBody className="space-y-4">
          {thread.isPending ? (
            <Skeleton className="h-24" />
          ) : thread.isError ? (
            <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
          ) : (
            <ol className="space-y-3" data-testid="request-thread">
              {thread.data.map((entry) =>
                entry.kind === 'status' && entry.status ? (
                  <li key={entry.id} className="text-sm" data-testid="request-event">
                    <span className="text-muted">
                      {formatDateTime(entry.created_at)} · <span className="font-medium text-fg">{entry.author}</span>{' '}
                      {REQUEST_EVENT_LABEL[entry.status]}
                    </span>
                    {entry.body && (
                      <p className="mt-1 whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2">{entry.body}</p>
                    )}
                  </li>
                ) : (
                  <li key={entry.id} className="text-sm" data-testid="request-comment">
                    <span className="text-muted">
                      {formatDateTime(entry.created_at)} · <span className="font-medium text-fg">{entry.author}</span>
                    </span>
                    <p className="mt-1 whitespace-pre-wrap rounded-lg border border-border px-3 py-2">{entry.body}</p>
                  </li>
                ),
              )}
            </ol>
          )}
          {actions.comment ? (
            <form onSubmit={sendComment} className="space-y-2">
              <Field label="Comentario">
                {(props) => (
                  <Textarea
                    {...props}
                    rows={3}
                    maxLength={5000}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    data-testid="request-comment-input"
                  />
                )}
              </Field>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={!comment.trim()}
                loading={mutations.comment.isPending}
                data-testid="request-comment-send"
              >
                <MessageSquare className="h-4 w-4" aria-hidden />
                Comentar
              </Button>
            </form>
          ) : (
            <Notice>Con tu rol puedes leer la conversación, pero no comentar.</Notice>
          )}
        </CardBody>
      </Card>

      <Dialog
        open={changesOpen}
        onOpenChange={setChangesOpen}
        title="Pedir cambios"
        description="Explica qué hay que cambiar. Quien prepara la pieza lo verá en la conversación."
        footer={
          <>
            <Button variant="secondary" onClick={() => setChangesOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              form="request-changes-form"
              loading={mutations.requestChanges.isPending}
              disabled={!changes.trim()}
              data-testid="request-changes-send"
            >
              Pedir cambios
            </Button>
          </>
        }
      >
        <form id="request-changes-form" onSubmit={sendChanges}>
          <Field label="Qué hay que cambiar">
            {(props) => (
              <Textarea
                {...props}
                rows={5}
                maxLength={5000}
                value={changes}
                onChange={(e) => setChanges(e.target.value)}
                data-testid="request-changes-input"
              />
            )}
          </Field>
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmAccept}
        onOpenChange={setConfirmAccept}
        title="¿Aceptar la entrega?"
        description={`La pieza quedará aprobada en la versión ${request.delivered_version ?? ''} y el encargo, cerrado.`}
        confirmLabel="Aceptar"
        destructive={false}
        loading={mutations.accept.isPending}
        onConfirm={accept}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="¿Cancelar el encargo?"
        description="Quedará cerrado y nadie seguirá preparándolo. Lo ya entregado se conserva en Contenidos."
        confirmLabel="Cancelar encargo"
        loading={mutations.cancel.isPending}
        onConfirm={cancel}
      />
    </div>
  );
}
