import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contentKeys } from '@/features/content/api';
import type {
  ContentCommentRow,
  ContentItemRow,
  MediaAssetRow,
  PublicationAttemptRow,
  ScheduledPublicationRow,
  SocialAccountRow,
} from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { HOLD_REASON_TEXT } from './calendar';

// Acceso a datos de la publicación (Fase 3): cuentas conectadas, calendario,
// intentos y comentarios de la pieza. Las reglas viven en la base de datos
// (migraciones 20261119010000 a 20261119040000): aquí solo se lee y se llama a
// sus funciones. Los tokens no llegan nunca al navegador.

export const socialKeys = {
  accounts: (brandId: string) => ['brand', brandId, 'social', 'accounts'] as const,
  calendar: (brandId: string) => ['brand', brandId, 'social', 'calendar'] as const,
  range: (brandId: string, from: string, to: string) => ['brand', brandId, 'social', 'calendar', from, to] as const,
  attempts: (brandId: string, publicationId: string) =>
    ['brand', brandId, 'social', 'attempts', publicationId] as const,
  comments: (brandId: string, contentId: string) => ['brand', brandId, 'social', 'comments', contentId] as const,
  candidates: (brandId: string) => ['brand', brandId, 'social', 'candidates'] as const,
  media: (brandId: string) => ['brand', brandId, 'social', 'media'] as const,
  contentPublication: (brandId: string, contentId: string) =>
    ['brand', brandId, 'social', 'content-publication', contentId] as const,
  contentItem: (brandId: string, contentId: string) => ['brand', brandId, 'social', 'content-item', contentId] as const,
};

// ── Cuentas conectadas ───────────────────────────────────────────────────

export function useSocialAccounts(brandId: string, enabled = true) {
  return useQuery({
    queryKey: socialKeys.accounts(brandId),
    enabled,
    queryFn: async (): Promise<SocialAccountRow[]> =>
      unwrap(
        await supabase
          .from('social_accounts')
          .select('*')
          .eq('brand_id', brandId)
          .neq('status', 'disconnected')
          .order('created_at', { ascending: false }),
      ),
  });
}

/** Empieza la conexión: devuelve la dirección del diálogo de Meta. */
export async function startSocialConnect(brandId: string, network: 'instagram'): Promise<string> {
  const { data, error } = await supabase.functions.invoke('social-connect/start', { body: { brandId, network } });
  if (error) {
    let message = 'No se pudo empezar la conexión. Inténtalo de nuevo.';
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      const body = (await context.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (body?.error?.message) message = body.error.message;
    }
    throw new Error(message);
  }
  const url = (data as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Respuesta inesperada del servidor.');
  return url;
}

export interface TokenConnectResult {
  accountId: string;
  username: string;
  expiresAt: string | null;
  dataAccessExpiresAt: string | null;
  tokenType: string | null;
  warnings: string[];
}

/**
 * Conecta la cuenta pegando un token de página de larga duración (en lugar de
 * OAuth). El servidor lo valida con Meta y lo guarda cifrado; no vuelve nunca.
 */
export function useConnectWithToken(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { igUserId: string; accessToken: string }): Promise<TokenConnectResult> => {
      const { data, error } = await supabase.functions.invoke('social-connect/token', {
        body: { brandId, network: 'instagram', igUserId: input.igUserId, accessToken: input.accessToken },
      });
      if (error) {
        let message = 'No se pudo conectar la cuenta. Inténtalo de nuevo.';
        const context = (error as { context?: Response }).context;
        if (context && typeof context.json === 'function') {
          const body = (await context.json().catch(() => null)) as { error?: { message?: string } } | null;
          if (body?.error?.message) message = body.error.message;
        }
        throw new Error(message);
      }
      return data as TokenConnectResult;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: socialKeys.accounts(brandId) });
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
    },
  });
}

export function useDisconnectAccount(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string) =>
      unwrap(await supabase.rpc('disconnect_social_account', { p_account_id: accountId })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: socialKeys.accounts(brandId) });
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
    },
  });
}

// ── Calendario ───────────────────────────────────────────────────────────

export type CalendarContent = Pick<
  ContentItemRow,
  'id' | 'title' | 'status' | 'current_version' | 'network' | 'format' | 'archived_at'
>;

export interface CalendarEntry extends ScheduledPublicationRow {
  content: CalendarContent | null;
}

