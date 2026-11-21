import Konva from 'konva/lib/Core';
import type { Context } from 'konva/lib/Context';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Shape } from 'konva/lib/Shape';
import { Line } from 'konva/lib/shapes/Line';
import { Rect } from 'konva/lib/shapes/Rect';
import { Text } from 'konva/lib/shapes/Text';
import { Transformer } from 'konva/lib/shapes/Transformer';
import type { Rect as Bounds } from '../../safeZones';
import { layersInRect, normalizeRect, snapBox, snapTargets } from '../arrange';
import { layerToNodeBox, nodeToLayerBox, type Guides } from '../geometry';
import type { LayerPatch } from '../history';
import { ImageStore } from './imageStore';
import { editKey, editNeedsPixels } from '../imageEffects/imageEdit';
import { BitmapCache, EDITOR_BITMAP_SIDE, prepareBitmap } from '../imageEffects/prepare';
import { applySpecAttrs, drawSpecShape, type LoadedImage } from './draw';
import type { NodeSpec } from './nodes';
import type { SafeZoneOverlay, SelectOptions } from './types';

// Dibujo con Konva, sin React. Recibe la descripción plana de cada capa
// (nodes.ts) y crea o actualiza sus nodos; de vuelta, informa de lo que hace la
// persona (seleccionar, arrastrar, transformar) como cambios del documento.
// No guarda estado propio del documento: cada `render` deja los nodos igual que
// la descripción que recibe.

export interface SceneCallbacks {
  onSelect: (id: string | null, options?: SelectOptions) => void;
  onSelectMany: (ids: string[], additive: boolean) => void;
  onChange: (changes: { id: string; patch: LayerPatch }[]) => void;
  onEditText: (id: string) => void;
}

export interface SceneInput {
  nodes: NodeSpec[];
  canvas: { width: number; height: number; backgroundColor: string };
  selectedIds: string[];
  /** Texto que se edita encima del lienzo: su nodo no se dibuja mientras tanto. */
  editingId: string | null;
  safeZone: SafeZoneOverlay | null;
  readOnly: boolean;
  /** Escala de pantalla: píxeles por unidad del lienzo. */
  scale: number;
}

type AnyNode = Shape;

const SELECTION = '#2563EB';
const GUIDE = '#EC4899';
const UNSAFE = 'rgba(220, 38, 38, 0.18)';
const UNSAFE_LINE = 'rgba(220, 38, 38, 0.85)';

const boxOf = (node: AnyNode) =>
  nodeToLayerBox({
    x: node.x(),
    y: node.y(),
    width: node.width(),
    height: node.height(),
    rotation: node.rotation(),
    scaleX: node.scaleX(),
    scaleY: node.scaleY(),
  });

const specBox = (spec: NodeSpec) => ({
  x: spec.box.x - spec.box.offsetX,
  y: spec.box.y - spec.box.offsetY,
  width: spec.box.width,
  height: spec.box.height,
  rotation: spec.box.rotation,
});

const withModifier = (event: KonvaEventObject<MouseEvent | TouchEvent>) => {
  const native = event.evt as MouseEvent;
  return Boolean(native.shiftKey || native.ctrlKey || native.metaKey);
};

export class Scene {
  private stage: Konva.Stage;
  private background: Rect;
  private content: Konva.Layer;
  private overlay: Konva.Layer;
  private transformer: Transformer;
  private guides: Line[] = [];
  private zone: Konva.Shape[] = [];
  private marquee: Rect;
  private marqueeStart: { x: number; y: number; additive: boolean } | null = null;
  private nodes = new Map<string, AnyNode>();
  private specs = new Map<string, NodeSpec>();
  private images = new ImageStore(() => this.content.batchDraw());
  private bitmaps = new BitmapCache();
  private input: SceneInput | null = null;
  private pendingEmit = false;

