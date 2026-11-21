import { AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { buttonClasses, type ButtonSize, type ButtonVariant } from './buttonStyles';

type Tone = 'info' | 'warning' | 'danger';

const TONE: Record<Tone, { box: string; icon: string }> = {
  info: { box: 'border-primary/25 bg-primary-soft', icon: 'text-primary' },
  warning: { box: 'border-warning/30 bg-warning-soft', icon: 'text-warning' },
  danger: { box: 'border-danger/30 bg-danger-soft', icon: 'text-danger' },
};

interface ActionNoticeProps {
  tone?: Tone;
  icon?: LucideIcon;
  /** Una frase corta: qué pasa. */
  title: ReactNode;
  /** El botón (o enlace) que lleva a resolverlo. */
  action?: ReactNode;
  /** La explicación larga, plegada bajo «¿Por qué?». */
  why?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * Aviso que se puede resolver: una frase, un botón que lleva al sitio donde se
 * arregla y, si hace falta, el detalle plegado. Nada de rutas escritas
 * («Marca → Datos → …»): para eso está el botón.
 */
export function ActionNotice({
  tone = 'warning',
  icon,
  title,
  action,
  why,
  className,
  'data-testid': testId,
}: ActionNoticeProps) {
  const Icon = icon ?? (tone === 'info' ? Info : AlertTriangle);
  return (
    <div className={cn('rounded-xl border px-4 py-3', TONE[tone].box, className)} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon className={cn('h-5 w-5 shrink-0', TONE[tone].icon)} aria-hidden />
        <p className="min-w-[12rem] flex-1 text-sm font-medium text-fg" data-testid={testId && `${testId}-text`}>
          {title}
        </p>
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </div>
      {why && (
        <details className="group mt-1.5 pl-8">
          <summary
            className="w-fit cursor-pointer select-none rounded text-xs font-medium text-muted underline-offset-2 hover:text-fg hover:underline"
            data-testid={testId && `${testId}-why`}
          >
            ¿Por qué?
          </summary>
          <div className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{why}</div>
        </details>
      )}
    </div>
  );
}

interface LinkButtonProps {
  to: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  onClick?: () => void;
  'data-testid'?: string;
}

/** Un enlace interno con aspecto de botón: para los botones que llevan a otra pantalla. */
export function LinkButton({
  to,
  children,
  variant = 'primary',
  size = 'sm',
  className,
  onClick,
  'data-testid': testId,
}: LinkButtonProps) {
  return (
    <Link to={to} onClick={onClick} className={buttonClasses(variant, size, className)} data-testid={testId}>
      {children}
    </Link>
  );
}