/** Publicaciones del intervalo, con su pieza. Se refresca sola mientras alguna se está publicando. */
export function useCalendar(brandId: string, from: Date, to: Date) {
  return useQuery({
    queryKey: socialKeys.range(brandId, from.toISOString(), to.toISOString()),
    queryFn: async (): Promise<CalendarEntry[]> => {
      const rows = unwrap(
        await supabase
          .from('scheduled_publications')
          .select('*')
          .eq('brand_id', brandId)
          .gte('scheduled_at', from.toISOString())
          .lt('scheduled_at', to.toISOString())
          .order('scheduled_at', { ascending: true })
          .limit(1000),
      );
      const ids = [...new Set(rows.map((r) => r.content_id))];
      const contents = ids.length
        ? unwrap(
            await supabase
              .from('content_items')
              .select('id, title, status, current_version, network, format, archived_at')
              .in('id', ids),
          )
        : [];
      const byId = new Map((contents as CalendarContent[]).map((c) => [c.id, c]));
      return rows.map((r) => ({ ...r, content: byId.get(r.content_id) ?? null }));
    },
    refetchInterval: (query) =>
      (query.state.data ?? []).some((e) => e.status === 'publishing' || e.status === 'scheduled') ? 30_000 : false,
  });
}

export function usePublicationAttempts(brandId: string, publicationId: string | null) {
  return useQuery({
    queryKey: socialKeys.attempts(brandId, publicationId ?? ''),
    enabled: Boolean(publicationId),
    queryFn: async (): Promise<PublicationAttemptRow[]> =>
      unwrap(
        await supabase
          .from('publication_attempts')
          .select('*')
          .eq('publication_id', publicationId!)
          .order('attempt_no', { ascending: false })
          .limit(50),
      ),
  });
}

/** Piezas que se pueden poner en el calendario (no archivadas). */
export function useSchedulableContents(brandId: string, enabled = true) {
  return useQuery({
    queryKey: socialKeys.candidates(brandId),
    enabled,
    queryFn: async (): Promise<CalendarContent[]> =>
      unwrap(
        await supabase
          .from('content_items')
          .select('id, title, status, current_version, network, format, archived_at')
          .eq('brand_id', brandId)
          .is('archived_at', null)
          .order('updated_at', { ascending: false })
          .limit(200),
      ) as CalendarContent[],
  });
}

/** Imágenes JPEG y vídeos de la marca, para elegir lo que se publica (se filtran por procedencia aquí). */
export function usePublishableMedia(brandId: string, enabled = true) {
  return useQuery({
    queryKey: socialKeys.media(brandId),
    enabled,
    queryFn: async (): Promise<MediaAssetRow[]> =>
      unwrap(
        await supabase
          .from('media_assets')
          .select('*')
          .eq('brand_id', brandId)
          .in('mime_type', ['image/jpeg', 'video/mp4', 'video/quicktime'])
          .order('created_at', { ascending: false })
          .limit(300),
      ),
  });
}

/** Exportaciones de una pieza en una versión concreta (lo único que se publica como imagen). */
export function exportsOf(assets: MediaAssetRow[], contentId: string, version: number): MediaAssetRow[] {
  return assets.filter((a) => {
    const p = (a.provenance ?? {}) as Record<string, unknown>;
    return (
      a.mime_type === 'image/jpeg' &&
      p.type === 'export' &&
      p.content_id === contentId &&
      p.version === version &&
      p.unsaved_changes !== true
    );
  });
}

/** Página (desde 1) y páginas del documento de una exportación de un carrusel; null si es de una sola imagen. */
export function exportPageOf(asset: Pick<MediaAssetRow, 'provenance'>): { page: number; count: number } | null {
  const p = (asset.provenance ?? {}) as Record<string, unknown>;
  if (typeof p.page !== 'number' || typeof p.page_count !== 'number') return null;
  return { page: p.page, count: p.page_count };
}

/**
 * Exportaciones de una pieza y versión para publicar, ya en el orden de las
 * páginas: en un carrusel, la más reciente de cada página (de la última tanda
 * exportada, la que dice cuántas páginas tiene el documento); en un post, la
 * más reciente de una sola imagen. Null si falta alguna página. La base de
 * datos vuelve a comprobarlo con el documento de la versión.
 */
export function publishableExportsOf(
  assets: MediaAssetRow[],
  contentId: string,
  version: number,
  format: string,
): MediaAssetRow[] | null {
  const all = exportsOf(assets, contentId, version).sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (format !== 'carousel') {
    const single = all.find((a) => (exportPageOf(a)?.count ?? 1) === 1);
    return single ? [single] : null;
  }
  const latest = all.map(exportPageOf).find((page) => page !== null && page.count > 1);
  if (!latest) return null;
  const ordered: MediaAssetRow[] = [];
  for (let page = 1; page <= latest.count; page++) {
    const found = all.find((a) => {
      const info = exportPageOf(a);
      return info?.count === latest.count && info.page === page;
    });
    if (!found) return null;
    ordered.push(found);
  }
  return ordered;
}

