import {
  clampPageIndex,
  MAX_LAYERS,
  pageView,
  validateDocument,
  type Canvas,
  type ContentDocument,
  type DocumentIssue,
  type ImageLayer,
  type Layer,
  type PageView,
  type TextLayer,
} from '../document';
import { dropLoneGroups } from '../editor/arrange';
import { applyLayerPatch, type LayerPatch } from '../editor/history';
import { FALLBACK_FONTS, newImageLayer, newLayerId, newLogoLayer } from '../editor/layers';
import { backdropAt, contrastOf, legibleTextColor, type CopilotBrandColor } from './legibility';
import {
  COPILOT_MOVE_STEP,
  type CopilotAlign,
  type CopilotOperation,
  type CopilotPosition,
  type CopilotTextStyle,
} from './operations';

// Aplica las operaciones del copiloto por voz al documento, de forma pura y
// determinista: la IA dice QUÉ (un texto de título arriba, la foto de fondo
// difuminada), y aquí se decide DÓNDE y CÓMO con las tipografías y colores del
// perfil de marca (el color de un texto, por el uso de cada color y legible
// sobre lo que tiene debajo: ver legibility.ts). El resultado se valida con el esquema del documento; si no
// cumple, no se aplica nada. El editor lo mete en el historial como UN paso de
// deshacer (acción `replace`).

/** Desenfoque cuando se pide difuminar sin decir cuánto. */
export const DEFAULT_BLUR = 40;

export type { CopilotBrandColor } from './legibility';

export interface CopilotBrandStyle {
  /** Colores del perfil, en su orden, con su uso («Principal», «fondo», «texto»…). */
  palette: CopilotBrandColor[];
  /** Tipografías del perfil, en su orden (la primera, para títulos). */
  fonts: string[];
}

export interface CopilotAssetInfo {
  id: string;
  name: string;
  width?: number | null;
  height?: number | null;
}

export interface CopilotApplyContext {
  brand: CopilotBrandStyle;
  /** Fotos y logotipos conocidos (nombre y medidas), por id. */
  assets: ReadonlyMap<string, CopilotAssetInfo>;
  /** Logotipos del perfil, en su orden. */
  logoIds: readonly string[];
  /**
   * Tono medio (#RRGGBB) de las fotos ya analizadas, por id de recurso. Una
   * foto sin tono conocido se supone media oscura (ver legibility.ts).
   */
  imageTones?: ReadonlyMap<string, string>;
  /** Página sobre la que actúa (la activa del editor). Por omisión, la primera. */
  pageIndex?: number;
}

export type CopilotApplyResult =
  | {
      ok: true;
      document: ContentDocument;
      /** Lo hecho, en palabras, para la persona. */
      changes: string[];
      /** Lo que no se ha podido hacer, con su motivo. */
      skipped: string[];
      /** Capas nuevas o tocadas, para dejarlas elegidas. */
      touched: string[];
    }
  | { ok: false; issues: DocumentIssue[] };

const TEXT_SIZE: Record<CopilotTextStyle, { size: number; weight: number }> = {
  title: { size: 0.085, weight: 700 },
  subtitle: { size: 0.06, weight: 600 },
  body: { size: 0.045, weight: 400 },
  small: { size: 0.035, weight: 400 },
};
const SLOT: Record<CopilotPosition, number> = { top: 0.05, upper: 0.2, middle: 0.4, lower: 0.62, bottom: 0.82 };
const LINE_HEIGHT = 1.25;
/** Ancho medio de un carácter respecto al cuerpo de letra (para estimar cuántas líneas ocupa un texto). */
const GLYPH = 0.55;
const SIDE = 0.08;

/** ¿Cubre la imagen todo el lienzo? Es la «foto de fondo». */
function coversCanvas(layer: Layer, canvas: Canvas): boolean {
  return layer.x <= 1 && layer.y <= 1 && layer.x + layer.width >= canvas.width - 1 && layer.y + layer.height >= canvas.height - 1;
}

