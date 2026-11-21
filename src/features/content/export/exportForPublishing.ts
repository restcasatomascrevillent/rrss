import { uploadAsset } from '@/features/library/api';
import { pageView, type ContentDocument } from '../document';
import type { ImageLookup } from '../editor/canvas/nodes';
import {
  buildProvenance,
  DEFAULT_QUALITY,
  EXPORT_FOLDER,
  EXPORT_FORMATS,
  EXPORT_TAG,
  suggestFileName,
} from './options';

export interface ExportForPublishingInput {
  document: ContentDocument;
  images: ImageLookup;
  title: string;
  contentId: string;
  orgId: string;
  brandId: string;
  /** Versión guardada que se exporta (sin cambios pendientes). */
  version: number;
  prepareFonts?: () => Promise<void>;
}

/**
 * Exporta la versión guardada a JPEG a tamaño real y la guarda en la biblioteca,
 * con la misma procedencia que «Exportar imagen»: es lo que el calendario
 * acepta para publicar. La hace el navegador. Un documento de varias páginas
 * (carrusel) da una imagen por página, con su número en la procedencia.
 * Devuelve los recursos creados, en el orden de las páginas.
 */
export async function exportForPublishing(input: ExportForPublishingInput): Promise<string[]> {
  await input.prepareFonts?.();
  const { renderDocument } = await import('../editor/canvas/exporter');
  const count = input.document.pages.length;
  const ids: string[] = [];
  // Una detrás de otra: así no se dibujan diez lienzos a la vez en la memoria del navegador.
  for (let index = 0; index < count; index++) {
    const rendered = await renderDocument(pageView(input.document, index), input.images, {
      format: 'jpeg',
      quality: DEFAULT_QUALITY,
      pixelRatio: 1,
    });
    const page = count > 1 ? { number: index + 1, count } : undefined;
    const fileName = suggestFileName({
      title: input.title,
      format: 'jpeg',
      width: rendered.width,
      height: rendered.height,
      version: input.version,
      unsaved: false,
      page: page?.number,
    });
    const file = new File([rendered.blob], fileName, { type: EXPORT_FORMATS.jpeg.mime });
    const asset = await uploadAsset({
      organizationId: input.orgId,
      brandId: input.brandId,
      file,
      dimensions: { width: rendered.width, height: rendered.height, durationMs: null },
      folder: EXPORT_FOLDER,
      tags: [EXPORT_TAG],
      provenance: buildProvenance({
        contentId: input.contentId,
        version: input.version,
        unsavedChanges: false,
        format: 'jpeg',
        width: rendered.width,
        height: rendered.height,
        pixelRatio: 1,
        exportedAt: new Date(),
        page,
      }),
    });
    ids.push(asset.id);
  }
  return ids;
}
