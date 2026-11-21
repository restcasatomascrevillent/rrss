// Lógica de la Edge Function `drive-media` (docs/biblioteca-drive.md):
//
//   POST …/drive-media/start      sesión de quien administra la organización → { url } de Google
//   GET  …/drive-media/callback   vuelta de Google (sin sesión: la autentica el estado anti-CSRF)
//   POST …/drive-media/browse     sesión de quien edita la marca → carpetas e imágenes de una carpeta
//   POST …/drive-media/import     sesión de quien edita la marca → alta en la biblioteca
//   POST …/drive-media/sign       sesión (RLS: solo recursos que ve) o clave de servicio →
//                                 direcciones firmadas de las imágenes
//   GET  …/drive-media/file/<firma>   la imagen (o su miniatura), sin sesión
//
// En config.toml lleva `verify_jwt = false`: Google vuelve sin JWT y las
// imágenes se piden sin cabeceras. Cada ruta comprueba lo suyo: la sesión con
// RPC que se ejecutan con el token de la persona (la base de datos decide), y
// las imágenes con la firma (tickets.ts), que solo se da tras comprobar la RLS.
import type { RpcClient } from '../_shared/ai/contract.ts';
import { DRIVE_IMAGE_MIME_TYPES, DriveApiError, FOLDER_MIME, type DriveFile } from '../_shared/drive/contract.ts';
import type { DriveConfig } from '../_shared/drive/config.ts';
import { isDriveId } from '../_shared/drive/google-drive.ts';
import { signTicket, verifyTicket, type Variant } from '../_shared/drive/tickets.ts';
import { decryptToken, encryptToken } from '../_shared/social/crypto.ts';

/** Recurso de Drive tal como lo ve quien pregunta (por RLS) o el servidor. */
export interface DriveAssetRef {
  storage_path: string;
  drive_connection_id: string | null;
  drive_file_id: string | null;
}

