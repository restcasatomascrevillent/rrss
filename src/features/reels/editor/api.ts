// Datos del editor de reels: guardar el montaje como versión de la pieza y
// seguir los montajes (trabajos del trabajador) que salen de ella.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { contentKeys } from '@/features/content/api';
import { assetKeys } from '@/features/library/api';
import type { ContentVersionRow, Json } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { JOB_POLL_MS, REEL_KIND } from '../api';
import { describeJob, isActive, type MediaJobSummary } from '../plan';
import { finalizeProject, REEL_PLAN_VERSION, type ReelProject } from './project';

export interface SaveReelInput {
  contentId: string;
  project: ReelProject;
  note?: string;
  /** Versión sobre la que se trabajaba: si otra persona guardó después, falla (CT001). */
  expectedVersion: number;
}

/** Guarda el montaje como versión nueva de la pieza. Valida antes con el esquema (lanza `ProjectError`). */
export async function saveReelVersion(input: SaveReelInput): Promise<ContentVersionRow> {
  const ready = finalizeProject(input.project);
  return unwrap(
    await supabase.rpc('save_content_version', {
      p_content_id: input.contentId,
      p_data: ready as unknown as Json,
      p_schema_version: REEL_PLAN_VERSION,
      p_change_note: input.note ?? '',
      p_expected_version: input.expectedVersion,
    }),
  );
}

export function useSaveReelVersion(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveReelVersion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: contentKeys.all(brandId) }),
  });
}

export const pieceJobKeys = (brandId: string, contentId: string) =>
  ['brand', brandId, 'media-jobs', 'content', contentId] as const;

/**
 * Montajes de esta pieza: los últimos trabajos de reel de la marca cuya carga
 * dice que salen de ella. Mientras alguno está en marcha se vuelve a mirar; al
 * terminar uno, se refresca la biblioteca.
 */
export function usePieceJobs(brandId: string, contentId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: pieceJobKeys(brandId, contentId),
    queryFn: async (): Promise<MediaJobSummary[]> => {
      const rows: MediaJobSummary[] = unwrap(
        await supabase
          .from('jobs')
          .select('id, kind, status, attempts, max_attempts, last_error, result, payload, created_at')
          .eq('brand_id', brandId)
          .eq('kind', REEL_KIND)
          .order('created_at', { ascending: false })
          .limit(40),
      );
      return rows.filter((job) => (job.payload as { content?: { id?: unknown } } | null)?.content?.id === contentId);
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

/** Versión de la pieza de la que salió un montaje. */
export const jobContentVersion = (job: MediaJobSummary): number | null => {
  const version = (job.payload as { content?: { version?: unknown } } | null)?.content?.version;
  return typeof version === 'number' ? version : null;
};

/** El último montaje terminado de una versión (su vídeo en la biblioteca), si lo hay. */
export function renderOfVersion(jobs: MediaJobSummary[], version: number): string | null {
  for (const job of jobs) {
    if (jobContentVersion(job) !== version) continue;
    const view = describeJob(job);
    if (view.assetId) return view.assetId;
  }
  return null;
}