/** La foto de fondo: la imagen más al fondo que cubre todo el lienzo. */
export function backgroundImageOf(document: Pick<PageView, 'canvas' | 'layers'>): ImageLayer | null {
  const found = document.layers.find((layer) => layer.type === 'image' && coversCanvas(layer, document.canvas));
  return (found as ImageLayer | undefined) ?? null;
}

/** ¿Hay alguna orden que pide una foto sin decir cuál? (el editor abre el selector). */
export function needsPhotoPick(operations: CopilotOperation[]): boolean {
  return operations.some((op) => op.op === 'set_background_image' && op.assetId === null);
}

/** Rellena «esta foto» con la elegida. */
export function withPickedPhoto(operations: CopilotOperation[], assetId: string | null): CopilotOperation[] {
  return operations.flatMap((op) => {
    if (op.op !== 'set_background_image' || op.assetId !== null) return [op];
    return assetId ? [{ ...op, assetId }] : [];
  });
}

function textBox(canvas: Canvas, text: string, fontSize: number) {
  const width = Math.round(canvas.width * (1 - SIDE * 2));
  const perLine = Math.max(1, Math.floor(width / (fontSize * GLYPH)));
  const lines = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return { width, height: Math.round(lines * fontSize * LINE_HEIGHT) };
}

function xFor(canvas: Canvas, width: number, align: CopilotAlign | null): number {
  if (align === 'left') return Math.round(canvas.width * SIDE);
  if (align === 'right') return Math.round(canvas.width - width - canvas.width * SIDE);
  return Math.round((canvas.width - width) / 2);
}

const overlapsY = (a: { y: number; height: number }, b: { y: number; height: number }) =>
  a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Altura para un texto nuevo: la de su posición o, sin posición, debajo del
 * último texto. Si choca con otro texto o logotipo, baja hasta dejar sitio.
 */
function placeY(document: Pick<PageView, 'canvas' | 'layers'>, height: number, position: CopilotPosition | null, after: Layer | null) {
  const { canvas } = document;
  const gap = Math.round(canvas.height * 0.02);
  let y = position ? Math.round(canvas.height * SLOT[position]) : after ? after.y + after.height + gap : Math.round(canvas.height * SLOT.upper);
  const others = document.layers.filter((layer) => layer.type === 'text' || layer.type === 'logo');
  for (let guard = 0; guard < others.length; guard += 1) {
    const hit = others.find((layer) => overlapsY({ y, height }, layer));
    if (!hit) break;
    y = hit.y + hit.height + gap;
  }
  return Math.max(0, Math.min(y, canvas.height - height - gap));
}

const isHeading = (style: CopilotTextStyle) => style === 'title' || style === 'subtitle';

function fontFor(brand: CopilotBrandStyle, style: CopilotTextStyle) {
  return (isHeading(style) ? brand.fonts[0] : (brand.fonts[1] ?? brand.fonts[0])) ?? FALLBACK_FONTS[0]!;
}

/** Un texto ya puesto «es de título» si va en negrita (los títulos y subtítulos del copiloto van a 600 o más). */
const looksHeading = (layer: TextLayer) => layer.fontWeight >= 600;

const layerName = (layer: Layer) =>
  layer.type === 'text' ? `«${layer.text.split('\n')[0]!.slice(0, 40)}»` : layer.name || 'la capa';

/**
 * Aplica las operaciones en orden sobre una copia de UNA página del documento
 * (`context.pageIndex`, la activa del editor) y valida el documento entero. Las
 * demás páginas no se tocan; el color de fondo del lienzo es común a todas.
 */