export interface DriveMediaDeps {
  config: DriveConfig;
  /** RPC con la clave de servicio. */
  rpc: RpcClient;
  /** RPC con la sesión de la persona (su JWT). */
  userRpc(accessToken: string): RpcClient;
  /** Recursos de Drive con esas rutas que VE quien llama (RLS), o todos si es el servidor (token null). */
  assetsForPaths(accessToken: string | null, paths: string[]): Promise<DriveAssetRef[]>;
  /** ¿Es la clave de servicio? (el trabajador de medios firma así). */
  isServiceToken(token: string): boolean;
  allowedOrigin?: string;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const DRIVE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/drive\/[A-Za-z0-9_-]{10,200}$/i;
const UUID = /^[0-9a-f-]{36}$/i;

export const bindingFor = (organizationId: string, email: string) =>
  `rrss.drive-token.v1|${organizationId}|${email.toLowerCase()}`;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fromRpcError(error: { code?: string; message: string }): HttpError {
  if (error.code === '42501' || error.code === '28000') return new HttpError(403, 'forbidden', error.message);
  return new HttpError(400, 'refused', error.message);
}

export function isSupportedImage(mimeType: string): boolean {
  return (DRIVE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function createDriveMediaHandler(deps: DriveMediaDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  // Las imágenes se piden desde <img crossorigin>, Konva y el trabajador: la
  // firma ya es la autorización, así que cualquier origen puede leerlas.
  const fileCors = { 'access-control-allow-origin': '*' };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  // Tokens de acceso por conexión, en memoria de la función (duran una hora).
  const accessTokens = new Map<string, { token: string; until: number }>();

  async function accessTokenFor(connectionId: string): Promise<string> {
    const cached = accessTokens.get(connectionId);
    if (cached && cached.until > now()) return cached.token;
    const { config } = deps;
    if (!config.client || !config.keyRing) {
      throw new HttpError(503, 'not_configured', 'Google Drive no está configurado en este entorno.');
    }
    const secret = (await deps.rpc('drive_connection_token', { p_connection_id: connectionId })).data as {
      organization_id: string;
      account_email: string;
      key_id: string;
      refresh_token_ciphertext: string;
    } | null;
    if (!secret) throw new HttpError(409, 'not_connected', 'Google Drive no está conectado: vuelve a conectarlo.');
    const refreshToken = await decryptToken(
      config.keyRing,
      secret.key_id,
      secret.refresh_token_ciphertext,
      bindingFor(secret.organization_id, secret.account_email),
    );
    try {
      const tokens = await config.drive.refresh({ ...config.client, refreshToken });
      accessTokens.set(connectionId, {
        token: tokens.accessToken,
        until: now() + Math.max(60, tokens.expiresInSeconds - 120) * 1000,
      });
      return tokens.accessToken;
    } catch (e) {
      if (e instanceof DriveApiError && e.reason === 'invalid_grant') {
        await deps.rpc('drive_connection_report', {
          p_connection_id: connectionId,
          p_status: 'needs_reauth',
          p_last_error: 'Google ya no acepta el acceso: vuelve a conectar Google Drive.',
        });
        throw new HttpError(409, 'needs_reauth', 'Google ya no acepta el acceso: vuelve a conectar Google Drive.');
      }
      throw e;
    }
  }

  const bearer = (request: Request) =>
    /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim() ?? null;

  async function body(request: Request): Promise<Record<string, unknown>> {
    try {
      const parsed = (await request.json()) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, 'bad_request', 'Cuerpo no válido.');
    }
  }

  async function connectionFor(token: string, brandId: unknown, connectionId: unknown) {
    if (typeof brandId !== 'string' || !UUID.test(brandId)) throw new HttpError(400, 'bad_request', 'Falta la marca.');
    if (connectionId != null && (typeof connectionId !== 'string' || !UUID.test(connectionId))) {
      throw new HttpError(400, 'bad_request', 'Conexión no válida.');
    }
    const { data, error } = await deps.userRpc(token)('drive_connection_for_brand', {
      p_brand_id: brandId,
      p_connection_id: connectionId ?? null,
    });
    if (error) throw fromRpcError(error);
    return data as { id: string; organization_id: string; account_email: string; user_id: string };
  }

  async function ticketsFor(connectionId: string, fileId: string) {
    const ring = deps.config.keyRing!;
    const t = Math.floor(now() / 1000);
    return {
      full: await signTicket(ring, { connectionId, fileId, variant: 'full' }, t),
      thumb: await signTicket(ring, { connectionId, fileId, variant: 'thumb' }, t),
    };
  }

  // ── Rutas ──

  async function start(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Hace falta iniciar sesión.');
    const { config } = deps;
    if (!config.client || !config.callbackUrl || !config.keyRing || !config.appUrl) {
      throw new HttpError(503, 'not_configured', 'Google Drive no está configurado en este entorno.');
    }
    const input = await body(request);
    if (typeof input.organizationId !== 'string' || !UUID.test(input.organizationId)) {
      throw new HttpError(400, 'bad_request', 'Falta la organización.');
    }
    const { data, error } = await deps.userRpc(token)('drive_oauth_begin', { p_organization_id: input.organizationId });
    if (error) throw fromRpcError(error);
    const url = config.drive.authUrl({
      clientId: config.client.clientId,
      redirectUri: config.callbackUrl,
      state: String(data),
      scopes: config.scopes,
    });
    return json(200, { url });
  }

  async function callback(url: URL): Promise<Response> {
    const { config } = deps;
    const appUrl = config.appUrl ?? '';
    const back = (org: string | null, result: string) =>
      new Response(null, {
        status: 302,
        headers: {
          location: org ? `${appUrl}/o/${org}/ajustes/drive?drive=${result}` : `${appUrl}/?drive=${result}`,
          'cache-control': 'no-store',
        },
      });
    if (!config.client || !config.callbackUrl || !config.keyRing) return back(null, 'failed');
    const consumed = await deps.rpc('drive_oauth_consume', { p_state: url.searchParams.get('state') ?? '' });
    if (consumed.error) {
      log('state_rejected', { code: consumed.error.code });
      return back(null, consumed.error.code === '42501' ? 'forbidden' : 'expired');
    }
    const ctx = consumed.data as { organization_id: string; user_id: string };
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) return back(ctx.organization_id, 'denied');
    try {
      const tokens = await config.drive.exchangeCode({ ...config.client, redirectUri: config.callbackUrl, code });
      if (!tokens.refreshToken) return back(ctx.organization_id, 'failed');
      if (!tokens.scopes.some((s) => s.endsWith('/auth/drive.readonly') || s.endsWith('/auth/drive'))) {
        return back(ctx.organization_id, 'denied');
      }
      const who = await config.drive.whoAmI(tokens.accessToken);
      const sealed = await encryptToken(
        config.keyRing,
        tokens.refreshToken,
        bindingFor(ctx.organization_id, who.email),
      );
      const saved = await deps.rpc('drive_connection_save', {
        p_user_id: ctx.user_id,
        p_organization_id: ctx.organization_id,
        p_account_email: who.email,
        p_display_name: who.name,
        p_scopes: tokens.scopes,
        p_key_id: sealed.keyId,
        p_refresh_token_ciphertext: sealed.ciphertext,
      });
      if (saved.error) {
        log('save_failed', { code: saved.error.code });
        return back(ctx.organization_id, saved.error.code === '42501' ? 'forbidden' : 'failed');
      }
      accessTokens.delete((saved.data as { id: string }).id);
      return back(ctx.organization_id, 'connected');
    } catch (e) {
      log('google_failed', { name: (e as Error)?.name, message: (e as Error)?.message?.slice(0, 200) });
      return back(ctx.organization_id, 'failed');
    }
  }

  async function browse(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Hace falta iniciar sesión.');
    const input = await body(request);
    const connection = await connectionFor(token, input.brandId, input.connectionId);
    const folderId = input.folderId ?? 'root';
    if (!isDriveId(folderId)) throw new HttpError(400, 'bad_request', 'Carpeta no válida.');
    const pageToken = typeof input.pageToken === 'string' && input.pageToken.length <= 2000 ? input.pageToken : null;
    const access = await accessTokenFor(connection.id);
    const listing = await deps.config.drive.list(access, { folderId, pageToken });
    const items = [];
    for (const f of listing.files) {
      const isFolder = f.mimeType === FOLDER_MIME;
      const supported = !isFolder && isSupportedImage(f.mimeType);
      items.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        isFolder,
        supported,
        bytes: f.bytes,
        width: f.width,
        height: f.height,
        thumbTicket: supported ? (await ticketsFor(connection.id, f.id)).thumb : null,
      });
    }
    return json(200, {
      connection: { id: connection.id, accountEmail: connection.account_email },
      folderId,
      items,
      nextPageToken: listing.nextPageToken,
    });
  }

  async function importFiles(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Hace falta iniciar sesión.');
    const input = await body(request);
    const connection = await connectionFor(token, input.brandId, input.connectionId);
    const ids = Array.isArray(input.fileIds) ? [...new Set(input.fileIds)] : [];
    if (ids.length === 0 || ids.length > 100 || !ids.every((id) => isDriveId(id) && id !== 'root')) {
      throw new HttpError(400, 'bad_request', 'Elige entre 1 y 100 imágenes.');
    }
    const folder = typeof input.folder === 'string' ? input.folder.trim().slice(0, 200) : '';
    const access = await accessTokenFor(connection.id);
    const files: DriveFile[] = [];
    for (const id of ids as string[]) {
      // Los metadatos se leen de Google: lo que diga el navegador no cuenta.
      const file = await deps.config.drive.get(access, id);
      if (file.trashed || !isSupportedImage(file.mimeType)) {
        throw new HttpError(
          422,
          'unsupported',
          `«${file.name}» no se puede añadir: solo imágenes JPEG, PNG, WebP o GIF (las HEIC del móvil hay que convertirlas antes).`,
        );
      }
      files.push(file);
    }
    const { data, error } = await deps.rpc('drive_assets_import', {
      p_user_id: connection.user_id,
      p_brand_id: input.brandId,
      p_connection_id: connection.id,
      p_files: files.map((f) => ({
        id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        bytes: f.bytes ?? 0,
        width: f.width,
        height: f.height,
      })),
      p_folder: folder,
      p_tags: [],
    });
    if (error) throw fromRpcError(error);
    return json(200, { assets: data });
  }

  async function sign(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Hace falta iniciar sesión.');
    if (!deps.config.keyRing)
      throw new HttpError(503, 'not_configured', 'Google Drive no está configurado en este entorno.');
    const input = await body(request);
    const paths = Array.isArray(input.paths) ? [...new Set(input.paths)] : [];
    if (paths.length > 500 || !paths.every((p) => typeof p === 'string' && DRIVE_PATH.test(p))) {
      throw new HttpError(400, 'bad_request', 'Rutas no válidas.');
    }
    const assets = paths.length
      ? await deps.assetsForPaths(deps.isServiceToken(token) ? null : token, paths as string[])
      : [];
    const urls: Record<string, { full: string; thumb: string }> = {};
    for (const asset of assets) {
      if (!asset.drive_connection_id || !asset.drive_file_id) continue;
      urls[asset.storage_path] = await ticketsFor(asset.drive_connection_id, asset.drive_file_id);
    }
    return json(200, { tickets: urls });
  }

  async function file(ticket: string): Promise<Response> {
    const ring = deps.config.keyRing;
    if (!ring) return new Response(null, { status: 503, headers: fileCors });
    const target = await verifyTicket(ring, ticket, Math.floor(now() / 1000));
    if (!target) return new Response(null, { status: 403, headers: { ...fileCors, 'cache-control': 'no-store' } });
    const access = await accessTokenFor(target.connectionId);
    const meta = await deps.config.drive.get(access, target.fileId);
    if (meta.trashed) return new Response(null, { status: 404, headers: fileCors });
    const upstream = await deps.config.drive.media(access, meta, target.variant as Variant);
    const type = upstream.headers.get('content-type') ?? meta.mimeType;
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...fileCors,
        'content-type': type.startsWith('image/') ? type : 'application/octet-stream',
        // Privada: la dirección firmada es de una persona; caduca con la firma.
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  }

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const route = url.pathname.replace(/\/+$/, '').split('/drive-media')[1] ?? '';
    try {
      if (route === '/callback' && request.method === 'GET') return await callback(url);
      if (route.startsWith('/file/') && request.method === 'GET') return await file(decodeURIComponent(route.slice(6)));
      if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
      if (route === '/start') return await start(request);
      if (route === '/browse') return await browse(request);
      if (route === '/import') return await importFiles(request);
      if (route === '/sign') return await sign(request);
      return json(404, { error: { code: 'not_found' } });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof DriveApiError) {
        log('drive_failed', { status: e.status, reason: e.reason });
        const status = e.status === 404 ? 404 : e.status === 403 ? 403 : 502;
        return json(status, {
          error: {
            code: 'drive_failed',
            message:
              status === 404
                ? 'Ese archivo ya no está en Google Drive.'
                : 'Google Drive no respondió como se esperaba.',
          },
        });
      }
      log('internal', { name: (e as Error)?.name });
      return json(500, { error: { code: 'internal', message: 'No se pudo completar la operación.' } });
    }
  };
}
