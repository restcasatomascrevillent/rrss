// Graph API de Meta SIMULADA, para las pruebas. No es Instagram: es un `fetch`
// que responde a las mismas rutas que usa meta-graph.ts con las formas que da
// la documentación, y guarda en memoria lo «publicado» para poder comprobar
// que nada sale dos veces. Se le pueden provocar fallos (tiempo agotado justo
// después de publicar, token caducado, cupo agotado…).
//
// Solo se usa en las pruebas de Node y, en la prueba de extremo a extremo
// LOCAL, detrás de la guarda de local-test.ts. Los enlaces que inventa van a un
// dominio `.invalid` (reservado: no existe) para que nadie los confunda con
// una publicación real.
import type { FetchLike } from './meta-graph.ts';
import { handleSimulatedInsights, type SimulatedInsightsOptions } from '../analytics/simulated-insights.ts';

export const SIMULATED_IG_USER_ID = '17841400000000001';
export const SIMULATED_IG_USERNAME = 'cuenta_simulada';
export const SIMULATED_PAGE_ID = '100000000000001';
export const SIMULATED_PERMALINK_HOST = 'https://instagram.simulado.invalid';
/** CDN simulada de las imágenes del histórico (importar publicaciones). */
export const SIMULATED_CDN_HOST = 'https://scontent.simulado.invalid';
// PNG de 1×1 píxel: lo que sirve la CDN simulada.
const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export type SimulatedOperation =
  | 'container'
  | 'status'
  | 'media_publish'
  | 'limit'
  | 'media_list'
  // Descarga de una imagen de la CDN simulada.
  | 'cdn'
  // Métricas (analítica, Fase 5): insights de cuenta y de publicación, y seguidores.
  | 'insights'
  | 'any';

export interface SimulatedFailure {
  op: SimulatedOperation;
  /**
   * error: responde con el error indicado y no hace nada.
   * timeout: no responde (la operación NO se hace).
   * timeout_after: la operación SÍ se hace, pero la respuesta no llega.
   */
  mode: 'error' | 'timeout' | 'timeout_after';
  error?: { code: number; subcode?: number; message?: string; status?: number };
}

interface Container {
  id: string;
  igUserId: string;
  kind: 'IMAGE' | 'CAROUSEL_ITEM' | 'CAROUSEL' | 'REELS';
  status: 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';
  pollsLeft: number;
  caption: string;
  mediaUrl: string | null;
  altText: string | null;
  children: string[];
  createdAt: number;
}

export interface SimulatedMedia {
  id: string;
  igUserId: string;
  containerId: string;
  caption: string;
  kind: Container['kind'];
  mediaUrls: string[];
  timestamp: string;
  permalink: string;
}

/** Publicación que la cuenta ya tenía antes de la plataforma (importar publicaciones). */
export interface SimulatedExistingPost {
  id: string;
  igUserId?: string;
  caption?: string;
  mediaType?: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  productType?: 'FEED' | 'REELS' | 'STORY';
  timestamp: string;
  /** Piezas de un carrusel (cada una con su propia imagen). */
  children?: number;
}

export interface SimulatedGraphOptions {
  /** Histórico previo de la cuenta, de cualquier orden: se sirve de la más reciente a la más antigua. */
  existing?: SimulatedExistingPost[];
  /** Cabecera X-Business-Use-Case-Usage de las respuestas de /media (JSON). */
  mediaUsageHeader?: string;
  now?: () => number;
  /** Cupo que da content_publishing_limit (config.quota_total). Por defecto, 50. */
  quotaTotal?: number;
  /** Uso de partida, sumado a lo publicado en las últimas 24 h. */
  quotaUsage?: number;
  /** Consultas de estado que un reel pasa en IN_PROGRESS antes de FINISHED. Por defecto, 0. */
  reelPolls?: number;
  /** Páginas que devuelve /me/accounts. Por defecto, una con una cuenta de Instagram. */
  pages?: Array<{ id: string; name: string; instagram: { id: string; username: string } | null }>;
  /** Métricas (analítica, Fase 5): ver ../analytics/simulated-insights.ts. */
  insights?: SimulatedInsightsOptions;
}

