import { pieceHashtagKeys, pieceMentionKeys, publishedText, textLength } from '@/features/brandcheck/text';
import type { PostCopy } from '../document';
import type { NetworkFormatSpec, SpecProvenance } from '../networks';
import { lengthUnitOf } from '../textUnits';

// Contadores del texto de la publicación frente a los límites de la red. Se
// cuenta igual que el verificador de marca (mismas funciones de texto), para
// que el contador y la comprobación no se contradigan.

export interface CopyCounter {
  field: 'caption' | 'hashtags' | 'mentions' | 'altText';
  label: string;
  value: number;
  /** undefined: la red no publica ese límite o no lo conocemos. */
  max?: number;
  provenance?: SpecProvenance;
  over: boolean;
  /** Matiz que conviene enseñar junto al contador. */
  note?: string;
}

export function copyCounters(copy: PostCopy, spec: NetworkFormatSpec | undefined): CopyCounter[] {
  const text = spec?.text ?? {};
  const caption = text.caption;
  // Unidad común a editor, IA y verificador: ver ../textUnits.ts.
  const captionLength = textLength(publishedText(copy.caption, copy.hashtags), lengthUnitOf(caption?.value));
  const hashtags = pieceHashtagKeys(copy.caption, copy.hashtags).length;
  const mentions = pieceMentionKeys(copy.caption, copy.mentions).length;
  const alt = text.altText;
  const altLength = textLength(copy.altText, lengthUnitOf(alt?.value));

  const counter = (
    field: CopyCounter['field'],
    label: string,
    value: number,
    limit: { value: number; provenance: SpecProvenance } | undefined,
    note?: string,
  ): CopyCounter => ({
    field,
    label,
    value,
    ...(limit ? { max: limit.value, provenance: limit.provenance } : {}),
    over: limit !== undefined && value > limit.value,
    ...(note ? { note } : {}),
  });

  return [
    counter(
      'caption',
      'Texto publicado',
      captionLength,
      caption && { value: caption.value.maxLength, provenance: caption.provenance },
      'Incluye los hashtags que se añaden al final.',
    ),
    counter('hashtags', 'Hashtags', hashtags, text.maxHashtags),
    counter('mentions', 'Menciones', mentions, text.maxMentions),
    counter(
      'altText',
      'Texto alternativo',
      altLength,
      alt && { value: alt.value.maxLength, provenance: alt.provenance },
      text.altTextSupported?.value === false ? 'Este formato no admite texto alternativo.' : undefined,
    ),
  ];
}

/** Convierte «#uno, dos #tres» en ['uno', 'dos', 'tres']: sin símbolo, sin repetidos ni vacíos. */
export function parseTagList(input: string, sigil: '#' | '@'): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const value = raw.replace(new RegExp(`^\\${sigil}+`), '').trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

export function formatTagList(values: readonly string[], sigil: '#' | '@'): string {
  return values.map((value) => `${sigil}${value}`).join(' ');
}
