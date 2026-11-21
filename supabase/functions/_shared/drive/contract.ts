// Contrato con Google Drive (docs/biblioteca-drive.md). Lo cumplen el
// adaptador real (google-drive.ts) y el simulado de las pruebas locales
// (simulated-drive.ts). Sin dependencias de Deno ni de Node.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Permisos que se piden a Google: leer el Drive (sin escribir) y saber qué cuenta es. */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'openid', 'email'] as const;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Lo que el navegador pinta y la biblioteca acepta desde Drive. */
export const DRIVE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  modifiedTime: string | null;
  /** Miniatura de Google (si la hay). Se pide con el token; nunca llega al navegador tal cual. */
  thumbnailLink: string | null;
  trashed: boolean;
}

export interface DriveListing {
  files: DriveFile[];
  nextPageToken: string | null;
}

export interface DriveTokens {
  accessToken: string;
  /** Solo la primera vez (o con prompt=consent). */
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[];
}

export class DriveApiError extends Error {
  override name = 'DriveApiError';
  constructor(
    readonly status: number,
    /** invalid_grant: Google ya no acepta el token de refresco (hay que volver a conectar). */
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DriveApi {
  authUrl(p: { clientId: string; redirectUri: string; state: string; scopes: readonly string[] }): string;
  exchangeCode(p: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<DriveTokens>;
  refresh(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<DriveTokens>;
  whoAmI(accessToken: string): Promise<{ email: string; name: string }>;
  /** Carpetas e imágenes dentro de una carpeta (`root` = Mi unidad). */
  list(accessToken: string, p: { folderId: string; pageToken?: string | null }): Promise<DriveListing>;
  get(accessToken: string, fileId: string): Promise<DriveFile>;
  /** El archivo (o su miniatura) tal cual lo da Google. */
  media(accessToken: string, file: DriveFile, variant: 'full' | 'thumb'): Promise<Response>;
}
