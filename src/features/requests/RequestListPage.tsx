import { BellOff, ChevronRight, ClipboardList, Inbox, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Select, Skeleton } from '@/components/ui';
import { targetLabel } from '@/features/content/labels';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { ContentRequestStatus } from '@/lib/database.types';
import { formatDate, formatDateTime } from '@/lib/utils';
import { useRequests } from './api';
import { CreateRequestDialog } from './CreateRequestDialog';
import {
  NOTIFICATION_TEXT,
  unreadByRequest,
  useMarkRequestNotificationsRead,
  useUnreadRequestNotifications,
} from './notifications';
import { REQUEST_STATUSES, REQUEST_STATUS_LABEL, REQUEST_STATUS_TONE, requestPaths } from './labels';

/** Encargos de la marca: lo que se ha pedido, en qué estado está y quién tiene que moverlo. */
export function RequestListPage() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canRequest = can('comment');
  const paths = requestPaths(org.id, brand.id);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<ContentRequestStatus | ''>('');
  const requests = useRequests(brand.id, status);
  const rows = requests.data ?? [];
  const unread = useUnreadRequestNotifications(brand.id);
  const unreadMap = unreadByRequest(unread.data);
  const markRead = useMarkRequestNotificationsRead(brand.id);

  const newButton = canRequest && (
    <Button onClick={() => setCreating(true)} data-testid="request-new">
      <Plus className="h-4 w-4" aria-hidden />
      Nuevo encargo
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Encargos"
        description={`Lo que se pide para ${brand.name}: se entrega un borrador y se acepta o se piden cambios.`}
        action={newButton}
      />

      <div className="mb-4 grid items-center gap-2 sm:grid-cols-3">
        <Select
          aria-label="Filtrar por estado"
          value={status}
          onChange={(e) => setStatus(e.target.value as ContentRequestStatus | '')}
          data-testid="request-status-filter"
        >
          <option value="">Todos los estados</option>
          {REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REQUEST_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        {unreadMap.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => markRead.mutate(null)}
            loading={markRead.isPending}
            data-testid="request-mark-all-read"
          >
            <BellOff className="h-4 w-4" aria-hidden />
            Marcar avisos como leídos
          </Button>
        )}
      </div>

      {requests.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : requests.isError ? (
        <Card>
          <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={status ? Inbox : ClipboardList}
            title={status ? 'Ningún encargo en ese estado' : 'Todavía no hay encargos'}
            description={
              status
                ? 'Prueba con otro estado.'
                : canRequest
                  ? 'Pide una publicación: cuenta qué necesitas y adjunta fotos de la biblioteca.'
                  : 'Cuando alguien pida una publicación, aparecerá aquí.'
            }
            action={
              status ? (
                <Button variant="secondary" onClick={() => setStatus('')} data-testid="request-clear-filter">
                  Ver todos los encargos
                </Button>
              ) : canRequest ? (
                <Button onClick={() => setCreating(true)} data-testid="request-empty-new">
                  <Plus className="h-4 w-4" aria-hidden />
                  Nuevo encargo
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface" data-testid="request-list">
          {rows.map((request) => (
            <li key={request.id}>
              <Link
                to={paths.item(request.id)}
                className="flex items-center gap-3 px-4 py-3 hover:bg-subtle"
                data-testid="request-row"
              >
                <ClipboardList className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{request.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {targetLabel(request.network, request.format)}
                    {request.desired_date ? ` · para el ${formatDate(request.desired_date)}` : ''} · pedido el{' '}
                    {formatDateTime(request.created_at)}
                  </span>
                </span>
                {unreadMap.has(request.id) && (
                  <Badge tone="primary">
                    <span data-testid="request-unread">{NOTIFICATION_TEXT[unreadMap.get(request.id)!.kind]}</span>
                  </Badge>
                )}
                <Badge tone={REQUEST_STATUS_TONE[request.status]}>{REQUEST_STATUS_LABEL[request.status]}</Badge>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canRequest && (
        <CreateRequestDialog organizationId={org.id} brandId={brand.id} open={creating} onOpenChange={setCreating} />
      )}
    </>
  );
}
