import { Clapperboard, FileText, FilterX, Film, HardDrive, Images, Music, Search, Upload } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton } from '@/components/ui';
import { mediaWorkerEnabled } from '@/config/app';
import { isDriveAsset, useDriveConnections } from '@/features/drive/api';
import { DriveImportDialog } from '@/features/drive/DriveImportDialog';
import { useBrand, useOrg } from '@/features/orgs/context';
import { useFeature } from '@/features/platform/integrations/useFeature';
import type { AssetKind, MediaAssetRow } from '@/lib/database.types';
import { formatBytes } from '@/lib/utils';
import {
  previewPath,
  useAssetFacets,
  useAssets,
  useAssetsByIds,
  useSignedUrls,
  useStorageCleanup,
  type AssetFilters,
} from './api';
import { AssetDialog } from './AssetDialog';
import { ASSET_KIND_LABEL, ASSET_KINDS } from './labels';
import { ThumbImage } from './ThumbImage';
import { UploadPanel } from './UploadPanel';

function Thumbnail({ asset, url }: { asset: MediaAssetRow; url: string | undefined }) {
  if (asset.mime_type.startsWith('image/')) {
    return url ? (
      <ThumbImage url={url} />
    ) : (
      <Skeleton className="h-full w-full rounded-none" />
    );
  }
  const Icon = asset.mime_type.startsWith('video/') ? Film : asset.mime_type.startsWith('audio/') ? Music : FileText;
  return (
    <span className="flex h-full w-full items-center justify-center text-muted">
      <Icon className="h-8 w-8" aria-hidden />
    </span>
  );
}

