import { Film } from 'lucide-react';
import { useState } from 'react';
import { previewPath, useAssetsByIds, useSignedUrls } from '@/features/library/api';
import { ThumbImage } from '@/features/library/ThumbImage';
import type { CalendarEntry } from './api';
import { usePublicationText } from './previewData';

// Lo que se va a publicar, visto desde el calendario: la imagen (o el vídeo)
// elegida y el texto. El texto se compone con la misma regla que el publicador
// (supabase/functions/_shared/social/caption.ts → composeCaption) y que el
// verificador (publishedText): el pie y, al final, los hashtags de la lista que
// no estén ya en el pie.

/** Miniatura pequeña para la vista de calendario. No ocupa sitio si la publicación no tiene medio. */
export function EntryThumb({ thumb }: { thumb: { url?: string; video: boolean } | undefined }) {
  if (!thumb) return null;
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded bg-subtle text-muted"
      data-testid="calendar-entry-thumb"
    >
      {thumb.video ? (
        <Film className="h-3.5 w-3.5" aria-label="Vídeo" />
      ) : thumb.url ? (
        <ThumbImage url={thumb.url} size={24} />
      ) : null}
    </span>
  );
}

const CLAMP_AT = 220;

/** Imagen o vídeo elegidos y texto que se publicará, con «Ver más» si es largo. */
export function PublicationPreview({ brandId, entry }: { brandId: string; entry: CalendarEntry }) {
  const assetId = entry.media_asset_ids[0] ?? null;
  const assets = useAssetsByIds(brandId, assetId ? [assetId] : []);
  const asset = assets.data?.[0] ?? null;
  const urls = useSignedUrls(asset ? [previewPath(asset)] : []);
  const url = asset ? urls.data?.get(previewPath(asset)) : undefined;
  const text = usePublicationText(brandId, entry);
  const [expanded, setExpanded] = useState(false);
  const full = text.data ?? '';
  const long = full.length > CLAMP_AT;

  return (
    <section aria-label="Lo que se publicará" className="flex gap-3" data-testid="publication-preview">
      {assetId && (
        <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-border bg-subtle">
          {entry.media_asset_ids.length > 1 && (
            // Un carrusel: se ve la primera página y cuántas lleva (en el orden en que se publican).
            <span
              className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-[11px] text-white"
              data-testid="publication-pages"
            >
              1/{entry.media_asset_ids.length}
            </span>
          )}
          {asset?.mime_type.startsWith('video/') ? (
            url ? (
              <video src={url} controls preload="metadata" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-muted">
                <Film className="h-6 w-6" aria-hidden />
              </span>
            )
          ) : url ? (
            <ThumbImage url={url} size={112} />
          ) : null}
        </div>
      )}
      <div className="min-w-0 flex-1 text-sm">
        {text.isLoading ? (
          <p className="text-xs text-muted">Cargando el texto…</p>
        ) : full ? (
          <>
            <p className="whitespace-pre-wrap break-words" data-testid="publication-text">
              {long && !expanded ? `${full.slice(0, CLAMP_AT).trimEnd()}…` : full}
            </p>
            {long && (
              <button
                type="button"
                className="mt-1 text-xs text-primary underline"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                data-testid="publication-text-more"
              >
                {expanded ? 'Ver menos' : 'Ver más'}
              </button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted" data-testid="publication-text-empty">
            Esta versión no tiene texto.
          </p>
        )}
      </div>
    </section>
  );
}
