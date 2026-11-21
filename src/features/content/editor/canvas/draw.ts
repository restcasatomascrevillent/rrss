import type { Context } from 'konva/lib/Context';
import type { Shape } from 'konva/lib/Shape';
import { Text } from 'konva/lib/shapes/Text';
import { containBox, coverCrop } from '../geometry';
import type { BackdropSpec, NodeSpec, ShadowSpec } from './nodes';
import { traceSticker } from './stickers';

// Dibujo de cada tipo de nodo, común al lienzo del editor (`scene.ts`) y a la
// exportación (`exporter.ts`): así lo que se exporta se dibuja con el mismo
// código que lo que se ve. Sin estado ni interacción.

/**
 * Una imagen lista para dibujar (la foto tal cual o ya editada y preparada, ver
 * imageEffects/prepare.ts), 'error' si falló, o undefined si aún no se ha pedido.
 */
export type LoadedImage = HTMLImageElement | HTMLCanvasElement | 'error' | undefined;
type Drawable = HTMLImageElement | HTMLCanvasElement;

const isDrawable = (image: LoadedImage): image is Drawable =>
  image instanceof HTMLImageElement ? image.naturalWidth > 0 : image instanceof HTMLCanvasElement && image.width > 0;

const naturalSize = (image: Drawable) =>
  image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };

