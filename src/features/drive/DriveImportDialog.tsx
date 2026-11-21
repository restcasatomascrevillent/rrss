import { ChevronRight, Folder, HardDrive } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, EmptyState, ErrorState, Field, Input, Skeleton } from '@/components/ui';
import { translateError } from '@/lib/errors';
import { cn, formatBytes } from '@/lib/utils';
import { driveFileUrl, useDriveFolder, useImportFromDrive, type DriveItem } from './api';

interface Crumb {
  id: string;
  name: string;
}

/**
 * Elegir fotos del Google Drive de la organización y añadirlas a la biblioteca
 * de la marca. Las fotos no se copian: la biblioteca guarda la referencia y las
 * pide a Drive cuando se ven o se usan.
 */
export function DriveImportDialog({
  brandId,
  open,
  onOpenChange,
}: {
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>([{ id: 'root', name: 'Mi unidad' }]);
  const [selected, setSelected] = useState<Map<string, DriveItem>>(new Map());
  const [folderName, setFolderName] = useState('');
  const current = trail[trail.length - 1]!;
  const folder = useDriveFolder(brandId, null, current.id, open);
  const importFiles = useImportFromDrive(brandId);
  const connectionId = folder.data?.connection.id ?? null;

  const toggle = (item: DriveItem) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });

  const close = (value: boolean) => {
    if (!value) {
      setSelected(new Map());
      setTrail([{ id: 'root', name: 'Mi unidad' }]);
    }
    onOpenChange(value);
  };

  const submit = () => {
    if (!connectionId || selected.size === 0) return;
    importFiles.mutate(
      { connectionId, fileIds: [...selected.keys()], folder: folderName.trim() },
      {
        onSuccess: (result) => {
          const n = result.assets?.length ?? selected.size;
          toast.success(n === 1 ? '1 foto añadida desde Google Drive' : `${n} fotos añadidas desde Google Drive`);
          close(false);
        },
        onError: (error) => toast.error(translateError(error)),
      },
    );
  };

  const items = folder.data?.items ?? [];
  const folders = items.filter((i) => i.isFolder);
  const files = items.filter((i) => !i.isFolder);
  const unsupported = files.filter((i) => !i.supported).length;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title="Añadir desde Google Drive"
      description={
        folder.data
          ? `Cuenta ${folder.data.connection.accountEmail}. Las fotos se quedan en Drive: la biblioteca guarda solo la referencia.`
          : 'Las fotos se quedan en Drive: la biblioteca guarda solo la referencia.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            disabled={selected.size === 0 || !connectionId}
            loading={importFiles.isPending}
            data-testid="drive-import-submit"
          >
            {selected.size === 0 ? 'Elige fotos' : `Añadir ${selected.size} ${selected.size === 1 ? 'foto' : 'fotos'}`}
          </Button>
        </>
      }
    >
      <nav aria-label="Carpeta de Drive" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        {trail.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden />}
            <button
              type="button"
              className={cn('rounded px-1 hover:underline', i === trail.length - 1 && 'font-medium')}
              onClick={() => setTrail(trail.slice(0, i + 1))}
              disabled={i === trail.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {folder.isPending ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : folder.isError ? (
        <ErrorState error={folder.error} onRetry={() => void folder.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={HardDrive} title="Carpeta vacía" description="Aquí no hay carpetas ni imágenes." />
      ) : (
        <div className="max-h-[55vh] space-y-3 overflow-y-auto" data-testid="drive-folder">
          {folders.length > 0 && (
            <ul className="grid gap-2 sm:grid-cols-2">
              {folders.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-subtle"
                    onClick={() => setTrail([...trail, { id: f.id, name: f.name }])}
                    data-testid="drive-subfolder"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="truncate">{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {files.length > 0 && (
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {files.map((file) => {
                const checked = selected.has(file.id);
                return (
                  <li key={file.id}>
                    <label
                      className={cn(
                        'block overflow-hidden rounded-lg border bg-surface text-left',
                        file.supported ? 'cursor-pointer hover:shadow-pop' : 'cursor-not-allowed opacity-60',
                        checked ? 'border-primary ring-2 ring-primary' : 'border-border',
                      )}
                      title={file.supported ? file.name : `${file.name}: formato que el navegador no muestra`}
                      data-testid="drive-file"
                    >
                      <span className="relative block aspect-square bg-subtle">
                        {file.thumbTicket ? (
                          <img
                            src={driveFileUrl(file.thumbTicket)}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">
                            {file.mimeType.includes('hei') ? 'HEIC: conviértela a JPEG' : 'Formato no admitido'}
                          </span>
                        )}
                        <input
                          type="checkbox"
                          className="absolute left-2 top-2 h-4 w-4"
                          checked={checked}
                          disabled={!file.supported}
                          onChange={() => toggle(file)}
                          aria-label={`Elegir ${file.name}`}
                        />
                      </span>
                      <span className="block truncate px-2 pt-1.5 text-xs">{file.name}</span>
                      <span className="block px-2 pb-1.5 text-xs text-muted">
                        {file.bytes ? formatBytes(file.bytes) : ' '}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {unsupported > 0 && (
            <p className="text-xs text-muted" data-testid="drive-unsupported">
              {unsupported === 1 ? 'Hay 1 imagen' : `Hay ${unsupported} imágenes`} en un formato que el navegador no
              muestra (por ejemplo, HEIC del iPhone). Exporta esas fotos a JPEG en Drive para poder añadirlas.
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        <Field label="Carpeta de la biblioteca" optional>
          {(field) => (
            <Input
              {...field}
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              maxLength={200}
              placeholder="Por ejemplo, Platos"
              data-testid="drive-import-folder"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
