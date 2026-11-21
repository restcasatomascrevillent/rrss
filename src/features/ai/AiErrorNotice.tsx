import { AlertTriangle, Gauge } from 'lucide-react';
import { Button } from '@/components/ui';
import { AiRequestError, isQuotaError } from './api';

/**
 * Error de una petición a la IA. El cupo (agotado o sin asignar) se explica
 * aparte, con qué hacer, porque reintentar no lo arregla.
 */
export function AiErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (isQuotaError(error)) {
    const exhausted = error.code === 'quota_exhausted';
    return (
      <div
        role="alert"
        className="flex gap-3 rounded-lg bg-warning-soft px-3.5 py-3 text-sm text-warning"
        data-testid="ai-quota-error"
      >
        <Gauge className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">
            {exhausted ? 'El cupo de IA de este mes está agotado' : 'Esta organización no tiene cupo de IA'}
          </p>
          <p className="mt-1">{error.message}</p>
          <p className="mt-1">Mientras tanto, puedes seguir escribiendo y editando a mano.</p>
        </div>
      </div>
    );
  }
  const message =
    error instanceof AiRequestError ? error.message : 'Algo ha fallado al usar la IA. Inténtalo de nuevo.';
  const retryable = error instanceof AiRequestError ? error.retryable || error.code === 'provider_timeout' : true;
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg bg-danger-soft px-3.5 py-3 text-sm text-danger"
      data-testid="ai-error"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>{message}</p>
        {onRetry && retryable && (
          <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
            Reintentar
          </Button>
        )}
      </div>
    </div>
  );
}
