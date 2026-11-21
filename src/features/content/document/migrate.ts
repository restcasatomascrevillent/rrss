import { validateDocument, type DocumentIssue, type DocumentValidation } from './document';
import { DOCUMENT_SCHEMA_VERSION, type ContentDocument } from './schema';

/** Convierte un documento de la versión N del esquema a la N + 1. No debe modificar el que recibe. */
export type DocumentMigration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migraciones del esquema: la entrada `n` lleva un documento de la versión `n`
 * a la `n + 1`. Al cambiar el esquema: subir DOCUMENT_SCHEMA_VERSION y añadir
 * aquí la función que adapta los documentos guardados (los antiguos no se
 * reescriben: se migran al leer).
 */
/** Campos de capa que llegan con la versión 5. */
const V5_LAYER_FIELDS = [
  'adjust',
  'turn',
  'flipX',
  'flipY',
  'straighten',
  'crop',
  'backdrop',
  'shadow',
  'outline',
  'background',
] as const;

export const DOCUMENT_MIGRATIONS: Record<number, DocumentMigration> = {
  // 1 → 2: llegan los grupos de capas. Un documento de la 1 no tiene ninguno; si
  // alguna capa trajera ya un `groupId` (no debería), se quita para que no se
  // agrupe nada que la persona no agrupó.
  1: (document) => {
    const layers = Array.isArray(document.layers)
      ? document.layers.map((layer: unknown) => {
          if (typeof layer !== 'object' || layer === null || !('groupId' in layer)) return layer;
          const rest = { ...(layer as Record<string, unknown>) };
          delete rest.groupId;
          return rest;
        })
      : document.layers;
    return { ...document, layers };
  },
  // 2 → 3: llega el desenfoque de las imágenes. Un documento de la 2 no tiene
  // ninguno; si alguna capa trajera ya `blur` (no debería), se quita para no
  // desenfocar nada que la persona no desenfocó.
  2: (document) => {
    const layers = Array.isArray(document.layers)
      ? document.layers.map((layer: unknown) => {
          if (typeof layer !== 'object' || layer === null || !('blur' in layer)) return layer;
          const rest = { ...(layer as Record<string, unknown>) };
          delete rest.blur;
          return rest;
        })
      : document.layers;
    return { ...document, layers };
  },
  // 3 → 4: llegan las páginas. Las capas del documento pasan a ser las de su
  // única página; el resto (lienzo, texto de la publicación) no cambia. Si
  // trajera ya `pages` (no debería), se descarta: manda lo que se dibujaba.
  3: (document) => {
    const rest = { ...document };
    const layers = rest.layers === undefined ? [] : rest.layers;
    delete rest.layers;
    delete rest.pages;
    return { ...rest, pages: [{ id: 'p1', name: '', layers }] };
  },
  // 4 → 5: llegan las ediciones sencillas (ajustes, giro, recorte, fondo,
  // sombra, contorno y fondo del texto). Un documento de la 4 no tiene ninguna;
  // si alguna capa trajera ya alguno de esos campos (no debería), se quita para
  // no editar nada que la persona no editó.
  4: (document) => {
    const pages = Array.isArray(document.pages)
      ? document.pages.map((page: unknown) => {
          if (typeof page !== 'object' || page === null || !Array.isArray((page as { layers?: unknown }).layers)) {
            return page;
          }
          const layers = (page as { layers: unknown[] }).layers.map((layer: unknown) => {
            if (typeof layer !== 'object' || layer === null) return layer;
            const rest = { ...(layer as Record<string, unknown>) };
            for (const field of V5_LAYER_FIELDS) delete rest[field];
            return rest;
          });
          return { ...(page as Record<string, unknown>), layers };
        })
      : document.pages;
    return { ...document, pages };
  },
};

export type DocumentFailure =
  /** No es un objeto o no dice su versión de esquema. */
  | 'not_a_document'
  /** Lo guardó una versión de la aplicación más nueva que esta. */
  | 'newer_version'
  /** Falta la migración de alguna versión intermedia (error de programación). */
  | 'missing_migration'
  /** Tras migrar, no cumple el esquema actual. */
  | 'invalid';

const MESSAGES: Record<DocumentFailure, string> = {
  not_a_document: 'El documento no es válido.',
  newer_version: 'Este documento se guardó con una versión más reciente de la aplicación. Recarga la página.',
  missing_migration: 'No se puede abrir este documento: falta la conversión desde su versión.',
  invalid: 'El documento no es válido.',
};

export class DocumentError extends Error {
  readonly reason: DocumentFailure;
  readonly issues: DocumentIssue[];

  constructor(reason: DocumentFailure, issues: DocumentIssue[] = []) {
    super(MESSAGES[reason]);
    this.name = 'DocumentError';
    this.reason = reason;
    this.issues = issues;
  }
}

/**
 * Aplica en orden las migraciones necesarias para llevar `raw` a la versión
 * `target`. Devuelve una copia: `raw` no se toca. No valida el resultado.
 */
export function runMigrations(
  raw: unknown,
  target: number = DOCUMENT_SCHEMA_VERSION,
  migrations: Record<number, DocumentMigration> = DOCUMENT_MIGRATIONS,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DocumentError('not_a_document');
  let document = structuredClone(raw) as Record<string, unknown>;
  let version = document.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new DocumentError('not_a_document');
  }
  if (version > target) throw new DocumentError('newer_version');

  while (version < target) {
    const migrate = migrations[version];
    if (!migrate) throw new DocumentError('missing_migration');
    document = { ...migrate(document), schemaVersion: version + 1 };
    version += 1;
  }
  return document;
}

/**
 * Como `validateDocument`, pero acepta también documentos de versiones
 * anteriores del esquema (los migra antes). Para lo que llega de fuera ya
 * escrito con una versión concreta, como la entrega de la agencia.
 */
export function validateDocumentFromAnyVersion(input: unknown): DocumentValidation {
  try {
    return validateDocument(runMigrations(input));
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    return { ok: false, issues: [{ path: 'schemaVersion', message: error.message }] };
  }
}

/**
 * Lee un documento guardado con cualquier versión anterior del esquema y lo
 * devuelve en la actual, validado. Lanza `DocumentError` si no puede.
 */
export function migrateDocument(raw: unknown): ContentDocument {
  const result = validateDocument(runMigrations(raw));
  if (!result.ok) throw new DocumentError('invalid', result.issues);
  return result.document;
}
