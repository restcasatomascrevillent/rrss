import { Archive, ArchiveRestore, ChevronRight, FileText, FilterX, Lightbulb, Plus, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '@/components/ui';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { ContentStatus } from '@/lib/database.types';
import { formatDateTime } from '@/lib/utils';
import { useContentItems, type ContentFilters } from './api';
import { CreateContentDialog } from './CreateContentDialog';
import { contentPaths, targetLabel } from './labels';
import { NETWORKS } from './networks';
import { CONTENT_STATUSES, STATUS_LABEL, STATUS_TONE } from './status';

export function ContentListPage() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canEdit = can('edit');
  const paths = contentPaths(org.id, brand.id);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<ContentStatus | ''>('');
  const [network, setNetwork] = useState('');
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);

  const filters: ContentFilters = useMemo(
    () => ({ status, network, archived, search: deferredSearch }),
    [status, network, archived, deferredSearch],
  );
  const items = useContentItems(brand.id, filters);
  const rows = useMemo(() => items.data?.pages.flat() ?? [], [items.data]);
  const filtering = Boolean(status || network || deferredSearch.trim());
  const clearFilters = () => {
    setStatus('');
    setNetwork('');
    setSearch('');
  };

  return (
    <>
      <PageHeader
        title="Contenidos"
        description={`Las publicaciones de ${brand.name}: de la idea a la pieza aprobada.`}
        action={
          canEdit && (
            <Button onClick={() => setCreating(true)} data-testid="content-new">
              <Plus className="h-4 w-4" aria-hidden />
              Nueva idea
            </Button>
          )
        }
        more={[
          archived
            ? {
                id: 'live',
                label: 'Ver las que están en curso',
                icon: ArchiveRestore,
                onSelect: () => setArchived(false),
                testId: 'content-show-live',
              }
            : {
                id: 'archived',
                label: 'Ver las archivadas',
                icon: Archive,
                onSelect: () => setArchived(true),
                testId: 'content-show-archived',
              },
        ]}
        moreTestId="content-more"
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Buscar por nombre"
            placeholder="Buscar por nombre"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="content-search"
          />
        </div>
        <Select
          aria-label="Filtrar por estado"
          value={status}
          onChange={(e) => setStatus(e.target.value as ContentStatus | '')}
          data-testid="content-status-filter"
        >
          <option value="">Todos los estados</option>
          {CONTENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por red"
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
          data-testid="content-network-filter"
        >
          <option value="">Todas las redes</option>
          {NETWORKS.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </Select>
      </div>

      {archived && (
        <ActionNotice
          tone="info"
          icon={Archive}
          className="mb-4"
          title="Estás viendo las archivadas"
          action={
            <Button size="sm" variant="secondary" onClick={() => setArchived(false)} data-testid="content-back-live">
              Volver a las que están en curso
            </Button>
          }
          data-testid="content-archived-notice"
        />
      )}

      {items.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : items.isError ? (
        <Card>
          <ErrorState error={items.error} onRetry={() => void items.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={archived ? Archive : filtering ? Search : Lightbulb}
            title={
              archived
                ? 'No hay contenidos archivados'
                : filtering
                  ? 'Nada coincide con los filtros'
                  : 'Todavía no hay contenidos'
            }
            description={
              archived
                ? 'Lo que se archiva no se borra: aparece aquí y se puede recuperar.'
                : filtering
                  ? 'Prueba con otra búsqueda o quita algún filtro.'
                  : canEdit
                    ? 'Empieza con una idea: elige la red y el formato y diséñala en el editor.'
                    : 'Cuando el equipo prepare publicaciones, aparecerán aquí.'
            }
            action={
              filtering ? (
                <Button variant="secondary" onClick={clearFilters} data-testid="content-clear-filters">
                  <FilterX className="h-4 w-4" aria-hidden />
                  Quitar filtros
                </Button>
              ) : archived ? null : (
                canEdit && (
                  <Button onClick={() => setCreating(true)} data-testid="content-empty-new">
                    <Plus className="h-4 w-4" aria-hidden />
                    Nueva idea
                  </Button>
                )
              )
            }
          />
        </Card>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface" data-testid="content-list">
            {rows.map((item) => (
              <li key={item.id}>
                <Link
                  to={paths.item(item.id)}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-subtle"
                  data-testid="content-row"
                >
                  <FileText className="h-5 w-5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {targetLabel(item.network, item.format)} ·{' '}
                      {item.current_version > 0 ? `versión ${item.current_version}` : 'sin diseño'} ·{' '}
                      {formatDateTime(item.updated_at)}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          {items.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button variant="secondary" onClick={() => void items.fetchNextPage()} loading={items.isFetchingNextPage}>
                Cargar más
              </Button>
            </div>
          )}
        </>
      )}

      {canEdit && (
        <CreateContentDialog organizationId={org.id} brandId={brand.id} open={creating} onOpenChange={setCreating} />
      )}
    </>
  );
}
