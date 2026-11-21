// Firmar y guardar en el almacén de cada archivo desde el servidor (clave de
// servicio): publicación en Instagram, referencias de la IA de imagen, imágenes
// generadas y borrado de organizaciones (docs/almacenamiento-r2.md).
//
// Sin dependencias de Deno ni de Node.
import type { RpcClient } from '../ai/contract.ts';
import type { ObjectStorage, StorageBackend } from './contract.ts';
import { loadMediaStorageConfig, type MediaStorageConfig } from './config.ts';
import { createS3Storage } from './s3.ts';

export interface MediaStores {
  config: MediaStorageConfig | null;
  supabase: ObjectStorage;
  r2: ObjectStorage | null;
}

/**
 * Los almacenes de la configuración efectiva. Una configuración local mal
 * puesta no tumba la función que la usa: R2 queda sin usar y se avisa.
 */
export function mediaStoresFor(
  env: Record<string, string | undefined>,
  supabase: ObjectStorage,
  log?: (event: string, data: Record<string, unknown>) => void,
): MediaStores {
  try {
    const config = loadMediaStorageConfig(env);
    return { config, supabase, r2: config.s3 ? createS3Storage(config.s3) : null };
  } catch (e) {
    log?.('media_storage_config_invalid', { message: (e as Error).message });
    return { config: null, supabase, r2: null };
  }
}

/**
 * URL de lectura de un archivo de la biblioteca en su almacén. `backendOf`
 * dice dónde está (por `media_assets.storage_backend`; lo que no es un recurso,
 * en Supabase).
 */
export async function signStoredPath(
  stores: MediaStores,
  backendOf: (path: string) => Promise<StorageBackend>,
  path: string,
  seconds: number,
): Promise<string> {
  const backend = await backendOf(path);
  if (backend === 'r2') {
    if (!stores.r2) throw new Error('El archivo está en Cloudflare R2 y R2 no está configurado');
    return stores.r2.signGet(path, seconds);
  }
  return stores.supabase.signGet(path, seconds);
}

/**
 * Dónde guarda el servidor un archivo nuevo de la biblioteca. Si es R2, lo
 * apunta antes en la base de datos (`media_storage_register_upload`, sin
 * persona: es el propio servidor) para que el recurso que se dé de alta con
 * esa ruta quede en R2.
 */
export async function uploadStoreFor(stores: MediaStores, rpc: RpcClient, path: string): Promise<ObjectStorage> {
  if (stores.config?.uploadBackend !== 'r2' || !stores.r2) return stores.supabase;
  const { error } = await rpc('media_storage_register_upload', { p_user_id: null, p_path: path });
  if (error) throw new Error('No se pudo apuntar el archivo en R2');
  return stores.r2;
}