/** Qué hace «Usar la versión aprobada» en una publicación detenida por «content_changed». */
export type ApprovedVersionPlan =
  | { ok: true; version: number; mediaAssetIds: string[] }
  | { ok: false; reason: 'not_approved' | 'no_exports'; version: number };

/**
 * Versión aprobada vigente de la pieza y sus exportaciones (en un carrusel, una
 * por página y en orden, como en ScheduleDialog). Un reel conserva su vídeo: no
 * depende de la versión. La base de datos vuelve a comprobarlo al guardar.
 */
export function approvedVersionPlan(
  content: Pick<CalendarContent, 'id' | 'status' | 'current_version' | 'format'>,
  assets: MediaAssetRow[],
  currentMediaIds: string[],
): ApprovedVersionPlan {
  const version = content.current_version;
  if (content.status !== 'approved' || version < 1) return { ok: false, reason: 'not_approved', version };
  if (content.format === 'reel') {
    return currentMediaIds.length > 0
      ? { ok: true, version, mediaAssetIds: currentMediaIds }
      : { ok: false, reason: 'no_exports', version };
  }
  const found = publishableExportsOf(assets, content.id, version, content.format);
  return found
    ? { ok: true, version, mediaAssetIds: found.map((a) => a.id) }
    : { ok: false, reason: 'no_exports', version };
}

export function videosOf(assets: MediaAssetRow[]): MediaAssetRow[] {
  return assets.filter((a) => a.kind === 'video');
}

/**
 * El montaje de una versión de un reel hecho en el editor de reels: el vídeo
 * cuya procedencia dice que sale de esa pieza y esa versión (el más reciente).
 * La publicación admite cualquier vídeo de la marca; esto solo lo propone.
 */
export function reelRenderOf(assets: MediaAssetRow[], contentId: string, version: number): MediaAssetRow | null {
  return (
    videosOf(assets)
      .filter((a) => {
        const p = (a.provenance ?? {}) as Record<string, unknown>;
        return p.content_id === contentId && Number(p.content_version) === version;
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null
  );
}

function useCalendarMutation<TInput, TData>(brandId: string, fn: (input: TInput) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
    },
  });
}

export interface SavePublicationInput {
  publicationId: string | null;
  contentId: string;
  scheduledAt: string;
  accountId: string | null;
  mediaAssetIds: string[];
  contentVersion: number | null;
}

export function useSavePublication(brandId: string) {
  return useCalendarMutation(brandId, async (input: SavePublicationInput) =>
    unwrap(
      await supabase.rpc('save_publication', {
        p_publication_id: input.publicationId,
        p_content_id: input.contentId,
        p_scheduled_at: input.scheduledAt,
        p_social_account_id: input.accountId,
        p_media_asset_ids: input.mediaAssetIds,
        p_content_version: input.contentVersion,
      }),
    ),
  );
}

export function useReschedulePublication(brandId: string) {
  return useCalendarMutation(brandId, async (input: { publicationId: string; scheduledAt: string }) =>
    unwrap(
      await supabase.rpc('reschedule_publication', {
        p_publication_id: input.publicationId,
        p_scheduled_at: input.scheduledAt,
      }),
    ),
  );
}

export function useCancelPublication(brandId: string) {
  return useCalendarMutation(brandId, async (publicationId: string) =>
    unwrap(await supabase.rpc('cancel_publication', { p_publication_id: publicationId })),
  );
}

export function useRetryPublication(brandId: string) {
  return useCalendarMutation(brandId, async (publicationId: string) =>
    unwrap(await supabase.rpc('retry_publication', { p_publication_id: publicationId })),
  );
}

// ── Aprobaciones y comentarios de la pieza ───────────────────────────────

export interface ApprovalResult {
  content_id: string;
  ok: boolean;
  message: string | null;
}

/** Aprueba varias piezas, cada una en su versión. Devuelve qué se aprobó y qué no. */
export function useApproveContents(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: { contentId: string; version: number }[]): Promise<ApprovalResult[]> =>
      unwrap(
        await supabase.rpc('approve_content_items', {
          p_items: items.map((i) => ({ content_id: i.contentId, version: i.version })),
        }),
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
      void qc.invalidateQueries({ queryKey: contentKeys.all(brandId) });
      void qc.invalidateQueries({ queryKey: ['brand', brandId, 'social', 'comments'] });
    },
  });
}

export interface CommentEntry extends ContentCommentRow {
  author: string;
}

