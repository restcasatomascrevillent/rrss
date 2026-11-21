// Almacenamiento de los medios generados sobre Supabase Storage.
//
// Cada resultado acaba en dos sitios, como cualquier subida de la biblioteca:
//   1. el archivo, en el cubo privado `brand-media`, con la ruta
//      `<organización>/<marca>/ia/<generación>-<índice>.<ext>`;
//   2. su fila en `media_assets`, con `origin = 'generated'` y su procedencia en
//      la columna `provenance` (la misma que usa la exportación del editor), con
//      `type: 'ai_generation'`: generación, proveedor, modelo, encargo recortado,
//      región y si el adaptador está sin probar. Máximo 2048 bytes (lo exige la
//      tabla); solo el servidor puede escribir ese tipo (migración 20261118210000).
//
// Ediciones de una foto con IA (quitar el fondo, ampliar): mismo camino, pero
// la procedencia es `type: 'ai_edit'` con la operación y el recurso original
// (`source_asset_id`), carpeta «Ediciones» y nombre «Sin fondo · <original>».
// El original no se toca nunca: el resultado es siempre un recurso nuevo.
//
// Idempotente: la misma generación e índice van siempre a la misma ruta; subir
// otra vez sobrescribe el mismo objeto y la fila se reutiliza (la ruta es
// única). Así el sondeo y el webhook pueden llegar a la vez sin duplicar nada.
//
// Tope de 50 MB por archivo: el del cubo, que es el del plan gratuito de
// Supabase. Un resultado mayor se rechaza aquí, antes de intentar subirlo.
//
// Sin dependencias: recibe un `MediaStorageBackend` (en la función, el cliente
// de Supabase con la clave de servicio; en las pruebas, la base de datos real).
import { MediaProviderFailure, type MediaProvenance, type MediaStorage } from './contract.ts';
import { isRecord } from './http.ts';

export const BRAND_MEDIA_BUCKET = 'brand-media';
/** Tope del cubo `brand-media` (migración 20261115121000) y del plan gratuito de Supabase. */
export const BRAND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
/** Carpeta de la biblioteca donde caen las imágenes generadas. */
export const GENERATED_FOLDER = 'IA';
/** Tope de `media_assets.provenance` (migración 20261118120000). */
export const MAX_PROVENANCE_BYTES = 2048;
export const AI_PROVENANCE_TYPE = 'ai_generation';
/** Procedencia de una foto editada con IA (solo la escribe el servidor, migración 20261128010000). */
export const AI_EDIT_PROVENANCE_TYPE = 'ai_edit';
/** Carpeta de la biblioteca de las fotos editadas (con IA o en el navegador). */
export const EDITS_FOLDER = 'Ediciones';

/** Tipos que admite el cubo y su extensión. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Fila que se escribe en `media_assets`. */
export interface GeneratedAssetRow {
  brand_id: string;
  organization_id: string;
  kind: 'image' | 'video';
  origin: 'generated';
  storage_path: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  folder: string;
  tags: string[];
  provenance: Record<string, unknown>;
  created_by: string | null;
}

export interface MediaStorageBackend {
  /** Sube (o sobrescribe) el objeto en el cubo. Lanza si falla. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Crea la fila o devuelve la que ya hay con esa ruta. Lanza si falla. */
  saveAsset(row: GeneratedAssetRow): Promise<{ id: string }>;
}

/**
 * Tipo real del archivo mirando sus primeros bytes: los proveedores a veces
 * lo entregan como `application/octet-stream`.
 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (at(0) === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(4, 8) === 'ftyp') return ascii(8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video/webm';
  return null;
}

/** Ancho y alto de una imagen PNG, JPEG o WebP leyendo su cabecera, o `null`. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = sniffMimeType(bytes);
  try {
    if (type === 'image/png' && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === 'image/gif' && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (type === 'image/webp' && bytes.length >= 30) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === 'VP8 ')
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = view.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        const w = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16);
        const h = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16);
        return { width: w + 1, height: h + 1 };
      }
      return null;
    }
    if (type === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        const length = view.getUint16(offset + 2);
        // SOF0…SOF15 salvo DHT (C4), JPG (C8) y DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Procedencia de un recurso generado, recortando el encargo para que el JSON
 * no pase de 2048 bytes (se mide en UTF-8, como la restricción de la tabla).
 */
export function provenanceJson(generationId: string, provenance: MediaProvenance | undefined): Record<string, unknown> {
  if (provenance?.edit) {
    const edit = provenance.edit;
    return {
      type: AI_EDIT_PROVENANCE_TYPE,
      operation: edit.operation,
      source_asset_id: edit.sourceAssetId,
      ...(edit.scale ? { scale: edit.scale } : {}),
      generation_id: generationId,
      provider: provenance.provider,
      model: provenance.model,
      purpose: provenance.purpose ?? null,
      // Cambiar el fondo: cómo se pidió (recortado: la procedencia tiene tope de tamaño).
      ...(provenance.prompt ? { prompt: [...provenance.prompt].slice(0, 400).join('') } : {}),
      data_region: provenance.dataRegion,
      trains_on_inputs: provenance.trainsOnInputs,
      untested_adapter: provenance.untestedAdapter,
    };
  }
  const build = (prompt: string | null) => ({
    type: AI_PROVENANCE_TYPE,
    generation_id: generationId,
    provider: provenance?.provider ?? null,
    model: provenance?.model ?? null,
    purpose: provenance?.purpose ?? null,
    prompt,
    data_region: provenance?.dataRegion ?? 'unknown',
    trains_on_inputs: provenance?.trainsOnInputs ?? 'unknown',
    untested_adapter: provenance?.untestedAdapter ?? true,
  });
  const encoder = new TextEncoder();
  let prompt = provenance?.prompt ? [...provenance.prompt] : [];
  // Margen de 200 bytes: al pasar a texto, jsonb añade espacios tras «:» y «,».
  while (
    prompt.length > 0 &&
    encoder.encode(JSON.stringify(build(prompt.join('')))).length > MAX_PROVENANCE_BYTES - 200
  ) {
    prompt = prompt.slice(0, Math.max(0, Math.floor(prompt.length * 0.9) - 1));
  }
  return build(prompt.length ? prompt.join('') : null);
}

