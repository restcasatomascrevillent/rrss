import { ExternalLink, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, ConfirmDialog, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { mediaWorkerEnabled } from '@/config/app';
import { StringListInput } from '@/features/brand/editor/inputs';
import { canEditPhoto } from '@/features/photo-edit/api';
import { PhotoEditDialog } from '@/features/photo-edit/PhotoEditDialog';
import type { AssetKind, MediaAssetRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { useAssetMutations } from './api';
import { CropPanel } from './CropPanel';
import { canCrop } from './crops';
import { ASSET_KIND_LABEL, ASSET_KINDS, parseRights, rightsExpired, serializeRights, type AssetRights } from './labels';

interface AssetDialogProps {
  asset: MediaAssetRow;
  url: string | undefined;
  canEdit: boolean;
  onClose: () => void;
  /** Abre otra ficha de la biblioteca (los recortes de esta foto). */
  onOpenAsset?: (assetId: string) => void;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function AssetDialog({ asset, url, canEdit, onClose, onOpenAsset }: AssetDialogProps) {
  const { update, remove } = useAssetMutations(asset.brand_id);
  const [fileName, setFileName] = useState(asset.file_name);
  const [kind, setKind] = useState<AssetKind>(asset.kind);
  const [folder, setFolder] = useState(asset.folder);
  const [tags, setTags] = useState<string[]>(asset.tags);
  const [rights, setRights] = useState<AssetRights>(() => parseRights(asset.rights));
  const [confirming, setConfirming] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState(false);

  const setRight = (key: keyof AssetRights, value: string) => setRights((current) => ({ ...current, [key]: value }));
  const details = [
    formatBytes(asset.bytes),
    asset.width && asset.height ? `${asset.width} × ${asset.height} px` : null,
    asset.duration_ms ? formatDuration(asset.duration_ms) : null,
    `subido el ${formatDateTime(asset.created_at)}`,
  ].filter(Boolean);

  function save() {
    update.mutate(
      {
        id: asset.id,
        patch: {
          file_name: fileName.trim() || asset.file_name,
          kind,
          folder: folder.trim(),
          tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
          rights: serializeRights(rights),
        },
      },
      {
        onSuccess: () => {
          toast.success('Cambios guardados');
          onClose();
        },
        onError: (e) => toast.error(translateError(e)),
      },
    );
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={asset.file_name}
        description={details.join(' · ')}
        size="lg"
        footer={
          canEdit ? (
            <>
              <Button
                variant="ghost"
                className="mr-auto text-danger"
                onClick={() => setConfirming(true)}
                data-testid="asset-delete"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Eliminar
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={save} loading={update.isPending} data-testid="asset-save">
                Guardar
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
          )
        }
      >
        <div className="space-y-5">
          <div className="flex min-h-[8rem] items-center justify-center overflow-hidden rounded-lg bg-subtle">
            {url && asset.mime_type.startsWith('image/') ? (
              <img src={url} alt={asset.file_name} className="max-h-72 w-auto object-contain" />
            ) : url && asset.mime_type.startsWith('video/') ? (
              <video src={url} controls className="max-h-72 w-full" />
            ) : url && asset.mime_type.startsWith('audio/') ? (
              <audio src={url} controls className="w-full px-4" />
            ) : (
              <p className="px-4 py-6 text-sm text-muted">Sin vista previa para este tipo de archivo.</p>
            )}
          </div>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
              Abrir el archivo original
            </a>
          )}
          {canEdit && url && canEditPhoto(asset) && (
            <Button variant="secondary" onClick={() => setEditingPhoto(true)} data-testid="asset-edit-photo">
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              Editar foto
            </Button>
          )}

          {mediaWorkerEnabled() && canCrop(asset) && onOpenAsset && (
            <CropPanel asset={asset} url={url} canEdit={canEdit} onOpenAsset={onOpenAsset} />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre" className="sm:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  maxLength={255}
                  disabled={!canEdit}
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  data-testid="asset-name"
                />
              )}
            </Field>
            <Field label="Tipo">
              {(p) => (
                <Select {...p} disabled={!canEdit} value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
                  {ASSET_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ASSET_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Carpeta" optional>
              {(p) => (
                <Input
                  {...p}
                  maxLength={200}
                  disabled={!canEdit}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="P. ej. Campaña de verano"
                />
              )}
            </Field>
          </div>

          <StringListInput
            label="Etiquetas"
            values={tags}
            onChange={setTags}
            placeholder="Añade una etiqueta"
            disabled={!canEdit}
            maxLength={50}
            testId="asset-tag-input"
          />

          <fieldset className="space-y-4 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">
              Derechos de uso {rightsExpired(rights) && <Badge tone="danger">Caducados</Badge>}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Licencia" optional>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={200}
                    disabled={!canEdit}
                    value={rights.license}
                    onChange={(e) => setRight('license', e.target.value)}
                    placeholder="Propia, banco de imágenes…"
                  />
                )}
              </Field>
              <Field label="Titular" optional>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={200}
                    disabled={!canEdit}
                    value={rights.owner}
                    onChange={(e) => setRight('owner', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Caduca el" optional>
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    disabled={!canEdit}
                    value={rights.expires_on}
                    onChange={(e) => setRight('expires_on', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Notas" optional className="sm:col-span-2">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={2}
                    maxLength={1000}
                    disabled={!canEdit}
                    value={rights.notes}
                    onChange={(e) => setRight('notes', e.target.value)}
                    placeholder="Personas que aparecen, permisos, restricciones…"
                  />
                )}
              </Field>
            </div>
          </fieldset>
        </div>
      </Dialog>

      {editingPhoto && (
        <PhotoEditDialog
          asset={asset}
          url={url}
          open
          onOpenChange={setEditingPhoto}
          resultLabel="Abrir"
          onResult={onOpenAsset ? (row) => onOpenAsset(row.id) : undefined}
        />
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="¿Eliminar este archivo?"
        description={`«${asset.file_name}» se borrará de la biblioteca de forma definitiva. No se puede deshacer.`}
        confirmLabel="Eliminar"
        loading={remove.isPending}
        onConfirm={() =>
          // Con la promesa y no con los avisos de `mutate`: al borrar, la rejilla se refresca y esta ficha se
          // desmonta; si eso ocurre antes de que termine la mutación, los avisos de `mutate` no se ejecutan.
          remove.mutateAsync(asset).then(
            () => {
              toast.success('Archivo eliminado');
              onClose();
            },
            (e: unknown) => {
              setConfirming(false);
              toast.error(translateError(e));
            },
          )
        }
      />
    </>
  );
}
