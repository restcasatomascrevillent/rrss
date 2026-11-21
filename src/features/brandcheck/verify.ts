// Agregado: ejecuta todas las comprobaciones y devuelve veredicto y hallazgos ordenados.

import { checkAltText, checkHashtagCount, checkLength, checkMentionCount, checkPageCount } from './limits';
import { checkEmojis, checkReadability } from './style';
import { checkBrandHashtags, checkCallToAction, checkForbiddenPhrases } from './vocabulary';
import { checkContrast, checkPalette, checkSafeZone } from './visual';
import type {
  BrandCheckInput,
  BrandCheckOptions,
  BrandCheckResult,
  CheckId,
  CheckStatus,
  Finding,
  Severity,
} from './types';

const SEVERITY_RANK: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

/** Orden estable de las comprobaciones (también el orden de desempate al ordenar). */
export const CHECK_ORDER: CheckId[] = [
  'pages',
  'length',
  'hashtags',
  'mentions',
  'forbidden-phrases',
  'brand-hashtags',
  'call-to-action',
  'contrast',
  'safe-zone',
  'palette',
  'emojis',
  'alt-text',
  'readability',
];

function statusOf(findings: Finding[]): CheckStatus {
  const real = findings.filter((f) => !f.omitted);
  if (real.some((f) => f.severity !== 'info')) return 'failed';
  if (findings.length > 0 && real.length === 0) return 'skipped';
  return 'passed';
}

/** Ejecuta todas las comprobaciones. No lanza: los datos que faltan se notifican como hallazgos informativos. */
export function verifyPiece(input: BrandCheckInput, options: BrandCheckOptions = {}): BrandCheckResult {
  const { text, limits, brand } = input;
  const byCheck: Record<CheckId, Finding[]> = {
    pages: checkPageCount(input.pages),
    length: checkLength(text, limits),
    hashtags: checkHashtagCount(text, limits),
    mentions: checkMentionCount(text, limits),
    'forbidden-phrases': checkForbiddenPhrases(text, input.textLayers, brand),
    'brand-hashtags': checkBrandHashtags(text, brand),
    'call-to-action': checkCallToAction(text, brand),
    contrast: checkContrast(input.textLayers),
    'safe-zone': checkSafeZone(input.textLayers, input.safeArea, input.limits.label),
    palette: checkPalette(input.imagePalette, brand.brandColors, input.imageKind, options),
    emojis: checkEmojis(text, brand.emojiPolicy),
    'alt-text': checkAltText(text, input.hasImage, limits),
    readability: checkReadability(text, options),
  };

  const findings = CHECK_ORDER.flatMap((id, order) => byCheck[id].map((finding, index) => ({ finding, order, index })))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        a.order - b.order ||
        (a.finding.target.range?.start ?? 0) - (b.finding.target.range?.start ?? 0) ||
        a.index - b.index,
    )
    .map((x) => x.finding);

  const counts: Record<Severity, number> = { block: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    verdict: counts.block > 0 ? 'fail' : counts.warn > 0 ? 'pass_with_warnings' : 'pass',
    counts,
    findings,
    checks: CHECK_ORDER.map((id) => ({ id, status: statusOf(byCheck[id]) })),
  };
}
