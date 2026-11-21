// Métricas de la Graph API SIMULADA (analítica, Fase 5). La enchufa
// ../social/simulated-graph.ts: responde a las rutas de insights con cifras
// DETERMINISTAS (salen de la cuenta, la métrica y el día), coherentes entre sí
// (las interacciones son la suma de me gusta, comentarios, guardados y
// compartidos) y con las mismas formas que da la documentación. Como Meta, lo
// que no hay llega como lista vacía, no como 0.
//
// No es Instagram: solo se usa en las pruebas y, en la prueba de extremo a
// extremo LOCAL, detrás de la guarda de ../social/local-test.ts.

export interface SimulatedInsightsOptions {
  /** Métricas de cuenta que la red «no da» (lista vacía, como hace Meta). */
  missingAccountMetrics?: string[];
  /** Métricas de cuenta que la red rechaza con el error 100 (no admitidas). */
  unsupportedAccountMetrics?: string[];
  /** call_count que declara la cabecera X-Business-Use-Case-Usage (en %). Por defecto, 5. */
  usageCallCount?: number;
  /**
   * Responder también por publicaciones que esta simulada no ha publicado (con
   * identificador numérico). Solo para la prueba local de extremo a extremo:
   * allí publica una función y mide otra, y cada una tiene su simulada en memoria.
   * El tipo (imagen o reel) se deduce de las métricas pedidas.
   */
  answerUnknownMedia?: boolean;
}

/** Métricas de cuenta que atiende la simulada (las de la documentación consultada el 18/11/2026). */
export const SIMULATED_ACCOUNT_METRICS = [
  'reach',
  'views',
  'accounts_engaged',
  'total_interactions',
  'likes',
  'comments',
  'saves',
  'shares',
  'replies',
  'reposts',
  'profile_links_taps',
  'follows_and_unfollows',
] as const;

/** Métricas de publicación que atiende la simulada, por tipo. */
export const SIMULATED_MEDIA_METRICS: Record<'FEED' | 'REELS', readonly string[]> = {
  FEED: ['reach', 'views', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  REELS: [
    'reach',
    'views',
    'likes',
    'comments',
    'saved',
    'shares',
    'total_interactions',
    'ig_reels_avg_watch_time',
    'ig_reels_video_view_total_time',
  ],
};

/** Número determinista entre min y max a partir de un texto (FNV-1a). */
export function simulatedNumber(seed: string, min: number, max: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return min + (h % (max - min + 1));
}

const ACCOUNT_RANGES: Record<string, [number, number]> = {
  reach: [200, 900],
  views: [400, 2000],
  accounts_engaged: [20, 120],
  likes: [20, 100],
  comments: [0, 15],
  saves: [0, 20],
  shares: [0, 15],
  replies: [0, 5],
  reposts: [0, 5],
  profile_links_taps: [0, 10],
};

/** Cifra simulada de una métrica de cuenta en un día (AAAA-MM-DD). */
export function simulatedAccountValue(igUserId: string, metric: string, day: string): number {
  if (metric === 'total_interactions') {
    return ['likes', 'comments', 'saves', 'shares'].reduce(
      (sum, m) => sum + simulatedAccountValue(igUserId, m, day),
      0,
    );
  }
  const [min, max] = ACCOUNT_RANGES[metric] ?? [0, 10];
  return simulatedNumber(`${igUserId}|${metric}|${day}`, min, max);
}

/** Seguidores simulados de una cuenta un día dado (AAAA-MM-DD). */
export function simulatedFollowers(igUserId: string, day: string): number {
  const days = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return 1000 + simulatedNumber(igUserId, 0, 500) + (days % 60) * 3;
}

/** Cifra acumulada simulada de una publicación, según los días que lleva publicada. */
export function simulatedMediaValue(mediaId: string, kind: 'FEED' | 'REELS', metric: string, ageDays: number): number {
  const grow = Math.min(1, (Math.max(0, ageDays) + 1) / 7);
  const base = (m: string, min: number, max: number) =>
    Math.round(simulatedNumber(`${mediaId}|${m}`, min, max) * grow * (kind === 'REELS' && m === 'views' ? 2 : 1));
  switch (metric) {
    case 'reach':
      return base('reach', 100, 800);
    case 'views':
      return base('views', 150, 2500);
    case 'likes':
      return base('likes', 5, 120);
    case 'comments':
      return base('comments', 0, 20);
    case 'saved':
      return base('saved', 0, 30);
    case 'shares':
      return base('shares', 0, 25);
    case 'total_interactions':
      return ['likes', 'comments', 'saved', 'shares'].reduce(
        (sum, m) => sum + simulatedMediaValue(mediaId, kind, m, ageDays),
        0,
      );
    case 'ig_reels_avg_watch_time':
      return simulatedNumber(`${mediaId}|avg`, 2000, 9000);
    case 'ig_reels_video_view_total_time':
      return simulatedMediaValue(mediaId, kind, 'views', ageDays) * simulatedNumber(`${mediaId}|avg`, 2000, 9000);
    default:
      return 0;
  }
}

/** Lo que la Graph API simulada le pasa a este módulo para atender una petición. */
export interface SimulatedInsightsRequest {
  method: string;
  /** Ruta sin la versión, en trozos: [id] o [id, 'insights']. */
  parts: string[];
  query: URLSearchParams;
  now: number;
  options: SimulatedInsightsOptions;
  /** Cuentas de Instagram que existen en la simulada. */
  igUserIds: Set<string>;
  published: Array<{ id: string; igUserId: string; kind: string; timestamp: string }>;
  /** Fallo provocado pendiente para las métricas, si lo hay (ya convertido en respuesta). */
  takeFailure(): Response | null;
  graphError(status: number, code: number, message: string, subcode?: number): Response;
}

const json = (status: number, body: unknown, owner: string, callCount: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-business-use-case-usage': JSON.stringify({
        [owner]: [
          {
            type: 'instagram',
            call_count: callCount,
            total_cputime: 1,
            total_time: 1,
            estimated_time_to_regain_access: callCount >= 100 ? 30 : 0,
          },
        ],
      }),
    },
  });