  constructor(
    container: HTMLDivElement,
    private readonly callbacks: SceneCallbacks,
  ) {
    this.stage = new Konva.Stage({ container, width: 1, height: 1 });
    this.content = new Konva.Layer();
    this.overlay = new Konva.Layer();
    this.background = new Rect({ x: 0, y: 0, name: 'background' });
    this.content.add(this.background);
    this.transformer = new Transformer({
      rotateEnabled: true,
      keepRatio: false,
      flipEnabled: false,
      borderStroke: SELECTION,
      anchorStroke: SELECTION,
      anchorSize: 10,
      rotationSnaps: [0, 45, 90, 135, 180, 225, 270, 315],
      boundBoxFunc: (oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox),
    });
    // Konva avisa del final de la transformación al transformador y a cada nodo:
    // se escucha solo aquí para mandar un único cambio con todas las capas.
    this.transformer.on('transformend', () => this.emitNodes(this.transformer.nodes() as AnyNode[]));
    this.marquee = new Rect({
      visible: false,
      fill: 'rgba(37, 99, 235, 0.08)',
      stroke: SELECTION,
      dash: [6, 4],
      listening: false,
    });
    this.overlay.add(this.transformer, this.marquee);
    this.stage.add(this.content, this.overlay);

    // En el vacío o en el fondo: rectángulo de selección; un clic sin arrastrar quita la selección.
    this.stage.on('mousedown touchstart', (event) => {
      if (event.target !== this.stage && event.target !== this.background) return;
      const point = this.pointer();
      if (!point) return;
      this.marqueeStart = { ...point, additive: withModifier(event) };
    });
    this.stage.on('mousemove touchmove', () => {
      if (!this.marqueeStart) return;
      const point = this.pointer();
      if (!point) return;
      const rect = normalizeRect(this.marqueeStart, point);
      const strokeWidth = 1 / Math.max(this.input?.scale ?? 1, 0.05);
      this.marquee.setAttrs({
        visible: true,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        strokeWidth,
        dash: [6 * strokeWidth, 4 * strokeWidth],
      });
      this.overlay.batchDraw();
    });
    this.stage.on('mouseup touchend', () => this.finishMarquee());
  }

