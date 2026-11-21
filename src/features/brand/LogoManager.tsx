import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, X } from 'lucide-react';
import { useRef, useState, type MutableRefObject } from 'react';
import { toast } from 'sonner';
import { Button, Skeleton } from '@/components/ui';
import { LOGO_MIME_TYPES } from '@/config/app';
import { assetKeys, deleteAssets, uploadAsset, useAssetsByIds, useSignedUrls } from '@/features/library/api';
import { translateError } from '@/lib/errors';

interface LogoManagerProps {
  organizationId: string;
  brandId: string;
  ids: string[];
  onChange: (ids: string[]) => void;
  /** Ids subidos en esta sesión que aún no están en ninguna versión guardada (los gestiona quien guarda). */
  pending: MutableRefObject<Set<string>>;
  disabled?: boolean;
}

/** Logotipos del perfil: son archivos de la biblioteca (tipo «logo») enlazados por su id. */
export function LogoManager({ organizationId, brandId, ids, onChange, pending, disabled }: LogoManagerProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const assets = useAssetsByIds(brandId, ids);
  const urls = useSignedUrls((assets.data ?? []).map((a) => a.storage_path));

  async function add(files: FileList) {
    setUploading(true);
    const added: string[] = [];
    for (const file of Array.from(files)) {
      try {
        if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type))
          throw new Error(`«${file.name}» no es una imagen PNG, JPG o WebP.`);
        // Provisional hasta que se guarde el perfil: si se cierra la pestaña sin guardar, lo limpia el servidor.
        const asset = await uploadAsset({ organizationId, brandId, file, kind: 'logo', provisional: true });
        added.push(asset.id);
        pending.current.add(asset.id);
      } catch (e) {
        toast.error(translateError(e));
      }
    }
    setUploading(false);
    if (added.length > 0) {
      onChange([...ids, ...added]);
      await queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
    }
  }

  /** Quita el logotipo del borrador; si nunca se guardó, tampoco se queda en la biblioteca. */
  function remove(id: string) {
    onChange(ids.filter((v) => v !== id));
    if (!pending.current.delete(id)) return;
    void deleteAssets([id])
      .catch((e) => toast.error(translateError(e)))
      .finally(() => queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) }));
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Logotipos</p>
      <p className="text-xs text-muted">
        PNG, JPG o WebP. Sube las variantes que uséis (color, negativo, símbolo…). Se guardan en la biblioteca.
      </p>
      <ul className="flex flex-wrap gap-3">
        {ids.map((id) => {
          const asset = assets.data?.find((a) => a.id === id);
          const url = asset ? urls.data?.get(asset.storage_path) : undefined;
          return (
            <li
              key={id}
              className="relative h-24 w-24 overflow-hidden rounded-lg border border-border bg-subtle"
              data-testid="logo-item"
            >
              {url ? (
                <img src={url} alt={asset?.file_name ?? 'Logotipo'} className="h-full w-full object-contain p-2" />
              ) : (
                <Skeleton className="h-full w-full rounded-none" />
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(id)}
                  aria-label={`Quitar el logotipo ${asset?.file_name ?? ''} del perfil`}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-surface text-fg shadow-card hover:bg-subtle"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </li>
          );
        })}
        {ids.length === 0 && disabled && <li className="text-sm text-muted">Sin logotipos.</li>}
      </ul>
      {!disabled && (
        <>
          <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} loading={uploading}>
            <ImagePlus className="h-4 w-4" aria-hidden />
            Subir logotipo
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={LOGO_MIME_TYPES.join(',')}
            className="sr-only"
            aria-label="Subir logotipos"
            data-testid="logo-file-input"
            onChange={(e) => {
              if (e.target.files) void add(e.target.files);
              e.target.value = '';
            }}
          />
        </>
      )}
    </div>
  );
}