export function applyCopilotOperations(
  input: ContentDocument,
  operations: CopilotOperation[],
  context: CopilotApplyContext,
): CopilotApplyResult {
  const pageIndex = clampPageIndex(input, context.pageIndex ?? 0);
  const start = pageView(input, pageIndex);
  let document: PageView = { ...start, canvas: { ...start.canvas }, layers: [...start.layers] };
  // Las capas nuevas no repiten identificador con las de otras páginas.
  const otherLayers = input.pages.flatMap((page, index) => (index === pageIndex ? [] : page.layers));
  const taken = () => [...otherLayers, ...document.layers];
  const changes: string[] = [];
  const skipped: string[] = [];
  const touched = new Set<string>();
  let lastText: Layer | null = null;
  /** Textos con el color dictado en esta orden: ese color se respeta. */
  const dictatedColor = new Set<string>();

  const find = (id: string | null) => (id ? (document.layers.find((layer) => layer.id === id) ?? null) : null);
  const replaceLayer = (next: Layer) => {
    document = { ...document, layers: document.layers.map((layer) => (layer.id === next.id ? next : layer)) };
    touched.add(next.id);
  };
  const patch = (layer: Layer, change: LayerPatch) => replaceLayer(applyLayerPatch(layer, change));
  const add = (layer: Layer, atBottom = false) => {
    if (document.layers.length >= MAX_LAYERS) {
      skipped.push(`No caben más capas (máximo ${MAX_LAYERS}).`);
      return false;
    }
    document = { ...document, layers: atBottom ? [layer, ...document.layers] : [...document.layers, layer] };
    touched.add(layer.id);
    return true;
  };
  const { canvas } = document;

  /**
   * Tras cambiar el fondo, los textos sin color dictado en esta orden que ya no
   * se leen pasan a un color legible (el de la marca por su uso, el más legible
   * de la marca, o blanco o negro). Los bloqueados no se tocan.
   */
  const keepTextsReadable = () => {
    document.layers.forEach((layer, index) => {
      if (layer.type !== 'text' || layer.locked || dictatedColor.has(layer.id)) return;
      const backdrop = backdropAt(document.canvas, document.layers.slice(0, index), layer, context.imageTones);
      if (contrastOf(layer.color, backdrop.hex) >= backdrop.required) return;
      const color = legibleTextColor(context.brand.palette, looksHeading(layer), backdrop);
      if (color === layer.color.toUpperCase()) return;
      patch(layer, { color });
      changes.push(`Texto ${layerName(layer)} en ${color} para que se lea sobre el fondo`);
    });
  };

  for (const op of operations) {
    switch (op.op) {
      case 'set_background_image': {
        const asset = op.assetId ? context.assets.get(op.assetId) : undefined;
        if (!op.assetId) {
          skipped.push('Falta elegir la foto de fondo.');
          break;
        }
        const name = asset?.name ?? 'Foto de fondo';
        const blur = op.blur ?? undefined;
        const current = backgroundImageOf(document);
        if (current) {
          patch(current, {
            source: { kind: 'asset', assetId: op.assetId },
            name: name.slice(0, 120),
            ...(op.blur !== null ? { blur } : {}),
          });
        } else {
          const layer = newImageLayer(canvas, taken(), { id: op.assetId, name });
          if (!add(blur ? { ...layer, blur } : layer, true)) break;
        }
        changes.push(op.blur ? `Foto de fondo «${name}», difuminada (${op.blur} %)` : `Foto de fondo «${name}»`);
        keepTextsReadable();
        break;
      }
      case 'blur_image': {
        const layer = op.target ? find(op.target) : backgroundImageOf(document);
        if (!layer || layer.type !== 'image') {
          skipped.push('No hay ninguna foto que desenfocar.');
          break;
        }
        if (layer.locked) {
          skipped.push(`${layerName(layer)} está bloqueada.`);
          break;
        }
        const blur = op.blur ?? DEFAULT_BLUR;
        patch(layer, { blur });
        changes.push(blur > 0 ? `Desenfoque de la foto: ${blur} %` : 'Foto nítida');
        break;
      }
      case 'add_logo': {
        const id = op.assetId ?? context.logoIds[0];
        if (!id) {
          skipped.push('La marca no tiene logotipos en su perfil.');
          break;
        }
        const asset = context.assets.get(id) ?? { id, name: 'Logotipo' };
        const base = newLogoLayer(canvas, taken(), asset);
        const margin = Math.round(Math.min(canvas.width, canvas.height) * 0.05);
        let { x, y } = base;
        if (op.position || op.align) {
          x = xFor(canvas, base.width, op.align ?? 'center');
          if (op.align === 'left' || op.align === 'right') x = op.align === 'left' ? margin : canvas.width - base.width - margin;
          y =
            op.position === 'top' || op.position === 'upper'
              ? margin
              : op.position === 'middle'
                ? Math.round((canvas.height - base.height) / 2)
                : canvas.height - base.height - margin;
        }
        // Que no pise un texto: si choca, se reduce (hasta la mitad, sin deformar)
        // hacia su borde para caber en el hueco; si ni así, se pone y se avisa.
        let { width, height } = base;
        const clashWith = () =>
          document.layers.find(
            (l) => l.type === 'text' && l.visible && x < l.x + l.width && l.x < x + width && y < l.y + l.height && l.y < y + height,
          );
        let clash = clashWith();
        if (clash) {
          const gap = Math.round(canvas.height * 0.02);
          const onTop = y + height / 2 < clash.y + clash.height / 2;
          const room = onTop ? clash.y - gap - y : y + height - (clash.y + clash.height + gap);
          if (room >= height / 2) {
            const scale = room / height;
            const centerX = x + width / 2;
            if (!onTop) y += height - Math.round(height * scale);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
            if (op.align === 'right') x += base.width - width;
            else if (op.align !== 'left') x = Math.round(centerX - width / 2);
            clash = clashWith();
          }
        }
        const anchorY = y < canvas.height / 3 ? 'top' : y > (canvas.height * 2) / 3 ? 'bottom' : 'center';
        const anchorX = op.align === 'left' ? 'left' : op.align === 'right' ? 'right' : op.position ? 'center' : 'right';
        if (add({ ...base, x, y, width, height, anchor: { x: anchorX, y: anchorY } })) {
          changes.push(width < base.width ? 'Logotipo de la marca (más pequeño, para no pisar el texto)' : 'Logotipo de la marca');
          if (clash) skipped.push(`El logotipo pisa ${layerName(clash)}: muévelo o quita ese texto.`);
        }
        break;
      }
      case 'add_text': {
        if (!op.text) break;
        const style = op.style ?? 'body';
        const fontSize = Math.round(Math.min(canvas.width, canvas.height) * TEXT_SIZE[style].size);
        const box = textBox(canvas, op.text, fontSize);
        const y = placeY(document, box.height, op.position, lastText);
        const x = xFor(canvas, box.width, null);
        const color =
          op.color ??
          legibleTextColor(
            context.brand.palette,
            isHeading(style),
            backdropAt(document.canvas, document.layers, { x, y, width: box.width, height: box.height }, context.imageTones),
          );
        const layer: TextLayer = {
          id: newLayerId(taken()),
          type: 'text',
          name: '',
          x,
          y,
          width: box.width,
          height: box.height,
          rotation: 0,
          opacity: 1,
          visible: true,
          locked: false,
          anchor: { x: 'center', y: y < canvas.height / 3 ? 'top' : y > (canvas.height * 2) / 3 ? 'bottom' : 'center' },
          text: op.text,
          fontFamily: op.font ?? fontFor(context.brand, style),
          fontSize,
          fontWeight: TEXT_SIZE[style].weight,
          italic: false,
          color,
          align: op.align ?? 'center',
          lineHeight: LINE_HEIGHT,
        };
        if (add(layer)) {
          lastText = layer;
          if (op.color) dictatedColor.add(layer.id);
          changes.push(`Texto ${layerName(layer)}`);
        }
        break;
      }
      case 'update_text': {
        const layer = find(op.target);
        if (!layer || layer.type !== 'text') {
          skipped.push('No se encuentra el texto que hay que cambiar.');
          break;
        }
        if (layer.locked) {
          skipped.push(`${layerName(layer)} está bloqueado.`);
          break;
        }
        const change: LayerPatch = {};
        if (op.text) {
          change.text = op.text;
          change.height = Math.max(layer.height, textBox(canvas, op.text, layer.fontSize).height);
        }
        if (op.style) {
          change.fontSize = Math.round(Math.min(canvas.width, canvas.height) * TEXT_SIZE[op.style].size);
          change.fontWeight = TEXT_SIZE[op.style].weight;
        }
        if (op.color) {
          change.color = op.color;
          dictatedColor.add(layer.id);
        }
        if (op.font) change.fontFamily = op.font;
        if (op.align) change.align = op.align;
        patch(layer, change);
        changes.push(`Cambiado el texto ${layerName(layer)}`);
        break;
      }
      case 'move_layer': {
        const layer = find(op.target);
        if (!layer || layer.locked) {
          skipped.push(layer ? `${layerName(layer)} está bloqueada.` : 'No se encuentra la capa que hay que mover.');
          break;
        }
        // En cada eje: a un sitio concreto o, si no, unos pasos (5 % del lienzo cada uno), sin salirse.
        const clampY = (y: number) => Math.round(Math.min(Math.max(y, 0), Math.max(0, canvas.height - layer.height)));
        const clampX = (x: number) => Math.round(Math.min(Math.max(x, 0), Math.max(0, canvas.width - layer.width)));
        const change: LayerPatch = {};
        if (op.position) change.y = clampY(canvas.height * SLOT[op.position]);
        else if (op.dy) change.y = clampY(layer.y + op.dy * COPILOT_MOVE_STEP * canvas.height);
        if (op.align) change.x = xFor(canvas, layer.width, op.align);
        else if (op.dx) change.x = clampX(layer.x + op.dx * COPILOT_MOVE_STEP * canvas.width);
        if ((change.y === undefined || change.y === layer.y) && (change.x === undefined || change.x === layer.x)) {
          skipped.push(
            op.dx || op.dy ? `${layerName(layer)} ya está en el borde.` : `${layerName(layer)} ya está ahí.`,
          );
          break;
        }
        patch(layer, change);
        changes.push(`Movida ${layerName(layer)}`);
        break;
      }
      case 'remove_layer': {
        const layer = find(op.target);
        if (!layer || layer.locked) {
          skipped.push(layer ? `${layerName(layer)} está bloqueada.` : 'No se encuentra la capa que hay que quitar.');
          break;
        }
        document = { ...document, layers: dropLoneGroups(document.layers.filter((l) => l.id !== layer.id)) };
        touched.delete(layer.id);
        changes.push(`Quitada ${layerName(layer)}`);
        break;
      }
      case 'set_background_color': {
        if (!op.color) break;
        document = { ...document, canvas: { ...document.canvas, backgroundColor: op.color.toUpperCase() } };
        changes.push(`Color de fondo ${op.color.toUpperCase()}`);
        keepTextsReadable();
        break;
      }
    }
  }

  const merged: ContentDocument = {
    ...input,
    canvas: document.canvas,
    pages: input.pages.map((page, index) => (index === pageIndex ? { ...page, layers: document.layers } : page)),
  };
  const checked = validateDocument(merged);
  if (!checked.ok) return { ok: false, issues: checked.issues };
  const present = new Set(checked.document.pages[pageIndex]!.layers.map((layer) => layer.id));
  return {
    ok: true,
    document: checked.document,
    changes,
    skipped,
    touched: [...touched].filter((id) => present.has(id)),
  };
}
