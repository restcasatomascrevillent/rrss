// Comprobaciones de vocabulario de marca: palabras vetadas, hashtags y llamada a la acción.

import { findPhrase, pieceHashtagKeys, stripSigil, tagKey } from './text';
import type { BrandRules, Finding, PieceText, TextLayer } from './types';
import { textWhere } from './visual';

function missingData(check: Finding['check'], what: string): Finding {
  return {
    code: 'PROFILE_DATA_MISSING',
    check,
    severity: 'info',
    message: `El perfil de marca no define ${what}; esta comprobación se omite.`,
    target: { part: 'piece' },
    omitted: true,
  };
}

const clean = (items: string[] | undefined) => (items ?? []).map((s) => s.trim()).filter(Boolean);

/**
 * Palabras y expresiones vetadas del perfil, sin distinguir mayúsculas ni tildes
 * y por palabra completa. Un hallazgo por aparición, con su posición.
 */
export function checkForbiddenPhrases(text: PieceText, layers: TextLayer[] | undefined, brand: BrandRules): Finding[] {
  const phrases = clean(brand.forbiddenPhrases);
  if (phrases.length === 0) return [missingData('forbidden-phrases', 'palabras o expresiones vetadas')];
  const findings: Finding[] = [];
  const scan = (source: string, target: Finding['target'], where: string) => {
    for (const phrase of phrases) {
      for (const m of findPhrase(source, phrase)) {
        findings.push({
          code: 'FORBIDDEN_PHRASE',
          check: 'forbidden-phrases',
          severity: 'block',
          message: `«${m.found}» está vetada por la marca${where}. Quítala o cámbiala.`,
          measured: m.found,
          threshold: phrase,
          target: { ...target, range: { start: m.start, end: m.end } },
        });
      }
    }
  };
  scan(text.caption, { part: 'caption' }, '');
  if (text.altText) scan(text.altText, { part: 'altText' }, ' (en el texto alternativo)');
  for (const tag of text.hashtags ?? []) {
    const raw = stripSigil(tag);
    const hits = phrases.flatMap((p) => findPhrase(raw, p).map((m) => ({ p, m })));
    for (const { p, m } of hits) {
      findings.push({
        code: 'FORBIDDEN_PHRASE',
        check: 'forbidden-phrases',
        severity: 'block',
        message: `«${m.found}» está vetada por la marca (en el hashtag #${raw}). Quítala o cámbiala.`,
        measured: m.found,
        threshold: p,
        target: { part: 'hashtags' },
      });
    }
  }
  for (const layer of layers ?? []) {
    if (layer.text) scan(layer.text, { part: 'textLayer', layerId: layer.id }, ` (en ${textWhere(layer).toLowerCase()})`);
  }
  return findings;
}

/** Hashtags obligatorios (bloquea si faltan) y recomendados (informa) del perfil. */
export function checkBrandHashtags(text: PieceText, brand: BrandRules): Finding[] {
  const required = clean(brand.requiredHashtags);
  const recommended = clean(brand.recommendedHashtags);
  if (required.length === 0 && recommended.length === 0) {
    return [missingData('brand-hashtags', 'hashtags obligatorios ni recomendados')];
  }
  const present = new Set(pieceHashtagKeys(text.caption, text.hashtags));
  const findings: Finding[] = [];
  for (const tag of required) {
    if (!present.has(tagKey(tag))) {
      findings.push({
        code: 'BRAND_HASHTAG_MISSING',
        check: 'brand-hashtags',
        severity: 'block',
        message: `Falta el hashtag obligatorio #${stripSigil(tag)}.`,
        measured: 0,
        threshold: `#${stripSigil(tag)}`,
        target: { part: 'hashtags' },
      });
    }
  }
  const absent = recommended.filter((tag) => !present.has(tagKey(tag)));
  if (absent.length > 0) {
    findings.push({
      code: 'BRAND_HASHTAG_RECOMMENDED_MISSING',
      check: 'brand-hashtags',
      severity: 'info',
      message: `Hashtags recomendados que no aparecen: ${absent.map((t) => `#${stripSigil(t)}`).join(', ')}.`,
      measured: recommended.length - absent.length,
      threshold: recommended.length,
      target: { part: 'hashtags' },
    });
  }
  return findings;
}

/** Aparece al menos una de las llamadas a la acción de la marca. */
export function checkCallToAction(text: PieceText, brand: BrandRules): Finding[] {
  const ctas = clean(brand.callsToAction);
  if (ctas.length === 0) return [missingData('call-to-action', 'llamadas a la acción')];
  if (ctas.some((cta) => findPhrase(text.caption, cta).length > 0)) return [];
  return [
    {
      code: 'CALL_TO_ACTION_MISSING',
      check: 'call-to-action',
      severity: 'warn',
      message: `El texto no incluye ninguna llamada a la acción de la marca (por ejemplo: ${ctas
        .slice(0, 3)
        .map((c) => `«${c}»`)
        .join(', ')}).`,
      measured: 0,
      threshold: 1,
      target: { part: 'caption' },
    },
  ];
}