export function LibraryPage() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canEdit = can('edit');
  const navigate = useNavigate();
  useStorageCleanup(brand.id, canEdit);
  const [uploading, setUploading] = useState(false);
  // Google Drive: solo si el entorno lo tiene, el servidor está configurado y la
  // organización tiene una conexión activa.
  const driveConfigured = useFeature('drive');
  const driveConnections = useDriveConnections(org.id, driveConfigured && canEdit);
  const canUseDrive = driveConfigured && canEdit && (driveConnections.data ?? []).some((c) => c.status === 'active');
  const [drivePicking, setDrivePicking] = useState(false);
  const [kind, setKind] = useState<AssetKind | ''>('');
  const [tag, setTag] = useState('');
  const [folder, setFolder] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  // `?recurso=<id>` abre ese recurso (lo usa «Abrir en la biblioteca» desde Reels).
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('recurso'));
  const closeSelected = () => {
    setSelectedId(null);
    if (searchParams.has('recurso')) setSearchParams({}, { replace: true });
  };

  const filters: AssetFilters = useMemo(
    () => ({ kind, tag, folder, search: deferredSearch }),
    [kind, tag, folder, deferredSearch],
  );
  const assets = useAssets(brand.id, filters);
  const facets = useAssetFacets(brand.id);
  const rows = useMemo(() => assets.data?.pages.flat() ?? [], [assets.data]);
  // Un recurso que no está en la página cargada (p. ej. un recorte recién hecho) se lee aparte.
  const inRows = rows.some((a) => a.id === selectedId);
  const outside = useAssetsByIds(brand.id, selectedId && !assets.isPending && !inRows ? [selectedId] : []);
  const selected = rows.find((a) => a.id === selectedId) ?? outside.data?.find((a) => a.id === selectedId) ?? null;
  const previewPaths = useMemo(
    () => [
      ...rows.filter((a) => a.mime_type.startsWith('image/') || a.id === selectedId).map(previewPath),
      ...(selected && !inRows ? [previewPath(selected)] : []),
    ],
    [rows, selectedId, selected, inRows],
  );
  // Cuadrícula con miniaturas (las de Drive, la miniatura de Google); la ficha, con el archivo entero.
  const urls = useSignedUrls(previewPaths, { variant: 'thumb' });
  const selectedPaths = useMemo(() => (selected ? [selected.storage_path] : []), [selected]);
  const selectedUrls = useSignedUrls(selectedPaths);
  const filtering = Boolean(kind || tag || folder || deferredSearch.trim());

  return (
    <>
      <PageHeader
        title="Biblioteca"
        description={`Fotos, vídeos, logotipos y documentos de ${brand.name}.`}
        action={
          canEdit && (
            <Button
              onClick={() => setUploading((v) => !v)}
              aria-expanded={uploading}
              data-testid="library-upload-toggle"
            >
              <Upload className="h-4 w-4" aria-hidden />
              {uploading ? 'Ocultar subida' : 'Subir archivos'}
            </Button>
          )
        }
        more={
          canEdit
            ? [
                canUseDrive
                  ? {
                      id: 'drive',
                      label: 'Traer de Google Drive',
                      icon: HardDrive,
                      onSelect: () => setDrivePicking(true),
                      testId: 'library-drive',
                    }
                  : null,
                mediaWorkerEnabled()
                  ? {
                      id: 'reels',
                      label: 'Montar un reel',
                      icon: Clapperboard,
                      onSelect: () => navigate('reels'),
                      testId: 'library-reels',
                    }
                  : null,
              ]
            : undefined
        }
        moreTestId="library-more"
      />

      {canEdit && uploading && (
        <div className="mb-6">
          <UploadPanel organizationId={org.id} brandId={brand.id} />
        </div>
      )}

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Buscar por nombre"
            placeholder="Buscar por nombre"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="library-search"
          />
        </div>
        <Select
          aria-label="Filtrar por tipo"
          value={kind}
          onChange={(e) => setKind(e.target.value as AssetKind | '')}
          data-testid="library-kind"
        >
          <option value="">Todos los tipos</option>
          {ASSET_KINDS.map((k) => (
            <option key={k} value={k}>
              {ASSET_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por etiqueta"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          disabled={!facets.data?.tags.length}
        >
          <option value="">Todas las etiquetas</option>
          {facets.data?.tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por carpeta"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          disabled={!facets.data?.folders.length}
        >
          <option value="">Todas las carpetas</option>
          {facets.data?.folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </div>

      {assets.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      ) : assets.isError ? (
        <Card>
          <ErrorState error={assets.error} onRetry={() => void assets.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Images}
            title={filtering ? 'Nada coincide con los filtros' : 'La biblioteca está vacía'}
            description={
              filtering
                ? 'Prueba con otra búsqueda o quita algún filtro.'
                : canEdit
                  ? 'Sube las fotos, vídeos y logotipos de la marca para tenerlos siempre a mano.'
                  : 'Todavía no se ha subido ningún archivo.'
            }
            action={
              filtering ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setKind('');
                    setTag('');
                    setFolder('');
                    setSearch('');
                  }}
                  data-testid="library-clear-filters"
                >
                  <FilterX className="h-4 w-4" aria-hidden />
                  Quitar filtros
                </Button>
              ) : (
                canEdit &&
                !uploading && (
                  <Button onClick={() => setUploading(true)} data-testid="library-empty-upload">
                    <Upload className="h-4 w-4" aria-hidden />
                    Subir archivos
                  </Button>
                )
              )
            }
          />
        </Card>
      ) : (
        <>
          <ul
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            data-testid="library-grid"
          >
            {rows.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(asset.id)}
                  className="group block w-full overflow-hidden rounded-xl border border-border bg-surface text-left shadow-card transition-shadow hover:shadow-pop"
                  data-testid="library-asset"
                >
                  <span className="block aspect-square overflow-hidden bg-subtle">
                    <Thumbnail asset={asset} url={urls.data?.get(asset.storage_path)} />
                  </span>
                  <span className="block px-3 py-2">
                    <span className="block truncate text-sm font-medium">{asset.file_name}</span>
                    <span className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span>{formatBytes(asset.bytes)}</span>
                      {isDriveAsset(asset) ? (
                        <span data-testid="library-asset-drive">
                          <Badge>Drive</Badge>
                        </span>
                      ) : (
                        asset.kind !== 'image' && <Badge>{ASSET_KIND_LABEL[asset.kind]}</Badge>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {assets.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void assets.fetchNextPage()}
                loading={assets.isFetchingNextPage}
              >
                Cargar más
              </Button>
            </div>
          )}
        </>
      )}

      {canUseDrive && <DriveImportDialog brandId={brand.id} open={drivePicking} onOpenChange={setDrivePicking} />}

      {selected && (
        <AssetDialog
          key={selected.id}
          asset={selected}
          url={selectedUrls.data?.get(selected.storage_path) ?? urls.data?.get(selected.storage_path)}
          canEdit={canEdit}
          onClose={closeSelected}
          onOpenAsset={setSelectedId}
        />
      )}
    </>
  );
}