export interface SimulatedGraph {
  fetch: FetchLike;
  /** Lo publicado, en orden. */
  readonly published: SimulatedMedia[];
  /** Contenedores creados (también los no publicados). */
  readonly containers: Map<string, Container>;
  /** Llamadas recibidas: «MÉTODO /ruta». */
  readonly calls: string[];
  fail(failure: SimulatedFailure): void;
  /** Marca un token como caducado: desde ahora responde con el error 190. */
  expireToken(token: string): void;
  setQuotaUsage(usage: number): void;
  /** Cambia desde ahora la cabecera de uso del límite de llamadas de /media (null = sin cabecera). */
  setMediaUsageHeader(header: string | null): void;
  /** Añade publicaciones previas al histórico. */
  addExisting(posts: SimulatedExistingPost[]): void;
  /** Cambia desde ahora cómo responden las métricas (analítica). */
  setInsights(options: SimulatedInsightsOptions): void;
}

class SimulatedTimeout extends Error {
  override name = 'TimeoutError';
}

let sequence = 0;
/** Identificadores numéricos, como los de Meta, que no se repiten entre llamadas. */
function nextId(): string {
  sequence += 1;
  return `${Date.now()}${String(sequence).padStart(4, '0')}`;
}

export function createSimulatedGraph(options: SimulatedGraphOptions = {}): SimulatedGraph {
  const now = options.now ?? Date.now;
  const containers = new Map<string, Container>();
  const published: SimulatedMedia[] = [];
  const calls: string[] = [];
  const failures: SimulatedFailure[] = [];
  const expired = new Set<string>();
  let baseUsage = options.quotaUsage ?? 0;
  let mediaUsageHeader: string | null = options.mediaUsageHeader ?? null;
  const existing: SimulatedExistingPost[] = [...(options.existing ?? [])];
  const defaultIg = options.pages?.[0]?.instagram?.id ?? SIMULATED_IG_USER_ID;
  let insights: SimulatedInsightsOptions = { ...(options.insights ?? {}) };
  const pages = options.pages ?? [
    {
      id: SIMULATED_PAGE_ID,
      name: 'Página simulada',
      instagram: { id: SIMULATED_IG_USER_ID, username: SIMULATED_IG_USERNAME },
    },
  ];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const graphError = (status: number, code: number, message: string, subcode?: number) =>
    json(status, { error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'SIMULADO' } });

  const takeFailure = (op: SimulatedOperation) => {
    const i = failures.findIndex((f) => f.op === op || f.op === 'any');
    return i < 0 ? null : failures.splice(i, 1)[0]!;
  };

  const tokenOf = (request: { headers: Headers; query: URLSearchParams }) =>
    /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? request.query.get('access_token') ?? '';

  /** Un token simulado vale si empieza por «sim-» y no se ha caducado a propósito. */
  const tokenOk = (token: string) => token.startsWith('sim-') && !expired.has(token);

  const usage24h = () => baseUsage + published.filter((m) => Date.parse(m.timestamp) > now() - 86_400_000).length;

  async function handle(method: string, url: URL, headers: Headers, body: URLSearchParams): Promise<Response> {
    const parts = url.pathname.split('/').filter(Boolean); // [versión, ...]
    const path = `/${parts.slice(1).join('/')}`;
    calls.push(`${method} ${path}`);
    const query = url.searchParams;

    // ── OAuth ──
    if (method === 'GET' && path === '/oauth/access_token') {
      if (!query.get('client_id') || !query.get('client_secret')) return graphError(400, 101, 'Missing client_id');
      if (query.get('grant_type') === 'fb_exchange_token') {
        const t = query.get('fb_exchange_token') ?? '';
        if (!tokenOk(t)) return graphError(400, 190, 'Invalid OAuth access token');
        return json(200, { access_token: `sim-long-${nextId()}`, token_type: 'bearer', expires_in: 5_183_944 });
      }
      const code = query.get('code') ?? '';
      if (!code.startsWith('sim-code-') || !query.get('redirect_uri')) {
        return graphError(400, 100, 'Invalid verification code format.');
      }
      return json(200, { access_token: `sim-user-${nextId()}`, token_type: 'bearer', expires_in: 5_400 });
    }
    if (method === 'GET' && path === '/debug_token') {
      const t = query.get('input_token') ?? '';
      return json(200, {
        data: {
          app_id: 'simulada',
          type: t.startsWith('sim-page-') ? 'PAGE' : 'USER',
          is_valid: tokenOk(t),
          expires_at: 0,
          data_access_expires_at: Math.floor(now() / 1000) + 90 * 86_400,
          scopes: [
            'instagram_basic',
            'instagram_content_publish',
            'pages_show_list',
            'pages_read_engagement',
            'instagram_manage_insights',
          ],
        },
      });
    }

    // Token de aplicación («App ID|App Secret»): «Probar conexión» de Meta. Vale
    // con cualquier App ID numérico salvo que el secreto empiece por «mal».
    const appToken = query.get('access_token') ?? '';
    if (method === 'GET' && parts.length === 2 && appToken.includes('|')) {
      const [appId, appSecret] = appToken.split('|');
      if (appId !== parts[1] || !appSecret || appSecret.startsWith('mal')) {
        return graphError(400, 190, 'Invalid OAuth access token signature.');
      }
      return json(200, { id: appId, name: 'Aplicación simulada' });
    }

    const token = tokenOf({ headers, query });
    if (!tokenOk(token)) {
      return graphError(401, 190, 'Error validating access token: Session has expired (simulado).', 463);
    }

    if (method === 'GET' && path === '/me/accounts') {
      return json(200, {
        data: pages.map((p) => ({
          id: p.id,
          name: p.name,
          access_token: `sim-page-${p.id}-${nextId()}`,
          ...(p.instagram
            ? { instagram_business_account: { id: p.instagram.id, username: p.instagram.username } }
            : {}),
        })),
      });
    }

    // GET /me con un token de página: la página (conectar con un token pegado).
    if (method === 'GET' && path === '/me') {
      const page = pages.find((p) => token.startsWith(`sim-page-${p.id}`)) ?? pages[0];
      return page ? json(200, { id: page.id, name: page.name }) : graphError(400, 100, 'Sin página');
    }
    // GET /{ig-user-id}?fields=id,username,name (conectar con un token pegado).
    if (method === 'GET' && parts.length === 2 && (query.get('fields') ?? '').includes('username')) {
      const ig = pages.find((p) => p.instagram?.id === parts[1])?.instagram;
      if (ig) return json(200, { id: ig.id, username: ig.username, name: `Cuenta ${ig.username}` });
    }

    // /{ig-user-id}/content_publishing_limit
    if (method === 'GET' && parts[2] === 'content_publishing_limit') {
      const failure = takeFailure('limit');
      if (failure) return failureResponse(failure);
      return json(200, {
        data: [{ quota_usage: usage24h(), config: { quota_total: options.quotaTotal ?? 50, quota_duration: 86_400 } }],
      });
    }

    // POST /{ig-user-id}/media
    if (method === 'POST' && parts.length === 3 && parts[2] === 'media') {
      const failure = takeFailure('container');
      if (failure && failure.mode !== 'timeout_after') return failureResponse(failure);
      const mediaType = body.get('media_type');
      const isItem = body.get('is_carousel_item') === 'true';
      let kind: Container['kind'];
      if (mediaType === 'CAROUSEL') {
        const children = (body.get('children') ?? '').split(',').filter(Boolean);
        if (children.length < 2 || children.length > 20 || children.some((c) => !containers.has(c))) {
          return graphError(400, 100, 'Invalid children');
        }
        kind = 'CAROUSEL';
      } else if (mediaType === 'REELS') {
        if (!body.get('video_url')) return graphError(400, 100, 'video_url is required');
        kind = 'REELS';
      } else {
        if (!body.get('image_url')) return graphError(400, 100, 'image_url is required');
        kind = isItem ? 'CAROUSEL_ITEM' : 'IMAGE';
      }
      if ((body.get('caption') ?? '').length > 2200) return graphError(400, 100, 'Caption too long', 2207010);
      const container: Container = {
        id: nextId(),
        igUserId: parts[1]!,
        kind,
        status: kind === 'REELS' && (options.reelPolls ?? 0) > 0 ? 'IN_PROGRESS' : 'FINISHED',
        pollsLeft: kind === 'REELS' ? (options.reelPolls ?? 0) : 0,
        caption: body.get('caption') ?? '',
        mediaUrl: body.get('image_url') ?? body.get('video_url'),
        altText: body.get('alt_text'),
        children: (body.get('children') ?? '').split(',').filter(Boolean),
        createdAt: now(),
      };
      containers.set(container.id, container);
      if (failure) return failureResponse(failure);
      return json(200, { id: container.id });
    }

    // POST /{ig-user-id}/media_publish
    if (method === 'POST' && parts[2] === 'media_publish') {
      const failure = takeFailure('media_publish');
      if (failure && failure.mode !== 'timeout_after') return failureResponse(failure);
      const container = containers.get(body.get('creation_id') ?? '');
      if (!container || container.igUserId !== parts[1]) {
        return graphError(400, 24, 'The media container does not exist', 2207008);
      }
      if (container.status === 'PUBLISHED') return graphError(400, 100, 'The media has already been published');
      if (container.status !== 'FINISHED') return graphError(400, 9007, 'Media is not ready to be published', 2207027);
      if (container.kind === 'CAROUSEL_ITEM') return graphError(400, 100, 'Carousel items are published in a carousel');
      if (usage24h() >= (options.quotaTotal ?? 50)) {
        return graphError(400, 9, 'Application request limit reached (simulado)', 2207042);
      }
      container.status = 'PUBLISHED';
      const id = nextId();
      const media: SimulatedMedia = {
        id,
        igUserId: container.igUserId,
        containerId: container.id,
        caption: container.caption,
        kind: container.kind,
        mediaUrls:
          container.kind === 'CAROUSEL'
            ? container.children.map((c) => containers.get(c)?.mediaUrl ?? '')
            : [container.mediaUrl ?? ''],
        timestamp: new Date(now()).toISOString(),
        permalink: `${SIMULATED_PERMALINK_HOST}/p/${id}/`,
      };
      published.push(media);
      if (failure) return failureResponse(failure);
      return json(200, { id });
    }

    // GET /{ig-user-id}/media: el histórico (previo y publicado aquí), paginado como Meta
    // (`limit`, cursor `after`; `paging.next` solo si hay otra página).
    if (method === 'GET' && parts[2] === 'media') {
      const failure = takeFailure('media_list');
      if (failure) return failureResponse(failure);
      const igUserId = parts[1]!;
      const fields = new Set((query.get('fields') ?? '').split(/[,{}]/).map((f) => f.trim()));
      const history = [
        ...published
          .filter((m) => m.igUserId === igUserId)
          .reverse()
          .map((m) => ({ ...m, product: m.kind === 'REELS' ? 'REELS' : 'FEED', previous: false as const })),
        ...existing
          .filter((e) => (e.igUserId ?? defaultIg) === igUserId)
          .map((e) => ({
            id: e.id,
            caption: e.caption ?? '',
            kind: e.mediaType ?? 'IMAGE',
            timestamp: e.timestamp,
            permalink: `${SIMULATED_PERMALINK_HOST}/p/${e.id}/`,
            product: e.productType ?? 'FEED',
            children: e.children ?? 0,
            previous: true as const,
          })),
      ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      const wanted = query.get('limit') ? Number(query.get('limit')) : 10;
      const limit = Math.max(1, Math.min(Number.isFinite(wanted) ? wanted : 10, 100));
      const offset = Number.parseInt(atob(query.get('after') ?? btoa('0')), 10);
      if (!Number.isInteger(offset) || offset < 0) return graphError(400, 100, 'Invalid cursor');
      const slice = history.slice(offset, offset + limit);
      const cdn = (id: string) => `${SIMULATED_CDN_HOST}/img/${id}.png`;
      const data = slice.map((m) => {
        const row: Record<string, unknown> = { id: m.id };
        if (fields.has('caption')) row.caption = m.caption;
        if (fields.has('timestamp')) row.timestamp = m.timestamp;
        if (fields.has('permalink')) row.permalink = m.permalink;
        if (fields.has('media_type'))
          row.media_type = m.previous
            ? m.kind
            : m.kind === 'REELS'
              ? 'VIDEO'
              : m.kind === 'CAROUSEL'
                ? 'CAROUSEL_ALBUM'
                : 'IMAGE';
        if (fields.has('media_product_type')) row.media_product_type = m.product;
        const video = m.previous ? m.kind === 'VIDEO' : m.kind === 'REELS';
        if (fields.has('media_url')) row.media_url = video ? `${SIMULATED_CDN_HOST}/video/${m.id}.mp4` : cdn(m.id);
        if (fields.has('thumbnail_url') && video) row.thumbnail_url = cdn(`${m.id}-t`);
        const kids = m.previous ? (m.children ?? 0) : m.kind === 'CAROUSEL' ? m.mediaUrls.length : 0;
        if (fields.has('children') && kids > 0) {
          row.children = {
            data: Array.from({ length: kids }, (_, i) => ({
              id: `${m.id}${i}`,
              media_type: 'IMAGE',
              // Un carrusel publicado aquí devuelve, como dirección de cada hijo, la
              // que se le dio al crearlo (Meta devolvería la de su CDN): así la prueba
              // de extremo a extremo comprueba el ORDEN en que se enviaron las páginas.
              media_url: m.previous ? cdn(`${m.id}-${i}`) : (m.mediaUrls[i] ?? cdn(`${m.id}-${i}`)),
            })),
          };
        }
        return row;
      });
      const more = offset + limit < history.length;
      const response = json(200, {
        data,
        paging: {
          cursors: { before: btoa(String(offset)), after: btoa(String(offset + limit)) },
          ...(more
            ? { next: `https://graph.facebook.com/v0/${igUserId}/media?after=${btoa(String(offset + limit))}` }
            : {}),
        },
      });
      if (mediaUsageHeader) response.headers.set('x-business-use-case-usage', mediaUsageHeader);
      return response;
    }

    // Métricas (analítica, Fase 5): ../analytics/simulated-insights.ts.
    const insightsResponse = handleSimulatedInsights({
      method,
      parts: parts.slice(1),
      query,
      now: now(),
      options: insights,
      igUserIds: new Set([
        ...pages.flatMap((p) => (p.instagram ? [p.instagram.id] : [])),
        ...published.map((m) => m.igUserId),
      ]),
      published,
      takeFailure: () => {
        const failure = takeFailure('insights');
        return failure ? failureResponse(failure) : null;
      },
      graphError,
    });
    if (insightsResponse) return insightsResponse;

    // GET /{id}?fields=…  (contenedor o publicación)
    if (method === 'GET' && parts.length === 2) {
      const id = parts[1]!;
      const container = containers.get(id);
      if (container) {
        const failure = takeFailure('status');
        if (failure) return failureResponse(failure);
        if (container.status === 'IN_PROGRESS') {
          if (container.pollsLeft <= 0) container.status = 'FINISHED';
          else container.pollsLeft -= 1;
        }
        return json(200, { id, status_code: container.status, status: container.status === 'ERROR' ? 'Error' : 'Ok' });
      }
      const media = published.find((m) => m.id === id);
      if (media)
        return json(200, { id, permalink: media.permalink, caption: media.caption, timestamp: media.timestamp });
      return graphError(400, 100, 'Unsupported get request. Object does not exist', 33);
    }

    return graphError(400, 100, `Ruta no simulada: ${method} ${path}`);
  }

  function failureResponse(failure: SimulatedFailure): Response {
    if (failure.mode === 'timeout' || failure.mode === 'timeout_after')
      throw new SimulatedTimeout('Simulado: sin respuesta');
    const e = failure.error ?? { code: 2, message: 'Service temporarily unavailable' };
    return graphError(e.status ?? 400, e.code, e.message ?? 'Error simulado', e.subcode);
  }

  const simulatedFetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.origin === SIMULATED_CDN_HOST) {
      calls.push(`GET ${url.pathname}`);
      const failure = takeFailure('cdn');
      if (failure) return failureResponse(failure);
      if (url.pathname.endsWith('.mp4'))
        return new Response('video', { status: 200, headers: { 'content-type': 'video/mp4' } });
      return new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url.origin !== 'https://graph.facebook.com') {
      throw new Error(`La Graph API simulada no atiende ${url.origin}`);
    }
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    return handle(method, url, headers, body);
  };

  return {
    fetch: simulatedFetch,
    published,
    containers,
    calls,
    fail: (failure) => failures.push(failure),
    expireToken: (token) => expired.add(token),
    setQuotaUsage: (usage) => {
      baseUsage = usage;
    },
    setMediaUsageHeader: (header) => {
      mediaUsageHeader = header;
    },
    addExisting: (posts) => {
      existing.push(...posts);
    },
    setInsights: (next) => {
      insights = { ...next };
    },
  };
}
