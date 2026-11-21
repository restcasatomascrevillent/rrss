import { useMemo } from 'react';
import { previewPath, useAssetsByIds, useSignedUrls } from '@/features/library/api';
import type { ImageLookup } from '../editor/canvas/nodes';

/** Recurso de la biblioteca → dirección firmada (de su miniatura si la tiene), para dibujar las fotos de unos documentos. */
export function useImageLookup(brandId: string, assetIds: string[]): ImageLookup {
  const key = [...new Set(assetIds)].sort().join(',');
  const ids = useMemo(() => (key ? key.split(',') : []), [key]);
  const assets = useAssetsByIds(brandId, ids);
  const storagePaths = useMemo(() => (assets.data ?? []).map(previewPath).sort(), [assets.data]);
  const signed = useSignedUrls(storagePaths);
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const asset of assets.data ?? []) {
      const url = signed.data?.get(previewPath(asset));
      if (url) map.set(asset.id, url);
    }
    return map;
  }, [assets.data, signed.data]);
}
