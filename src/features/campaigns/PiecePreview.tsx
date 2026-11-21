import { Film, GalleryHorizontal, Image as ImageIcon, Smartphone } from 'lucide-react';
import { PageThumb } from '@/features/content/editor/panels/PageThumb';
import { ThumbImage } from '@/features/library/ThumbImage';
import { cn } from '@/lib/utils';
import type { PiecePreviewSource } from './previews';

// Miniatura de una pieza de campaña. Ocupa siempre el hueco que le da su
// contenedor; sin vista previa enseña el icono del formato (no una imagen
// inventada). `alt` describe la imagen cuando la miniatura no es decorativa.

function FormatIcon({ format, className }: { format: string; className?: string }) {
  const Icon =
    format === 'carousel'
      ? GalleryHorizontal
      : format === 'story'
        ? Smartphone
        : format === 'reel' || format === 'video' || format === 'short'
          ? Film
          : ImageIcon;
  return <Icon className={className} aria-hidden />;
}

export function PiecePreview({
  source,
  format,
  alt,
  size = 160,
}: {
  source: PiecePreviewSource | undefined;
  format: string;
  /** Texto alternativo; sin él la miniatura es decorativa (la describe el texto de al lado). */
  alt?: string;
  size?: number;
}) {
  const label = alt && source ? `${alt} (${source.label.toLowerCase()})` : alt;
  return (
    <span
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-subtle text-muted"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      data-testid="campaign-piece-thumb"
      data-preview={source?.kind ?? 'none'}
    >
      {source?.kind === 'image' ? (
        <ThumbImage url={source.url} size={size} />
      ) : source?.kind === 'document' ? (
        <span className="block w-full">
          <PageThumb canvas={source.canvas} layers={source.layers} images={source.images} />
        </span>
      ) : source?.kind === 'video' ? (
        <Film className="h-6 w-6" aria-hidden />
      ) : (
        <FormatIcon format={format} className={cn('h-6 w-6 opacity-70')} />
      )}
      {format === 'carousel' && source && (
        <GalleryHorizontal
          className="absolute right-1.5 top-1.5 h-4 w-4 rounded bg-black/60 p-0.5 text-white"
          aria-hidden
        />
      )}
    </span>
  );
}
