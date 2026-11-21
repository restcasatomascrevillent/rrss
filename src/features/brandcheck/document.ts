// Conector documento → verificador: construye la entrada del verificador de
// marca a partir del documento por capas, la especificación de la red y el
// perfil. Lógica pura: sin red, sin base de datos y sin interfaz.

import { pageLimits, pageView, type ContentDocument, type Layer, type PageView, type ShapeLayer } from '@/features/content/document';
import { NETWORKS, type NetworkFormatSpec } from '@/features/content/networks';
import { safeZoneFor } from '@/features/content/safeZones';
import { lengthUnitOf } from '@/features/content/textUnits';
import { blendOver, parseHex, type Rgb } from './color';
import { brandRulesFromProfile, type ProfileLike } from './profile';
import type { BrandCheckInput, NetworkLimits, PaletteColor, TextLayer } from './types';

/**
 * Ancho (en píxeles CSS) de la pantalla en la que se supone que se ve la pieza
 * a lo ancho: un móvil estrecho. Sirve para pasar el cuerpo de letra del lienzo
 * a puntos y decidir si un texto es «grande» según WCAG (18 pt, o 14 pt en
 * negrita). Es un supuesto, no una medida: se puede cambiar con
 * `BuildInputOptions.viewportWidthPx`.
 */
export const REFERENCE_VIEWPORT_PX = 390;
/** WCAG define 18 pt = 24 px CSS, es decir, 1 px CSS = 0,75 pt. */
const PT_PER_CSS_PX = 0.75;
/** Peso de letra desde el que se considera negrita. */
const BOLD_WEIGHT = 700;

export interface BuildInputOptions {
  /** Paleta dominante de la imagen ya extraída (ver `palette.ts`). Sin ella, esa comprobación se omite. */
  imagePalette?: PaletteColor[];
  viewportWidthPx?: number;
}

// ── Límites de la red ────────────────────────────────────────────────────

/**
 * Límites de texto de la especificación de la red. Lo que la especificación no
 * trae queda sin definir (el verificador lo notifica como dato desconocido).
 * La unidad de cuenta es la común del producto (`content/textUnits.ts`), la
 * misma que el contador del editor y la ventana «Redactar con IA».
 */
export function limitsFromSpec(spec: NetworkFormatSpec | undefined): NetworkLimits {
  if (!spec) return {};
  const { text } = spec;
  const limits: NetworkLimits = { label: NETWORKS.find((n) => n.id === spec.network)?.label ?? spec.label };
  if (text.caption) {
    limits.maxCaptionLength = text.caption.value.maxLength;
    limits.lengthUnit = lengthUnitOf(text.caption.value);
  }
  if (text.maxHashtags) limits.maxHashtags = text.maxHashtags.value;
  if (text.maxMentions) limits.maxMentions = text.maxMentions.value;
  if (text.altText) limits.maxAltTextLength = text.altText.value.maxLength;
  return limits;
}

// ── Geometría ────────────────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}
type Box = Pick<Layer, 'x' | 'y' | 'width' | 'height' | 'rotation'>;

const EPSILON = 0.5;

