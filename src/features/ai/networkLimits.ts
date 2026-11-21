// Límites de texto de una red y formato para la IA, sacados SOLO del catálogo
// (src/features/content/networks.ts). Lo que el catálogo no sabe, aquí tampoco:
// `maxChars: null` y la interfaz lo dice.
import { publishedText, textLength } from '@/features/brandcheck/text';
import type { LengthUnit } from '@/features/brandcheck/types';
import { getFormatSpec, NETWORKS, type SpecProvenance } from '@/features/content/networks';
import { postCopySchema, type PostCopy } from '@/features/content/document';
import { lengthUnitOf } from '@/features/content/textUnits';
import type { AiNetworkLimits, PostCaptionVariant } from './api';

/**
 * Techo técnico del pie en el documento (postCopySchema.caption). Se usa como
 * límite para la IA cuando la red no tiene uno conocido: no es un límite de la red.
 */
export const DOCUMENT_CAPTION_MAX = 10_000;

export interface CaptionLimits {
  /** Lo que se envía a `ai-generate`. */
  request: AiNetworkLimits;
  networkLabel: string;
  formatLabel: string | null;
  /** Máximo de la red, o `null` si no se conoce. */
  maxChars: number | null;
  maxHashtags: number | null;
  provenance: SpecProvenance | null;
  unit: LengthUnit;
}

export function captionLimits(network: string, format: string): CaptionLimits {
  const spec = getFormatSpec(network, format);
  const networkLabel = NETWORKS.find((n) => n.id === network)?.label ?? network;
  const caption = spec?.text.caption;
  const hashtags = spec?.text.maxHashtags;
  const notes: string[] = [];
  const truncation = spec?.text.truncation?.[0]?.value;
  if (truncation) {
    notes.push(`Antes de «ver más» solo se ven unos ${truncation.characters} caracteres: lo importante, al principio.`);
  }
  const maxChars = caption?.value.maxLength ?? null;
  return {
    request: {
      id: network,
      name: networkLabel,
      maxChars: maxChars ?? DOCUMENT_CAPTION_MAX,
      ...(hashtags ? { maxHashtags: hashtags.value } : {}),
      ...(notes.length ? { notes } : {}),
    },
    networkLabel,
    formatLabel: spec?.label ?? null,
    maxChars,
    maxHashtags: hashtags?.value ?? null,
    provenance: caption?.provenance ?? null,
    // Unidad común a editor, verificador y servidor (content/textUnits.ts).
    unit: lengthUnitOf(caption?.value),
  };
}

/** Hashtag del documento: sin almohadilla y solo letras, números y guion bajo. */
function cleanHashtag(raw: string): string {
  return raw
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, 100);
}

/** Caracteres de la variante con la unidad de la red (texto y, debajo, etiquetas). */
export function variantLength(variant: Pick<PostCaptionVariant, 'text' | 'hashtags'>, limits: CaptionLimits): number {
  return textLength(publishedText(variant.text, variant.hashtags.map(cleanHashtag).filter(Boolean)), limits.unit);
}

/** ¿Cabe la variante? `null` si el límite de la red no se conoce. */
export function variantFits(
  variant: Pick<PostCaptionVariant, 'text' | 'hashtags'>,
  limits: CaptionLimits,
): boolean | null {
  if (limits.maxChars === null) return null;
  const tags = variant.hashtags.map(cleanHashtag).filter(Boolean).length;
  return (
    variantLength(variant, limits) <= limits.maxChars && (limits.maxHashtags === null || tags <= limits.maxHashtags)
  );
}

/**
 * Variante elegida → `PostCopy`. Sustituye el pie y los hashtags; lo demás
 * (menciones, texto alternativo, llamada a la acción) se conserva del texto actual.
 */
export function variantToPostCopy(
  variant: Pick<PostCaptionVariant, 'text' | 'hashtags'>,
  current?: PostCopy,
): PostCopy {
  const hashtags = [...new Set(variant.hashtags.map(cleanHashtag).filter(Boolean))].slice(0, 100);
  return postCopySchema.parse({ ...(current ?? {}), caption: variant.text.slice(0, DOCUMENT_CAPTION_MAX), hashtags });
}
