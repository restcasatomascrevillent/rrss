import Konva from 'konva/lib/Core';
import type { Shape } from 'konva/lib/Shape';
import { Rect } from 'konva/lib/shapes/Rect';
import { Text } from 'konva/lib/shapes/Text';
import { fetchImageObjectUrl } from '../../../../lib/corsImage';
import type { PageView } from '../../document';
import { EXPORT_FORMATS, exportErrors, exportSize, layerLabel, type ExportOptions } from '../../export/options';
import { editKey } from '../imageEffects/imageEdit';
import { EXPORT_BITMAP_SIDE, prepareBitmap } from '../imageEffects/prepare';
import { applySpecAttrs, drawSpecShape, type LoadedImage } from './draw';
import { describeDocument, type ImageLookup, type NodeSpec } from './nodes';

// Exportación de la imagen final en el navegador. Dibuja el documento en un
// escenario de Konva que no está en pantalla, a tamaño lógico (escala 1) y sin
// guías, selección ni tiradores (nada de eso existe aquí: solo las capas, con el
// mismo dibujo que el lienzo del editor, `draw.ts`). Se carga aparte, con Konva.

export interface RenderResult {
  blob: Blob;
  width: number;
  height: number;
}

const FONT_LOAD_TIMEOUT_MS = 8000;
const IMAGE_LOAD_TIMEOUT_MS = 30_000;

