import { DownloadCloud, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { Button, Notice } from '@/components/ui';
import type { SocialAccountRow } from '@/lib/database.types';
import { formatDate } from '@/lib/utils';
import {
  importSummary,
  plural,
  useImportDriver,
  useImportedTotal,
  useLastImport,
  type ImportProgress,
} from './importApi';

/**
 * Cuentas conectadas · Importar publicaciones de la cuenta. Lee el histórico de
 * Instagram con la cuenta conectada (en el servidor) para sacar de él las
 * plantillas de diseño de la marca. Opcionalmente copia las imágenes a la
 * biblioteca (carpeta «Instagram / Publicadas»). Se puede detener y reanudar.
 * Solo quien gestiona la marca.
 */
export function ImportPostsPanel({ brandId, account }: { brandId: string; account: SocialAccountRow }) {
  const last = useLastImport(brandId, account.id);
  const total = useImportedTotal(brandId);
  const driver = useImportDriver(brandId, account.id);
  const [copy, setCopy] = useState(false);

  const row = last.data;
  const open = row && row.status !== 'completed' ? row : null;
  const current: ImportProgress | null =
    driver.progress ??
    (row
      ? {
          id: row.id,
          status: row.status,
          phase: row.phase,
          copyImages: row.copy_images,
          pages: row.pages,
          itemsSeen: row.items_seen,
          itemsNew: row.items_new,
          copied: row.copied,
          copyFailed: row.copy_failed,
          retryAfter: row.retry_after,
          lastError: row.last_error,
        }
      : null);
  const waitingUntil = current?.status === 'running' ? current.retryAfter : null;
  const label = driver.active
    ? current?.phase === 'copying'
      ? 'Copiando imágenes a la biblioteca…'
      : `Leyendo el historial de Instagram… (página ${current?.pages ?? 0})`
    : null;

  return (
    <div className="rounded-lg border border-border p-3" data-testid="social-import">
      <div className="flex flex-wrap items-start gap-3">
        <DownloadCloud className="mt-0.5 h-5 w-5 text-muted" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">Importar publicaciones de la cuenta</p>
          <p className="text-xs text-muted">
            Lee lo que la cuenta ya ha publicado en Instagram para sacar de ello las plantillas de diseño y mantener el
            estilo de la marca. No publica nada ni toca la cuenta.
          </p>
          <p className="text-xs" data-testid="social-import-total">
            {total.isSuccess
              ? total.data > 0
                ? `${plural(total.data, 'publicación importada', 'publicaciones importadas')} de esta marca.`
                : 'Todavía no se ha importado nada.'
              : ' '}
          </p>
        </div>
        {driver.active ? (
          <Button variant="secondary" size="sm" onClick={() => void driver.stop()} data-testid="social-import-stop">
            <Pause className="h-4 w-4" aria-hidden />
            Detener
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void driver.start(copy || (open?.copy_images ?? false))}
            disabled={account.status !== 'active'}
            data-testid="social-import-start"
          >
            {open ? <Play className="h-4 w-4" aria-hidden /> : <DownloadCloud className="h-4 w-4" aria-hidden />}
            {open ? 'Reanudar la importación' : 'Importar publicaciones'}
          </Button>
        )}
      </div>

      {!driver.active && !open && (
        <label className="mt-2 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={copy}
            onChange={(e) => setCopy(e.target.checked)}
            className="mt-0.5"
            data-testid="social-import-copy"
          />
          <span>
            Copiar también las imágenes a la biblioteca (carpeta «Instagram / Publicadas»). Ocupan espacio de tu plan.
            Solo debe hacerse con cuentas propias o con permiso de su titular.
          </span>
        </label>
      )}

      {(label || current) && (
        <div className="mt-2 space-y-1" role="status" aria-live="polite" data-testid="social-import-progress">
          {label && <p className="text-xs font-medium">{label}</p>}
          {current && <p className="text-xs text-muted">{importSummary(current)}</p>}
          {current?.status === 'completed' && !driver.active && (
            <p className="text-xs text-success" data-testid="social-import-done">
              Importación terminada
              {row?.finished_at ? ` el ${formatDate(row.finished_at)}` : ''}.
            </p>
          )}
          {current?.status === 'paused' && !driver.active && !driver.error && (
            <p className="text-xs text-muted">Detenida: lo importado se conserva. Puedes reanudarla.</p>
          )}
        </div>
      )}
      {waitingUntil && !driver.active && (
        <Notice tone="warning">
          Meta pide ir más despacio: se puede reanudar a partir de las{' '}
          {new Date(waitingUntil).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}.
        </Notice>
      )}
      {driver.message && !waitingUntil && <Notice tone="warning">{driver.message}</Notice>}
      {(driver.error || (current?.status === 'paused' && current.lastError && !driver.active)) && (
        <p className="mt-2 text-xs text-danger" role="alert" data-testid="social-import-error">
          {driver.error ?? current?.lastError}
        </p>
      )}
    </div>
  );
}