export function useContentComments(brandId: string, contentId: string | null) {
  return useQuery({
    queryKey: socialKeys.comments(brandId, contentId ?? ''),
    enabled: Boolean(contentId),
    queryFn: async (): Promise<CommentEntry[]> => {
      const rows = unwrap(
        await supabase
          .from('content_comments')
          .select('*')
          .eq('content_id', contentId!)
          .order('created_at', { ascending: true })
          .limit(500),
      );
      const ids = [...new Set(rows.map((r) => r.author_id).filter((v): v is string => Boolean(v)))];
      const profiles = ids.length
        ? unwrap(await supabase.from('profiles').select('user_id, full_name, email').in('user_id', ids))
        : [];
      const names = new Map(profiles.map((p) => [p.user_id, p.full_name || p.email]));
      return rows.map((r) => ({ ...r, author: (r.author_id && names.get(r.author_id)) || 'Usuario' }));
    },
  });
}

export function useCommentContent(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contentId: string; body: string; version?: number | null }) =>
      unwrap(
        await supabase.rpc('comment_content_item', {
          p_content_id: input.contentId,
          p_body: input.body,
          p_version: input.version ?? null,
        }),
      ),
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: socialKeys.comments(brandId, input.contentId) });
    },
  });
}

export function useRequestChanges(brandId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contentId: string; message: string }) =>
      unwrap(
        await supabase.rpc('request_content_changes', { p_content_id: input.contentId, p_message: input.message }),
      ),
    onSettled: (_d, _e, input) => {
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
      void qc.invalidateQueries({ queryKey: contentKeys.all(brandId) });
      void qc.invalidateQueries({ queryKey: socialKeys.comments(brandId, input.contentId) });
    },
  });
}

// ── Publicar ahora ───────────────────────────────────────────────────────

/** Estados en los que la publicación ya no cambia sola: se deja de sondear. */
export const SETTLED_STATUSES = ['published', 'failed', 'planned', 'cancelled'] as const;

/** La publicación viva (no cancelada) de una pieza, o null. Con `pollMs` se vuelve a leer cada cierto tiempo (sin tiempo real). */
export function useContentPublication(
  brandId: string,
  contentId: string | null,
  enabled = true,
  pollMs: number | false = false,
) {
  return useQuery({
    queryKey: socialKeys.contentPublication(brandId, contentId ?? ''),
    enabled: enabled && Boolean(contentId),
    refetchInterval: pollMs,
    queryFn: async (): Promise<ScheduledPublicationRow | null> => {
      const rows = unwrap(
        await supabase
          .from('scheduled_publications')
          .select('*')
          .eq('content_id', contentId!)
          .neq('status', 'cancelled')
          .limit(1),
      );
      return rows[0] ?? null;
    },
  });
}

/** La pieza que se va a publicar, con su estado actual. */
export function useCalendarContent(brandId: string, contentId: string | null, enabled = true) {
  return useQuery({
    queryKey: socialKeys.contentItem(brandId, contentId ?? ''),
    enabled: enabled && Boolean(contentId),
    queryFn: async (): Promise<CalendarContent | null> => {
      const rows = unwrap(
        await supabase
          .from('content_items')
          .select('id, title, status, current_version, network, format, archived_at')
          .eq('id', contentId!)
          .limit(1),
      );
      return (rows[0] as CalendarContent | undefined) ?? null;
    },
  });
}

export interface PublishNowInput {
  contentId: string;
  accountId: string;
  mediaAssetIds: string[];
  contentVersion: number;
  publicationId: string | null;
}

/**
 * Pone la pieza en el calendario con la hora actual y la encola (todas las
 * garantías las impone la base de datos). Si no se puede, el error explica por qué.
 */
export async function publishNowRequest(input: PublishNowInput): Promise<ScheduledPublicationRow> {
  const { data, error } = await supabase.rpc('publish_publication_now', {
    p_content_id: input.contentId,
    p_social_account_id: input.accountId,
    p_media_asset_ids: input.mediaAssetIds,
    p_content_version: input.contentVersion,
    p_publication_id: input.publicationId,
  });
  if (error) {
    const reason = (error as { details?: string | null }).details as keyof typeof HOLD_REASON_TEXT | null | undefined;
    if (error.code === 'PB003' && reason && HOLD_REASON_TEXT[reason]) throw new Error(HOLD_REASON_TEXT[reason]);
    throw error;
  }
  return data as ScheduledPublicationRow;
}

/**
 * Pide al publicador que procese la cola ya, sin esperar al minuto del reloj.
 * Si falla (red, función caída), no pasa nada grave: el reloj la recoge.
 */
export async function kickPublisher(publicationId: string): Promise<void> {
  try {
    await supabase.functions.invoke('social-publish/now', { body: { publicationId } });
  } catch {
    /* el reloj de cada minuto la recogerá */
  }
}
