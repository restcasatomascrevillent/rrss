import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contentKeys } from '@/features/content/api';
import { isKnownTarget } from '@/features/content/networks';
import { keys as orgKeys } from '@/features/orgs/api';
import type {
  BrandAiMode,
  ContentRequestCommentRow,
  ContentRequestRow,
  ContentRequestStatus,
} from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

// Acceso a datos de los encargos de una marca (content_requests) y de su
// conversación (content_request_comments). Las reglas viven en la base de datos
// (migración 20261118230000); aquí solo se valida lo que conviene decir antes
// de ir al servidor.

export const MAX_REFERENCE_ASSETS = 20;

export const requestKeys = {
  all: (brandId: string) => ['brand', brandId, 'requests'] as const,
  list: (brandId: string, status: ContentRequestStatus | '') => ['brand', brandId, 'requests', 'list', status] as const,
  item: (brandId: string, requestId: string) => ['brand', brandId, 'requests', 'item', requestId] as const,
  thread: (brandId: string, requestId: string) => ['brand', brandId, 'requests', 'thread', requestId] as const,
  forContent: (brandId: string, contentId: string) => ['brand', brandId, 'requests', 'content', contentId] as const,
};

// ── Lectura ──────────────────────────────────────────────────────────────

export function useRequests(brandId: string, status: ContentRequestStatus | '' = '') {
  return useQuery({
    queryKey: requestKeys.list(brandId, status),
    queryFn: async (): Promise<ContentRequestRow[]> => {
      let query = supabase
        .from('content_requests')
        .select('*')
        .eq('brand_id', brandId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (status) query = query.eq('status', status);
      return unwrap(await query);
    },
  });
}

export function useRequest(brandId: string, requestId: string) {
  return useQuery({
    queryKey: requestKeys.item(brandId, requestId),
    queryFn: async (): Promise<ContentRequestRow> =>
      unwrap(await supabase.from('content_requests').select('*').eq('id', requestId).single()),
  });
}

export interface ThreadEntry extends ContentRequestCommentRow {
  author: string;
}

/** Conversación e historial del encargo, del más antiguo al más reciente, con el nombre de cada autor. */
export function useRequestThread(brandId: string, requestId: string) {
  return useQuery({
    queryKey: requestKeys.thread(brandId, requestId),
    queryFn: async (): Promise<ThreadEntry[]> => {
      const rows = unwrap(
        await supabase
          .from('content_request_comments')
          .select('*')
          .eq('request_id', requestId)
          .order('created_at', { ascending: true })
          .order('id')
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

/** El encargo más reciente sobre una pieza (para enseñarlo en el editor), o null. */
export function useRequestForContent(brandId: string, contentId: string) {
  return useQuery({
    queryKey: requestKeys.forContent(brandId, contentId),
    queryFn: async (): Promise<ContentRequestRow | null> => {
      const rows = unwrap(
        await supabase
          .from('content_requests')
          .select('*')
          .eq('content_id', contentId)
          .order('created_at', { ascending: false })
          .limit(1),
      );
      return rows[0] ?? null;
    },
  });
}

// ── Escritura ────────────────────────────────────────────────────────────

export interface CreateRequestInput {
  brandId: string;
  title: string;
  brief: string;
  network: string;
  format: string;
  mediaKind: 'image' | 'video' | null;
  referenceAssetIds: string[];
  /** Fecha deseada (AAAA-MM-DD) o null. */
  desiredDate: string | null;
  /** Encargo sobre una pieza que ya existe. */
  contentId?: string | null;
}

export function validateRequestInput(input: CreateRequestInput): string | null {
  if (!input.title.trim()) return 'Ponle un título al encargo.';
  if (input.title.trim().length > 200) return 'El título es demasiado largo.';
  if (!input.brief.trim()) return 'Explica qué necesitas.';
  if (input.brief.trim().length > 5000) return 'El encargo es demasiado largo (máximo 5.000 caracteres).';
  if (!input.contentId && !isKnownTarget(input.network, input.format))
    return 'Esa combinación de red y formato no existe.';
  if (input.referenceAssetIds.length > MAX_REFERENCE_ASSETS)
    return `Como mucho ${MAX_REFERENCE_ASSETS} recursos de referencia.`;
  if (input.desiredDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.desiredDate)) return 'La fecha no es válida.';
  return null;
}

export function useRequestMutations(brandId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: requestKeys.all(brandId) });
  // Aceptar aprueba la pieza: también cambia los contenidos.
  const refreshContent = () => queryClient.invalidateQueries({ queryKey: contentKeys.all(brandId) });

  const create = useMutation({
    mutationFn: async (input: CreateRequestInput): Promise<ContentRequestRow> => {
      const problem = validateRequestInput(input);
      if (problem) throw new Error(problem);
      return unwrap(
        await supabase.rpc('create_content_request', {
          p_brand_id: input.brandId,
          p_title: input.title.trim(),
          p_brief: input.brief.trim(),
          p_network: input.network,
          p_format: input.format,
          p_media_kind: input.mediaKind,
          p_reference_asset_ids: input.referenceAssetIds,
          p_desired_date: input.desiredDate,
          p_content_id: input.contentId ?? null,
        }),
      );
    },
    onSuccess: refresh,
  });

  const comment = useMutation({
    mutationFn: async ({ requestId, body }: { requestId: string; body: string }) => {
      if (!body.trim()) throw new Error('Escribe el comentario.');
      return unwrap(await supabase.rpc('comment_content_request', { p_request_id: requestId, p_body: body.trim() }));
    },
    onSuccess: refresh,
  });

  const accept = useMutation({
    mutationFn: async (requestId: string) =>
      unwrap(await supabase.rpc('accept_content_request', { p_request_id: requestId })),
    onSuccess: async () => {
      await Promise.all([refresh(), refreshContent()]);
    },
  });

  const requestChanges = useMutation({
    mutationFn: async ({ requestId, message }: { requestId: string; message: string }) => {
      if (!message.trim()) throw new Error('Explica qué cambios necesitas.');
      return unwrap(
        await supabase.rpc('request_content_request_changes', { p_request_id: requestId, p_message: message.trim() }),
      );
    },
    onSuccess: refresh,
  });

  const cancel = useMutation({
    mutationFn: async ({ requestId, reason }: { requestId: string; reason: string }) =>
      unwrap(await supabase.rpc('cancel_content_request', { p_request_id: requestId, p_reason: reason.trim() })),
    onSuccess: refresh,
  });

  return { create, comment, accept, requestChanges, cancel };
}

/** Cambia el modo de IA de la marca. Solo quien gestiona la marca (la RLS lo exige). */
export function useSetAiMode(orgId: string, brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mode: BrandAiMode) => {
      const rows = unwrap(await supabase.from('brands').update({ ai_mode: mode }).eq('id', brandId).select('id'));
      if (rows.length === 0) throw { code: '42501', message: 'permission denied' };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.brands(orgId) }),
  });
}
