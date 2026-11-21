// Adaptador de Meta (Instagram API con Facebook Login for Business).
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL: no hay todavía aplicación de Meta. Está
// escrito contra la documentación oficial (consultada el 19/11/2026) y probado
// solo contra la Graph API simulada (simulated-graph.ts), que responde a las
// mismas rutas y con las mismas formas:
//   · Publicar: https://developers.facebook.com/docs/instagram-platform/content-publishing
//     POST /{ig-user-id}/media → contenedor; GET /{container}?fields=status_code
//     (EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED); POST
//     /{ig-user-id}/media_publish con creation_id. Carrusel: hijos con
//     is_carousel_item=true y contenedor media_type=CAROUSEL con children
//     (hasta 20; la aplicación admite 10). Reel: media_type=REELS + video_url.
//     Host graph.facebook.com con el token de la página (Facebook Login).
//   · Parámetros: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
//     caption ≤ 2200, alt_text ≤ 1000 (solo imágenes), JPEG ≤ 8 MB.
//   · Cupo: GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config
//     (config.quota_total, config.quota_duration).
//   · OAuth: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
//     diálogo www.facebook.com/{v}/dialog/oauth (client_id, redirect_uri, state,
//     response_type=code, scope o config_id de Login for Business) y
//     GET /oauth/access_token con el código.
//   · Token largo: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
//     grant_type=fb_exchange_token (unos 60 días); GET /me/accounts da los
//     tokens de página, que no caducan si salen de un token largo.
//
// Los tokens van en la cabecera Authorization, salvo donde la documentación los
// pone en la consulta (intercambio y debug_token). Nunca se registran.
import {
  SocialApiError,
  type ContainerInfo,
  type InstagramApi,
  type MetaLoginApi,
  type PageWithInstagram,
  type PublishedMedia,
  type PublishingLimit,
  type SelfTokenInfo,
  type TokenConnectApi,
  type TokenInfo,
} from './contract.ts';

export const META_GRAPH_HOST = 'https://graph.facebook.com';
export const META_DIALOG_HOST = 'https://www.facebook.com';
/** Versión de la Graph API por defecto (la de los ejemplos de la documentación consultada). */
export const DEFAULT_GRAPH_API_VERSION = 'v27.0';
/** Permisos mínimos para publicar en Instagram con Facebook Login (documentación de publicación). */
export const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  // Analítica (Fase 5): leer las métricas de la cuenta y de sus publicaciones.
  'instagram_manage_insights',
];

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MetaGraphOptions {
  fetch: FetchLike;
  apiVersion?: string;
  /** Tiempo máximo por petición (ms). Por defecto, 30 s. */
  timeoutMs?: number;
}

/** Clasifica un error de la Graph API (código y subcódigo documentados). */
export function classifyGraphError(httpStatus: number, body: unknown): SocialApiError {
  const error = (body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : null) as {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    is_transient?: unknown;
  } | null;
  const code = typeof error?.code === 'number' ? error.code : null;
  const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : null;
  const raw = typeof error?.message === 'string' ? error.message : `HTTP ${httpStatus}`;
  const message = raw.slice(0, 300);
  const base = { code, subcode, httpStatus };
  if (code === 190 || code === 102) return new SocialApiError({ kind: 'token', message, ...base });
  if (subcode === 2207042 || code === 9) return new SocialApiError({ kind: 'publish_limit', message, ...base });
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== null && code >= 80000 && code <= 80099)) {
    return new SocialApiError({ kind: 'rate_limited', message, ...base });
  }
  if (code === 1 || code === 2 || error?.is_transient === true || httpStatus >= 500) {
    return new SocialApiError({ kind: 'transient', message, ...base, dubious: true });
  }
  if (!error) return new SocialApiError({ kind: 'unexpected', message, ...base });
  return new SocialApiError({ kind: 'rejected', message, ...base });
}

