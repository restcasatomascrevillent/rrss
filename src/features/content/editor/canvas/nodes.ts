import {
  allLayers,
  blurRadius,
  type ContentDocument,
  type Layer,
  type LayerShadow,
  type PageView,
  type ShapeKind,
} from '../../document';
import { layerToNodeBox, type NodeBox } from '../geometry';
import { editOf, type ImageEdit } from '../imageEffects/imageEdit';
import { isSticker, type StickerKind } from './stickers';

// Descripción plana, sin Konva, de lo que hay que dibujar por cada capa. Es la
// mitad «documento → nodos» de la traducción: `scene.ts` crea y actualiza los
// nodos de Konva a partir de esto. Al ser datos puros, se prueba sin lienzo y
// sirve igual al dibujo del servidor cuando llegue.

/** De dónde sale la dirección web de cada recurso de la biblioteca (por id). */
export type ImageLookup = ReadonlyMap<string, string>;

interface NodeCommon {
  id: string;
  box: NodeBox;
  opacity: number;
  visible: boolean;
  /** Se puede arrastrar y transformar (no está bloqueada y el editor no es de solo lectura). */
  editable: boolean;
}

/** Sombra lista para dibujar (medidas en unidades del lienzo). */
export type ShadowSpec = LayerShadow;

/** Fondo de una imagen, ya con el radio del desenfoque calculado para la caja de la capa. */
export type BackdropSpec =
  | { kind: 'color'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'blur'; radius: number };

export type NodeSpec =
  | (NodeCommon & {
      kind: 'text';
      text: string;
      fontFamily: string;
      fontSize: number;
      /** Como lo entiende Konva y el lienzo: «italic 700», «400»… */
      fontStyle: string;
      fill: string;
      align: 'left' | 'center' | 'right';
      lineHeight: number;
      outline: { color: string; width: number } | null;
      shadow: ShadowSpec | null;
      background: { color: string; opacity: number; padding: number; radius: number } | null;
    })
  | (NodeCommon & {
      kind: 'image';
      /** null si todavía no hay dirección (recurso sin cargar o generación de IA aún sin conectar). */
      url: string | null;
      fit: 'cover' | 'contain';
      focus: { x: number; y: number };
      /** Texto del marcador mientras no hay imagen. */
      placeholder: string;
      /** Radio del desenfoque en unidades del lienzo (0 = nítida). Ver `blurRadius`. */
      blur: number;
      /** Ajustes, giro y recorte de la foto; null si se dibuja tal cual. */
      edit: ImageEdit | null;
      backdrop: BackdropSpec | null;
      shadow: ShadowSpec | null;
    })
  | (NodeCommon & {
      kind: 'rect' | 'ellipse';
      fill: string | null;
      stroke: { color: string; width: number } | null;
      cornerRadius: number;
      shadow: ShadowSpec | null;
    })
  | (NodeCommon & {
      kind: 'sticker';
      shape: StickerKind;
      fill: string | null;
      stroke: { color: string; width: number } | null;
      shadow: ShadowSpec | null;
    });

export function fontStyleOf(weight: number, italic: boolean): string {
  return `${italic ? 'italic ' : ''}${weight}`;
}

export function describeLayer(layer: Layer, images: ImageLookup, readOnly = false): NodeSpec {
  const common: NodeCommon = {
    id: layer.id,
    box: layerToNodeBox(layer),
    opacity: layer.opacity,
    visible: layer.visible,
    editable: !readOnly && !layer.locked,
  };
  switch (layer.type) {
    case 'text':
      return {
        ...common,
        kind: 'text',
        text: layer.text,
        fontFamily: layer.fontFamily,
        fontSize: layer.fontSize,
        fontStyle: fontStyleOf(layer.fontWeight, layer.italic),
        fill: layer.color,
        align: layer.align,
        lineHeight: layer.lineHeight,
        outline: layer.outline ?? null,
        shadow: layer.shadow ?? null,
        background: layer.background ?? null,
      };
    case 'image':
      return {
        ...common,
        kind: 'image',
        url: layer.source.kind === 'asset' ? (images.get(layer.source.assetId) ?? null) : null,
        fit: layer.fit,
        focus: layer.focus,
        placeholder: layer.source.kind === 'asset' ? 'Imagen' : 'Imagen generada',
        blur: blurRadius(layer.blur, layer),
        edit: editOf(layer),
        backdrop: layer.backdrop
          ? layer.backdrop.kind === 'blur'
            ? { kind: 'blur', radius: blurRadius(layer.backdrop.blur, layer) }
            : layer.backdrop
          : null,
        shadow: layer.shadow ?? null,
      };
    case 'logo':
      return {
        ...common,
        kind: 'image',
        url: images.get(layer.assetId) ?? null,
        fit: 'contain',
        focus: { x: 0.5, y: 0.5 },
        placeholder: 'Logotipo',
        blur: 0,
        edit: null,
        backdrop: null,
        shadow: null,
      };
    case 'shape': {
      const shadow = layer.shadow ?? null;
      if (isSticker(layer.shape)) {
        return {
          ...common,
          kind: 'sticker',
          shape: layer.shape,
          fill: layer.shape === 'line' ? null : layer.fill,
          stroke: layer.shape === 'line' ? lineStroke(layer) : layer.stroke,
          shadow,
        };
      }
      return {
        ...common,
        kind: layer.shape === 'ellipse' ? 'ellipse' : 'rect',
        fill: layer.fill,
        stroke: layer.stroke,
        cornerRadius: layer.shape === 'rectangle' ? layer.cornerRadius : 0,
        shadow,
      };
    }
  }
}

/** La línea solo tiene borde: si no se le ha puesto, usa el color de relleno y el alto de la caja. */
function lineStroke(layer: { fill: string | null; stroke: { color: string; width: number } | null; height: number }) {
  return layer.stroke ?? { color: layer.fill ?? '#111111', width: Math.max(1, layer.height) };
}

export type { ShapeKind };

/** Nodos de una página, del fondo al frente (el orden del array de capas). */
export function describeDocument(page: Pick<PageView, 'layers'>, images: ImageLookup, readOnly = false): NodeSpec[] {
  return page.layers.map((layer) => describeLayer(layer, images, readOnly));
}

/** Identificadores de la biblioteca que el documento (todas sus páginas) necesita para dibujarse. */
export function assetIdsOf(document: ContentDocument): string[] {
  const ids = new Set<string>();
  for (const layer of allLayers(document)) {
    if (layer.type === 'image' && layer.source.kind === 'asset') ids.add(layer.source.assetId);
    if (layer.type === 'logo') ids.add(layer.assetId);
  }
  return [...ids].sort();
}
