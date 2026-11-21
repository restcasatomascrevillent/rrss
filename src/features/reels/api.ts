import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { assetKeys } from '@/features/library/api';
import type { Json, MediaAssetRow, MediaJobKind } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { isActive, type MediaJobSummary } from './plan';

export const REEL_KIND: MediaJobKind = 'media.reel.template';
/** Cada cuánto se mira el estado mientras hay algo en cola o montándose. */
export const JOB_POLL_MS = 4000;

export const reelKeys = {
  jobs: (brandId: string) => ['brand', brandId, 'media-jobs'] as const,
  sources: (brandId: string) => ['brand', brandId, 'assets', 'reel-sources'] as const,
};

export type ReelSourceAsset = Pick<
  MediaAssetRow,
  'id' | 'kind' | 'storage_path' | 'file_name' | 'mime_type' | 'duration_ms' | 'created_at'
>;

/** Fotos, clips y audios de la marca con los que se puede montar un reel (los 300 más recientes). */
export function useReelSources(brandId: string) {
  return useQuery({
    queryKey: reelKeys.sources(brandId),
    queryFn: async (): Promise<ReelSourceAsset[]> =>
      unwrap(
        await supabase
          .from('media_assets')
          .select('id, kind, storage_path, file_name, mime_type, duration_ms, created_at')
          .eq('brand_id', brandId)
          .in('kind', ['image', 'video', 'audio'])
          .order('created_at', { ascending: false })
          .limit(300),
      ),
  });
}

/**
 * Últimos trabajos de reel de la marca. La RLS de `jobs` deja verlos a quien
 * ve la marca. Mientras alguno está en cola o montándose se vuelve a mirar
 * cada pocos segundos; al terminar uno, se refresca la biblioteca.
 */
export function useReelJobs(brandId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: reelKeys.jobs(brandId),
    queryFn: async (): Promise<MediaJobSummary[]> =>
      unwrap(
        await supabase
          .from('jobs')
          .select('id, kind, status, attempts, max_attempts, last_error, result, payload, created_at')
          .eq('brand_id', brandId)
          .eq('kind', REEL_KIND)
          .order('created_at', { ascending: false })
          .limit(10),
      ),
    refetchInterval: (q) => (q.state.data?.some(isActive) ? JOB_POLL_MS : false),
  });

  // Un trabajo que pasa a «Listo» trae un recurso nuevo a la biblioteca.
  const finished = (query.data ?? []).filter((job) => job.status === 'succeeded').length;
  const previous = useRef(finished);
  useEffect(() => {
    if (finished > previous.current) void queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
    previous.current = finished;
  }, [finished, brandId, queryClient]);

  return query;
}

export function useRequestReel(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { request: Json; idempotencyKey: string }) =>
      unwrap(
        await supabase.rpc('request_media_job', {
          p_brand_id: brandId,
          p_kind: REEL_KIND,
          p_input: input.request,
          p_idempotency_key: input.idempotencyKey,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reelKeys.jobs(brandId) }),
  });
}

/**
 * Cancela un trabajo de medios (reel o recorte) en cola o montándose. Lo puede
 * hacer quien edita la marca (`cancel_media_job`); el trabajador lo deja al
 * renovar su reserva y no llega nada a la biblioteca.
 */
export function useCancelMediaJob(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => unwrap(await supabase.rpc('cancel_media_job', { p_job_id: jobId })),
    // La clave de los reels es el prefijo de la de los recortes: se refrescan las dos.
    onSettled: () => queryClient.invalidateQueries({ queryKey: reelKeys.jobs(brandId) }),
  });
}
