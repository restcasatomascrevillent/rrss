// Estilo del texto: emojis y legibilidad en español (Fernández-Huerta).

import { DEFAULT_READABILITY_MIN_WORDS, READABILITY_REFERENCE } from './thresholds';
import { findEmojis } from './text';
import type { BrandCheckOptions, EmojiPolicy, Finding, PieceText } from './types';

/** Número de emojis y si la política de la marca los permite. Sin política no se inventa la regla. */
export function checkEmojis(text: PieceText, policy: EmojiPolicy | undefined): Finding[] {
  const hasRule = policy !== undefined && (policy.allowed !== undefined || policy.max !== undefined);
  if (!hasRule) {
    return [
      {
        code: 'PROFILE_DATA_MISSING',
        check: 'emojis',
        severity: 'info',
        message: 'El perfil de marca no define una política de emojis; esta comprobación se omite.',
        target: { part: 'piece' },
        omitted: true,
      },
    ];
  }
  const found = findEmojis(text.caption);
  const count = found.length;
  if (policy.allowed === false && count > 0) {
    const first = found[0]!;
    return [
      {
        code: 'EMOJIS_NOT_ALLOWED',
        check: 'emojis',
        severity: 'warn',
        message: `La marca no usa emojis y el texto tiene ${count}. Quítalos.`,
        measured: count,
        threshold: 0,
        target: { part: 'caption', range: { start: first.start, end: first.end } },
      },
    ];
  }
  if (policy.max !== undefined && count > policy.max) {
    const extra = found[policy.max]!;
    return [
      {
        code: 'EMOJIS_EXCEEDED',
        check: 'emojis',
        severity: 'warn',
        message: `El texto tiene ${count} emojis y la marca admite como máximo ${policy.max}.`,
        measured: count,
        threshold: policy.max,
        target: { part: 'caption', range: { start: extra.start, end: extra.end } },
      },
    ];
  }
  return [];
}

// ── Fernández-Huerta ─────────────────────────────────────────────────────

const STRONG = new Set(['a', 'e', 'o', 'á', 'é', 'ó']);
const ACCENTED_WEAK = new Set(['í', 'ú']);
const WEAK = new Set(['i', 'u', 'ü']);

/**
 * Sílabas de una palabra española por núcleos vocálicos: diptongos y triptongos
 * (vocal débil con otra) forman una sílaba; dos vocales fuertes, o una débil
 * acentuada junto a otra vocal, forman hiato. La «u» de que/qui/gue/gui es muda y
 * la «y» final cuenta como vocal. Es una aproximación: sirve para el índice, no para silabear.
 */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().normalize('NFC');
  const chars = [...w];
  const kinds: ('S' | 'A' | 'W' | 'C')[] = chars.map((ch, i) => {
    if (STRONG.has(ch)) return 'S';
    if (ACCENTED_WEAK.has(ch)) return 'A';
    if (ch === 'u') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      if (prev === 'q') return 'C';
      if (prev === 'g' && (next === 'e' || next === 'i' || next === 'é' || next === 'í')) return 'C';
      return 'W';
    }
    if (WEAK.has(ch)) return 'W';
    if (ch === 'y' && (i === chars.length - 1 || chars.length === 1)) return 'W';
    return 'C';
  });
  let syllables = 0;
  let i = 0;
  while (i < kinds.length) {
    if (kinds[i] === 'C') {
      i++;
      continue;
    }
    let strongOrAccented = 0;
    while (i < kinds.length && kinds[i] !== 'C') {
      if (kinds[i] === 'S' || kinds[i] === 'A') strongOrAccented++;
      i++;
    }
    syllables += Math.max(1, strongOrAccented);
  }
  return syllables;
}

export interface ReadabilityStats {
  words: number;
  sentences: number;
  syllables: number;
  /** Índice de Fernández-Huerta, acotado a 0-100. */
  score: number;
}

/** Quita lo que no es prosa: enlaces, #hashtags, @menciones y emojis. */
function proseOnly(value: string): string {
  return value
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[#@][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/\p{Emoji_Presentation}|️|‍/gu, ' ');
}

/**
 * L = 206,84 − 0,60·P − 1,02·F, con P = sílabas por 100 palabras y F = palabras por frase
 * (Fernández Huerta, 1959). Null si no hay palabras.
 */
export function fernandezHuerta(value: string): ReadabilityStats | null {
  const prose = proseOnly(value);
  const words = prose.match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return null;
  const sentences = prose.split(/[.!?…]+|\n+/u).filter((s) => /\p{L}/u.test(s)).length || 1;
  const syllables = words.reduce((sum, w) => sum + Math.max(1, countSyllables(w)), 0);
  const P = (syllables / words.length) * 100;
  const F = words.length / sentences;
  const raw = 206.84 - 0.6 * P - 1.02 * F;
  return { words: words.length, sentences, syllables, score: Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10 };
}

/** Tramos orientativos del índice (varían según la fuente: no es un criterio de aprobación). */
export function readabilityBand(score: number): string {
  if (score < 30) return 'muy difícil';
  if (score < 50) return 'difícil';
  if (score < 60) return 'algo difícil';
  if (score < 70) return 'normal';
  if (score < 80) return 'bastante fácil';
  if (score < 90) return 'fácil';
  return 'muy fácil';
}

/** Legibilidad del pie. Solo informa: nunca avisa ni bloquea. */
export function checkReadability(text: PieceText, options: BrandCheckOptions = {}): Finding[] {
  const minWords = options.readabilityMinWords ?? DEFAULT_READABILITY_MIN_WORDS;
  const stats = fernandezHuerta(text.caption);
  if (!stats || stats.words < minWords) {
    return [
      {
        code: 'READABILITY_TOO_SHORT',
        check: 'readability',
        severity: 'info',
        message: `El texto es demasiado corto para medir su legibilidad (se necesitan al menos ${minWords} palabras).`,
        measured: stats?.words ?? 0,
        threshold: minWords,
        target: { part: 'caption' },
        omitted: true,
      },
    ];
  }
  return [
    {
      code: 'READABILITY_SCORE',
      check: 'readability',
      severity: 'info',
      message: `Facilidad de lectura: ${stats.score} de 100, ${readabilityBand(stats.score)}. Es solo orientativo.`,
      measured: stats.score,
      threshold: READABILITY_REFERENCE,
      target: { part: 'caption' },
    },
  ];
}
