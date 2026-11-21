import type { ContentStatus, PublicationHoldReason, ScheduledPublicationRow } from '@/lib/database.types';

// Fechas del calendario (en la hora del navegador) y el estado que se enseña de
// cada publicación. Sin dependencias: se prueba aparte.

export type CalendarView = 'month' | 'week' | 'day' | 'network';

export const CALENDAR_VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'month', label: 'Mes' },
  { value: 'week', label: 'Semana' },
  { value: 'day', label: 'Día' },
  { value: 'network', label: 'Por red' },
];

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

/** Lunes de la semana de la fecha. */
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  return addDays(d, -((d.getDay() + 6) % 7));
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Clave estable de un día (AAAA-MM-DD, hora local). */
export function dayKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Intervalo [desde, hasta) que cubre la vista. El mes se ve en semanas completas (6 filas). */
export function viewRange(view: CalendarView, anchor: Date): { from: Date; to: Date; days: Date[] } {
  let from: Date;
  let count: number;
  if (view === 'day') {
    from = startOfDay(anchor);
    count = 1;
  } else if (view === 'week') {
    from = startOfWeek(anchor);
    count = 7;
  } else {
    from = startOfWeek(startOfMonth(anchor));
    count = 42;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  return { from, to: addDays(from, count), days };
}

/** Avanza o retrocede la vista una unidad (mes, semana o día). */
export function shiftAnchor(view: CalendarView, anchor: Date, step: 1 | -1): Date {
  if (view === 'day') return addDays(anchor, step);
  if (view === 'week') return addDays(anchor, 7 * step);
  return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
}

/** Lleva una fecha a otro día conservando la hora (arrastrar y soltar en mes o semana). */
export function moveToDay(original: Date, day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), original.getHours(), original.getMinutes());
}

/** Lleva una fecha a otro día y hora en punto (soltar en la vista de día). */
export function moveToHour(original: Date, day: Date, hour: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, original.getMinutes());
}

/** Valor para <input type="datetime-local"> en hora local. */
export function toLocalInput(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** De <input type="datetime-local"> (hora local) a ISO; null si no es una fecha. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

export function rangeTitle(view: CalendarView, anchor: Date): string {
  if (view === 'day') {
    return anchor.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  if (view === 'week') {
    const from = startOfWeek(anchor);
    const to = addDays(from, 6);
    const f = (d: Date) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    return `${f(from)} – ${f(to)} de ${to.getFullYear()}`;
  }
  return anchor.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
}

// ── Estado que se enseña ─────────────────────────────────────────────────

/**
 * Lo que se ve en el calendario: «Programada» solo cuando la base de datos la
 * tiene armada, y «Publicada» solo con el identificador que dio la red.
 * Mientras no está armada, se ve en qué punto está la pieza (idea, borrador,
 * en revisión) o «Detenida» con el motivo.
 */
export type DisplayState =
  'idea' | 'draft' | 'in_review' | 'held' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export function displayState(
  pub: Pick<ScheduledPublicationRow, 'status' | 'hold_reason' | 'external_id'>,
  contentStatus: ContentStatus | null,
): DisplayState {
  switch (pub.status) {
    case 'published':
      return pub.external_id ? 'published' : 'publishing';
    case 'publishing':
    case 'failed':
    case 'cancelled':
    case 'scheduled':
      return pub.status;
    case 'planned':
      if (pub.hold_reason === 'not_approved' && contentStatus && contentStatus !== 'approved') return contentStatus;
      return 'held';
  }
}

export const DISPLAY_LABEL: Record<DisplayState, string> = {
  idea: 'Idea',
  draft: 'Borrador',
  in_review: 'En revisión',
  held: 'Detenida',
  scheduled: 'Programada',
  publishing: 'Publicando',
  published: 'Publicada',
  failed: 'Falló',
  cancelled: 'Cancelada',
};

export const DISPLAY_TONE: Record<DisplayState, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  idea: 'neutral',
  draft: 'neutral',
  in_review: 'warning',
  held: 'warning',
  scheduled: 'primary',
  publishing: 'primary',
  published: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export const DISPLAY_STATES: DisplayState[] = [
  'idea',
  'draft',
  'in_review',
  'held',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
];

export const HOLD_REASON_TEXT: Record<PublicationHoldReason, string> = {
  not_approved: 'La pieza no está aprobada: no se publicará hasta que alguien con permiso la apruebe.',
  content_changed:
    'La pieza ha cambiado desde que se programó: elige la versión aprobada y su exportación para volver a programarla.',
  content_archived: 'La pieza está archivada.',
  no_account: 'Falta elegir la cuenta en la que se publica.',
  account_disconnected: 'La cuenta se ha desconectado: conéctala otra vez o elige otra.',
  account_needs_reauth: 'El acceso a la cuenta ha caducado: vuelve a conectarla en Marca → Cuentas conectadas.',
  no_media: 'Falta elegir la imagen o el vídeo exportado de la versión aprobada.',
  invalid_media:
    'Los recursos no valen: hacen falta exportaciones JPEG de la versión aprobada (1 en una publicación, de 2 a 10 en un carrusel) o un vídeo en un reel.',
  unsupported_format: 'Este formato todavía no se publica automáticamente.',
};

/** ¿Se puede mover, cambiar o cancelar? */
export function isEditable(status: ScheduledPublicationRow['status']): boolean {
  return status === 'planned' || status === 'scheduled' || status === 'failed';
}

/** Cupo de publicación: aviso cuando se acerca (80 %) o se alcanza. Sin cifras de la red, nada. */
export function quotaWarning(usage: number | null, total: number | null): 'near' | 'reached' | null {
  if (usage === null || total === null || total <= 0) return null;
  if (usage >= total) return 'reached';
  return usage >= total * 0.8 ? 'near' : null;
}

/** ¿Caduca pronto el acceso? (7 días). */
export function tokenExpiresSoon(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - now < 7 * 86_400_000;
}

/** ¿Ya ha pasado? (fuera del render: para los manejadores de eventos). */
export function isPast(date: Date | string): boolean {
  return new Date(date).getTime() < Date.now();
}

/** Fecha por defecto al programar: el día pedido a las 10:00, o dentro de una hora. */
export function defaultScheduleDate(day: Date | null | undefined): Date {
  if (!day) return new Date(Date.now() + 3_600_000);
  const d = new Date(day);
  if (d.getHours() === 0 && d.getMinutes() === 0) d.setHours(10);
  return d;
}

/** Formatos que el publicador sabe publicar hoy (espejo de private.publication_format_supported). */
export const PUBLISHABLE_TARGETS = new Set(['instagram:post', 'instagram:carousel', 'instagram:reel']);
