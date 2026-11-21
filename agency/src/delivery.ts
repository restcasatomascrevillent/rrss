// Archivo de entrega: lo que prepara la sesión de la agencia para un encargo.
// Se valida con el MISMO esquema que usa el editor (documento por capas y
// `PostCopy`) y se comprueba con el MISMO verificador de marca sin IA.
//
// Forma (ver ejemplos/entrega.json):
//   {
//     "format": "rrss.agency-delivery",
//     "version": 1,
//     "title": "Nombre interno de la pieza (opcional)",
//     "copy": { caption, hashtags, mentions, altText, callToAction },
//     "variants": [ { caption, hashtags, … } ],          // opcional, hasta 5
//     "document": { schemaVersion: 4, canvas, pages: [ { id, layers } ] }   // opcional
//   }
// `copy` es el texto de la publicación; si hay `document`, su texto se
// sustituye por `copy`. Las variantes viajan como comentario del encargo.
//
// Páginas (documento v4): un carrusel es UNA pieza con varias páginas (de 2 a
// 10 en Instagram), todas con el mismo lienzo y el mismo `copy`; un post, una.
// El formato de la entrega no cambia (sigue en la versión 1): el documento dice
// su propia versión, y uno de las versiones 1 a 3 (`layers` sin páginas) se
// convierte en uno de una sola página. Cuántas páginas admite el formato lo
// comprueba el verificador de marca (comprobación `pages`, bloqueante).
import {
  createEmptyDocument,
  postCopySchema,
  validateDocumentFromAnyVersion,
  type AspectRatio,
  type ContentDocument,
  type DocumentIssue,
  type PostCopy,
} from '../../src/features/content/document/index.ts';
import { buildBrandCheckInput, verifyPiece, type ProfileLike } from '../../src/features/brandcheck/index.ts';
import type { BrandCheckResult } from '../../src/features/brandcheck/types.ts';
import {
  allowedCanvasRatios,
  getFormatSpec,
  recommendedCanvasRatio,
  type NetworkFormatSpec,
} from '../../src/features/content/networks.ts';

export const DELIVERY_FORMAT = 'rrss.agency-delivery';
export const DELIVERY_VERSION = 1;
export const MAX_VARIANTS = 5;

export interface Delivery {
  title: string | null;
  copy: PostCopy;
  variants: PostCopy[];
  /** Documento por capas entregado (ya con `copy` dentro), o null si solo se entrega texto. */
  document: ContentDocument | null;
}

export type DeliveryParse = { ok: true; delivery: Delivery } | { ok: false; issues: DocumentIssue[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function copyIssues(prefix: string, input: unknown): { copy: PostCopy | null; issues: DocumentIssue[] } {
  const parsed = postCopySchema.safeParse(input);
  if (parsed.success) return { copy: parsed.data, issues: [] };
  return {
    copy: null,
    issues: parsed.error.issues.map((issue) => ({
      path: [prefix, ...issue.path].join('.'),
      message: issue.message,
    })),
  };
}

/** Valida el archivo de entrega. No toca la red. */
export function parseDelivery(input: unknown): DeliveryParse {
  const issues: DocumentIssue[] = [];
  if (!isObject(input)) return { ok: false, issues: [{ path: '', message: 'La entrega debe ser un objeto JSON' }] };
  if (input.format !== DELIVERY_FORMAT) {
    issues.push({ path: 'format', message: `Debe ser "${DELIVERY_FORMAT}"` });
  }
  if (input.version !== DELIVERY_VERSION) issues.push({ path: 'version', message: `Debe ser ${DELIVERY_VERSION}` });

  let title: string | null = null;
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== 'string' || input.title.trim().length > 200) {
      issues.push({ path: 'title', message: 'El título es un texto de hasta 200 caracteres' });
    } else {
      title = input.title.trim() || null;
    }
  }

  if (!isObject(input.copy)) issues.push({ path: 'copy', message: 'Falta el texto de la publicación (copy)' });
  const main = copyIssues('copy', input.copy ?? {});
  issues.push(...main.issues);
  if (main.copy && !main.copy.caption.trim()) issues.push({ path: 'copy.caption', message: 'El pie está vacío' });

  const variants: PostCopy[] = [];
  if (input.variants !== undefined) {
    if (!Array.isArray(input.variants) || input.variants.length > MAX_VARIANTS) {
      issues.push({ path: 'variants', message: `Las variantes son una lista de hasta ${MAX_VARIANTS}` });
    } else {
      input.variants.forEach((variant, index) => {
        const parsed = copyIssues(`variants.${index}`, variant);
        issues.push(...parsed.issues);
        if (parsed.copy) variants.push(parsed.copy);
      });
    }
  }

  let document: ContentDocument | null = null;
  if (input.document !== undefined && input.document !== null) {
    if (!isObject(input.document)) {
      issues.push({ path: 'document', message: 'El documento debe ser un objeto' });
    } else {
      // Admite documentos escritos con una versión anterior del esquema: se migran a la actual.
      const validation = validateDocumentFromAnyVersion({ ...input.document, copy: main.copy ?? {} });
      if (validation.ok) document = validation.document;
      else issues.push(...validation.issues.map((issue) => ({ ...issue, path: `document.${issue.path}` })));
    }
  }

  if (issues.length || !main.copy) return { ok: false, issues };
  return { ok: true, delivery: { title, copy: main.copy, variants, document } };
}

