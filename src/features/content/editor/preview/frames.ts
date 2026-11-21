import { publishedText } from '@/features/brandcheck/text';
import type { PostCopy } from '../../document';
import type { NetworkFormatSpec, SpecProvenance } from '../../networks';

// Lógica pura de las vistas previas por red: qué marco toca y cuánto pie se ve
// antes de «ver más». Son aproximaciones: ninguna red publica su diseño, y el
// recorte del pie sale del catálogo (casi siempre sin verificar).

/** `feed`: publicación en el muro. `vertical`: pantalla completa (historia, reel, short, vídeo). */
export type PreviewFrame = 'feed' | 'vertical';

/** Qué formatos son de pantalla completa: los que tienen zona segura de vídeo vertical o solo son vídeo vertical. */
export function previewFrameOf(spec: NetworkFormatSpec | undefined): PreviewFrame {
  if (!spec) return 'feed';
  if (spec.safeZone?.value.ratio === '9:16') return 'vertical';
  return 'feed';
}

/** Las historias no llevan pie visible; los reels y vídeos, sí (encima del vídeo). */
export function showsCaption(spec: NetworkFormatSpec | undefined): boolean {
  return spec?.format !== 'story';
}

export interface CaptionPreview {
  /** Lo que se ve antes de «ver más» (o todo, si cabe o no se sabe dónde corta). */
  visible: string;
  /** Hay más texto escondido tras «ver más». */
  truncated: boolean;
  /** Caracteres que se ven, según el catálogo; null si no se sabe. */
  limit: number | null;
  provenance: SpecProvenance | null;
}

/**
 * Pie como se vería en el muro: el texto publicado (pie y hashtags) cortado en
 * los caracteres que el catálogo dice que se ven antes de «ver más». Si el
 * catálogo da varias cifras, se usa la del móvil. Se cuenta por caracteres
 * (puntos de código), no por píxeles: la red corta por ancho real.
 */
export function captionPreview(copy: Pick<PostCopy, 'caption' | 'hashtags'>, spec: NetworkFormatSpec | undefined) {
  const text = publishedText(copy.caption, copy.hashtags).trim();
  const options = spec?.text.truncation ?? [];
  const chosen = options.find((option) => option.value.context === 'mobile') ?? options[0];
  if (!chosen) return { visible: text, truncated: false, limit: null, provenance: null } satisfies CaptionPreview;
  const limit = chosen.value.characters;
  const characters = [...text];
  if (characters.length <= limit) {
    return { visible: text, truncated: false, limit, provenance: chosen.provenance } satisfies CaptionPreview;
  }
  return {
    visible: characters.slice(0, limit).join('').trimEnd(),
    truncated: true,
    limit,
    provenance: chosen.provenance,
  } satisfies CaptionPreview;
}