/** `#RRGGBB` y opacidad → `rgba(...)`. */
export function rgba(hex: string, opacity: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const alpha = Math.min(1, Math.max(0, opacity));
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** Atributos de sombra de Konva (que ya los escala con el zoom y la densidad de la pantalla). */
function shadowAttrs(shadow: ShadowSpec | null) {
  return shadow
    ? {
        shadowEnabled: true,
        shadowColor: shadow.color,
        shadowBlur: shadow.blur,
        shadowOffsetX: shadow.offsetX,
        shadowOffsetY: shadow.offsetY,
        shadowOpacity: shadow.opacity,
      }
    : { shadowEnabled: false };
}

type TextSpec = Extract<NodeSpec, { kind: 'text' }>;

/** Función de dibujo propia de los textos, la que usa Konva por defecto. */
const textSceneFunc = (Text.prototype as unknown as { _sceneFunc(context: Context): void })._sceneFunc;

/** Camino de un rectángulo con esquinas redondeadas (sin depender de `roundRect`). */
function roundedRect(native: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  native.beginPath();
  native.moveTo(x + r, y);
  native.arcTo(x + w, y, x + w, y + h, r);
  native.arcTo(x + w, y + h, x, y + h, r);
  native.arcTo(x, y + h, x, y, r);
  native.arcTo(x, y, x + w, y, r);
  native.closePath();
}

/**
 * Fondo del texto: un rectángulo con margen alrededor de las líneas escritas
 * (no de toda la caja), colocado según la alineación. Se dibuja antes de las letras.
 */
function drawTextBackground(context: Context, shape: Shape, spec: TextSpec): void {
  const background = spec.background;
  const lines = (shape as unknown as { textArr?: { width: number }[] }).textArr;
  if (!background || !lines || lines.length === 0 || spec.text.trim() === '') return;
  const textWidth = Math.max(...lines.map((line) => line.width));
  const textHeight = lines.length * spec.fontSize * spec.lineHeight;
  const boxWidth = shape.width();
  const left = spec.align === 'left' ? 0 : spec.align === 'right' ? boxWidth - textWidth : (boxWidth - textWidth) / 2;
  const native = context._context;
  native.save();
  native.globalAlpha *= background.opacity;
  native.fillStyle = background.color;
  roundedRect(
    native,
    left - background.padding,
    -background.padding,
    textWidth + background.padding * 2,
    textHeight + background.padding * 2,
    background.radius,
  );
  native.fill();
  native.restore();
}

/** Atributos de Konva que corresponden a la descripción del nodo. */
export function applySpecAttrs(node: Shape, spec: NodeSpec): void {
  node.setAttrs({
    ...spec.box,
    scaleX: 1,
    scaleY: 1,
    opacity: spec.opacity,
    visible: spec.visible,
    draggable: spec.editable,
  });
  if (spec.kind === 'text') {
    node.setAttrs({
      text: spec.text,
      fontFamily: spec.fontFamily,
      fontSize: spec.fontSize,
      fontStyle: spec.fontStyle,
      fill: spec.fill,
      align: spec.align,
      lineHeight: spec.lineHeight,
      wrap: 'word',
      verticalAlign: 'top',
      // El contorno se dibuja por detrás de las letras: así solo se ve la mitad de fuera
      // y se dobla el grosor para que mida lo que dice el panel.
      stroke: spec.outline?.color,
      strokeWidth: spec.outline ? spec.outline.width * 2 : 0,
      strokeEnabled: Boolean(spec.outline),
      fillAfterStrokeEnabled: true,
      lineJoin: 'round',
      ...shadowAttrs(spec.shadow),
      sceneFunc: spec.background
        ? function (this: Shape, context: Context) {
            drawTextBackground(context, this, spec);
            textSceneFunc.call(this, context);
          }
        : undefined,
    });
  } else if (spec.kind === 'rect') {
    node.setAttrs({
      fill: spec.fill ?? undefined,
      stroke: spec.stroke?.color,
      strokeWidth: spec.stroke?.width ?? 0,
      strokeEnabled: Boolean(spec.stroke),
      cornerRadius: spec.cornerRadius,
      ...shadowAttrs(spec.shadow),
    });
  } else if (spec.kind === 'ellipse' || spec.kind === 'sticker') {
    node.setAttrs({
      fill: spec.fill ?? undefined,
      stroke: spec.stroke?.color,
      strokeWidth: spec.stroke?.width ?? 0,
      strokeEnabled: Boolean(spec.stroke),
      lineJoin: 'round',
      lineCap: 'round',
      ...shadowAttrs(spec.shadow),
    });
  }
}

/** Dibujo de las elipses, las figuras y las imágenes (con su recorte o su encaje). */
export function drawSpecShape(context: Context, shape: Shape, spec: NodeSpec, image: LoadedImage): void {
  const width = shape.width();
  const height = shape.height();
  if (spec.kind === 'ellipse') {
    context.beginPath();
    context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    context.closePath();
    context.fillStrokeShape(shape);
    return;
  }
  if (spec.kind === 'sticker') {
    traceSticker(context, spec.shape, width, height);
    context.fillStrokeShape(shape);
    return;
  }
  if (spec.kind !== 'image') return;
  if (isDrawable(image)) {
    const native = context._context;
    if (spec.backdrop) drawBackdrop(native, spec.backdrop, image, spec, width, height);
    native.save();
    if (spec.shadow) applyNativeShadow(native, spec.shadow);
    if (spec.blur > 0) {
      drawBlurredImage(native, image, spec.fit, spec.focus, spec.blur, width, height);
    } else {
      drawFitted(native, image, spec.fit, spec.focus, 0, 0, width, height);
    }
    native.restore();
    return;
  }
  // Marcador mientras la imagen no está (cargando, sin acceso o generación sin conectar).
  const native = context._context;
  native.save();
  native.fillStyle = 'rgba(148, 163, 184, 0.35)';
  native.fillRect(0, 0, width, height);
  native.strokeStyle = 'rgba(100, 116, 139, 0.8)';
  native.setLineDash([12, 8]);
  native.lineWidth = 2;
  native.strokeRect(1, 1, width - 2, height - 2);
  native.fillStyle = 'rgba(51, 65, 85, 0.9)';
  native.font = `${Math.max(14, Math.min(width, height) / 10)}px sans-serif`;
  native.textAlign = 'center';
  native.textBaseline = 'middle';
  const label = image === 'error' ? `${spec.placeholder} no disponible` : spec.placeholder;
  native.fillText(label, width / 2, height / 2, width * 0.9);
  native.restore();
}

/** Dibuja la imagen en una zona (`x`, `y`, `w`, `h`) llenándola (`cover`) o entera (`contain`). */
function drawFitted(
  target: CanvasRenderingContext2D,
  image: Drawable,
  fit: 'cover' | 'contain',
  focus: { x: number; y: number },
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const natural = naturalSize(image);
  if (fit === 'cover') {
    const crop = coverCrop(natural, { width: w, height: h }, focus);
    target.drawImage(image, crop.x, crop.y, crop.width, crop.height, x, y, w, h);
  } else {
    const box = containBox(natural, { width: w, height: h });
    target.drawImage(image, x + box.x, y + box.y, box.width, box.height);
  }
}

/**
 * Sombra de lo que se ve de la foto (su silueta). La del lienzo no se escala
 * con el zoom ni con la resolución de exportación, así que se multiplica por la
 * escala del contexto: sale igual en el editor ampliado y al exportar.
 */
function applyNativeShadow(native: CanvasRenderingContext2D, shadow: ShadowSpec): void {
  const scale = contextScale(native);
  native.shadowColor = rgba(shadow.color, shadow.opacity);
  native.shadowBlur = shadow.blur * scale;
  native.shadowOffsetX = shadow.offsetX * scale;
  native.shadowOffsetY = shadow.offsetY * scale;
}

/** Fondo de una imagen: color, degradado o la propia foto desenfocada llenando la caja. */
function drawBackdrop(
  native: CanvasRenderingContext2D,
  backdrop: BackdropSpec,
  image: Drawable,
  spec: Extract<NodeSpec, { kind: 'image' }>,
  width: number,
  height: number,
): void {
  native.save();
  if (backdrop.kind === 'color') {
    native.fillStyle = backdrop.color;
    native.fillRect(0, 0, width, height);
  } else if (backdrop.kind === 'gradient') {
    // 0° = de arriba abajo, 90° = de izquierda a derecha.
    const angle = (backdrop.angle * Math.PI) / 180;
    const dx = Math.sin(angle);
    const dy = Math.cos(angle);
    const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    const gradient = native.createLinearGradient(
      width / 2 - dx * half,
      height / 2 - dy * half,
      width / 2 + dx * half,
      height / 2 + dy * half,
    );
    gradient.addColorStop(0, backdrop.from);
    gradient.addColorStop(1, backdrop.to);
    native.fillStyle = gradient;
    native.fillRect(0, 0, width, height);
  } else {
    drawBlurredImage(native, image, 'cover', spec.focus, backdrop.radius, width, height);
  }
  native.restore();
}

/** Escala del contexto respecto a las unidades del lienzo (zoom del editor × densidad de la pantalla). */
function contextScale(native: CanvasRenderingContext2D): number {
  const matrix = typeof native.getTransform === 'function' ? native.getTransform() : null;
  return matrix ? Math.hypot(matrix.a, matrix.b) || 1 : 1;
}

/** ¿Admite el navegador `filter` en el lienzo 2D? (Safari antiguo no.) */
function supportsCanvasFilter(native: CanvasRenderingContext2D): boolean {
  return typeof native.filter === 'string';
}

/**
 * Imagen desenfocada dentro de su caja. El desenfoque oscurece y transparenta
 * los bordes; para que no se note, la imagen se dibuja un poco más grande que
 * la caja (el doble del radio por cada lado) y se recorta a la caja.
 *
 * El radio va en unidades del lienzo; el filtro del navegador trabaja en
 * píxeles reales, así que se multiplica por la escala del contexto (el mismo
 * dibujo vale para el editor ampliado y para la exportación a 2160 px). Sin
 * `filter` (Safari antiguo), se aproxima reduciendo y volviendo a ampliar.
 */
function drawBlurredImage(
  native: CanvasRenderingContext2D,
  image: Drawable,
  fit: 'cover' | 'contain',
  focus: { x: number; y: number },
  radius: number,
  width: number,
  height: number,
): void {
  const margin = radius * 2;
  const outer = { width: width + margin * 2, height: height + margin * 2 };
  native.save();
  native.beginPath();
  native.rect(0, 0, width, height);
  native.clip();
  const scale = contextScale(native);
  if (supportsCanvasFilter(native)) {
    native.filter = `blur(${Math.max(0.5, radius * scale).toFixed(2)}px)`;
    drawFitted(native, image, fit, focus, -margin, -margin, outer.width, outer.height);
  } else {
    // Aproximación: a 1/(radio) del tamaño y de vuelta, con suavizado.
    const factor = Math.max(1, radius * scale);
    const small = window.document.createElement('canvas');
    small.width = Math.max(1, Math.round((outer.width * scale) / factor));
    small.height = Math.max(1, Math.round((outer.height * scale) / factor));
    const smallContext = small.getContext('2d');
    if (smallContext) {
      drawFitted(smallContext, image, fit, focus, 0, 0, small.width, small.height);
      native.imageSmoothingEnabled = true;
      native.drawImage(small, -margin, -margin, outer.width, outer.height);
    }
  }
  native.restore();
}
