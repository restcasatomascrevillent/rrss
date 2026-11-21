// Almacenamiento de objetos de la biblioteca (docs/almacenamiento-r2.md): la
// misma interfaz para Supabase Storage (cubo `brand-media`) y para un cubo S3
// (Cloudflare R2 o, en las pruebas locales, MinIO). Las rutas son siempre
// `<organización>/<marca>/<carpeta>/<archivo>`, iguales en los dos almacenes.
//
// Sin dependencias de Deno ni de Node: lo usan las funciones, el trabajador,
// el script de migración y las pruebas.

export type StorageBackend = 'supabase' | 'r2';
export const STORAGE_BACKENDS: readonly StorageBackend[] = ['supabase', 'r2'];

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SignedUpload {
  url: string;
  method: 'PUT' | 'POST';
  /** Cabeceras que hay que enviar tal cual (van firmadas). */
  headers: Record<string, string>;
  expiresIn: number;
}

export interface ObjectStorage {
  readonly backend: StorageBackend;
  /** URL de lectura sin cabeceras, válida `seconds` segundos. */
  signGet(key: string, seconds: number, options?: { download?: string }): Promise<string>;
  /** URL de subida con el tipo y el tamaño exactos firmados. */
  signPut(key: string, contentType: string, bytes: number, seconds: number): Promise<SignedUpload>;
  /** Tamaño del objeto, o null si no existe. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** Sube (o sobrescribe) un objeto desde el servidor. */
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, contentType: string, bytes: number): Promise<void>;
  /** Borra objetos; lo que ya no estaba no es un error. Devuelve las claves que no se pudieron borrar. */
  remove(keys: string[]): Promise<{ failed: string[] }>;
  /** Claves bajo un prefijo (todas, paginando). */
  list(prefix: string): Promise<Array<{ key: string; bytes: number }>>;
}

/** Sin propiedades de parámetro: el script de migración lo carga con Node sin compilar. */
export class StorageError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status = 0, retryable = true) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.retryable = retryable;
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MEDIA_KEY = new RegExp(`^${UUID}/${UUID}/[^/]+(/[^/]+)*$`, 'i');
const DRIVE_KEY = new RegExp(`^${UUID}/${UUID}/drive/`, 'i');

/**
 * ¿Es una ruta de la biblioteca guardable en un almacén? `<org>/<marca>/…`,
 * sin tramos vacíos, `.` ni `..`, sin barras invertidas ni caracteres de
 * control, y fuera de la carpeta reservada de Drive.
 */
export function isMediaKey(key: string): boolean {
  if (typeof key !== 'string' || key.length > 1024 || !MEDIA_KEY.test(key) || DRIVE_KEY.test(key)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(key)) return false;
  return key.split('/').every((s) => s !== '.' && s !== '..');
}

/** Organización y marca de una ruta válida. */
export function keyOwner(key: string): { organizationId: string; brandId: string } {
  const [organizationId = '', brandId = ''] = key.split('/');
  return { organizationId: organizationId.toLowerCase(), brandId: brandId.toLowerCase() };
}
