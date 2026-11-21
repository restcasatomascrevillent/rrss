// Textos de planes y suscripciones, y el interruptor de la facturación.
import type { BillingInterval, PlanFeature, SubscriptionSource, SubscriptionStatus } from '@/lib/database.types';
import { formatBytes } from '@/lib/utils';

/**
 * ¿Están desplegadas y configuradas las funciones de pago (Stripe)? Sin
 * `VITE_BILLING_ENABLED=true` no aparece nada de pago: ni precios para el
 * cliente, ni «Contratar», ni el portal. El plan y el uso se ven igual.
 */
export function resolveBillingEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

export function billingEnabled(): boolean {
  return resolveBillingEnabled(import.meta.env.VITE_BILLING_ENABLED);
}

export const PLAN_FEATURES: PlanFeature[] = ['ai_text', 'ai_image', 'ai_video', 'reels', 'publishing'];

export const FEATURE_LABEL: Record<PlanFeature, string> = {
  ai_text: 'Texto con IA',
  ai_image: 'Imagen con IA',
  ai_video: 'Vídeo con IA',
  reels: 'Reels',
  publishing: 'Publicación en redes',
};

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: 'Activa',
  trialing: 'En prueba',
  past_due: 'Pago pendiente',
  unpaid: 'Impagada',
  canceled: 'Cancelada',
  incomplete: 'Pago sin completar',
  incomplete_expired: 'Pago caducado',
  paused: 'En pausa',
};

export const SOURCE_LABEL: Record<SubscriptionSource, string> = {
  default: 'Plan por defecto',
  manual: 'Asignado por la plataforma',
  stripe: 'Pago con tarjeta (Stripe)',
};

export const INTERVAL_LABEL: Record<BillingInterval, string> = { month: 'al mes', year: 'al año' };

const count = new Intl.NumberFormat('es-ES');

/** «3 de 5», «3 (sin límite)». */
export function usageText(used: number, max: number | null): string {
  return max === null ? `${count.format(used)} (sin límite)` : `${count.format(used)} de ${count.format(max)}`;
}

export function storageText(used: number, max: number | null): string {
  return max === null ? `${formatBytes(used)} (sin límite)` : `${formatBytes(used)} de ${formatBytes(max)}`;
}

/** Proporción usada, entre 0 y 1; `null` si no hay límite. */
export function usageRatio(used: number, max: number | null): number | null {
  if (max === null) return null;
  if (max <= 0) return 1;
  return Math.min(1, used / max);
}

export const GIB = 1024 ** 3;

/** Texto de un formulario («25», «0,5», vacío = sin límite) → bytes. `undefined` si no es válido. */
export function parseGigabytes(input: string): number | null | undefined {
  const text = input.trim().replace(',', '.');
  if (!text) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(text)) return undefined;
  return Math.round(Number(text) * GIB);
}

/** Entero positivo o vacío (= sin límite). `undefined` si no es válido. */
export function parseLimit(input: string): number | null | undefined {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d{1,6}$/.test(text) || Number(text) < 1) return undefined;
  return Number(text);
}
