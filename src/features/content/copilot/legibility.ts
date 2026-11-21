import { contrastRatio, parseHex, relativeLuminance } from '@/features/brandcheck/color';
import { WCAG_LARGE_TEXT, WCAG_NORMAL_TEXT } from '@/features/brandcheck/thresholds';
import type { Canvas, Layer } from '../document';

// Color legible para los textos del copiloto (docs/copiloto-voz.md, «Color de
// los textos»). El color por defecto de un texto sale del USO que la marca da a
// cada color en su perfil (principal, fondo, texto…), no de su posición en la
// paleta, y se comprueba con lo que hay debajo del texto: si no llega a un
// contraste legible, se usa el color de la marca más legible y, si ninguno
// vale, blanco o negro.

/** Uso de un color en el perfil de marca, leído del campo libre «Uso». */
export type BrandColorRole = 'title' | 'text' | 'background' | 'primary';

export interface CopilotBrandColor {
  /** #RRGGBB */
  hex: string;
  /** Uso que le da la marca («Principal», «fondo», «texto»…); texto libre del perfil. */
  role?: string;
}

const ROLE_WORDS: [BrandColorRole, RegExp][] = [
  ['title', /\b(titul\w*|cabecera\w*|heading\w*|titles?)\b/],
  ['text', /\b(texto\w*|text|cuerpo|body|letras?)\b/],
  ['background', /\b(fondos?|background|bg)\b/],
  ['primary', /\b(principal\w*|primari\w*|primary|main)\b/],
];

/** Lee el uso de un color (sin mayúsculas ni tildes). `null` si no es ninguno de los conocidos. */
export function colorRole(role: string | undefined): BrandColorRole | null {
  if (!role) return null;
  const plain = role.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return ROLE_WORDS.find(([, words]) => words.test(plain))?.[0] ?? null;
}

/**
 * Tono que se supone a una foto cuyo tono no se conoce todavía (recién puesta,
 * sin analizar): gris medio oscuro, lo habitual en fotos de ambiente. Con él
 * gana el texto claro, que es lo que suele leerse sobre una foto difuminada.
 */
export const ASSUMED_PHOTO_TONE = '#5A5A5A';
/** A partir de este desenfoque, la foto se trata como un fondo casi uniforme. */
export const BLURRED_FROM = 20;

/** Lo que hay debajo de un texto. */
export interface Backdrop {
  hex: string;
  /** Contraste mínimo exigido sobre este fondo. */
  required: number;
  kind: 'color' | 'photo';
}

/**
 * Contraste exigido: WCAG AA para texto grande (3:1) sobre un color liso o una
 * foto difuminada de tono conocido (todos los textos del copiloto son texto
 * grande). Sobre una foto nítida o de tono desconocido, 4,5:1 de margen: una
 * foto no es un color uniforme.
 */
function requiredOver(kind: Backdrop['kind'], known: boolean, blurred: boolean): number {
  return kind === 'color' || (known && blurred) ? WCAG_LARGE_TEXT : WCAG_NORMAL_TEXT;
}

const shown = (layer: Layer) => layer.visible && layer.opacity >= 0.5;
const containsPoint = (layer: Layer, x: number, y: number) =>
  x >= layer.x && x <= layer.x + layer.width && y >= layer.y && y <= layer.y + layer.height;

/**
 * Lo que hay debajo del centro de una caja: la capa de imagen o forma con
 * relleno más alta de `below` (de abajo arriba, como en el documento) que lo
 * cubre, o el color del lienzo. Textos y logotipos no cuentan como fondo.
 * `tones`: tono medio de las fotos ya analizadas, por id de recurso.
 */
export function backdropAt(
  canvas: Canvas,
  below: readonly Layer[],
  box: { x: number; y: number; width: number; height: number },
  tones?: ReadonlyMap<string, string>,
): Backdrop {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = below.length - 1; i >= 0; i -= 1) {
    const layer = below[i]!;
    if (!shown(layer) || !containsPoint(layer, cx, cy)) continue;
    if (layer.type === 'image') {
      const tone = layer.source.kind === 'asset' ? tones?.get(layer.source.assetId) : undefined;
      const blurred = (layer.blur ?? 0) >= BLURRED_FROM;
      return { hex: tone ?? ASSUMED_PHOTO_TONE, kind: 'photo', required: requiredOver('photo', Boolean(tone), blurred) };
    }
    if (layer.type === 'shape' && layer.fill) {
      return { hex: layer.fill.toUpperCase(), kind: 'color', required: requiredOver('color', true, false) };
    }
  }
  return { hex: canvas.backgroundColor.toUpperCase(), kind: 'color', required: WCAG_LARGE_TEXT };
}

/** Contraste WCAG entre dos #RRGGBB (1 si alguno no es válido). */
export function contrastOf(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return ca && cb ? contrastRatio(ca, cb) : 1;
}

/**
 * Color de la marca que le toca a un texto por su uso: títulos, el de títulos
 * o el principal; el resto, el de texto. Sin usos en el perfil, por orden (el
 * primero para títulos y el segundo para el resto, como antes). Los colores de
 * fondo no se proponen para textos.
 */
export function preferredTextColor(palette: readonly CopilotBrandColor[], heading: boolean): string | null {
  const byRole = (role: BrandColorRole) => palette.find((color) => colorRole(color.role) === role)?.hex ?? null;
  const usable = palette.filter((color) => colorRole(color.role) !== 'background').map((color) => color.hex);
  if (heading) return byRole('title') ?? byRole('primary') ?? usable[0] ?? null;
  return byRole('text') ?? usable[1] ?? usable[0] ?? null;
}

/**
 * Color legible para un texto sin color dictado: el de la marca por su uso si
 * se lee sobre el fondo; si no, el color de la marca más legible si llega; si
 * ninguno llega, blanco o negro (el que más contraste).
 */
export function legibleTextColor(palette: readonly CopilotBrandColor[], heading: boolean, backdrop: Backdrop): string {
  const preferred = preferredTextColor(palette, heading);
  if (preferred && contrastOf(preferred, backdrop.hex) >= backdrop.required) return preferred.toUpperCase();
  let best: { hex: string; ratio: number } | null = null;
  for (const { hex } of palette) {
    const ratio = contrastOf(hex, backdrop.hex);
    if (!best || ratio > best.ratio) best = { hex, ratio };
  }
  if (best && best.ratio >= backdrop.required) return best.hex.toUpperCase();
  return contrastOf('#FFFFFF', backdrop.hex) >= contrastOf('#000000', backdrop.hex) ? '#FFFFFF' : '#000000';
}

/**
 * Tono medio de una foto a partir de su paleta dominante (la que ya calcula el
 * editor para el verificador): media ponderada en luminancia lineal, devuelta
 * como gris de esa luminancia. Basta para el contraste. `null` sin paleta.
 */
export function toneOfPalette(palette: readonly { hex: string; weight?: number }[]): string | null {
  let total = 0;
  let sum = 0;
  for (const color of palette) {
    const rgb = parseHex(color.hex);
    if (!rgb) continue;
    const weight = color.weight ?? 1;
    total += weight;
    sum += relativeLuminance(rgb) * weight;
  }
  if (total <= 0) return null;
  const luminance = sum / total;
  // Luminancia lineal → canal sRGB.
  const channel = luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
  const value = Math.round(Math.min(1, Math.max(0, channel)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `#${value}${value}${value}`;
}
