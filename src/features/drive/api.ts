import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveConnectionRow, MediaAssetRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase, supabaseUrl } from '@/lib/supabase';

// Biblioteca con Google Drive (docs/biblioteca-drive.md). La conexión es de la
// organización; las fotos se eligen de su Drive y quedan en la biblioteca de
// una marca como referencias (sin copia en Storage). Todo lo que habla con
// Google pasa por la Edge Function `drive-media`: aquí no llega ningún token.

export type DriveVariant = 'full' | 'thumb';

export const driveKeys = {
  connections: (orgId: string) => ['org', orgId, 'drive', 'connections'] as const,
  folder: (brandId: string, connectionId: string | null, folderId: string) =>
    ['brand', brandId, 'drive', 'folder', connectionId, folderId] as const,
};

/** Ruta virtual de un recurso que vive en Drive: `<org>/<marca>/drive/<id de Drive>`. */
const DRIVE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/drive\/[A-Za-z0-9_-]{10,200}$/i;

export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

export function isDriveAsset(asset: Pick<MediaAssetRow, 'storage_path'> & { source?: string }): boolean {
  return asset.source === 'google_drive' || isDrivePath(asset.storage_path);
}

/** Dirección pública de una imagen firmada por `drive-media`. */
export function driveFileUrl(ticket: string): string {
  return `${supabaseUrl}/functions/v1/drive-media/file/${encodeURIComponent(ticket)}`;
}

/** Mensaje en español del error de una llamada a `drive-media`. */
async function functionError(error: unknown, fallback: string): Promise<Error> {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === 'function') {
    const body = (await context.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (body?.error?.message) return new Error(body.error.message);
  }
  return new Error(fallback);
}

async function invoke<T>(route: string, body: unknown, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`drive-media/${route}`, { body: body as object });
  if (error) throw await functionError(error, fallback);
  return data as T;
}

/** Firma las direcciones de los recursos de Drive que ve la persona (los que no ve no salen). */
export async function signDrivePaths(paths: string[], variant: DriveVariant): Promise<Map<string, string>> {
  const result = await invoke<{ tickets?: Record<string, { full: string; thumb: string }> }>(
    'sign',
    { paths },
    'No se pudieron cargar las imágenes de Google Drive.',
  );
  const map = new Map<string, string>();
  for (const [path, tickets] of Object.entries(result?.tickets ?? {})) {
    map.set(path, driveFileUrl(variant === 'thumb' ? tickets.thumb : tickets.full));
  }
  return map;
}

// ── Conexiones ───────────────────────────────────────────────────────────

export function useDriveConnections(orgId: string, enabled = true) {
  return useQuery({
    queryKey: driveKeys.connections(orgId),
    enabled,
    queryFn: async (): Promise<DriveConnectionRow[]> =>
      unwrap(
        await supabase
          .from('drive_connections')
          .select('*')
          .eq('organization_id', orgId)
          .neq('status', 'disconnected')
          .order('connected_at', { ascending: false }),
      ),
  });
}

/** Empieza la conexión: devuelve la dirección de Google a la que ir. */
export async function startDriveConnect(organizationId: string): Promise<string> {
  const data = await invoke<{ url?: unknown }>(
    'start',
    { organizationId },
    'No se pudo empezar la conexión con Google Drive. Inténtalo de nuevo.',
  );
  const url = data?.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Respuesta inesperada del servidor.');
  return url;
}

export function useDisconnectDrive(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) =>
      unwrap(await supabase.rpc('disconnect_drive', { p_connection_id: connectionId })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: driveKeys.connections(orgId) }),
  });
}

// ── Elegir fotos ─────────────────────────────────────────────────────────

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  /** Imagen que el navegador pinta (JPEG, PNG, WebP o GIF). Las HEIC del móvil no. */
  supported: boolean;
  bytes: number | null;
  width: number | null;
  height: number | null;
  thumbTicket: string | null;
}

export interface DriveFolderPage {
  connection: { id: string; accountEmail: string };
  folderId: string;
  items: DriveItem[];
  nextPageToken: string | null;
}

export function useDriveFolder(brandId: string, connectionId: string | null, folderId: string, enabled: boolean) {
  return useQuery({
    queryKey: driveKeys.folder(brandId, connectionId, folderId),
    enabled,
    staleTime: 60_000,
    queryFn: () =>
      invoke<DriveFolderPage>(
        'browse',
        { brandId, connectionId, folderId },
        'No se pudo leer la carpeta de Google Drive.',
      ),
  });
}

export function useImportFromDrive(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; fileIds: string[]; folder: string }) =>
      invoke<{ assets: MediaAssetRow[] }>(
        'import',
        { brandId, ...input },
        'No se pudieron añadir las fotos de Google Drive.',
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['brand', brandId, 'assets'] }),
  });
}
