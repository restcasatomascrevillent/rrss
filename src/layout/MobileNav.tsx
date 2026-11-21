import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Dialog } from '@/components/ui';
import { cn } from '@/lib/utils';
import { NavBadge, type NavItem } from './nav';

/**
 * Secciones fijas en la barra inferior del móvil (por el final de su ruta). Son
 * las de uso diario: ver cómo va, preparar piezas, programarlas y buscar fotos.
 * El resto va en «Más».
 */
const MOBILE_PRIMARY_SECTIONS = ['inicio', 'contenidos', 'calendario', 'biblioteca'] as const;
/** Con estas entradas o menos caben todas y no hace falta «Más». */
const FITS_WITHOUT_MORE = 5;

/** ¿La dirección actual está dentro de esta entrada? (lo mismo que decide NavLink). */
function isNavItemActive(item: Pick<NavItem, 'to' | 'end'>, pathname: string): boolean {
  if (pathname === item.to) return true;
  return !item.end && pathname.startsWith(item.to.endsWith('/') ? item.to : `${item.to}/`);
}

function isPrimary(item: NavItem): boolean {
  const last = item.to.split('/').pop() ?? '';
  return (MOBILE_PRIMARY_SECTIONS as readonly string[]).includes(last);
}

const tabClass = (active: boolean) =>
  cn(
    'relative flex min-h-[3.5rem] min-w-0 flex-1 flex-col items-center justify-center gap-1 px-0.5 text-[0.6875rem] font-medium leading-tight',
    active ? 'text-primary' : 'text-muted',
  );

/** Marca de la pestaña activa: una raya arriba, además del color. */
function ActiveBar({ active }: { active: boolean }) {
  if (!active) return null;
  return <span aria-hidden className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary" />;
}

/** Barra inferior del móvil y la tableta: 4 secciones fijas y «Más» con el resto. */
export function MobileNav({ items, brandName }: { items: NavItem[]; brandName?: string }) {
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  const needsMore = items.length > FITS_WITHOUT_MORE;
  const primary = needsMore ? items.filter(isPrimary) : items;
  const rest = needsMore ? items.filter((item) => !isPrimary(item)) : [];
  const restActive = rest.some((item) => isNavItemActive(item, pathname));
  const restBadge = rest.reduce((sum, item) => sum + (item.badge ?? 0), 0);

  return (
    <>
      <nav
        aria-label="Principal"
        data-testid="mobile-nav"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {primary.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => tabClass(isActive)}>
            {({ isActive }) => (
              <>
                <ActiveBar active={isActive} />
                <span className="relative">
                  <Icon className="h-5 w-5" aria-hidden />
                  <NavBadge count={badge} compact />
                </span>
                <span className="whitespace-nowrap">{label}</span>
              </>
            )}
          </NavLink>
        ))}
        {needsMore && (
          <button
            type="button"
            data-testid="nav-more"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            data-active={restActive}
            className={tabClass(restActive)}
            onClick={() => setMoreOpen(true)}
          >
            <ActiveBar active={restActive} />
            <span className="relative">
              <MoreHorizontal className="h-5 w-5" aria-hidden />
              <NavBadge count={restBadge} compact />
            </span>
            <span className="whitespace-nowrap">Más</span>
          </button>
        )}
      </nav>

      {needsMore && (
        <Dialog
          open={moreOpen}
          onOpenChange={setMoreOpen}
          title="Más secciones"
          description={brandName ? `De ${brandName} y de la organización.` : undefined}
        >
          <nav aria-label="Más secciones" data-testid="mobile-more-sheet">
            <ul className="grid grid-cols-2 gap-2 pb-[env(safe-area-inset-bottom)]">
              {rest.map(({ to, label, icon: Icon, end, badge }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    end={end}
                    onClick={() => setMoreOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-[3rem] items-center gap-3 rounded-lg border px-3 text-sm font-medium',
                        isActive
                          ? 'border-primary bg-primary-soft text-primary'
                          : 'border-border text-fg hover:bg-subtle',
                      )
                    }
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden />
                    <span>{label}</span>
                    <NavBadge count={badge} />
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </Dialog>
      )}
    </>
  );
}
