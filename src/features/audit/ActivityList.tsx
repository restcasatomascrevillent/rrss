import { History } from 'lucide-react';
import { EmptyState, ErrorState, Spinner } from '@/components/ui';
import type { AuditPage } from '@/features/orgs/api';
import { formatDateTime } from '@/lib/utils';
import { describeAudit } from './describe';

interface ActivityListProps {
  page: AuditPage | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
}

export function ActivityList({ page, isPending, error, onRetry }: ActivityListProps) {
  if (isPending) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!page || page.rows.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Sin actividad todavía"
        description="Aquí aparecerán los cambios que se hagan."
      />
    );
  }
  const nameOf = (id: string) => page.names.get(id) ?? '';
  // Las filas que otra ya cuenta (altas de miembro al aceptar una invitación) no se repiten.
  const items = page.rows.flatMap((row) => {
    const text = describeAudit(row, nameOf);
    return text === null ? [] : [{ row, text }];
  });
  return (
    <ul className="divide-y divide-border" data-testid="activity-list">
      {items.map(({ row, text }) => (
        <li
          key={row.id}
          className="flex flex-col gap-0.5 px-5 py-3 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
        >
          <span className="min-w-0">
            <span className="font-medium">{(row.actor_id && nameOf(row.actor_id)) || 'El sistema'}</span>{' '}
            {text}
          </span>
          <time dateTime={row.created_at} className="shrink-0 text-xs text-muted">
            {formatDateTime(row.created_at)}
          </time>
        </li>
      ))}
    </ul>
  );
}