export function createMetaGraph(options: MetaGraphOptions): InstagramApi & MetaLoginApi & TokenConnectApi {
  const version = options.apiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const url = (path: string, query: Record<string, string> = {}) => {
    const u = new URL(`${META_GRAPH_HOST}/${version}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  };

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    p: { token?: string; query?: Record<string, string>; form?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (p.token) headers.Authorization = `Bearer ${p.token}`;
    const init: RequestInit = { method, headers };
    if (p.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(p.form).toString();
    }
    let response: Response;
    try {
      response = await options.fetch(url(path, p.query), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new SocialApiError({
        kind: 'transient',
        message: timeout ? 'Meta no respondió a tiempo' : 'No se pudo hablar con Meta (red)',
        dubious: true,
      });
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
      throw classifyGraphError(response.status, body);
    }
    if (body === null || typeof body !== 'object') {
      throw new SocialApiError({ kind: 'unexpected', message: `Respuesta no JSON de Meta (HTTP ${response.status})` });
    }
    return body as T;
  }

  const idOf = (r: { id?: unknown }, what: string): string => {
    if (typeof r.id !== 'string' && typeof r.id !== 'number') {
      throw new SocialApiError({ kind: 'unexpected', message: `Meta no devolvió el identificador ${what}` });
    }
    return String(r.id);
  };

  const at = (seconds: unknown): number | null => (typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null);

  return {
    // ── Conexión (OAuth) ──────────────────────────────────────────────────
    dialogUrl({ appId, redirectUri, state, configId, scopes }) {
      const u = new URL(`${META_DIALOG_HOST}/${version}/dialog/oauth`);
      u.searchParams.set('client_id', appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      // Con Facebook Login for Business, la configuración (config_id) fija los permisos.
      if (configId) u.searchParams.set('config_id', configId);
      else u.searchParams.set('scope', scopes.join(','));
      return u.toString();
    },
    async exchangeCode({ appId, appSecret, redirectUri, code }) {
      const r = await call<{ access_token?: string; expires_in?: number }>('GET', '/oauth/access_token', {
        query: { client_id: appId, redirect_uri: redirectUri, client_secret: appSecret, code },
      });
      if (!r.access_token) throw new SocialApiError({ kind: 'unexpected', message: 'Meta no devolvió el token' });
      return { accessToken: r.access_token, expiresIn: typeof r.expires_in === 'number' ? r.expires_in : null };
    },
    async exchangeLongLived({ appId, appSecret, token }) {
      const r = await call<{ access_token?: string; expires_in?: number }>('GET', '/oauth/access_token', {
        query: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: token,
        },
      });
      if (!r.access_token) throw new SocialApiError({ kind: 'unexpected', message: 'Meta no devolvió el token largo' });
      return { accessToken: r.access_token, expiresIn: typeof r.expires_in === 'number' ? r.expires_in : null };
    },
    async pagesWithInstagram(userToken): Promise<PageWithInstagram[]> {
      const r = await call<{
        data?: Array<{
          id?: string;
          name?: string;
          access_token?: string;
          instagram_business_account?: { id?: string; username?: string; name?: string };
        }>;
      }>('GET', '/me/accounts', {
        token: userToken,
        query: { fields: 'id,name,access_token,instagram_business_account{id,username,name}', limit: '100' },
      });
      return (r.data ?? [])
        .filter((p) => p.id && p.access_token)
        .map((p) => ({
          pageId: String(p.id),
          pageName: p.name ?? null,
          pageAccessToken: String(p.access_token),
          instagram: p.instagram_business_account?.id
            ? {
                id: String(p.instagram_business_account.id),
                username: p.instagram_business_account.username ?? null,
                name: p.instagram_business_account.name ?? null,
              }
            : null,
        }));
    },
    async debugToken({ appId, appSecret, token }): Promise<TokenInfo> {
      const r = await call<{
        data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] };
      }>('GET', '/debug_token', { query: { input_token: token, access_token: `${appId}|${appSecret}` } });
      const d = r.data ?? {};
      return {
        isValid: d.is_valid === true,
        expiresAt: at(d.expires_at),
        dataAccessExpiresAt: at(d.data_access_expires_at),
        scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
      };
    },

    // ── Conectar con un token pegado ─────────────────────────────────────
    // https://developers.facebook.com/docs/graph-api/reference/debug_token:
    // access_token puede ser el propio token inspeccionado.
    async inspectToken(token): Promise<SelfTokenInfo> {
      const r = await call<{
        data?: {
          is_valid?: boolean;
          expires_at?: number;
          data_access_expires_at?: number;
          scopes?: string[];
          type?: string;
          app_id?: string | number;
        };
      }>('GET', '/debug_token', { query: { input_token: token, access_token: token } });
      const d = r.data ?? {};
      return {
        isValid: d.is_valid === true,
        expiresAt: at(d.expires_at),
        dataAccessExpiresAt: at(d.data_access_expires_at),
        scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
        type: typeof d.type === 'string' ? d.type : null,
        appId: d.app_id !== undefined && d.app_id !== null ? String(d.app_id) : null,
      };
    },
    async tokenOwner(token) {
      const r = await call<{ id?: string; name?: string }>('GET', '/me', { token, query: { fields: 'id,name' } });
      return { id: idOf(r, 'del dueño del token'), name: typeof r.name === 'string' ? r.name : null };
    },
    async instagramAccount(igUserId, token) {
      const r = await call<{ id?: string; username?: string; name?: string }>(
        'GET',
        `/${encodeURIComponent(igUserId)}`,
        { token, query: { fields: 'id,username,name' } },
      );
      return {
        id: idOf(r, 'de la cuenta de Instagram'),
        username: typeof r.username === 'string' ? r.username : null,
        name: typeof r.name === 'string' ? r.name : null,
      };
    },

    // ── Publicación ──────────────────────────────────────────────────────
    async publishingLimit(igUserId, token): Promise<PublishingLimit> {
      const r = await call<{
        data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }>;
      }>('GET', `/${encodeURIComponent(igUserId)}/content_publishing_limit`, {
        token,
        query: { fields: 'quota_usage,config' },
      });
      const row = r.data?.[0];
      if (!row || typeof row.quota_usage !== 'number') {
        throw new SocialApiError({ kind: 'unexpected', message: 'content_publishing_limit no devolvió quota_usage' });
      }
      return {
        usage: row.quota_usage,
        total: typeof row.config?.quota_total === 'number' ? row.config.quota_total : null,
        durationSeconds: typeof row.config?.quota_duration === 'number' ? row.config.quota_duration : null,
      };
    },
    async createImageContainer(igUserId, token, { imageUrl, caption, altText }) {
      const form: Record<string, string> = { image_url: imageUrl };
      if (caption) form.caption = caption;
      if (altText) form.alt_text = altText;
      return idOf(await call('POST', `/${encodeURIComponent(igUserId)}/media`, { token, form }), 'del contenedor');
    },
    async createCarouselItem(igUserId, token, { imageUrl, altText }) {
      const form: Record<string, string> = { image_url: imageUrl, is_carousel_item: 'true' };
      if (altText) form.alt_text = altText;
      return idOf(await call('POST', `/${encodeURIComponent(igUserId)}/media`, { token, form }), 'de la imagen');
    },
    async createCarouselContainer(igUserId, token, { children, caption }) {
      const form: Record<string, string> = { media_type: 'CAROUSEL', children: children.join(',') };
      if (caption) form.caption = caption;
      return idOf(await call('POST', `/${encodeURIComponent(igUserId)}/media`, { token, form }), 'del carrusel');
    },
    async createReelContainer(igUserId, token, { videoUrl, caption, shareToFeed }) {
      const form: Record<string, string> = {
        media_type: 'REELS',
        video_url: videoUrl,
        share_to_feed: shareToFeed === false ? 'false' : 'true',
      };
      if (caption) form.caption = caption;
      return idOf(await call('POST', `/${encodeURIComponent(igUserId)}/media`, { token, form }), 'del reel');
    },
    async containerStatus(containerId, token): Promise<ContainerInfo> {
      const r = await call<{ id?: string; status_code?: string; status?: string }>(
        'GET',
        `/${encodeURIComponent(containerId)}`,
        { token, query: { fields: 'status_code,status' } },
      );
      return {
        id: String(r.id ?? containerId),
        status: r.status_code ?? 'UNKNOWN',
        detail: typeof r.status === 'string' ? r.status.slice(0, 300) : null,
      };
    },
    async mediaPublish(igUserId, token, creationId) {
      return idOf(
        await call('POST', `/${encodeURIComponent(igUserId)}/media_publish`, {
          token,
          form: { creation_id: creationId },
        }),
        'de la publicación',
      );
    },
    async recentMedia(igUserId, token): Promise<PublishedMedia[]> {
      const r = await call<{
        data?: Array<{ id?: string; caption?: string; timestamp?: string; permalink?: string }>;
      }>('GET', `/${encodeURIComponent(igUserId)}/media`, {
        token,
        query: { fields: 'id,caption,timestamp,permalink', limit: '10' },
      });
      return (r.data ?? [])
        .filter((m) => m.id)
        .map((m) => ({
          id: String(m.id),
          caption: m.caption ?? null,
          timestamp: m.timestamp ?? null,
          permalink: m.permalink ?? null,
        }));
    },
    async permalink(mediaId, token) {
      const r = await call<{ permalink?: string }>('GET', `/${encodeURIComponent(mediaId)}`, {
        token,
        query: { fields: 'permalink' },
      });
      return typeof r.permalink === 'string' ? r.permalink : null;
    },
  };
}
