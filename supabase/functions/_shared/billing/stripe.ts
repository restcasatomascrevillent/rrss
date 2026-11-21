// Stripe con `fetch` puro, sin SDK y sin nada de Deno: lo usan las funciones
// `billing-checkout`, `billing-portal` y `billing-webhook`, y las pruebas en Node.
//
// SIN PROBAR CONTRA STRIPE REAL. Escrito contra la documentación oficial
// consultada el 19/11/2026 (docs.stripe.com):
//   * Firma de los avisos: cabecera `Stripe-Signature` con `t=<segundos>` y una
//     o varias `v1=<hex>`; la firma es HMAC-SHA256 de `<t>.<cuerpo sin tocar>`
//     con el secreto del punto de conexión (`whsec_…`). Se ignoran `v0` y las
//     entradas de depuración (`secret`, `destination`, `payload`). Tolerancia
//     de 5 minutos, la de las bibliotecas oficiales. Varias `v1` mientras se
//     rota el secreto: vale con que una coincida.
//   * El orden de llegada de los avisos no está garantizado y `created` no
//     sirve para ordenarlos: el aviso solo dice QUÉ suscripción cambió; su
//     estado se LEE de la API (`GET /v1/subscriptions/{id}`) al procesarlo.
//   * Desde 2025 el periodo (`current_period_end`) está en cada elemento de la
//     suscripción (`items.data[].current_period_end`); se lee de ahí y, si no,
//     del nivel superior (versiones antiguas de la API).
//   * La factura dice su suscripción en `parent.subscription_details.subscription`
//     (versiones nuevas) o en `subscription` (antiguas).
//   * Peticiones `application/x-www-form-urlencoded` con corchetes para los
//     anidados (`line_items[0][price]`), autenticadas con la clave secreta.

/** Versión de la API que se pide en cada llamada (la de la documentación consultada). */
export const STRIPE_API_VERSION = '2026-10-28.endive';
export const STRIPE_API_BASE = 'https://api.stripe.com';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 en hexadecimal (también lo usan las pruebas para firmar avisos simulados). */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'too_old' };

/**
 * Comprueba la cabecera `Stripe-Signature` de un aviso. `payload` es el cuerpo
 * EXACTO recibido (texto), antes de interpretarlo como JSON.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secrets: string[],
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): Promise<SignatureCheck> {
  if (!header) return { ok: false, reason: 'missing' };
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const item of header.split(',')) {
    const at = item.indexOf('=');
    if (at < 0) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value.toLowerCase());
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return { ok: false, reason: 'malformed' };

  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
    if (signatures.some((signature) => safeEqual(signature, expected))) matched = true;
  }
  if (!matched) return { ok: false, reason: 'mismatch' };
  // Primero la firma y después la antigüedad, como indica Stripe.
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'too_old' };
  return { ok: true };
}

/** Parámetros de Stripe → cuerpo `x-www-form-urlencoded` con corchetes para lo anidado. */
export function formEncode(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => add(`${key}[${i}]`, item));
    } else if (typeof value === 'object') {
      for (const [child, inner] of Object.entries(value as Record<string, unknown>)) add(`${key}[${child}]`, inner);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return pairs.join('&');
}

export class StripeApiError extends Error {
  readonly status: number;
  readonly type: string | null;
  constructor(status: number, message: string, type: string | null) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
    this.type = type;
  }
}

export interface StripeClient {
  request(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createStripeClient(options: {
  secretKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
  apiVersion?: string;
  timeoutMs?: number;
}): StripeClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.apiBase ?? STRIPE_API_BASE;
  return {
    async request(method, path, params = {}) {
      const body = formEncode(params);
      const url = method === 'GET' && body ? `${base}${path}?${body}` : `${base}${path}`;
      const response = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          'stripe-version': options.apiVersion ?? STRIPE_API_VERSION,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
      if (!response.ok) {
        const error = (record.error ?? {}) as { message?: unknown; type?: unknown };
        throw new StripeApiError(
          response.status,
          typeof error.message === 'string' ? error.message : `Stripe respondió ${response.status}`,
          typeof error.type === 'string' ? error.type : null,
        );
      }
      return record;
    },
  };
}

// ─────────────────────────── Lectura de objetos ───────────────────────────

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  const id = rec(value).id;
  return typeof id === 'string' && id ? id : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que la base de datos necesita de una suscripción de Stripe. */
export interface SubscriptionState {
  subscriptionId: string;
  customerId: string | null;
  priceId: string | null;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** `metadata.organization_id`, que pone nuestra función de alta. */
  organizationId: string | null;
}

export function readSubscription(object: unknown): SubscriptionState | null {
  const sub = rec(object);
  const subscriptionId = idOf(sub.id);
  const status = typeof sub.status === 'string' ? sub.status : null;
  if (!subscriptionId || !subscriptionId.startsWith('sub_') || !status) return null;
  const items = Array.isArray(rec(sub.items).data) ? (rec(sub.items).data as unknown[]) : [];
  const first = rec(items[0]);
  const periodEnd = Number(first.current_period_end ?? sub.current_period_end);
  const orgId = rec(sub.metadata).organization_id;
  return {
    subscriptionId,
    customerId: idOf(sub.customer),
    priceId: idOf(first.price),
    status,
    currentPeriodEnd: Number.isFinite(periodEnd) && periodEnd > 0 ? new Date(periodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || (typeof sub.cancel_at === 'number' && sub.cancel_at > 0),
    organizationId: typeof orgId === 'string' && UUID.test(orgId) ? orgId : null,
  };
}

/** Suscripción a la que se refiere un aviso, si la hay. */
export function subscriptionIdOfEvent(type: string, object: unknown): string | null {
  const data = rec(object);
  if (type.startsWith('customer.subscription.')) return idOf(data.id);
  if (type === 'checkout.session.completed') return data.mode === 'subscription' ? idOf(data.subscription) : null;
  if (type.startsWith('invoice.')) {
    return idOf(rec(rec(data.parent).subscription_details).subscription) ?? idOf(data.subscription);
  }
  return null;
}

/** Organización que indica un aviso de alta (`client_reference_id` de la sesión de Checkout). */
export function organizationIdOfEvent(type: string, object: unknown): string | null {
  if (type !== 'checkout.session.completed') return null;
  const ref = rec(object).client_reference_id;
  return typeof ref === 'string' && UUID.test(ref) ? ref : null;
}

/** Avisos que mantienen la suscripción al día: alta, cambios, renovación, impago y cancelación. */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
] as const;
