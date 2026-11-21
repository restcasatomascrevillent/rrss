import type { Layer } from '../document';
import { LAYER_TYPE_LABEL } from '../editor/layers';

// Lógica pura de la exportación de imagen (sin Konva ni navegador): formatos,
// tamaños, nombre del archivo, procedencia y los errores que se explican a la
// persona. El dibujo vive en `editor/canvas/exporter.ts`, que se carga aparte.

export type ExportFormat = 'png' | 'jpeg';

export const EXPORT_FORMATS: Record<ExportFormat, { mime: string; extension: string; label: string; hint: string }> = {
  png: { mime: 'image/png', extension: 'png', label: 'PNG', hint: 'Sin pérdida; el archivo pesa más.' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG', hint: 'Más ligero; se pierde algo de calidad.' },
};

export const DEFAULT_QUALITY = 0.92;
export const MIN_QUALITY = 0.5;
/** Lado máximo de la imagen exportada: por encima, algunos navegadores se quedan sin memoria o recortan. */
export const MAX_EXPORT_SIDE = 4096;
/** Carpeta y etiqueta con las que se guardan las exportaciones en la biblioteca. */
export const EXPORT_FOLDER = 'Exportaciones';
export const EXPORT_TAG = 'exportación';

export interface ExportOptions {
  format: ExportFormat;
  /** 0,5 a 1. Solo cuenta en JPEG. */
  quality: number;
  /** Píxeles de la imagen por unidad del lienzo lógico: 1 = tamaño real (1080×1350…), 2 = doble. */
  pixelRatio: number;
}

export function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_QUALITY;
  return Math.min(1, Math.max(MIN_QUALITY, Math.round(value * 100) / 100));
}

/** Tamaño en píxeles de la imagen exportada. */
export function exportSize(canvas: { width: number; height: number }, pixelRatio: number) {
  return { width: Math.round(canvas.width * pixelRatio), height: Math.round(canvas.height * pixelRatio) };
}

/** Escalas ofrecidas para este lienzo: tamaño real y, si cabe, el doble. */
export function availablePixelRatios(canvas: { width: number; height: number }): number[] {
  return [1, 2].filter((ratio) => {
    const size = exportSize(canvas, ratio);
    return Math.max(size.width, size.height) <= MAX_EXPORT_SIDE;
  });
}

function slug(text: string, max: number): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export interface FileNameInput {
  title: string;
  format: ExportFormat;
  width: number;
  height: number;
  /** Versión guardada de la que sale (null si la pieza no se ha guardado nunca). */
  version: number | null;
  /** Hay cambios sin guardar en lo que se exporta. */
  unsaved: boolean;
  /** Página (desde 1) de un documento de varias páginas; sin ella, no se dice. */
  page?: number;
}

/**
 * Nombre legible por omisión: `menu-de-otono-1080x1350-v3.png` (`-borrador` si
 * hay cambios sin guardar; `-p2` en la página 2 de un carrusel).
 */
export function suggestFileName({ title, format, width, height, version, unsaved, page }: FileNameInput): string {
  const parts = [slug(title, 50) || 'diseno', `${width}x${height}`];
  if (version) parts.push(`v${version}`);
  if (unsaved) parts.push('borrador');
  if (page) parts.push(`p${page}`);
  return `${parts.join('-')}.${EXPORT_FORMATS[format].extension}`;
}

/** Nombre de la página `page` a partir de uno elegido por la persona: `nombre-p2.jpg`. */
export function pageFileName(fileName: string, page: number, format: ExportFormat): string {
  const { extension } = EXPORT_FORMATS[format];
  const base = fileName
    .slice(0, fileName.toLowerCase().endsWith(`.${extension}`) ? -(extension.length + 1) : undefined)
    .replace(/-p\d+$/, '');
  return `${base.slice(0, 115)}-p${page}.${extension}`;
}

/** Lo que escribe la persona, saneado y con la extensión del formato (sin duplicarla). */
export function normalizeFileName(input: string, format: ExportFormat): string {
  const { extension } = EXPORT_FORMATS[format];
  const leaf = input.split(/[\\/]/).pop() ?? '';
  const clean = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  const withoutExt = clean.replace(/\.(png|jpe?g)$/i, '').replace(/[. ]+$/, '');
  return `${(withoutExt || 'diseno').slice(0, 120)}.${extension}`;
}

/** Nombre con el que se menciona una capa en los avisos: el suyo o «Imagen (capa 3)». */
export function layerLabel(layer: Pick<Layer, 'type' | 'name'>, index: number): string {
  return layer.name.trim() ? `«${layer.name.trim()}»` : `${LAYER_TYPE_LABEL[layer.type]} (capa ${index + 1})`;
}

export interface ProvenanceInput {
  contentId: string;
  version: number | null;
  unsavedChanges: boolean;
  format: ExportFormat;
  width: number;
  height: number;
  pixelRatio: number;
  exportedAt: Date;
  /**
   * Página exportada (desde 1) y cuántas tiene el documento. Solo en documentos
   * de varias páginas (carruseles): la base de datos exige, para publicar un
   * carrusel, una exportación de cada página de la versión, en su orden.
   */
  page?: { number: number; count: number };
}

/**
 * Procedencia que se guarda en `media_assets.provenance` (la forma está
 * documentada en las migraciones 20261118120000 y 20261203010000).
 */
export function buildProvenance(input: ProvenanceInput) {
  return {
    type: 'export' as const,
    content_id: input.contentId,
    version: input.version,
    unsaved_changes: input.unsavedChanges,
    format: input.format,
    width: input.width,
    height: input.height,
    pixel_ratio: input.pixelRatio,
    exported_at: input.exportedAt.toISOString(),
    ...(input.page ? { page: input.page.number, page_count: input.page.count } : {}),
  };
}

export type ExportErrorCode = 'missing-images' | 'image-load' | 'tainted' | 'render';

/** Error de exportación con un mensaje que se puede enseñar tal cual. */
export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
    /** Capas implicadas, ya con su nombre legible. */
    readonly layers: string[] = [],
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

const list = (names: string[]) => names.join(', ');

export const exportErrors = {
  missingImages: (layers: string[]) =>
    new ExportError(
      'missing-images',
      `Faltan imágenes por cargar o por generar: ${list(layers)}. Exportarías un recuadro gris en su lugar. ` +
        'Espera a que carguen, sustitúyelas o oculta esas capas y vuelve a intentarlo.',
      layers,
    ),
  imageLoad: (layers: string[]) =>
    new ExportError(
      'image-load',
      `No se ha podido cargar la imagen de ${list(layers)}. Puede que la dirección firmada haya caducado ` +
        '(duran una hora: recarga la página) o que el servidor no permita usarla en el lienzo (CORS). ' +
        'Si pasa con una imagen que viene de fuera, súbela a la biblioteca de la marca y vuelve a elegirla en el diseño.',
      layers,
    ),
  tainted: (layers: string[]) =>
    new ExportError(
      'tainted',
      'El navegador ha bloqueado la exportación porque una imagen se cargó sin permiso de CORS y «mancha» el lienzo. ' +
        `Imágenes del diseño: ${list(layers) || 'ninguna identificada'}. ` +
        'Recarga la página sin caché (Ctrl+F5): a veces el navegador reutiliza una copia de la imagen guardada sin CORS. ' +
        'Si sigue igual, vuelve a subir esa imagen a la biblioteca de la marca y cámbiala en el diseño.',
      layers,
    ),
  render: (detail: string) =>
    new ExportError('render', `No se ha podido generar la imagen${detail ? `: ${detail}` : ''}.`),
};
