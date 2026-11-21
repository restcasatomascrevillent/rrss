// Lectura de métricas de Instagram (Graph API) para la analítica (Fase 5).
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL: no hay todavía aplicación de Meta. Está
// escrito contra la documentación oficial (consultada el 18/11/2026) y probado
// solo contra la Graph API simulada (../social/simulated-graph.ts):
//   · Cuenta: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
//     GET /{ig-user-id}/insights?metric=…&period=day&metric_type=total_value&since=…&until=…
//     (since/until en segundos Unix, inclusivos). Cada métrica viene en data[]
//     con total_value.value. Lo que no está disponible llega como lista vacía,
//     NO como 0: aquí se devuelve null y no se guarda nada.
//   · Seguidores: campo followers_count del nodo de la cuenta
//     (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user).
//   · Publicación: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
//     GET /{ig-media-id}/insights?metric=… → data[] con values[0].value o
//     total_value.value (periodo lifetime).
//   · Límite de llamadas (Business Use Case de Instagram): cabecera
//     X-Business-Use-Case-Usage con call_count, total_cputime, total_time (en %)
//     y estimated_time_to_regain_access (minutos). Error 80002 al pasarse.
//   · Permiso: instagram_manage_insights (además de instagram_basic y
//     pages_read_engagement con Facebook Login).
import { SocialApiError } from '../social/contract.ts';
import {
  classifyGraphError,
  DEFAULT_GRAPH_API_VERSION,
  META_GRAPH_HOST,
  type FetchLike,
} from '../social/meta-graph.ts';

/** Uso del límite de llamadas que declara Meta en la última respuesta (en %, de 0 a 100). */
export interface ApiUsage {
  callCount: number;
  totalCputime: number;
  totalTime: number;
  /** Minutos hasta recuperar el acceso, si Meta lo dice. */
  regainMinutes: number;
}

export interface InsightsResult {
  /** Métrica de la API → cifra; null si la red no la dio (lista vacía). */
  values: Record<string, number | null>;
  usage: ApiUsage | null;
}

export interface InstagramInsightsApi {
  accountFields(igUserId: string, token: string): Promise<{ followersCount: number | null; usage: ApiUsage | null }>;
  /** Cifras de un día [since, until) de la cuenta, con metric_type=total_value. */
  accountInsights(
    igUserId: string,
    token: string,
    metrics: string[],
    since: number,
    until: number,
  ): Promise<InsightsResult>;
  /** Cifras acumuladas de una publicación. */
  mediaInsights(mediaId: string, token: string, metrics: string[]): Promise<InsightsResult>;
}

export interface InsightsGraphOptions {
  fetch: FetchLike;
  apiVersion?: string;
  timeoutMs?: number;
}

/** Lee la cabecera X-Business-Use-Case-Usage: el mayor uso declarado entre sus entradas. */
export function parseUsageHeader(raw: string | null): ApiUsage | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const usage: ApiUsage = { callCount: 0, totalCputime: 0, totalTime: 0, regainMinutes: 0 };
  let found = false;
  for (const entries of Object.values(parsed as Record<string, unknown>)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      usage.callCount = Math.max(usage.callCount, n(e.call_count));
      usage.totalCputime = Math.max(usage.totalCputime, n(e.total_cputime));
      usage.totalTime = Math.max(usage.totalTime, n(e.total_time));
      usage.regainMinutes = Math.max(usage.regainMinutes, n(e.estimated_time_to_regain_access));
      found = true;
    }
  }
  return found ? usage : null;
}

type InsightsRow = {
  name?: unknown;
  total_value?: { value?: unknown };
  values?: Array<{ value?: unknown }>;
};

/** Cifra de una fila de insights: total_value.value o values[último].value; null si no es un número. */
export function insightValue(row: InsightsRow): number | null {
  const pick = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const total = pick(row.total_value?.value);
  if (total !== null) return total;
  const values = Array.isArray(row.values) ? row.values : [];
  return values.length > 0 ? pick(values[values.length - 1]?.value) : null;
}

export function createInsightsGraph(options: InsightsGraphOptions): InstagramInsightsApi {
  const version = options.apiVersion ?? DEFAULT_GRAPH_API_VERSION;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function get<T>(path: string, token: string, query: Record<string, string>) {
    const u = new URL(`${META_GRAPH_HOST}/${version}${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
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
      throw new SocialApiError({ kind: 'unexpected', message: `Respuesta no JSON de Meta (HTTP ${response.status})` });
    }
    return { body: body as T, usage };
  }

  function readInsights(body: { data?: InsightsRow[] }, metrics: string[]): Record<string, number | null> {
    const values: Record<string, number | null> = Object.fromEntries(metrics.map((m) => [m, null]));
    for (const row of Array.isArray(body.data) ? body.data : []) {
      if (typeof row.name === 'string' && row.name in values) values[row.name] = insightValue(row);
    }
    return values;
  }

  return {
    async accountFields(igUserId, token) {
      const { body, usage } = await get<{ followers_count?: unknown }>(`/${encodeURIComponent(igUserId)}`, token, {
        fields: 'followers_count,media_count',
      });
      const f = body.followers_count;
      return { followersCount: typeof f === 'number' && Number.isFinite(f) && f >= 0 ? f : null, usage };
    },
    async accountInsights(igUserId, token, metrics, since, until) {
      const { body, usage } = await get<{ data?: InsightsRow[] }>(`/${encodeURIComponent(igUserId)}/insights`, token, {
        metric: metrics.join(','),
        period: 'day',
        metric_type: 'total_value',
        since: String(Math.floor(since)),
        until: String(Math.floor(until)),
      });
      return { values: readInsights(body, metrics), usage };
    },
    async mediaInsights(mediaId, token, metrics) {
      const { body, usage } = await get<{ data?: InsightsRow[] }>(`/${encodeURIComponent(mediaId)}/insights`, token, {
        metric: metrics.join(','),
      });
      return { values: readInsights(body, metrics), usage };
    },
  };
}
