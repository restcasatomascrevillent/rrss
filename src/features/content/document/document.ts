import {
  CANVAS_SIZES,
  DOCUMENT_SCHEMA_VERSION,
  MAX_PAGES,
  contentDocumentSchema,
  type AspectRatio,
  type ContentDocument,
} from './schema';

export interface DocumentIssue {
  /** Dónde está el problema: «pages.0.layers.2.fontSize», «copy.hashtags.0»… Vacío si es el documento entero. */
  path: string;
  message: string;
}

export type DocumentValidation = { ok: true; document: ContentDocument } | { ok: false; issues: DocumentIssue[] };

/**
 * Documento nuevo: un lienzo de la proporción pedida, sin capas ni texto, con
 * una página (o las que se pidan, para un carrusel: `p1`, `p2`…).
 */
export function createEmptyDocument(
  options: { aspectRatio?: AspectRatio; backgroundColor?: string; pages?: number } = {},
): ContentDocument {
  const aspectRatio = options.aspectRatio ?? '1:1';
  const count = Math.min(MAX_PAGES, Math.max(1, Math.trunc(options.pages ?? 1)));
  return contentDocumentSchema.parse({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    canvas: { aspectRatio, ...CANVAS_SIZES[aspectRatio], backgroundColor: options.backgroundColor },
    pages: Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}` })),
  });
}

/**
 * Comprueba que algo es un documento de la versión actual del esquema. Si lo
 * es, lo devuelve normalizado (valores por defecto puestos, hashtags sin
 * almohadilla); si no, dice qué falla y dónde. No migra: para leer un
 * documento guardado, `migrateDocument`.
 */
export function validateDocument(input: unknown): DocumentValidation {
  // Desde la versión 4 las capas van en sus páginas: una lista `layers` suelta
  // se perdería sin avisar (el esquema descarta lo que no conoce).
  if (typeof input === 'object' && input !== null && 'layers' in input) {
    return {
      ok: false,
      issues: [{ path: 'layers', message: 'Las capas van dentro de cada página (pages[].layers), no en el documento' }],
    };
  }
  const result = contentDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}
