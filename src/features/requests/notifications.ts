// Avisos de encargos dentro de la aplicación (no hay correo): un encargo nuevo
// para quien edita la marca y una entrega para quien lo pidió. Los escribe la
// base de datos (disparador sobre `content_requests`); aquí se leen con la RLS
// (cada persona, los suyos) y se marcan como leídos.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RequestNotificationRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

/** Cada cuánto se mira si hay avisos nuevos (sin tiempo real: la publicación de Realtime no los incluye). */
export const NOTIFICATIONS_POLL_MS = 60_000;

export const notificationKeys = {
  unread: (brandId: string) => ['brand', brandId, 'request-notifications', 'unread'] as const,
};

export type UnreadNotification = Pick<RequestNotificationRow, 'id' | 'request_id' | 'kind' | 'created_at'>;

/** Avisos sin leer de la persona en esta marca (los 100 más recientes). */
export function useUnreadRequestNotifications(brandId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: notificationKeys.unread(brandId ?? ''),
    enabled: Boolean(brandId) && enabled,
    refetchInterval: NOTIFICATIONS_POLL_MS,
    queryFn: async (): Promise<UnreadNotification[]> =>
      unwrap(
        await supabase
          .from('request_notifications')
          .select('id, request_id, kind, created_at')
          .eq('brand_id', brandId!)
          .is('read_at', null)
          .order('created_at', { ascending: false })
          .limit(100),
      ),
  });
}

/** Avisos sin leer por encargo. */
export function unreadByRequest(notifications: UnreadNotification[] | undefined): Map<string, UnreadNotification> {
  const map = new Map<string, UnreadNotification>();
  for (const n of notifications ?? []) if (!map.has(n.request_id)) map.set(n.request_id, n);
  return map;
}

/** Marca como leídos los avisos de un encargo o, sin encargo, todos los de la marca. */
export function useMarkRequestNotificationsRead(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string | null) =>
      unwrap(await supabase.rpc('mark_request_notifications_read', { p_brand_id: brandId, p_request_id: requestId })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationKeys.unread(brandId) }),
  });
}

export const NOTIFICATION_TEXT: Record<UnreadNotification['kind'], string> = {
  request_created: 'Nuevo',
  request_delivered: 'Entregado: revísalo',
};
