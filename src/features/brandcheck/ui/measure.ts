// Texto claro del dato medido y del umbral de un hallazgo, para mostrarlo en pantalla.

import type { Finding } from '../types';

const percent = (value: number) => `${Math.round(value * 100)} %`;
const num = (value: number) => String(value).replace('.', ',');

/** «Medido … · exigido …» en lenguaje llano; `null` si el hallazgo no trae datos que enseñar. */
export function describeMeasure(finding: Finding): string | null {
  const { measured, threshold } = finding;
  if (finding.omitted || measured === undefined || measured === null) return null;
  const m = typeof measured === 'number' ? measured : String(measured);
  const t = threshold ?? null;
  switch (finding.code) {
    case 'LENGTH_EXCEEDED':
      return `Tiene ${m} caracteres; el máximo es ${t}.`;
    case 'HASHTAGS_EXCEEDED':
      return `Hay ${m} hashtags; el máximo es ${t}.`;
    case 'MENTIONS_EXCEEDED':
      return `Hay ${m} menciones; el máximo es ${t}.`;
    case 'ALT_TEXT_TOO_LONG':
      return `Tiene ${m} caracteres; el máximo es ${t}.`;
    case 'CONTRAST_TOO_LOW':
      return `Contraste ${num(Number(m))}:1; se exige al menos ${num(Number(t))}:1.`;
    case 'PALETTE_OFF_BRAND':
      return `Colores de marca en el ${percent(Number(m))} de la imagen; se espera al menos el ${percent(Number(t))}.`;
    case 'EMOJIS_NOT_ALLOWED':
      return `Hay ${m} emojis; la marca no los usa.`;
    case 'EMOJIS_EXCEEDED':
      return `Hay ${m} emojis; el máximo es ${t}.`;
    case 'FORBIDDEN_PHRASE':
      return `Aparece «${m}»; la marca veta «${t}».`;
    case 'BRAND_HASHTAG_MISSING':
      return `Falta ${t}.`;
    case 'BRAND_HASHTAG_RECOMMENDED_MISSING':
      return `Usa ${m} de ${t} hashtags recomendados.`;
    case 'CALL_TO_ACTION_MISSING':
      return 'No aparece ninguna llamada a la acción de la marca.';
    case 'ALT_TEXT_MISSING':
      return null;
    case 'READABILITY_SCORE':
      return `Facilidad de lectura ${num(Number(m))}${t !== null ? ` (referencia ${t})` : ''}.`;
    default:
      return t !== null ? `Medido: ${m} · Umbral: ${t}.` : `Medido: ${m}.`;
  }
}
