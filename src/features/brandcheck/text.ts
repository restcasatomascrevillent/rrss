// Utilidades de texto: normalización con posiciones, hashtags, menciones, emojis.

import type { LengthUnit } from './types';

const MARKS = /\p{M}/gu;

/** Normaliza un carácter: minúsculas y sin tildes, pero conservando la «ñ» (año ≠ ano). */
function foldChar(ch: string): string {
  const lower = ch.toLowerCase();
  if (lower === 'ñ') return 'ñ';
  return lower.normalize('NFD').replace(MARKS, '').normalize('NFC');
}

export interface FoldedText {
  /** Texto en minúsculas, sin tildes y con los espacios colapsados. */
  text: string;
  /** Inicio (en el original) del carácter normalizado i. */
  starts: number[];
  /** Fin exclusivo (en el original) del carácter normalizado i. */
  ends: number[];
}

/** Normaliza conservando la correspondencia con las posiciones del original. */
export function foldWithMap(original: string): FoldedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < original.length) {
    const cp = original.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (/\s/u.test(ch)) {
      let j = next;
      while (j < original.length && /\s/u.test(original[j] ?? '')) j++;
      text += ' ';
      starts.push(i);
      ends.push(j);
      i = j;
      continue;
    }
    for (const folded of foldChar(ch)) {
      text += folded;
      starts.push(i);
      ends.push(next);
    }
    i = next;
  }
  return { text, starts, ends };
}

/** Normalización simple (sin mapa) para comparar palabras sueltas. */
export function foldText(value: string): string {
  return foldWithMap(value.trim()).text;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export interface PhraseMatch {
  start: number;
  end: number;
  /** Texto original encontrado. */
  found: string;
}

/**
 * Busca `phrase` en `source` sin distinguir mayúsculas ni tildes y por palabra
 * completa (los extremos de la coincidencia no pueden pegarse a otra letra o cifra).
 */
export function findPhrase(source: string, phrase: string): PhraseMatch[] {
  const needle = foldWithMap(phrase.trim()).text;
  if (!needle) return [];
  const hay = foldWithMap(source);
  const matches: PhraseMatch[] = [];
  const startsWithWord = WORD_CHAR.test(needle[0] ?? '');
  const endsWithWord = WORD_CHAR.test(needle[needle.length - 1] ?? '');
  let from = 0;
  while (from <= hay.text.length - needle.length) {
    const at = hay.text.indexOf(needle, from);
    if (at === -1) break;
    const last = at + needle.length - 1;
    const before = at > 0 ? (hay.text[at - 1] ?? '') : '';
    const after = hay.text[last + 1] ?? '';
    const okBefore = !startsWithWord || !WORD_CHAR.test(before);
    const okAfter = !endsWithWord || !WORD_CHAR.test(after);
    if (okBefore && okAfter) {
      const start = hay.starts[at] ?? 0;
      const end = hay.ends[last] ?? source.length;
      matches.push({ start, end, found: source.slice(start, end) });
      from = last + 1;
    } else {
      from = at + 1;
    }
  }
  return matches;
}

export interface Token {
  /** Sin el símbolo `#` o `@`. */
  value: string;
  start: number;
  end: number;
}

/** `#etiqueta` en el texto. No cuenta `#` pegado a una palabra ni etiquetas solo numéricas. */
export function extractHashtags(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_&#])#([\p{L}\p{N}_]+)/gu)) {
    const value = m[1] ?? '';
    if (!/\p{L}/u.test(value)) continue;
    out.push({ value, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** `@usuario` en el texto. No cuenta los correos electrónicos. */
export function extractMentions(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*)/gu)) {
    out.push({ value: m[1] ?? '', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Quita el `#` o `@` inicial y espacios. */
export function stripSigil(value: string): string {
  return value.trim().replace(/^[#@]+/, '');
}

/** Clave para comparar hashtags o menciones (sin símbolo, mayúsculas ni tildes). */
export function tagKey(value: string): string {
  return foldText(stripSigil(value));
}

function uniqueKeys(fromCaption: Token[], extra: string[]): string[] {
  const keys = new Set<string>();
  for (const t of fromCaption) keys.add(tagKey(t.value));
  for (const raw of extra) {
    const key = tagKey(raw);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Claves únicas de los hashtags de la pieza (los del pie más los añadidos aparte). */
export function pieceHashtagKeys(caption: string, extra: string[] = []): string[] {
  return uniqueKeys(extractHashtags(caption), extra);
}

export function pieceMentionKeys(caption: string, extra: string[] = []): string[] {
  return uniqueKeys(extractMentions(caption), extra);
}

/**
 * Texto que verá la red: el pie más los hashtags añadidos aparte que no estén ya
 * en el pie (en una línea nueva).
 */
export function publishedText(caption: string, extraHashtags: string[] = []): string {
  const inCaption = new Set(extractHashtags(caption).map((t) => tagKey(t.value)));
  const missing = extraHashtags
    .map((h) => stripSigil(h))
    .filter((h) => h && !inCaption.has(tagKey(h)))
    .map((h) => `#${h}`);
  return missing.length ? `${caption}\n\n${[...new Set(missing)].join(' ')}` : caption;
}

export function textLength(value: string, unit: LengthUnit = 'utf16'): number {
  if (unit === 'utf16') return value.length;
  if (unit === 'codepoints') return [...value].length;
  return graphemes(value).length;
}

function graphemes(value: string): { segment: string; index: number }[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) {
    let index = 0;
    return [...value].map((segment) => {
      const item = { segment, index };
      index += segment.length;
      return item;
    });
  }
  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((s) => ({
    segment: s.segment,
    index: s.index,
  }));
}

export interface EmojiFound {
  emoji: string;
  start: number;
  end: number;
}

/**
 * Emojis del texto: cada secuencia (ZWJ, bandera, tono, teclas) cuenta como uno.
 * Se exigen presentación de emoji, selector FE0F o `⃣`, de modo que ©, ® o ™ sueltos no cuentan.
 */
export function findEmojis(value: string): EmojiFound[] {
  const isEmoji = (g: string) => /\p{Emoji_Presentation}|️|⃣/u.test(g);
  return graphemes(value)
    .filter((g) => isEmoji(g.segment))
    .map((g) => ({ emoji: g.segment, start: g.index, end: g.index + g.segment.length }));
}