/** Proporción del lienzo para una pieza nueva de esa red y formato. */
export function canvasRatioFor(spec: NetworkFormatSpec | undefined, media: 'image' | 'video' | null): AspectRatio {
  if (!spec) return '1:1';
  const kind = media && spec.media.includes(media) ? media : spec.media[0];
  const recommended = recommendedCanvasRatio(spec, kind);
  if (recommended) return recommended.ratio;
  return allowedCanvasRatios(spec, kind)?.ratios[0] ?? '1:1';
}

export interface BuildContext {
  network: string;
  format: string;
  mediaKind: 'image' | 'video' | null;
  /** Documento vigente de la pieza enlazada al encargo, si la hay. */
  currentDocument: ContentDocument | null;
}

/**
 * Documento final que se guardará: el entregado; si no hay, el de la pieza
 * enlazada con el texto nuevo; si tampoco, un lienzo vacío de la proporción
 * recomendada para la red con el texto nuevo.
 */
export function buildDocument(delivery: Delivery, context: BuildContext): ContentDocument {
  if (delivery.document) return { ...delivery.document, copy: delivery.copy };
  if (context.currentDocument) return { ...context.currentDocument, copy: delivery.copy };
  const spec = getFormatSpec(context.network, context.format);
  const document = createEmptyDocument({ aspectRatio: canvasRatioFor(spec, context.mediaKind) });
  return { ...document, copy: delivery.copy };
}

/** Comprueba el documento (y cada variante, con el mismo lienzo) con el verificador de marca sin IA. */
export function checkDelivery(
  document: ContentDocument,
  variants: PostCopy[],
  network: string,
  format: string,
  profile: ProfileLike | null,
): { main: BrandCheckResult; variants: BrandCheckResult[] } {
  const spec = getFormatSpec(network, format);
  const check = (doc: ContentDocument) => verifyPiece(buildBrandCheckInput(doc, spec, profile));
  return { main: check(document), variants: variants.map((copy) => check({ ...document, copy })) };
}

/** Las variantes como texto para el comentario del encargo. */
export function variantsComment(variants: PostCopy[]): string {
  if (!variants.length) return '';
  const blocks = variants.map((variant, index) => {
    const tags = variant.hashtags.length ? `\n${variant.hashtags.map((tag) => `#${tag}`).join(' ')}` : '';
    return `Variante ${index + 2}:\n${variant.caption}${tags}`;
  });
  return `Otras propuestas de texto (la variante 1 es la de la pieza):\n\n${blocks.join('\n\n')}`.slice(0, 5000);
}
