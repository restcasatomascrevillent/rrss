import { STORAGE_BUCKET } from '@/config/app';
import { supabase } from '@/lib/supabase';
import { callIntegrations, type IntegrationAvailability } from '@/features/platform/integrations/api';

// Almacenamiento de los archivos de la biblioteca (docs/almacenamiento-r2.md).
// Cada recurso dice en qué almacén está (`media_assets.storage_backend`):
// Supabase Storage (lo de siempre, que el navegador firma con la sesión) o
// Cloudflare R2, cuyas URL firma la Edge Function `media-storage` después de
// comprobar con la RLS que la persona ve la marca. Si R2 no está configurado
// en el servidor, nada de esto se usa y todo va como antes.

/** Cuánto se recuerda si el servidor tiene R2 (como la disponibilidad de la interfaz). */
const AVAILABILITY_TTL_MS = 60_000;
let availability: { at: number; value: Promise<boolean> } | null = null;

/**
 * ¿Hay R2 en el servidor? (`useFeature('mediaStorage')` para la interfaz; esto,
 * para el código que no es un componente.) Si el servidor no contesta, no.
 */
export function mediaStorageEnabled(): Promise<boolean> {
  if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability.value;
  const value = callIntegrations<IntegrationAvailability>({ action: 'availability' })
    .then((a) => a?.mediaStorage === true)
    .catch(() => false);
  availability = { at: Date.now(), value };
  return value;
}

/** Olvida lo recordado (al guardar en Plataforma → Integraciones y en las pruebas). */
export function resetMediaStorageAvailability(): void {
  availability = null;
}

const FAILED = 'No se ha podido hablar con el almacenamiento. Inténtalo de nuevo en un momento.';

async function invoke<T>(route: 'sign' | 'upload' | 'delete' | 'discard', body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`media-storage/${route}`, { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const payload = (await context
        .clone()
        .json()
        .catch(() => null)) as { error?: { message?: unknown } } | null;
      if (typeof payload?.error?.message === 'string' && payload.error.message) {
        throw new Error(payload.error.message);
      }
    }
    throw new Error(FAILED);
  }
  return data as T;
}

/**
 * URL firmadas de lectura para rutas de Storage (no de Drive). Las que están en
 * R2 las firma el servidor; el resto, Supabase con la sesión. Las que no se
 * pueden firmar no salen.
 */
export async function signStoragePaths(
  paths: string[],
  seconds: number,
  options: { download?: boolean } = {},
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;
  let rest = paths;
  if (await mediaStorageEnabled()) {
    for (let i = 0; i < paths.length; i += 500) {
      const batch = paths.slice(i, i + 500);
      const result = await invoke<{ urls?: Record<string, string> }>('sign', {
        paths: batch,
        ...(options.download ? { download: true } : {}),
      });
      for (const [path, url] of Object.entries(result?.urls ?? {})) map.set(path, url);
    }
    rest = paths.filter((p) => !map.has(p));
  }
  if (rest.length === 0) return map;
  if (options.download && rest.length === 1) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(rest[0]!, seconds, { download: true });
    if (error) throw error;
    if (data?.signedUrl) map.set(rest[0]!, data.signedUrl);
    return map;
  }
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrls(rest, seconds);
  if (error) throw error;
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) map.set(item.path, item.signedUrl);
  }
  return map;
}

export type UploadTarget =
  | { backend: 'supabase' }
  | { backend: 'r2'; url: string; method: 'PUT'; headers: Record<string, string>; expiresIn: number };

/**
 * Dónde se sube un archivo nuevo. Sin R2 en el servidor, a Supabase sin
 * preguntar. Con R2, el servidor comprueba que la persona edita la marca y
 * devuelve la URL de subida (o dice que vaya a Supabase).
 */
export async function uploadTarget(path: string, contentType: string, bytes: number): Promise<UploadTarget> {
  if (!(await mediaStorageEnabled())) return { backend: 'supabase' };
  return invoke<UploadTarget>('upload', { path, contentType, bytes });
}

/**
 * Borra los archivos de los recursos ya borrados (anotados en la cola de
 * limpieza), cada uno en su almacén. Devuelve las rutas borradas.
 */
export async function deleteStoredMedia(paths: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (let i = 0; i < paths.length; i += 500) {
    const result = await invoke<{ removed?: string[] }>('delete', { paths: paths.slice(i, i + 500) });
    removed.push(...(result?.removed ?? []));
  }
  return removed;
}

/**
 * Borrado compensatorio: quita de R2 un archivo subido cuyo recurso no se pudo
 * crear. El servidor solo borra lo que esa persona subió y no tiene recurso.
 * Nunca lanza: si falla, lo recoge la tarea programada pasadas 24 horas.
 */
export async function discardUploadedMedia(path: string): Promise<void> {
  try {
    if (!(await mediaStorageEnabled())) return;
    await invoke('discard', { paths: [path] });
  } catch {
    /* lo limpia la tarea programada */
  }
}
