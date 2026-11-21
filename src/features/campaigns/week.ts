import { daysInclusive, isRealDate } from './plan';

// Días de una campaña para la tira de la semana. Las fechas del plan son
// AAAA-MM-DD sin hora: se cuentan y se nombran en UTC para que el huso del
// navegador no las mueva de día. Puro: sin red ni React.

const DAY_MS = 86_400_000;

/** Todos los días de la campaña, en orden (como mucho `limit`). */
export function campaignDays(start: string, end: string, limit = 63): string[] {
  if (!isRealDate(start) || !isRealDate(end) || end < start) return [];
  const count = Math.min(daysInclusive(start, end), limit);
  const first = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10));
}

const weekday = new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: 'UTC' });
const longDay = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** «lun» y «23» para la cabecera de un día. */
export function dayParts(value: string): { weekday: string; day: string } {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { weekday: '', day: value };
  return { weekday: weekday.format(date).replace('.', ''), day: String(date.getUTCDate()) };
}

/** «lunes, 23 de noviembre». */
export function longDayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : longDay.format(date);
}