/** Atiende una ruta de métricas; null si la petición no es de métricas. */
export function handleSimulatedInsights(r: SimulatedInsightsRequest): Response | null {
  if (r.method !== 'GET') return null;
  const [id, edge] = r.parts;
  if (!id) return null;
  const callCount = r.options.usageCallCount ?? 5;
  const today = new Date(r.now).toISOString().slice(0, 10);

  // GET /{ig-user-id}/insights
  if (edge === 'insights' && r.parts.length === 2 && r.igUserIds.has(id)) {
    const failure = r.takeFailure();
    if (failure) return failure;
    const metrics = (r.query.get('metric') ?? '').split(',').filter(Boolean);
    const unknown = metrics.find(
      (m) =>
        !(SIMULATED_ACCOUNT_METRICS as readonly string[]).includes(m) ||
        (r.options.unsupportedAccountMetrics ?? []).includes(m),
    );
    if (!metrics.length || unknown) {
      return r.graphError(400, 100, `(#100) metric[${unknown ?? ''}] must be one of the following values (simulado)`);
    }
    if (r.query.get('metric_type') !== 'total_value' || r.query.get('period') !== 'day') {
      return r.graphError(400, 100, '(#100) se espera metric_type=total_value y period=day (simulado)');
    }
    const since = Number(r.query.get('since'));
    const until = Number(r.query.get('until'));
    if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
      return r.graphError(400, 100, '(#100) since/until no válidos (simulado)');
    }
    const day = new Date(since * 1000).toISOString().slice(0, 10);
    // El día de hoy todavía no tiene cifras; follows_and_unfollows no se da (cuenta con pocos seguidores).
    const data =
      day >= today
        ? []
        : metrics
            .filter((m) => !(r.options.missingAccountMetrics ?? []).includes(m) && m !== 'follows_and_unfollows')
            .map((m) => ({
              name: m,
              period: 'day',
              title: m,
              description: 'Simulado',
              total_value: { value: simulatedAccountValue(id, m, day) },
              id: `${id}/insights/${m}/day`,
            }));
    return json(200, { data }, id, callCount);
  }

  // GET /{ig-media-id}/insights
  if (edge === 'insights' && r.parts.length === 2) {
    const metricsAsked = (r.query.get('metric') ?? '').split(',');
    const media =
      r.published.find((m) => m.id === id) ??
      (r.options.answerUnknownMedia && /^[0-9]{6,30}$/.test(id)
        ? {
            id,
            igUserId: [...r.igUserIds][0] ?? '',
            kind: metricsAsked.some((m) => m.startsWith('ig_reels_')) ? 'REELS' : 'IMAGE',
            timestamp: new Date(r.now).toISOString(),
          }
        : undefined);
    if (!media) return null;
    const failure = r.takeFailure();
    if (failure) return failure;
    const kind: 'FEED' | 'REELS' = media.kind === 'REELS' ? 'REELS' : 'FEED';
    const metrics = (r.query.get('metric') ?? '').split(',').filter(Boolean);
    const unknown = metrics.find((m) => !SIMULATED_MEDIA_METRICS[kind].includes(m));
    if (!metrics.length || unknown) {
      return r.graphError(400, 100, `(#100) metric[${unknown ?? ''}] is not supported for ${kind} media (simulado)`);
    }
    const ageDays = Math.floor((r.now - Date.parse(media.timestamp)) / 86_400_000);
    return json(
      200,
      {
        data: metrics.map((m) => ({
          name: m,
          period: 'lifetime',
          values: [{ value: simulatedMediaValue(media.id, kind, m, ageDays) }],
          title: m,
          description: 'Simulado',
          id: `${media.id}/insights/${m}/lifetime`,
        })),
      },
      media.igUserId,
      callCount,
    );
  }

  // GET /{ig-user-id}?fields=followers_count…
  if (r.parts.length === 1 && r.igUserIds.has(id)) {
    const failure = r.takeFailure();
    if (failure) return failure;
    return json(
      200,
      {
        id,
        followers_count: simulatedFollowers(id, today),
        media_count: r.published.filter((m) => m.igUserId === id).length,
      },
      id,
      callCount,
    );
  }
  return null;
}
