import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Badge, Button, Dialog, ErrorState, Notice, Spinner } from '@/components/ui';
import { formatDateTime } from '@/lib/utils';
import { useContentVersion, useContentVersions, type ContentVersionSummary, type LoadedVersion } from '../api';
import { pageView } from '../document';
import type { ImageLookup } from './canvas/nodes';

const CanvasView = lazy(() => import('./canvas/KonvaCanvas'));

interface VersionsDialogProps {
  brandId: string;
  contentId: string;
  currentVersion: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean;
  restoring: boolean;
  images: ImageLookup;
  onRestore: (version: LoadedVersion) => void;
}

const noop = () => {};
const NONE: string[] = [];

function VersionPreview({
  brandId,
  contentId,
  summary,
  isCurrent,
  canRestore,
  restoring,
  images,
  onRestore,
  onBack,
}: {
  brandId: string;
  contentId: string;
  summary: ContentVersionSummary;
  isCurrent: boolean;
  canRestore: boolean;
  restoring: boolean;
  images: ImageLookup;
  onRestore: (version: LoadedVersion) => void;
  onBack: () => void;
}) {
  const version = useContentVersion(brandId, contentId, summary.version);
  const loaded = version.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Todas las versiones
        </Button>
        {canRestore && !isCurrent && loaded?.document && (
          <Button size="sm" loading={restoring} onClick={() => onRestore(loaded)} data-testid="version-restore">
            Restaurar esta versión
          </Button>
        )}
      </div>
      {version.isPending ? (
        <Spinner />
      ) : version.isError ? (
        <ErrorState error={version.error} onRetry={() => void version.refetch()} />
      ) : !loaded?.document ? (
        <Notice tone="warning">{loaded?.documentError ?? 'No se puede leer esta versión.'}</Notice>
      ) : (
        <>
          <div className="h-72 rounded-lg bg-subtle p-3">
            <Suspense fallback={<Spinner />}>
              <CanvasView
                document={pageView(loaded.document, 0)}
                selectedIds={NONE}
                readOnly
                images={images}
                onSelect={noop}
                onSelectMany={noop}
                onChange={noop}
                onEditText={noop}
                editingTextId={null}
                onTextCommit={noop}
                onTextCancel={noop}
                safeZone={null}
                label={`Vista previa de la versión ${summary.version}`}
              />
            </Suspense>
          </div>
          {loaded.document.pages.length > 1 && (
            <p className="text-xs text-muted" data-testid="version-pages">
              Carrusel de {loaded.document.pages.length} páginas: se ve la primera.
            </p>
          )}
          {loaded.document.copy.caption && (
            <p className="whitespace-pre-wrap break-words text-sm text-muted">{loaded.document.copy.caption}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Historial de versiones de una pieza: ver cualquiera y restaurarla (crea una versión nueva; nada se pierde). */
export function VersionsDialog({
  brandId,
  contentId,
  currentVersion,
  open,
  onOpenChange,
  canRestore,
  restoring,
  images,
  onRestore,
}: VersionsDialogProps) {
  const versions = useContentVersions(brandId, contentId, open);
  const [viewing, setViewing] = useState<ContentVersionSummary | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setViewing(null);
        onOpenChange(next);
      }}
      title={viewing ? `Versión ${viewing.version}` : 'Historial de versiones'}
      description={
        viewing
          ? `${viewing.author} · ${formatDateTime(viewing.created_at)}`
          : 'Cada guardado es una versión. Restaurar una antigua crea otra nueva con su contenido; el historial no se toca.'
      }
      size="lg"
    >
      {viewing ? (
        <VersionPreview
          brandId={brandId}
          contentId={contentId}
          summary={viewing}
          isCurrent={viewing.version === currentVersion}
          canRestore={canRestore}
          restoring={restoring}
          images={images}
          onRestore={onRestore}
          onBack={() => setViewing(null)}
        />
      ) : versions.isPending ? (
        <Spinner />
      ) : versions.isError ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : versions.data.length === 0 ? (
        <p className="py-6 text-sm text-muted">Todavía no se ha guardado ninguna versión.</p>
      ) : (
        <ul className="divide-y divide-border" data-testid="versions-list">
          {versions.data.map((version) => (
            <li key={version.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  Versión {version.version}
                  {version.version === currentVersion && <Badge tone="success">Vigente</Badge>}
                  {version.restored_from !== null && <Badge>Restaurada de la {version.restored_from}</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {version.author} · {formatDateTime(version.created_at)}
                </p>
                {version.change_note && (
                  <p className="mt-0.5 break-words text-sm text-muted">«{version.change_note}»</p>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={() => setViewing(version)} data-testid="version-view">
                Ver
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
