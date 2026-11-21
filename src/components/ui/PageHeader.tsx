import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MoreMenu, type MoreMenuItem } from './MoreMenu';

interface PageHeaderProps {
  title: ReactNode;
  /** Una línea de contexto como mucho. */
  description?: ReactNode;
  /** La acción principal de la página: una sola, con el botón relleno. */
  action?: ReactNode;
  /** Algo que se queda a la vista pero sin peso (p. ej. «Guardar versión» en el editor). */
  secondary?: ReactNode;
  /** El resto de acciones, en el menú «⋯». */
  more?: MoreMenuItem[];
  moreLabel?: string;
  moreTestId?: string;
  /** Enlace de vuelta, encima del título. */
  back?: ReactNode;
  /** Datos de estado bajo el título (insignias, versión…), en lugar de `description`. */
  meta?: ReactNode;
  titleTestId?: string;
  /** Cabecera más baja, para pantallas de trabajo como el editor. */
  compact?: boolean;
  className?: string;
}

/**
 * Cabecera común de página: dónde estás, una línea de contexto y UNA acción
 * principal a la derecha; lo demás, en «⋯». En móvil las acciones bajan bajo el
 * título y la principal ocupa el ancho que sobra, para que se vea la primera.
 */
export function PageHeader({
  title,
  description,
  action,
  secondary,
  more,
  moreLabel,
  moreTestId,
  back,
  meta,
  titleTestId,
  compact = false,
  className,
}: PageHeaderProps) {
  const hasActions = Boolean(action || secondary || more?.some(Boolean));
  return (
    <header
      className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-3', compact ? 'mb-0' : 'mb-6', className)}
    >
      <div className="min-w-0 flex-1 basis-64">
        {back}
        <h1 className={cn('truncate', compact ? 'text-xl' : 'text-2xl')} data-testid={titleTestId}>
          {title}
        </h1>
        {description && <p className="mt-1 max-w-prose text-sm text-muted">{description}</p>}
        {meta && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">{meta}</div>}
      </div>
      {hasActions && (
        <div className="flex shrink-0 items-center gap-2" data-testid="page-actions">
          {secondary}
          {action}
          {more && <MoreMenu items={more} label={moreLabel} testId={moreTestId} size={compact ? 'sm' : 'md'} />}
        </div>
      )}
    </header>
  );
}
