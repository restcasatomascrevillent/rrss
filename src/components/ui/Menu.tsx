import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Menu = Dropdown.Root;
export const MenuTrigger = Dropdown.Trigger;

export function MenuContent({ children, align = 'start' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        align={align}
        sideOffset={6}
        className="z-50 max-h-[70dvh] min-w-[14rem] max-w-[90vw] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-pop"
      >
        {children}
      </Dropdown.Content>
    </Dropdown.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  destructive,
  ...props
}: {
  children: ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
  'data-testid'?: string;
}) {
  return (
    <Dropdown.Item
      onSelect={onSelect}
      className={cn(
        'flex min-h-[2.5rem] cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 text-sm outline-none',
        'data-[highlighted]:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        destructive ? 'text-danger' : 'text-fg',
      )}
      {...props}
    >
      {children}
    </Dropdown.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Dropdown.Label className="px-2.5 py-1.5 text-xs font-medium text-muted">{children}</Dropdown.Label>;
}

export function MenuSeparator() {
  return <Dropdown.Separator className="my-1.5 h-px bg-border" />;
}
