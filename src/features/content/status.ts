import type { ContentItemRow, ContentStatus } from '@/lib/database.types';

// Estados de una pieza y qué cambios ofrece la interfaz a cada persona. Es un
// espejo de set_content_status() (migración 20261117100000): aquí solo se
// decide qué botones enseñar; quien manda es la base de datos.

export const CONTENT_STATUSES: ContentStatus[] = ['idea', 'draft', 'in_review', 'approved'];

export const STATUS_LABEL: Record<ContentStatus, string> = {
  idea: 'Idea',
  draft: 'Borrador',
  in_review: 'En revisión',
  approved: 'Aprobada',
};

export const STATUS_TONE: Record<ContentStatus, 'neutral' | 'primary' | 'warning' | 'success'> = {
  idea: 'neutral',
  draft: 'primary',
  in_review: 'warning',
  approved: 'success',
};

export interface StatusAction {
  to: ContentStatus;
  label: string;
  /** Hace falta tener al menos una versión guardada. */
  needsVersion: boolean;
}

export interface StatusPermissions {
  edit: boolean;
  approve: boolean;
}

/** Cambios de estado que se ofrecen a quien tiene estos permisos. Una pieza archivada no admite ninguno. */
export function statusActions(
  item: Pick<ContentItemRow, 'status' | 'archived_at'>,
  can: StatusPermissions,
): StatusAction[] {
  if (item.archived_at) return [];
  const actions: StatusAction[] = [];
  const add = (to: ContentStatus, label: string, needsVersion = false) => actions.push({ to, label, needsVersion });

  switch (item.status) {
    case 'idea':
      if (can.edit) {
        add('draft', 'Pasar a borrador');
        add('in_review', 'Enviar a revisión', true);
      }
      break;
    case 'draft':
      if (can.edit) add('in_review', 'Enviar a revisión', true);
      if (can.edit && can.approve) add('approved', 'Aprobar', true);
      if (can.edit) add('idea', 'Devolver a idea');
      break;
    case 'in_review':
      if (can.approve) add('approved', 'Aprobar', true);
      if (can.edit || can.approve) add('draft', 'Devolver a borrador');
      break;
    case 'approved':
      if (can.edit || can.approve) add('draft', 'Retirar la aprobación');
      break;
  }
  return actions;
}

/** Mensaje tras un cambio de estado correcto. */
export function statusChangedMessage(to: ContentStatus): string {
  switch (to) {
    case 'idea':
      return 'Ha vuelto a idea';
    case 'draft':
      return 'Ha vuelto a borrador';
    case 'in_review':
      return 'Enviada a revisión';
    case 'approved':
      return 'Aprobada';
  }
}

/**
 * La acción principal del editor: una sola, según el estado de la pieza.
 *   archivada        → Recuperar
 *   idea / borrador  → Aprobar (si se puede) o Enviar a revisión
 *   en revisión      → Aprobar
 *   aprobada         → Publicar ahora (si la red y el formato se publican solos) o Programar
 * Los demás cambios de estado (Devolver a idea, Devolver a borrador, Retirar la
 * aprobación…) van al menú «⋯».
 */
export type EditorPrimary =
  { kind: 'status'; action: StatusAction } | { kind: 'publishNow' } | { kind: 'schedule' } | { kind: 'restore' };

const FORWARD: ContentStatus[] = ['approved', 'in_review'];

export function editorPrimaryAction(
  item: Pick<ContentItemRow, 'status' | 'archived_at'>,
  actions: StatusAction[],
  can: { edit: boolean; publishNow: boolean; schedule: boolean },
): EditorPrimary | null {
  if (item.archived_at) return can.edit ? { kind: 'restore' } : null;
  if (item.status === 'approved') {
    if (can.publishNow) return { kind: 'publishNow' };
    if (can.schedule) return { kind: 'schedule' };
    return null;
  }
  for (const to of FORWARD) {
    const action = actions.find((a) => a.to === to);
    if (action) return { kind: 'status', action };
  }
  return null;
}
