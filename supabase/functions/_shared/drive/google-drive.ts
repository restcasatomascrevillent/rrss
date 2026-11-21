// Adaptador de Google Drive (API v3) y del OAuth de Google. Escrito contra la
// documentación oficial (developers.google.com/drive/api/reference/rest/v3 y
// developers.google.com/identity/protocols/oauth2/web-server). SIN PROBAR
// contra el servicio real: falta el cliente OAuth del producto.
import {
  DriveApiError,
  FOLDER_MIME,
  type DriveApi,
  type DriveFile,
  type DriveTokens,
  type FetchLike,
} from './contract.ts';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,thumbnailLink,trashed,imageMediaMetadata(width,height)';

interface RawFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  thumbnailLink?: string;
  trashed?: boolean;
  imageMediaMetadata?: { width?: number; height?: number };
}

export function toDriveFile(raw: RawFile): DriveFile {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    mimeType: String(raw.mimeType ?? ''),
    bytes: raw.size != null && /^\d+$/.test(raw.size) ? Number(raw.size) : null,
    width: n(raw.imageMediaMetadata?.width),
    height: n(raw.imageMediaMetadata?.height),
    modifiedTime: raw.modifiedTime ?? null,
    thumbnailLink: raw.thumbnailLink ?? null,
    trashed: Boolean(raw.trashed),
  };
}

/** Identificadores de Drive: letras, cifras, guion y guion bajo. Evita inyectar en la consulta. */
export function isDriveId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'root' || /^[A-Za-z0-9_-]{10,200}$/.test(value));
}

async function failure(response: Response): Promise<DriveApiError> {
  let reason = `http_${response.status}`;
  let message = `Google respondió ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: string };
    if (typeof body.error === 'string') {
      reason = body.error;
      message = body.error_description ?? body.error;
    } else if (body.error && typeof body.error === 'object') {
      const e = body.error as { message?: string; errors?: Array<{ reason?: string }>; status?: string };
      reason = e.errors?.[0]?.reason ?? e.status ?? reason;
      message = e.message ?? message;
    }
  } catch {
    // Sin cuerpo JSON: se queda el código.
  }
  return new DriveApiError(response.status, reason, message.slice(0, 300));
}

function tokens(body: Record<string, unknown>): DriveTokens {
  if (typeof body.access_token !== 'string')
    throw new DriveApiError(502, 'bad_response', 'Google no devolvió un token');
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  };
}

export function createGoogleDrive(options: { fetch: FetchLike }): DriveApi {
  const doFetch = options.fetch;
  const authed = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

  const tokenRequest = async (form: Record<string, string>) => {
    const response = await doFetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (!response.ok) throw await failure(response);
    return tokens((await response.json()) as Record<string, unknown>);
  };

  return {
    authUrl({ clientId, redirectUri, state, scopes }) {
      const u = new URL(AUTH);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', scopes.join(' '));
      u.searchParams.set('state', state);
      // Sin «offline» y «consent» Google no da token de refresco al volver a conectar.
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('include_granted_scopes', 'true');
      return u.toString();
    },
    exchangeCode({ clientId, clientSecret, redirectUri, code }) {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      });
    },
    refresh({ clientId, clientSecret, refreshToken }) {
      return tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
    },
    async whoAmI(accessToken) {
      const response = await doFetch(`${API}/about?fields=user(emailAddress,displayName)`, {
        headers: authed(accessToken),
      });
      if (!response.ok) throw await failure(response);
      const body = (await response.json()) as { user?: { emailAddress?: string; displayName?: string } };
      if (!body.user?.emailAddress) throw new DriveApiError(502, 'bad_response', 'Google no dijo qué cuenta es');
      return { email: body.user.emailAddress, name: body.user.displayName ?? '' };
    },
    async list(accessToken, { folderId, pageToken }) {
      if (!isDriveId(folderId)) throw new DriveApiError(400, 'bad_request', 'Carpeta no válida');
      const u = new URL(`${API}/files`);
      u.searchParams.set(
        'q',
        `'${folderId}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or mimeType contains 'image/')`,
      );
      u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
      u.searchParams.set('orderBy', 'folder,name_natural');
      u.searchParams.set('pageSize', '100');
      u.searchParams.set('supportsAllDrives', 'true');
      u.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const response = await doFetch(u.toString(), { headers: authed(accessToken) });
      if (!response.ok) throw await failure(response);
      const body = (await response.json()) as { files?: RawFile[]; nextPageToken?: string };
      return { files: (body.files ?? []).map(toDriveFile), nextPageToken: body.nextPageToken ?? null };
    },
    async get(accessToken, fileId) {
      if (!isDriveId(fileId) || fileId === 'root') throw new DriveApiError(400, 'bad_request', 'Archivo no válido');
      const response = await doFetch(
        `${API}/files/${fileId}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
        { headers: authed(accessToken) },
      );
      if (!response.ok) throw await failure(response);
      return toDriveFile((await response.json()) as RawFile);
    },
    async media(accessToken, file, variant) {
      if (variant === 'thumb' && file.thumbnailLink) {
        // La miniatura de Google admite el tamaño al final (=s220 por defecto).
        const link = file.thumbnailLink.replace(/=s\d+(-c)?$/, '=s480');
        const thumb = await doFetch(link, { headers: authed(accessToken) });
        if (thumb.ok) return thumb;
        await thumb.arrayBuffer().catch(() => undefined);
      }
      const response = await doFetch(`${API}/files/${file.id}?alt=media&supportsAllDrives=true`, {
        headers: authed(accessToken),
      });
      if (!response.ok) throw await failure(response);
      return response;
    },
  };
}
