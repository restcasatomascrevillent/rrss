import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import { Button } from './Button';
import { MenuContent, MenuItem, MenuSeparator } from './Menu';

/** Una acción secundaria de la página: va en el menú «⋯» y no compite con la principal. */
export interface MoreAction {
  /** Identificador estable (también la clave de React). */
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Acción que quita o cambia algo de forma visible (archivar, retirar…): sale en rojo y al final. */
  destructive?: boolean;
  disabled?: boolean;
  /** Por qué está desactivada, o qué hace (ventana emergente del sistema). */
  hint?: string;
  testId?: string;
}

/** `null` separa grupos dentro del menú. */
export type MoreMenuItem = MoreAction | null;

interface MoreMenuProps {
  items: MoreMenuItem[];
  /** Nombre accesible del botón «⋯». */
  label?: string;
  testId?: string;
  size?: 'sm' | 'md';
}

/**
 * Menú «⋯» de las acciones secundarias. Radix lo hace accesible por teclado:
 * Intro o Espacio lo abre, las flechas recorren las acciones y Escape lo cierra
 * devolviendo el foco al botón.
 */
export function MoreMenu({ items, label = 'Más acciones', testId, size = 'md' }: MoreMenuProps) {
  // Sin separadores al principio, al final ni repetidos.
  const clean = items.filter((item, i, all) => item !== null || (i > 0 && i < all.length - 1 && all[i - 1] !== null));
  if (!clean.some(Boolean)) return null;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <Button
          variant="secondary"
          size={size === 'sm' ? 'sm' : 'icon'}
          className={size === 'sm' ? 'w-9 px-0' : undefined}
          aria-label={label}
          title={label}
          data-testid={testId}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Button>
      </Dropdown.Trigger>
      <MenuContent align="end">
        {clean.map((item, i) =>
          item === null ? (
            <MenuSeparator key={`sep-${i}`} />
          ) : (
            <Fragment key={item.id}>
              <MenuItem
                onSelect={item.onSelect}
                destructive={item.destructive}
                disabled={item.disabled}
                title={item.hint}
                data-testid={item.testId}
              >
                {item.icon && <item.icon className="h-4 w-4 shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1">{item.label}</span>
              </MenuItem>
            </Fragment>
          ),
        )}
      </MenuContent>
    </Dropdown.Root>
  );
}
