// Recortes de una foto de la biblioteca: el encargo `media.image.process` que
// ya acepta `request_media_job` (solo fotos y logotipos de la marca; las rutas
// de salida las pone la base de datos) y su seguimiento. Lo hace el trabajador
// de medios; al terminar, cada recorte es un recurso nuevo de la biblioteca
// (carpeta según el disparador de `jobs`, procedencia `media_job`).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { Json, MediaJobKind } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { JOB_POLL_MS, reelKeys } from '@/features/reels/api';
import { isActive, type MediaJobSummary } from '@/features/reels/plan';
import { assetKeys } from './api';

export const CROP_KIND: MediaJobKind = 'media.image.process';

export const CROP_ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type CropAspect = (typeof CROP_ASPECTS)[number];

export const CROP_ASPECT_LABEL: Record<CropAspect, string> = {
  '1:1': 'Cuadrado 1:1',
  '4:5': 'Vertical 4:5',
  '9:16': 'Historia 9:16',
  '16:9': 'Horizontal 16:9',
};

/** Ancho pedido para cada recorte; el trabajador nunca amplía por encima del original. */
export const CROP_WIDTH = 1080;

export interface FocalPoint {
  x: number;
  y: number;
}

const RATIO: Record<CropAspect, [number, number]> = { '1:1': [1, 1], '4:5': [4, 5], '9:16': [9, 16], '16:9': [16, 9] };

/**
 * Caja del recorte sobre la foto original, como la calcula el trabajador
 * (worker/src/handlers/shared.ts, `cropToAspect`): lo más grande que cabe con
 * esa proporción, centrado en el punto de interés sin salirse de la foto.
 */
export function cropBox(source: { width: number; height: number }, aspect: CropAspect, focal: FocalPoint) {
  const [aw, ah] = RATIO[aspect];
  const wide = source.width * ah > source.height * aw;
  const height = wide ? source.height : (source.width * ah) / aw;
  const width = wide ? (source.height * aw) / ah : source.width;
  const place = (size: number, total: number, point: number) =>
    Math.min(Math.max(point * total - size / 2, 0), total - size);
  return { width, height, x: place(width, source.width, focal.x), y: place(height, source.height, focal.y) };
}

/**
 * `object-position` (en %) para que una vista previa con `object-fit: cover`
 * enseñe exactamente la caja del recorte.
 */
export function previewPosition(source: { width: number; height: number }, aspect: CropAspect, focal: FocalPoint) {
  const box = cropBox(source, aspect, focal);
  const percent = (offset: number, size: number, total: number) =>
    total - size <= 0 ? 50 : Math.round((offset / (total - size)) * 1000) / 10;
  return `${percent(box.x, box.width, source.width)}% ${percent(box.y, box.height, source.height)}%`;
}

/** Formato de salida: el de la foto, para no perder la transparencia de un PNG. */
export function cropFormat(mimeType: string): 'jpeg' | 'png' | 'webp' {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpeg';
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));

/** Lo que se envía a `request_media_job` (la base de datos añade la ruta de cada salida). */
export function buildCropInput(sourcePath: string, mimeType: string, focal: FocalPoint, aspects: CropAspect[]): Json {
  const format = cropFormat(mimeType);
  return {
    source: { path: sourcePath },
    focalPoint: { x: clamp01(focal.x), y: clamp01(focal.y) },
    outputs: aspects.map((aspect) => ({ aspect, width: CROP_WIDTH, format })),
  };
}

/** ¿Se pueden pedir recortes de este recurso? Fotos y logotipos en un formato que el trabajador lee. */
export function canCrop(asset: { kind: string; mime_type: string }): boolean {
  return (
    (asset.kind === 'image' || asset.kind === 'logo') &&
    ['image/jpeg', 'image/png', 'image/webp'].includes(asset.mime_type)
  );
}

/** Recursos creados por un recorte terminado, con su proporción. */
export function cropResults(job: MediaJobSummary): Array<{ id: string; aspect: string }> {
  const assets = (job.result as { assets?: Array<{ id?: unknown; path?: unknown }> } | null)?.assets;
  const outputs = (job.payload as { outputs?: Array<{ path?: unknown; aspect?: unknown }> } | null)?.outputs ?? [];
  if (!Array.isArray(assets)) return [];
  return assets.flatMap((a) => {
    if (typeof a.id !== 'string') return [];
    const aspect = outputs.find((o) => o.path === a.path)?.aspect;
    return [{ id: a.id, aspect: typeof aspect === 'string' ? aspect : '' }];
  });
}

export const cropKeys = {
  // Bajo la clave de los trabajos de medios: cancelar refresca reels y recortes.
  jobs: (brandId: string, sourcePath: string) => [...reelKeys.jobs(brandId), 'crops', sourcePath] as const,
};

/**
 * Recortes encargados de una foto. Se leen los últimos de la marca y se
 * filtran por la foto de origen (la RLS de `jobs` deja verlos a quien ve la
 * marca). Mientras alguno está en marcha se vuelve a mirar; al terminar uno,
 * se refresca la biblioteca.
 */
export function useCropJobs(brandId: string, sourcePath: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: cropKeys.jobs(brandId, sourcePath),
    queryFn: async (): Promise<MediaJobSummary[]> => {
      const rows: MediaJobSummary[] = unwrap(
        await supabase
          .from('jobs')
          .select('id, kind, status, attempts, max_attempts, last_error, result, payload, created_at')
          .eq('brand_id', brandId)
          .eq('kind', CROP_KIND)
          .order('created_at', { ascending: false })
          .limit(50),
      );
      return rows
        .filter((job) => (job.payload as { source?: { path?: unknown } } | null)?.source?.path === sourcePath)
        .slice(0, 5);
    },
    refetchInterval: (q) => (q.state.data?.some(isActive) ? JOB_POLL_MS : false),
  });

  const finished = (query.data ?? []).filter((job) => job.status === 'succeeded').length;
  const previous = useRef(finished);
  useEffect(() => {
    if (finished > previous.current) void queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
    previous.current = finished;
  }, [finished, brandId, queryClient]);

  return query;
}

export function useRequestCrops(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { request: Json; idempotencyKey: string }) =>
      unwrap(
        await supabase.rpc('request_media_job', {
          p_brand_id: brandId,
          p_kind: CROP_KIND,
          p_input: input.request,
          p_idempotency_key: input.idempotencyKey,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reelKeys.jobs(brandId) }),
  });
}