function corners(box: Box): Point[] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const angle = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const
  ).map(([sx, sy]) => {
    const dx = (sx * box.width) / 2;
    const dy = (sy * box.height) / 2;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

function bounds(points: Point[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** Las cajas envolventes se solapan (criterio conservador: con giros puede dar solapes que no existen). */
function overlaps(a: Box, b: Box): boolean {
  const ba = bounds(corners(a));
  const bb = bounds(corners(b));
  return ba.left < bb.right && ba.right > bb.left && ba.top < bb.bottom && ba.bottom > bb.top;
}

function insideShape(shape: ShapeLayer, point: Point): boolean {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const angle = (-shape.rotation * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  // Punto en el sistema de la forma (sin girar), relativo a su centro.
  const lx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ly = dx * Math.sin(angle) + dy * Math.cos(angle);
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  if (shape.shape === 'ellipse') return (lx / (hw + EPSILON)) ** 2 + (ly / (hh + EPSILON)) ** 2 <= 1;
  if (Math.abs(lx) > hw + EPSILON || Math.abs(ly) > hh + EPSILON) return false;
  const r = Math.min(shape.cornerRadius, hw, hh);
  if (r <= 0) return true;
  // Esquinas redondeadas: fuera si cae en la esquina y más lejos del centro del arco que el radio.
  const ax = Math.abs(lx) - (hw - r);
  const ay = Math.abs(ly) - (hh - r);
  return ax <= 0 || ay <= 0 || ax * ax + ay * ay <= (r + EPSILON) ** 2;
}

function covers(shape: ShapeLayer, box: Box): boolean {
  return corners(box).every((p) => insideShape(shape, p));
}

// ── Fondo de un texto ────────────────────────────────────────────────────

function isShown(layer: Layer): boolean {
  return layer.visible && layer.opacity > 0;
}

const toHex = (rgb: Rgb) =>
  `#${[rgb.r, rgb.g, rgb.b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/**
 * Color de fondo (`#RRGGBB`) sobre el que se lee la capa `index`, o `null` si no
 * se puede saber. Se recorren las capas de debajo, de arriba abajo:
 *  - una imagen o logotipo que se solape con el texto → desconocido;
 *  - una forma con relleno que cubre todo el texto → su color (mezclado con lo
 *    que haya debajo si es translúcida);
 *  - una forma que solo cubre parte del texto → desconocido (fondo mixto);
 *  - formas sin relleno, capas ocultas y otros textos no cuentan;
 *  - si no hay nada más, el fondo del lienzo.
 */
export function backgroundBehind(
  document: Pick<PageView, 'canvas' | 'layers'> | ContentDocument,
  index: number,
): string | null {
  // Un documento entero: su primera página.
  const page = 'pages' in document ? pageView(document, 0) : document;
  const rgb = resolveBackground(page, index, page.layers[index]!);
  return rgb ? toHex(rgb) : null;
}

function resolveBackground(document: Pick<PageView, 'canvas' | 'layers'>, above: number, box: Box): Rgb | null {
  for (let i = above - 1; i >= 0; i--) {
    const layer = document.layers[i]!;
    if (!isShown(layer) || !overlaps(layer, box)) continue;
    if (layer.type === 'image' || layer.type === 'logo') return null;
    if (layer.type === 'shape') {
      const fill = layer.fill ? parseHex(layer.fill) : null;
      if (!fill) continue;
      if (!covers(layer, box)) return null;
      if (layer.opacity >= 1) return { ...fill, a: 1 };
      const under = resolveBackground(document, i, box);
      return under ? blendOver({ ...fill, a: layer.opacity }, under) : null;
    }
  }
  return parseHex(document.canvas.backgroundColor);
}

// ── Capas de texto ───────────────────────────────────────────────────────

const alphaHex = (opacity: number) =>
  Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, '0');

/**
 * Capas de texto visibles y con contenido de TODAS las páginas, con su color
 * (con el alfa de la capa), su fondo (en su página) y su tamaño en puntos. Las
 * capas ocultas o del todo transparentes no se ven y no se revisan. En un
 * documento de varias páginas, cada una dice la suya (`page`, desde 1).
 */
export function textLayersFromDocument(
  document: ContentDocument,
  viewportWidthPx: number = REFERENCE_VIEWPORT_PX,
): TextLayer[] {
  const pxPerUnit = viewportWidthPx / document.canvas.width;
  const several = document.pages.length > 1;
  const result: TextLayer[] = [];
  document.pages.forEach((_, pageIndex) => {
    const page = pageView(document, pageIndex);
    page.layers.forEach((layer, index) => {
      if (layer.type !== 'text' || !isShown(layer) || !layer.text.trim()) return;
      result.push({
        id: layer.id,
        text: layer.text,
        color: layer.opacity < 1 ? `${layer.color}${alphaHex(layer.opacity)}` : layer.color,
        background: backgroundBehind(page, index),
        fontSizePt: Math.round(layer.fontSize * pxPerUnit * PT_PER_CSS_PX * 10) / 10,
        bold: layer.fontWeight >= BOLD_WEIGHT,
        bounds: bounds(corners(layer)),
        ...(several ? { page: pageIndex + 1 } : {}),
      });
    });
  });
  return result;
}

// ── Entrada completa ─────────────────────────────────────────────────────

/**
 * Construye lo que necesita `verifyPiece`:
 *  - texto de la publicación (pie, hashtags, menciones y texto alternativo del documento);
 *  - límites de la red (de su especificación; sin especificación, todos desconocidos);
 *  - reglas de marca leídas del perfil;
 *  - capas de texto con colores, fondos y tamaños;
 *  - si hay imagen (hay capas visibles y la red admite texto alternativo) y de qué clase:
 *    `photo` si lleva alguna capa de imagen, `graphic` si es solo texto y formas.
 */
export function buildBrandCheckInput(
  document: ContentDocument,
  spec: NetworkFormatSpec | undefined,
  profile: ProfileLike | null | undefined,
  options: BuildInputOptions = {},
): BrandCheckInput {
  const shown = document.pages.flatMap((page) => page.layers).filter(isShown);
  const pageRange = pageLimits(spec);
  const altTextSupported = spec?.text.altTextSupported?.value !== false;
  const { copy } = document;
  const zone = safeZoneFor(spec, document.canvas);
  return {
    text: {
      caption: copy.caption,
      hashtags: copy.hashtags,
      mentions: copy.mentions,
      altText: copy.altText,
    },
    limits: limitsFromSpec(spec),
    brand: brandRulesFromProfile(profile),
    textLayers: textLayersFromDocument(document, options.viewportWidthPx),
    hasImage: shown.length > 0 && altTextSupported,
    imageKind: shown.length === 0 ? undefined : shown.some((l) => l.type === 'image') ? 'photo' : 'graphic',
    imagePalette: options.imagePalette,
    ...(zone ? { safeArea: { ...zone.safe, provenance: zone.provenance } } : {}),
    ...(spec ? { pages: { count: document.pages.length, ...pageRange } } : {}),
  };
}
