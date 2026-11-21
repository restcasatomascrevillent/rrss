import type { ContentRequestRow, ContentRequestStatus } from '@/lib/database.types';

// Estados de un encargo y qué acciones ofrece la interfaz a cada persona. Es un
// espejo de las funciones de la migración 20261118230000: aquí solo se decide
// qué botones enseñar; quien manda es la base de datos.

export const REQUEST_STATUSES: ContentRequestStatus[] = [
  'requested',
  'in_progress',
  'delivered',
  'changes_requested',
  'accepted',
  'cancelled',
];

export const REQUEST_STATUS_LABEL: Record<ContentRequestStatus, string> = {
  requested: 'Pedido',
  in_progress: 'En curso',
  delivered: 'Entregado',
  changes_requested: 'Cambios pedidos',
  accepted: 'Aceptado',
  cancelled: 'Cancelado',
};

export const REQUEST_STATUS_TONE: Record<
  ContentRequestStatus,
  'neutral' | 'primary' | 'warning' | 'success' | 'danger'
> = {
  requested: 'neutral',
  in_progress: 'primary',
  delivered: 'warning',
  changes_requested: 'primary',
  accepted: 'success',
  cancelled: 'neutral',
};

/** Frase del historial para cada cambio de estado. */
export const REQUEST_EVENT_LABEL: Record<ContentRequestStatus, string> = {
  requested: 'pidió el encargo',
  in_progress: 'empezó a prepararlo',
  delivered: 'entregó un borrador',
  changes_requested: 'pidió cambios',
  accepted: 'aceptó la entrega',
  cancelled: 'canceló el encargo',
};

export const MEDIA_KIND_LABEL = { image: 'Imagen', video: 'Vídeo' } as const;

export function isClosed(status: ContentRequestStatus): boolean {
  return status === 'accepted' || status === 'cancelled';
}

export interface RequestPermissions {
  comment: boolean;
  approve: boolean;
  manage: boolean;
  userId: string | null;
}

export interface RequestActions {
  accept: boolean;
  requestChanges: boolean;
  cancel: boolean;
  comment: boolean;
}

/** Acciones que se ofrecen sobre un encargo a quien tiene estos permisos. */
export function requestActions(
  request: Pick<ContentRequestRow, 'status' | 'requested_by'>,
  can: RequestPermissions,
): RequestActions {
  const delivered = request.status === 'delivered';
  const mine = can.userId !== null && request.requested_by === can.userId;
  return {
    accept: delivered && can.approve,
    requestChanges: delivered && can.approve,
    cancel: !isClosed(request.status) && (can.manage || (mine && can.comment)),
    comment: can.comment,
  };
}

/** Rutas de la sección dentro de una marca. */
export function requestPaths(orgId: string, brandId: string) {
  const base = `/o/${orgId}/m/${brandId}/encargos`;
  return { list: base, item: (requestId: string) => `${base}/${requestId}` };
}
