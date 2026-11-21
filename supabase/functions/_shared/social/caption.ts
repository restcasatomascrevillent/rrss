// Texto que se publica, a partir del texto de la versión aprobada (`copy` del
// documento, src/features/content/document/schema.ts): el pie y, al final, los
// hashtags de la lista que no estén ya en el pie. Es la misma regla que
// `publishedText` del verificador (src/features/brandcheck/text.ts), que es lo
// que la persona vio al aprobar.

export interface PostCopy {
  caption: string;
  hashtags: string[];
  altText: string;
}

const HASHTAG = /#([\p{L}\p{N}_]+)/gu;
const key = (tag: string) => tag.normalize('NFC').toLowerCase();

export function readCopy(raw: unknown): PostCopy {
  const copy = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    caption: typeof copy.caption === 'string' ? copy.caption : '',
    hashtags: Array.isArray(copy.hashtags) ? copy.hashtags.filter((h): h is string => typeof h === 'string') : [],
    altText: typeof copy.altText === 'string' ? copy.altText : '',
  };
}

export function composeCaption(copy: PostCopy): string {
  const inCaption = new Set([...copy.caption.matchAll(HASHTAG)].map((m) => key(m[1]!)));
  const missing: string[] = [];
  for (const raw of copy.hashtags) {
    const tag = raw.replace(/^#+/, '').trim();
    if (!tag || inCaption.has(key(tag))) continue;
    inCaption.add(key(tag));
    missing.push(`#${tag}`);
  }
  return missing.length ? `${copy.caption}\n\n${missing.join(' ')}` : copy.caption;
}

/** Límites de Instagram (referencia de POST /{ig-user-id}/media). */
export const INSTAGRAM_CAPTION_MAX = 2200;
export const INSTAGRAM_ALT_TEXT_MAX = 1000;