  render(input: SceneInput): void {
    this.input = input;
    const { canvas, scale } = input;
    this.stage.size({ width: Math.round(canvas.width * scale), height: Math.round(canvas.height * scale) });
    this.stage.scale({ x: scale, y: scale });
    this.background.setAttrs({ width: canvas.width, height: canvas.height, fill: canvas.backgroundColor });

    const seen = new Set<string>();
    input.nodes.forEach((spec, index) => {
      seen.add(spec.id);
      let node = this.nodes.get(spec.id);
      const previous = this.specs.get(spec.id);
      if (!node || !previous || previous.kind !== spec.kind) {
        node?.destroy();
        node = this.create(spec);
        this.nodes.set(spec.id, node);
        this.content.add(node);
      }
      this.specs.set(spec.id, spec);
      this.apply(node, spec);
      // Mientras se edita encima, el texto del lienzo no se ve (lo sustituye el campo).
      if (spec.id === input.editingId) node.visible(false);
      // El fondo ocupa la posición 0.
      node.zIndex(index + 1);
    });
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.destroy();
        this.nodes.delete(id);
        this.specs.delete(id);
      }
    }

    this.renderSelection(input);
    this.renderSafeZone(input);
    this.content.batchDraw();
    this.overlay.batchDraw();
  }

  destroy(): void {
    this.stage.destroy();
    this.nodes.clear();
    this.specs.clear();
    this.bitmaps.clear();
    this.images.destroy();
  }

  // ── Selección y zona segura ────────────────────────────────────────────

  private renderSelection(input: SceneInput): void {
    const chosen = input.selectedIds
      .filter((id) => id !== input.editingId)
      .flatMap((id) => {
        const node = this.nodes.get(id);
        const spec = this.specs.get(id);
        return node && spec?.visible ? [{ node, spec }] : [];
      });
    // Con varias, las bloqueadas no entran en el transformador (no deben moverse con las demás).
    const attached = chosen.length > 1 ? chosen.filter((item) => item.spec.editable) : chosen;
    this.transformer.nodes(attached.map((item) => item.node));
    const editable = attached.length > 0 && attached.every((item) => item.spec.editable);
    this.transformer.setAttrs({
      resizeEnabled: editable,
      rotateEnabled: editable,
      borderDash: editable ? [] : [6, 4],
    });
  }

  private renderSafeZone(input: SceneInput): void {
    for (const shape of this.zone) shape.destroy();
    this.zone = [];
    if (!input.safeZone) return;
    const strokeWidth = 2 / Math.max(input.scale, 0.05);
    for (const rect of input.safeZone.unsafe) {
      this.zone.push(
        new Rect({
          x: rect.left,
          y: rect.top,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
          fill: UNSAFE,
          listening: false,
        }),
      );
    }
    const safe = input.safeZone.safe;
    this.zone.push(
      new Rect({
        x: safe.left,
        y: safe.top,
        width: safe.right - safe.left,
        height: safe.bottom - safe.top,
        stroke: UNSAFE_LINE,
        strokeWidth,
        dash: [8 * strokeWidth, 6 * strokeWidth],
        listening: false,
      }),
    );
    for (const shape of this.zone) {
      this.overlay.add(shape);
      shape.moveToBottom();
    }
  }

  // ── Nodos ──────────────────────────────────────────────────────────────

  private create(spec: NodeSpec): AnyNode {
    const node: AnyNode =
      spec.kind === 'text'
        ? new Text({ id: spec.id })
        : spec.kind === 'rect'
          ? new Rect({ id: spec.id })
          : new Konva.Shape({
              id: spec.id,
              sceneFunc: (context, shape) => this.drawShape(context, shape),
              hitFunc: (context, shape) => {
                context.beginPath();
                context.rect(0, 0, shape.width(), shape.height());
                context.closePath();
                context.fillStrokeShape(shape);
              },
            });

    node.on('mousedown touchstart', (event) => {
      const selected = this.input?.selectedIds ?? [];
      if (withModifier(event)) {
        // Con Mayúsculas no se arrastra: solo se añade o se quita de la selección.
        node.stopDrag();
        this.callbacks.onSelect(spec.id, { toggle: true });
      } else if (!selected.includes(spec.id)) {
        this.callbacks.onSelect(spec.id);
      }
    });
    node.on('dblclick dbltap', () => {
      if (this.specs.get(spec.id)?.kind === 'text' && this.specs.get(spec.id)?.editable) {
        this.callbacks.onEditText(spec.id);
      }
    });
    node.on('dragmove', () => this.snap(node));
    node.on('dragend', () => {
      this.clearGuides();
      const attached = this.transformer.nodes() as AnyNode[];
      // Con varias, Konva arrastra todas y avisa por cada una: un solo cambio con todas.
      this.emitNodes(attached.length > 1 && attached.includes(node) ? attached : [node]);
    });
    // Durante la transformación la escala se pasa a ancho y alto, para que el texto no se deforme.
    node.on('transform', () => {
      const next = layerToNodeBox(boxOf(node));
      node.setAttrs({ ...next, scaleX: 1, scaleY: 1 });
    });
    return node;
  }

  private apply(node: AnyNode, spec: NodeSpec): void {
    applySpecAttrs(node, spec);
  }

  private drawShape(context: Context, shape: Shape): void {
    const spec = this.specs.get(shape.id());
    if (!spec) return;
    drawSpecShape(context, shape, spec, this.imageFor(spec));
  }

  /** La foto de la capa: tal cual, o ya editada con el mismo código que usa la exportación. */
  private imageFor(spec: NodeSpec): LoadedImage {
    if (spec.kind !== 'image' || !spec.url) return undefined;
    const base = this.images.get(spec.url);
    if (!(base instanceof HTMLImageElement) || !spec.edit) return base;
    if (editNeedsPixels(spec.edit) && !this.images.isReadable(spec.url)) return base;
    const key = `${spec.url}|${editKey(spec.edit)}`;
    let bitmap = this.bitmaps.get(key);
    if (!bitmap) {
      try {
        bitmap = prepareBitmap(base, spec.edit, EDITOR_BITMAP_SIDE);
      } catch {
        // El navegador no deja leer la foto: se ve sin editar (la exportación avisará).
        return base;
      }
      this.bitmaps.set(key, bitmap);
    }
    return bitmap;
  }

  // ── Interacción ────────────────────────────────────────────────────────

  /** Manda las cajas de varios nodos como un solo cambio; si llegan varios avisos seguidos, solo el primero. */
  private emitNodes(nodes: AnyNode[]): void {
    if (nodes.length === 0 || this.pendingEmit) return;
    this.pendingEmit = true;
    queueMicrotask(() => {
      this.pendingEmit = false;
    });
    // Al soltar, la posición y el tamaño quedan en números enteros (sin 12,3456 en el panel).
    this.callbacks.onChange(
      nodes.map((node) => {
        const box = boxOf(node);
        return {
          id: node.id(),
          patch: {
            ...box,
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.max(1, Math.round(box.width)),
            height: Math.max(1, Math.round(box.height)),
          },
        };
      }),
    );
  }

  private pointer(): { x: number; y: number } | null {
    const point = this.stage.getPointerPosition();
    if (!point || !this.input) return null;
    const scale = Math.max(this.input.scale, 0.0001);
    return { x: point.x / scale, y: point.y / scale };
  }

  private finishMarquee(): void {
    const start = this.marqueeStart;
    this.marqueeStart = null;
    if (!start) return;
    const end = this.pointer() ?? start;
    this.marquee.visible(false);
    this.overlay.batchDraw();
    const rect: Bounds = normalizeRect(start, end);
    const dragged = rect.right - rect.left >= 4 || rect.bottom - rect.top >= 4;
    if (!dragged) {
      if (!start.additive) this.callbacks.onSelect(null);
      return;
    }
    const layers = [...this.specs.values()].map((spec) => ({
      id: spec.id,
      ...specBox(spec),
      visible: spec.visible,
      locked: !spec.editable,
    }));
    this.callbacks.onSelectMany(layersInRect(layers, rect), start.additive);
  }

  /**
   * Guías de ajuste mientras se arrastra una sola capa: se pega a los bordes y
   * al centro del lienzo y de las demás capas visibles. Con varias elegidas no
   * se ajusta (se mueven juntas tal cual).
   */
  private snap(node: AnyNode): void {
    if (!this.input || (this.transformer.nodes().length > 1 && this.transformer.nodes().includes(node))) return;
    const box = boxOf(node);
    const others = [...this.specs.values()].filter((spec) => spec.id !== node.id() && spec.visible).map(specBox);
    const threshold = 8 / Math.max(this.input.scale, 0.05);
    const snapped = snapBox(box, snapTargets(this.input.canvas, others), threshold);
    const center = layerToNodeBox({ ...box, x: box.x + snapped.dx, y: box.y + snapped.dy });
    node.position({ x: center.x, y: center.y });
    this.drawGuides(snapped.guides);
  }

  private drawGuides(guides: Guides): void {
    this.clearGuides(false);
    if (!this.input) return;
    const { width, height } = this.input.canvas;
    const strokeWidth = 1 / Math.max(this.input.scale, 0.05);
    for (const x of guides.vertical) {
      this.guides.push(new Line({ points: [x, 0, x, height], stroke: GUIDE, strokeWidth, dash: [6, 4] }));
    }
    for (const y of guides.horizontal) {
      this.guides.push(new Line({ points: [0, y, width, y], stroke: GUIDE, strokeWidth, dash: [6, 4] }));
    }
    for (const line of this.guides) this.overlay.add(line);
    this.overlay.batchDraw();
  }

  private clearGuides(draw = true): void {
    for (const line of this.guides) line.destroy();
    this.guides = [];
    if (draw) this.overlay.batchDraw();
  }
}