const EDIT_NAME: Record<string, (scale?: number) => string> = {
  remove_background: () => 'Sin fondo',
  upscale: (scale) => `Ampliada ×${scale ?? 2}`,
  replace_background: () => 'Fondo nuevo',
  enhance: () => 'Mejorada',
};

/** Nombre legible en la biblioteca: «IA · <encargo recortado>.png» o «Sin fondo · <original>.png». */
function fileNameFor(provenance: MediaProvenance | undefined, generationId: string, index: number, extension: string) {
  const edit = provenance?.edit;
  if (edit) {
    const original = (edit.sourceName ?? '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[\\/:*?"<>|\s]+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim();
    const label = (EDIT_NAME[edit.operation] ?? (() => 'Editada'))(edit.scale);
    return `${label} · ${original || generationId.slice(0, 8)}${index > 0 ? ` (${index + 1})` : ''}.${extension}`;
  }
  const prompt = provenance?.prompt;
  const words = (prompt ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  const base = words ? `IA · ${words}` : `IA · ${generationId.slice(0, 8)}`;
  return `${base}${index > 0 ? ` (${index + 1})` : ''}.${extension}`;
}

export function createSupabaseMediaStorage(
  backend: MediaStorageBackend,
  options: { maxBytes?: number } = {},
): MediaStorage {
  const maxBytes = options.maxBytes ?? BRAND_MEDIA_MAX_BYTES;
  return {
    async put(object) {
      if (object.bytes.byteLength > maxBytes) {
        throw new MediaProviderFailure(
          'too_large',
          `El resultado ocupa más de ${Math.floor(maxBytes / 1024 / 1024)} MB, el máximo que admite el almacenamiento`,
        );
      }
      const sniffed = sniffMimeType(object.bytes);
      const declared = object.mimeType.split(';')[0]!.trim().toLowerCase();
      const mimeType = sniffed ?? declared;
      const extension = EXTENSIONS[mimeType];
      if (!extension) {
        throw new MediaProviderFailure(
          'bad_response',
          'El proveedor ha entregado un archivo de un tipo que no se admite',
        );
      }
      if ((object.kind === 'image') !== mimeType.startsWith('image/')) {
        throw new MediaProviderFailure(
          'bad_response',
          'El proveedor ha entregado un archivo que no es del tipo pedido',
        );
      }
      const path = `${object.organizationId}/${object.brandId}/ia/${object.generationId}-${object.index}.${extension}`;
      await backend.upload(path, object.bytes, mimeType);
      const size = object.kind === 'image' ? imageDimensions(object.bytes) : null;
      const row = await backend.saveAsset({
        brand_id: object.brandId,
        organization_id: object.organizationId,
        kind: object.kind,
        origin: 'generated',
        storage_path: path,
        file_name: fileNameFor(object.provenance, object.generationId, object.index, extension),
        mime_type: mimeType,
        bytes: object.bytes.byteLength,
        width: size && size.width > 0 ? size.width : null,
        height: size && size.height > 0 ? size.height : null,
        folder: object.provenance?.edit ? EDITS_FOLDER : GENERATED_FOLDER,
        tags: object.provenance?.edit ? ['ia', 'edición'] : ['ia'],
        provenance: provenanceJson(object.generationId, object.provenance),
        created_by: object.provenance?.requestedBy ?? null,
      });
      return { path, assetId: row.id };
    },
  };
}

/** Lo mínimo del cliente de Supabase (supabase-js) que usa `supabaseMediaStorageBackend`. */
export interface SupabaseStorageClientLike {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean },
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
  from(table: string): {
    upsert(
      row: Record<string, unknown>,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): { select(columns: string): { single(): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
  };
}

/**
 * Backend con el cliente de Supabase y la CLAVE DE SERVICIO (solo en funciones
 * del servidor). Los errores no copian el mensaje de Storage, que puede llevar
 * la ruta.
 */
export function supabaseMediaStorageBackend(client: SupabaseStorageClientLike): MediaStorageBackend {
  return {
    async upload(path, bytes, contentType) {
      const { error } = await client.storage
        .from(BRAND_MEDIA_BUCKET)
        .upload(path, bytes, { contentType, upsert: true });
      if (error) {
        throw new MediaProviderFailure('storage_failed', 'No se ha podido guardar el archivo en el almacenamiento', {
          retryable: true,
        });
      }
    },
    async saveAsset(row) {
      // Con la ruta repetida se actualiza la misma fila (mismo id): idempotente.
      const { data, error } = await client
        .from('media_assets')
        .upsert(row as unknown as Record<string, unknown>, { onConflict: 'storage_path', ignoreDuplicates: false })
        .select('id')
        .single();
      if (error || !isRecord(data) || typeof data.id !== 'string') {
        throw new MediaProviderFailure('storage_failed', 'No se ha podido registrar el archivo en la biblioteca', {
          retryable: true,
        });
      }
      return { id: data.id };
    },
  };
}
