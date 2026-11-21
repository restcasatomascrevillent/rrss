// Lectura del histórico de publicaciones de una cuenta de Instagram (Graph API)
// para «Importar publicaciones de la cuenta» (docs/importar-publicaciones.md).
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL: no hay todavía aplicación de Meta. Está
// escrito contra la documentación oficial y probado solo contra la Graph API
// simulada (simulated-graph.ts):
//   · https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
//     GET /{ig-user-id}/media?fields=…&limit=…&after=… → data[] y paging
//     (cursors.before / cursors.after y `next` solo si hay otra página).
//   · Campos: id, caption, media_type (IMAGE, VIDEO, CAROUSEL_ALBUM),
//     media_product_type (FEED, REELS, STORY, AD), media_url, thumbnail_url
//     (solo vídeos), permalink, timestamp y children{…} de un carrusel.
//     `media_url` falta en lo marcado por derechos de autor y las direcciones
//     de la CDN caducan.
//   · Límite de llamadas: cabecera X-Business-Use-Case-Usage (insights-graph.ts).
//
// El token va en la cabecera Authorization y nunca se registra.
import { SocialApiError } from './contract.ts';
import { classifyGraphError, DEFAULT_GRAPH_API_VERSION, META_GRAPH_HOST, type FetchLike } from './meta-graph.ts';
import { parseUsageHeader, type ApiUsage } from '../analytics/insights-graph.ts';

export const IMPORT_MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}';
/** Publicaciones por página: con `children` cada una cuesta más, así que no se pide el máximo (100). */
export const IMPORT_PAGE_SIZE = 25;

export interface ImportedChild {
  id: string;
  media_type: string;
  media_url: string | null;
  thumbnail_url: string | null;
}

export interface ImportedPost {
  id: string;
  caption: string | null;
  media_type: string;
  media_product_type: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  timestamp: string | null;
  children: ImportedChild[];
}

export interface MediaPage {
  items: ImportedPost[];
  /** Cursor `after` de la página siguiente; null si no hay más. */
  nextCursor: string | null;
  usage: ApiUsage | null;
}

export interface MediaHistoryApi {
  listMedia(igUserId: string, token: string, p: { after?: string | null; limit?: number }): Promise<MediaPage>;
}

export interface ImportGraphOptions {
  fetch: FetchLike;
  apiVersion?: string;
  timeoutMs?: number;
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;

function parseChild(raw: unknown): ImportedChild | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const id = str(c.id, 100);
  if (!id) return null;
  return {
    id,
    media_type: str(c.media_type, 30) ?? 'IMAGE',
    media_url: str(c.media_url, 2000),
    thumbnail_url: str(c.thumbnail_url, 2000),
  };
}

/** Una publicación de la respuesta; null si no trae identificador. */
export function parsePost(raw: unknown): ImportedPost | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id).slice(0, 100) : null;
  if (!id) return null;
  const childrenRaw = (m.children as { data?: unknown } | undefined)?.data;
  const children = (Array.isArray(childrenRaw) ? childrenRaw : [])
    .map(parseChild)
    .filter((c): c is ImportedChild => c !== null)
    .slice(0, 20);
  return {
    id,
    caption: str(m.caption, 5000),
    media_type: str(m.media_type, 30) ?? 'IMAGE',
    media_product_type: str(m.media_product_type, 30),
    media_url: str(m.media_url, 2000),
    thumbnail_url: str(m.thumbnail_url, 2000),
    permalink: str(m.permalink, 500),
    timestamp: str(m.timestamp, 40),
    children,
  };
}

export function createImportGraph(options: ImportGraphOptions): MediaHistoryApi {
  const version = options.apiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async listMedia(igUserId, token, { after, limit }) {
      const u = new URL(`${META_GRAPH_HOST}/${version}/${encodeURIComponent(igUserId)}/media`);
      u.searchParams.set('fields', IMPORT_MEDIA_FIELDS);
      u.searchParams.set('limit', String(Math.max(1, Math.min(limit ?? IMPORT_PAGE_SIZE, 100))));
      if (after) u.searchParams.set('after', after);
      let response: Response;
      try {
        response = await options.fetch(u.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        throw new SocialApiError({
          kind: 'transient',
          message: timeout ? 'Meta no respondió a tiempo' : 'No se pudo hablar con Meta (red)',
        });
      }
      const usage = parseUsageHeader(response.headers.get('x-business-use-case-usage'));
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
        throw new SocialApiError({
          kind: 'unexpected',
          message: `Respuesta no JSON de Meta (HTTP ${response.status})`,
        });
      }
      const page = body as {
        data?: unknown[];
        paging?: { cursors?: { after?: unknown }; next?: unknown };
      };
      const items = (Array.isArray(page.data) ? page.data : []).map(parsePost).filter((p): p is ImportedPost => !!p);
      const afterCursor = page.paging?.cursors?.after;
      // Hay otra página solo si Meta da `next` (y un cursor): sin él, esta fue la última.
      const nextCursor = page.paging?.next && typeof afterCursor === 'string' && afterCursor ? afterCursor : null;
      return { items, nextCursor, usage };
    },
  };
}
