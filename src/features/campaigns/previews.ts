import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { migrateDocument, type Canvas, type ContentDocument, type Layer } from '@/features/content/document';
import type { ImageLookup } from '@/features/content/editor/canvas/nodes';
import { useImageLookup } from '@/features/content/templates/useImageLookup';
import { previewPath, useAssetsByIds, useSignedUrls } from '@/features/library/api';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { campaignKeys } from './api';

// Miniaturas de las piezas de una campaña, solo con lo que ya existe:
//   1. la exportación de la versión vigente (la imagen que se publicaría);
//   2. si no hay, un esbozo de la primera página del documento (como la tira de
//      páginas del editor);
//   3. si la pieza todavía no existe (plan por revisar), el primer recurso de la
//      biblioteca que el plan sugiere.
// Sin nada de eso, la ficha enseña el formato y no se inventa una imagen.

export interface PreviewRequest {
  key: string;
  /** Pieza ya creada (campaña aceptada) y su versión vigente. */
  contentId?: string;
  version?: number;
  /** Recurso sugerido por el plan, de respaldo. */
  assetId?: string;
}

export type PiecePreviewSource =
  | { kind: 'image'; url: string; label: string }
  | { kind: 'video'; label: string }
  | { kind: 'document'; canvas: Canvas; layers: Layer[]; images: ImageLookup; label: string };

interface ExportRow {
  id: string;
  storage_path: string;
  thumb_path?: string | null;
  provenance: unknown;
  created_at: string;
}

/** La exportación más reciente de la primera página (o la única) de cada pieza en su versión vigente. */
function pickExports(rows: ExportRow[], wanted: Map<string, number>): Map<string, string> {
  const best = new Map<string, ExportRow>();
  for (const row of rows) {
    const p = (row.provenance ?? {}) as Record<string, unknown>;
    const contentId = typeof p.content_id === 'string' ? p.content_id : null;
    if (!contentId || p.type !== 'export' || p.unsaved_changes === true) continue;
    if (wanted.get(contentId) !== p.version) continue;
    if (typeof p.page === 'number' && p.page !== 1) continue;
    const current = best.get(contentId);
    if (!current || row.created_at > current.created_at) best.set(contentId, row);
  }
  return new Map([...best].map(([id, row]) => [id, previewPath(row)]));
}

function assetIdsOfLayers(layers: Layer[]): string[] {
  const ids: string[] = [];
  for (const layer of layers) {
    if (layer.type === 'image' && layer.source.kind === 'asset') ids.push(layer.source.assetId);
    if (layer.type === 'logo') ids.push(layer.assetId);
  }
  return ids;
}

/** Exportaciones y documentos de las piezas creadas (dos consultas para todas). */
function useContentSources(brandId: string, requests: PreviewRequest[]) {
  const wanted = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of requests) if (r.contentId && r.version) map.set(r.contentId, r.version);
    return map;
  }, [requests]);
  const key = [...wanted].map(([id, v]) => `${id}:${v}`).sort().join(',');
  return useQuery({
    queryKey: [...campaignKeys.all(brandId), 'previews', key] as const,
    enabled: wanted.size > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const ids = [...wanted.keys()];
      const exportRows = unwrap(
        await supabase
          .from('media_assets')
          .select('id, storage_path, thumb_path, provenance, created_at')
          .eq('brand_id', brandId)
          .eq('provenance->>type', 'export')
          .in('provenance->>content_id', ids)
          .limit(300),
      ) as ExportRow[];
      const exports = pickExports(exportRows, wanted);
      const missing = ids.filter((id) => !exports.has(id));
      const documents = new Map<string, ContentDocument>();
      if (missing.length) {
        const versions = unwrap(
          await supabase
            .from('content_versions')
            .select('content_id, version, data')
            .in('content_id', missing)
            .in('version', [...new Set(missing.map((id) => wanted.get(id)!))]),
        );
        for (const row of versions) {
          if (wanted.get(row.content_id) !== row.version) continue;
          try {
            documents.set(row.content_id, migrateDocument(row.data));
          } catch {
            // Un documento que no se puede leer se queda sin vista previa.
          }
        }
      }
      return { exports, documents };
    },
  });
}

/**
 * Vista previa de cada pieza pedida, por `key`. Lo que todavía no ha llegado (o
 * no existe) no está en el mapa.
 */
export function usePiecePreviews(brandId: string, requests: PreviewRequest[]): Map<string, PiecePreviewSource> {
  const sources = useContentSources(brandId, requests);
  const exportPaths = useMemo(() => [...(sources.data?.exports.values() ?? [])].sort(), [sources.data]);
  const exportUrls = useSignedUrls(exportPaths);

  const documentAssetIds = useMemo(
    () => [...(sources.data?.documents.values() ?? [])].flatMap((d) => assetIdsOfLayers(d.pages[0]?.layers ?? [])),
    [sources.data],
  );
  const images = useImageLookup(brandId, documentAssetIds);

  // Recursos sugeridos por el plan: solo para lo que no tiene exportación ni documento.
  const fallbackIds = useMemo(
    () =>
      [
        ...new Set(
          requests
            .filter(
              (r) =>
                r.assetId &&
                !(r.contentId && (sources.data?.exports.has(r.contentId) || sources.data?.documents.has(r.contentId))),
            )
            .map((r) => r.assetId!),
        ),
      ].sort(),
    [requests, sources.data],
  );
  const fallbackAssets = useAssetsByIds(brandId, fallbackIds);
  const fallbackPaths = useMemo(
    () => (fallbackAssets.data ?? []).map(previewPath).sort(),
    [fallbackAssets.data],
  );
  const fallbackUrls = useSignedUrls(fallbackPaths, { variant: 'thumb' });

  return useMemo(() => {
    const map = new Map<string, PiecePreviewSource>();
    const assets = new Map((fallbackAssets.data ?? []).map((a) => [a.id, a]));
    for (const r of requests) {
      const path = r.contentId ? sources.data?.exports.get(r.contentId) : undefined;
      const exportUrl = path ? exportUrls.data?.get(path) : undefined;
      if (exportUrl) {
        map.set(r.key, { kind: 'image', url: exportUrl, label: 'Imagen exportada' });
        continue;
      }
      const document = r.contentId ? sources.data?.documents.get(r.contentId) : undefined;
      if (document?.pages[0]) {
        map.set(r.key, {
          kind: 'document',
          canvas: document.canvas,
          layers: document.pages[0].layers,
          images,
          label: 'Esbozo del documento',
        });
        continue;
      }
      const asset = r.assetId ? assets.get(r.assetId) : undefined;
      if (asset?.mime_type.startsWith('video/')) {
        map.set(r.key, { kind: 'video', label: `Vídeo sugerido: ${asset.file_name}` });
        continue;
      }
      const assetUrl = asset ? fallbackUrls.data?.get(previewPath(asset)) : undefined;
      if (asset && assetUrl) map.set(r.key, { kind: 'image', url: assetUrl, label: `Foto sugerida: ${asset.file_name}` });
    }
    return map;
  }, [requests, sources.data, exportUrls.data, images, fallbackAssets.data, fallbackUrls.data]);
}