/** Familia lista para la propiedad `font` de CSS: con comillas si lleva espacios, como hace Konva. */
export function cssFontFamily(family: string): string {
  return family
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (/^["'].*["']$/.test(name) || !/\s/.test(name) ? name : `"${name}"`))
    .join(', ');
}

/** Espera a que las tipografías de los textos estén cargadas: si no, el lienzo dibujaría con la de reserva. */
export async function ensureFontsLoaded(specs: NodeSpec[]): Promise<void> {
  const fonts = window.document.fonts;
  if (!fonts) return;
  const wanted = new Map<string, string>();
  for (const spec of specs) {
    if (spec.kind !== 'text' || !spec.visible) continue;
    const font = `${spec.fontStyle} ${spec.fontSize}px ${cssFontFamily(spec.fontFamily)}`;
    wanted.set(font, `${wanted.get(font) ?? ''}${spec.text}`);
  }
  const loading = Promise.allSettled([...wanted].map(([font, text]) => fonts.load(font, text || ' ')));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all([loading, fonts.ready]).then(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Carga cada imagen de forma que el lienzo no quede «manchado». Se descarga con
 * `fetch` sin caché (lib/corsImage): la miniatura de la biblioteca deja en caché
 * la misma URL sin cabeceras CORS. Si `fetch` falla, se intenta con
 * `crossOrigin` como antes. Devuelve las que han fallado.
 */
async function loadImages(urls: string[]): Promise<{ images: Map<string, HTMLImageElement>; failed: Set<string> }> {
  const images = new Map<string, HTMLImageElement>();
  const failed = new Set<string>();
  await Promise.all(
    urls.map(
      async (url) => {
        const objectUrl = await fetchImageObjectUrl(url).catch(() => null);
        await new Promise<void>((resolve) => {
          const image = new window.Image();
          if (!objectUrl) image.crossOrigin = 'anonymous';
          // No se usa `decode()`: en una pestaña en segundo plano puede no resolverse nunca, y `drawImage` ya descodifica.
          const timer = setTimeout(() => {
            failed.add(url);
            resolve();
          }, IMAGE_LOAD_TIMEOUT_MS);
          image.onload = () => {
            clearTimeout(timer);
            if (image.naturalWidth > 0) images.set(url, image);
            else failed.add(url);
            resolve();
          };
          image.onerror = () => {
            clearTimeout(timer);
            failed.add(url);
            resolve();
          };
          image.src = objectUrl ?? url;
        });
        // La imagen ya está descodificada (o ha fallado): la URL intermedia sobra.
        if (objectUrl && objectUrl !== url) URL.revokeObjectURL(objectUrl);
      },
    ),
  );
  return { images, failed };
}

/**
 * La foto de una capa lista para dibujar: tal cual, o ya editada (girada,
 * recortada, con luz y color) con el mismo código que usa el editor.
 */
function bitmapFor(
  spec: NodeSpec,
  images: ReadonlyMap<string, HTMLImageElement>,
  cache: Map<string, HTMLCanvasElement>,
): LoadedImage {
  if (spec.kind !== 'image' || !spec.url) return undefined;
  const base = images.get(spec.url);
  if (!base || !spec.edit) return base;
  const key = `${spec.url}|${editKey(spec.edit)}`;
  let bitmap = cache.get(key);
  if (!bitmap) {
    bitmap = prepareBitmap(base, spec.edit, EXPORT_BITMAP_SIDE);
    cache.set(key, bitmap);
  }
  return bitmap;
}

function createNode(spec: NodeSpec, image: LoadedImage): Shape {
  const node: Shape =
    spec.kind === 'text'
      ? new Text({ id: spec.id, listening: false })
      : spec.kind === 'rect'
        ? new Rect({ id: spec.id, listening: false })
        : new Konva.Shape({
            id: spec.id,
            listening: false,
            sceneFunc: (context, shape) => drawSpecShape(context, shape, spec, image),
          });
  applySpecAttrs(node, spec);
  node.draggable(false);
  return node;
}

/** Nombres de las capas de imagen y logotipo visibles, para explicar qué puede estar fallando. */
function imageLayerNames(document: PageView, only?: (layerId: string) => boolean): string[] {
  const names: string[] = [];
  document.layers.forEach((layer, index) => {
    if (!layer.visible || (layer.type !== 'image' && layer.type !== 'logo')) return;
    if (only && !only(layer.id)) return;
    names.push(layerLabel(layer, index));
  });
  return names;
}

/**
 * Dibuja una página del documento (`pageView`) y devuelve el archivo. Lanza `ExportError` con un mensaje
 * para la persona si falta una imagen, no se puede cargar o el navegador bloquea
 * la lectura del lienzo.
 */
export async function renderDocument(
  document: PageView,
  lookup: ImageLookup,
  options: ExportOptions,
): Promise<RenderResult> {
  const specs = describeDocument(document, lookup, true).filter((spec) => spec.visible);
  const layerIndex = new Map(document.layers.map((layer, index) => [layer.id, index] as const));
  const nameOf = (id: string) => {
    const index = layerIndex.get(id) ?? 0;
    return layerLabel(document.layers[index]!, index);
  };

  // Una imagen sin dirección saldría como el recuadro gris del editor: mejor no exportar.
  const missing = specs.filter((spec) => spec.kind === 'image' && !spec.url).map((spec) => nameOf(spec.id));
  if (missing.length > 0) throw exportErrors.missingImages(missing);

  const urls = [...new Set(specs.flatMap((spec) => (spec.kind === 'image' && spec.url ? [spec.url] : [])))];
  const [{ images, failed }] = await Promise.all([loadImages(urls), ensureFontsLoaded(specs)]);
  if (failed.size > 0) {
    throw exportErrors.imageLoad(
      specs.filter((spec) => spec.kind === 'image' && spec.url && failed.has(spec.url)).map((spec) => nameOf(spec.id)),
    );
  }

  const { canvas } = document;
  const size = exportSize(canvas, options.pixelRatio);
  const container = window.document.createElement('div');
  const stage = new Konva.Stage({ container, width: canvas.width, height: canvas.height });
  try {
    const layer = new Konva.Layer();
    layer.add(new Rect({ x: 0, y: 0, width: canvas.width, height: canvas.height, fill: canvas.backgroundColor }));
    const bitmaps = new Map<string, HTMLCanvasElement>();
    for (const spec of specs) layer.add(createNode(spec, bitmapFor(spec, images, bitmaps)));
    stage.add(layer);
    layer.draw();

    const format = EXPORT_FORMATS[options.format];
    // pixelRatio explícito: sin él, Konva usaría el de la pantalla y el tamaño dependería del monitor.
    const blob = await stage.toBlob({
      pixelRatio: options.pixelRatio,
      mimeType: format.mime,
      quality: options.format === 'jpeg' ? options.quality : undefined,
    });
    if (!(blob instanceof Blob) || blob.size === 0) throw exportErrors.render('el navegador devolvió un archivo vacío');
    if (blob.type && blob.type !== format.mime) {
      throw exportErrors.render(`el navegador no sabe crear ${format.label} (devolvió ${blob.type})`);
    }
    return { blob, width: size.width, height: size.height };
  } catch (error) {
    if (error instanceof Error && error.name === 'ExportError') throw error;
    if (error instanceof DOMException && error.name === 'SecurityError') {
      throw exportErrors.tainted(imageLayerNames(document));
    }
    throw exportErrors.render(error instanceof Error ? error.message : '');
  } finally {
    stage.destroy();
  }
}
