import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { publishedText } from '@/features/brandcheck/text';
import { previewPath, useAssetsByIds, useSignedUrls } from '@/features/library/api';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import type { CalendarEntry } from './api';

// Datos de lo que se va a publicar. El texto se compone con la misma regla que
// el publicador (supabase/functions/_shared/social/caption.ts → composeCaption)
// y que el verificador (publishedText).

/** Pie y hashtags del documento de una versión (lectura tolerante: solo `copy`). */
export function usePublicationText(brandId: string, entry: CalendarEntry | null) {
  const version = entry ? (entry.content_version ?? entry.content?.current_version ?? 0) : 0;
  return useQuery({
    queryKey: ['brand', brandId, 'social', 'publication-text', entry?.content_id ?? '', version] as const,
    enabled: Boolean(entry) && version > 0,
    queryFn: async (): Promise<string> => {
      const rows = unwrap(
        await supabase
          .from('content_versions')
          .select('data')
          .eq('content_id', entry!.content_id)
          .eq('version', version)
          .limit(1),
      );
      const data = rows[0]?.data as { copy?: { caption?: unknown; hashtags?: unknown } } | null | undefined;
      const caption = typeof data?.copy?.caption === 'string' ? data.copy.caption : '';
      const hashtags = Array.isArray(data?.copy?.hashtags)
        ? data.copy.hashtags.filter((h): h is string => typeof h === 'string')
        : [];
      return publishedText(caption, hashtags);
    },
  });
}

/** Miniaturas de la primera imagen (o vídeo) de cada publicación, en un solo lote. */
export function useEntryThumbs(brandId: string, entries: CalendarEntry[]) {
  const ids = useMemo(
    () => [...new Set(entries.map((e) => e.media_asset_ids[0]).filter((id): id is string => Boolean(id)))]
      .sort()
      .slice(0, 100),
    [entries],
  );
  const assets = useAssetsByIds(brandId, ids);
  const paths = useMemo(() => (assets.data ?? []).map(previewPath), [assets.data]);
  const urls = useSignedUrls(paths, { variant: 'thumb' });
  return useMemo(() => {
    const map = new Map<string, { url?: string; video: boolean }>();
    for (const a of assets.data ?? []) {
      const url = urls.data?.get(previewPath(a));
      map.set(a.id, { ...(url ? { url } : {}), video: a.mime_type.startsWith('video/') });
    }
    return map;
  }, [assets.data, urls.data]);
}
