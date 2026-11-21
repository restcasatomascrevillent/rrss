// Comprobaciones visuales: contraste del texto y distancia de la paleta a los colores de marca.

import { blendOver, contrastRatio, deltaE2000, isLargeText, parseHex, requiredContrast, rgbToLab } from './color';
import { DEFAULT_PALETTE_MATCH_DELTA_E, DEFAULT_PALETTE_MIN_COVERAGE, DEFAULT_PALETTE_MIN_WEIGHT } from './thresholds';
import type { BrandCheckOptions, BrandColor, Finding, ImageKind, PaletteColor, SafeArea, TextLayer } from './types';

/** «Un texto de la imagen» o, en un documento de varias páginas, «Un texto de la página 3». */
export function textWhere(layer: Pick<TextLayer, 'page'>): string {
  return layer.page ? `Un texto de la página ${layer.page}` : 'Un texto de la imagen';
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Contraste WCAG 2.x de cada capa de texto sobre su fondo (4,5:1 texto normal,
 * 3:1 texto grande). Por debajo de 3:1 el texto es ilegible con cualquier criterio
 * y bloquea; entre 3:1 y 4,5:1 en texto normal avisa.
 */
export function checkContrast(layers: TextLayer[] | undefined): Finding[] {
  const findings: Finding[] = [];
  for (const layer of layers ?? []) {
    if (layer.exempt) continue;
    const target = { part: 'textLayer' as const, layerId: layer.id };
    const fg = parseHex(layer.color);
    const bg = layer.background ? parseHex(layer.background) : null;
    if (!fg || !bg || bg.a < 1) {
      findings.push({
        code: 'CONTRAST_UNKNOWN_BACKGROUND',
        check: 'contrast',
        severity: 'info',
        message: !fg
          ? `No se pudo leer el color de ${textWhere(layer).toLowerCase()}; no se comprueba su contraste.`
          : `Se desconoce el color de fondo (opaco) de ${textWhere(layer).toLowerCase()}; no se comprueba su contraste.`,
        target,
        omitted: true,
      });
      continue;
    }
    const ratio = round(contrastRatio(blendOver(fg, bg), bg));
    const large = isLargeText(layer.fontSizePt, layer.bold);
    const needed = requiredContrast(large);
    if (ratio >= needed) continue;
    const absolute = ratio < requiredContrast(true);
    findings.push({
      code: 'CONTRAST_TOO_LOW',
      check: 'contrast',
      severity: absolute ? 'block' : 'warn',
      message: `${textWhere(layer)} tiene un contraste de ${ratio}:1 y debería tener al menos ${needed}:1 (${
        large ? 'texto grande' : 'texto normal'
      }). Aclara el texto o oscurece el fondo.`,
      measured: ratio,
      threshold: needed,
      target,
    });
  }
  return findings;
}

/**
 * Textos de la imagen que caen, aunque sea en parte, donde la interfaz de la
 * red puede taparlos (historias y reels). Avisa, no bloquea: las cifras de las
 * zonas seguras no son oficiales y el mensaje lo dice.
 */
export function checkSafeZone(
  layers: TextLayer[] | undefined,
  safe: SafeArea | undefined,
  networkLabel?: string,
): Finding[] {
  if (!safe) return [];
  const findings: Finding[] = [];
  for (const layer of layers ?? []) {
    const b = layer.bounds;
    if (!b) continue;
    const area = (b.right - b.left) * (b.bottom - b.top);
    if (area <= 0) continue;
    const inside =
      Math.max(0, Math.min(b.right, safe.right) - Math.max(b.left, safe.left)) *
      Math.max(0, Math.min(b.bottom, safe.bottom) - Math.max(b.top, safe.top));
    const outside = Math.round((1 - inside / area) * 100);
    if (outside <= 0) continue;
    findings.push({
      code: 'TEXT_IN_UNSAFE_ZONE',
      check: 'safe-zone',
      severity: 'warn',
      message: `${textWhere(layer)} tiene el ${outside} % de su caja donde la interfaz de ${
        networkLabel ?? 'la red'
      } puede taparlo. Muévelo hacia el centro.${
        safe.provenance === 'unverified' ? ' Zona orientativa: la red no publica la cifra.' : ''
      }`,
      measured: `${outside} %`,
      threshold: '0 %',
      target: { part: 'textLayer', layerId: layer.id },
    });
  }
  return findings;
}

/** Peso normalizado de cada color de la paleta (sin dato, todos pesan igual). */
function normalizedPalette(palette: PaletteColor[], minWeight: number) {
  const valid = palette.flatMap((p) => {
    const rgb = parseHex(p.hex);
    return rgb ? [{ hex: p.hex, lab: rgbToLab(rgb), weight: p.weight ?? NaN }] : [];
  });
  const anyWeight = valid.some((p) => !Number.isNaN(p.weight));
  const raw = valid.map((p) => ({ ...p, weight: anyWeight ? Math.max(0, Number.isNaN(p.weight) ? 0 : p.weight) : 1 }));
  const total = raw.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return [];
  return raw.map((p) => ({ ...p, weight: p.weight / total })).filter((p) => p.weight >= minWeight);
}

/**
 * Distancia ΔE2000 entre la paleta dominante de la imagen y los colores de marca.
 * Mide qué parte de la imagen está a menos de `paletteMatchDeltaE` de algún color
 * de marca. Nunca bloquea: en una fotografía los colores no dependen de la marca
 * (informa); en una pieza gráfica del producto avisa.
 */
export function checkPalette(
  palette: PaletteColor[] | undefined,
  brandColors: BrandColor[] | undefined,
  imageKind: ImageKind | undefined,
  options: BrandCheckOptions = {},
): Finding[] {
  const brand = (brandColors ?? []).flatMap((c) => {
    const rgb = parseHex(c.hex);
    return rgb ? [{ ...c, lab: rgbToLab(rgb) }] : [];
  });
  if (brand.length === 0) {
    return [
      {
        code: 'PROFILE_DATA_MISSING',
        check: 'palette',
        severity: 'info',
        message: 'El perfil de marca no define colores; no se puede comparar la paleta de la imagen.',
        target: { part: 'image' },
        omitted: true,
      },
    ];
  }
  const maxDelta = options.paletteMatchDeltaE ?? DEFAULT_PALETTE_MATCH_DELTA_E;
  const minCoverage = options.paletteMinCoverage ?? DEFAULT_PALETTE_MIN_COVERAGE;
  const colors = normalizedPalette(palette ?? [], options.paletteMinWeight ?? DEFAULT_PALETTE_MIN_WEIGHT);
  if (colors.length === 0) {
    return [
      {
        code: 'PROFILE_DATA_MISSING',
        check: 'palette',
        severity: 'info',
        message: 'No hay paleta de colores de la imagen; no se comprueba su distancia a la paleta de marca.',
        target: { part: 'image' },
        omitted: true,
      },
    ];
  }
  let coverage = 0;
  let closest = Infinity;
  for (const c of colors) {
    const nearest = Math.min(...brand.map((b) => deltaE2000(c.lab, b.lab)));
    closest = Math.min(closest, nearest);
    if (nearest <= maxDelta) coverage += c.weight;
  }
  coverage = round(coverage);
  if (coverage >= minCoverage && coverage > 0) return [];
  const percent = Math.round(coverage * 100);
  return [
    {
      code: 'PALETTE_OFF_BRAND',
      check: 'palette',
      severity: imageKind === 'graphic' ? 'warn' : 'info',
      message:
        coverage === 0
          ? `Ningún color dominante de la imagen se parece a los de la marca (el más cercano está a ΔE ${round(closest, 1)}; se considera parecido por debajo de ${maxDelta}).`
          : `Solo el ${percent} % de la imagen usa colores de la marca; lo esperado es al menos el ${Math.round(minCoverage * 100)} %.`,
      measured: coverage,
      threshold: minCoverage,
      target: { part: 'image' },
    },
  ];
}
