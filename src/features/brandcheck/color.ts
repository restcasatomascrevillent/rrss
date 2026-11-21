// Color: contraste WCAG 2.x y distancia CIEDE2000. Fórmulas propias, sin bibliotecas.

import { LARGE_BOLD_TEXT_PT, LARGE_TEXT_PT, WCAG_LARGE_TEXT, WCAG_NORMAL_TEXT } from './thresholds';

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0-1; 1 si el color no trae alfa. */
  a: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** Lee `#RGB`, `#RRGGBB` o `#RRGGBBAA`. Devuelve null si no es un color válido. */
export function parseHex(value: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  const hex = m?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa (WCAG 2.x): 0,2126 R + 0,7152 G + 0,0722 B sobre canales linealizados. */
export function relativeLuminance(rgb: Pick<Rgb, 'r' | 'g' | 'b'>): number {
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** Relación de contraste WCAG entre dos luminancias: (L1 + 0,05) / (L2 + 0,05), L1 la mayor. */
export function contrastRatio(a: Pick<Rgb, 'r' | 'g' | 'b'>, b: Pick<Rgb, 'r' | 'g' | 'b'>): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mezcla un color con alfa sobre un fondo opaco. */
export function blendOver(fg: Rgb, bg: Rgb): Rgb {
  const mix = (f: number, b: number) => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** Texto grande según WCAG: ≥ 18 pt, o ≥ 14 pt en negrita. Sin tamaño se trata como normal. */
export function isLargeText(fontSizePt: number | undefined, bold: boolean | undefined): boolean {
  if (fontSizePt === undefined) return false;
  return fontSizePt >= LARGE_TEXT_PT || (bold === true && fontSizePt >= LARGE_BOLD_TEXT_PT);
}

export function requiredContrast(large: boolean): number {
  return large ? WCAG_LARGE_TEXT : WCAG_NORMAL_TEXT;
}

// ── CIELAB y CIEDE2000 ───────────────────────────────────────────────────

// Blanco de referencia D65.
const WHITE = { x: 0.95047, y: 1, z: 1.08883 };

export function rgbToLab(rgb: Pick<Rgb, 'r' | 'g' | 'b'>): Lab {
  const r = linear(rgb.r);
  const g = linear(rgb.g);
  const b = linear(rgb.b);
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x / WHITE.x);
  const fy = f(y / WHITE.y);
  const fz = f(z / WHITE.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** Distancia de color CIEDE2000 (Sharma, Wu y Dalal, 2005), con kL = kC = kH = 1. */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, ap: number) => (b === 0 && ap === 0 ? 0 : (deg(Math.atan2(b, ap)) + 360) % 360);
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;

  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** ΔE2000 entre dos colores hexadecimales; null si alguno no es válido. */
export function deltaEHex(hexA: string, hexB: string): number | null {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  if (!a || !b) return null;
  return deltaE2000(rgbToLab(a), rgbToLab(b));
}
