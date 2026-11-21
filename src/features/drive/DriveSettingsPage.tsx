import { AlertTriangle, HardDrive, Link2, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, ErrorState, Skeleton } from '@/components/ui';
import { driveLibraryEnabled } from '@/config/app';
import { useOrg } from '@/features/orgs/context';
import { useFeatureStatus } from '@/features/platform/integrations/useFeature';
import type { DriveConnectionRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { startDriveConnect, useDisconnectDrive, useDriveConnections } from './api';

/** Lo que significa cada `?drive=` con el que vuelve la conexión. */
const CONNECT_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google Drive conectado' },
  denied: { ok: false, text: 'No se ha conectado: se canceló o no se concedió el acceso a Drive en Google.' },
  expired: { ok: false, text: 'La conexión caducó o ya se había usado. Vuelve a intentarlo.' },
  forbidden: { ok: false, text: 'Solo quien administra la organización puede conectar Google Drive.' },
  failed: { ok: false, text: 'No se pudo conectar Google Drive. Inténtalo de nuevo más tarde.' },
};

/**
 * Configuración · Google Drive. Solo aparece si el entorno tiene la biblioteca
 * con Drive (VITE_DRIVE_LIBRARY_ENABLED) y el servidor tiene el cliente OAuth
 * de Google configurado (Plataforma → Integraciones). Conectar y desconectar es
 * de quien administra la organización; el resto ve qué cuenta hay.
 */
export function DriveSettingsPage() {
  const { org, isAdmin } = useOrg();
  // `undefined` mientras el servidor responde; `false` si no está configurado.
  const configured = useFeatureStatus('drive');
  const connections = useDriveConnections(org.id, driveLibraryEnabled());
  const disconnect = useDisconnectDrive(org.id);
  const [connecting, setConnecting] = useState(false);
  const [confirming, setConfirming] = useState<DriveConnectionRow | null>(null);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    const result = params.get('drive');
    if (!result) return;
    const info = CONNECT_RESULT[result] ?? CONNECT_RESULT.failed!;
    if (info.ok) toast.success(info.text);
    else toast.error(info.text);
    const next = new URLSearchParams(params);
    next.delete('drive');
    setParams(next, { replace: true });
  }, [params, setParams]);

  if (!driveLibraryEnabled()) {
    return <p className="text-sm text-muted">Google Drive no está disponible en este entorno.</p>;
  }

  const connect = async () => {
    setConnecting(true);
    try {
      window.location.assign(await startDriveConnect(org.id));
    } catch (error) {
      toast.error(translateError(error));
      setConnecting(false);
    }
  };

  const list = connections.data ?? [];

  return (
    <Card data-testid="drive-settings">
      <CardHeader
        title="Google Drive"
        description="Usa en la biblioteca las fotos que ya tienes en Google Drive sin subirlas otra vez: se quedan en Drive y la aplicación las pide cuando se ven o se usan. El acceso es de solo lectura y va cifrado; nunca se guarda una contraseña."
      />
      <CardBody className="space-y-3">
        {connections.isPending ? (
          <Skeleton className="h-14" />
        ) : connections.isError ? (
          <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted" data-testid="drive-settings-empty">
            No hay ninguna cuenta de Google Drive conectada.
          </p>
        ) : (
          list.map((c) => (
            <div key={c.id} className="rounded-lg border border-border p-3" data-testid="drive-connection">
              <div className="flex flex-wrap items-center gap-3">
                <HardDrive className="h-5 w-5 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.account_email}</span>
                  <span className="block text-xs text-muted">Conectada el {formatDate(c.connected_at)}</span>
                </span>
                {c.status === 'active' ? (
                  <Badge tone="success">Conectada</Badge>
                ) : (
                  <Badge tone="warning">Hay que volver a conectarla</Badge>
                )}
                {isAdmin && (
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(c)} data-testid="drive-disconnect">
                    <Unlink className="h-4 w-4" aria-hidden />
                    Desconectar
                  </Button>
                )}
              </div>
              {c.status === 'needs_reauth' && c.last_error && (
                <p className="mt-2 flex items-start gap-2 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {c.last_error}
                </p>
              )}
            </div>
          ))
        )}
        {configured === false ? (
          <p className="text-sm text-muted" data-testid="drive-not-configured">
            Google Drive no está configurado en este entorno: no se puede conectar ninguna cuenta.
          </p>
        ) : configured === undefined ? null : isAdmin ? (
          <Button onClick={() => void connect()} loading={connecting} data-testid="drive-connect">
            <Link2 className="h-4 w-4" aria-hidden />
            {list.length === 0 ? 'Conectar Google Drive' : 'Conectar otra cuenta o volver a conectar'}
          </Button>
        ) : (
          <p className="text-xs text-muted">Conectar Google Drive es cosa de quien administra la organización.</p>
        )}
      </CardBody>
      <ConfirmDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="¿Desconectar Google Drive?"
        description="Las fotos de Drive que ya están en la biblioteca se quedan, pero no se verán hasta que vuelvas a conectar la misma cuenta. En Drive no se toca nada."
        confirmLabel="Desconectar"
        loading={disconnect.isPending}
        onConfirm={() =>
          confirming &&
          disconnect.mutate(confirming.id, {
            onSuccess: () => {
              toast.success('Google Drive desconectado');
              setConfirming(null);
            },
            onError: (error) => toast.error(translateError(error)),
          })
        }
      />
    </Card>
  );
}
