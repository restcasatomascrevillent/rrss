import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Avisos sin leer (insignia). */
  badge?: number;
}

/** Insignia de avisos sin leer junto a una entrada del menú. */
export function NavBadge({ count, compact = false }: { count: number | undefined; compact?: boolean }) {
  if (!count) return null;
  const text = count > 99 ? '99+' : String(count);
  return (
    <span
      className={cn(
        'inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold leading-5 text-primary-fg',
        compact ? 'absolute -right-2.5 -top-2 ring-2 ring-surface' : 'ml-auto',
      )}
      data-testid="nav-badge"
    >
      {text}
      <span className="sr-only"> {count === 1 ? 'aviso sin leer' : 'avisos sin leer'}</span>
    </span>
  );
}
