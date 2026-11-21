// Lógica de las Edge Functions de pago, sin nada de Deno: reciben sus
// dependencias (sesión, RPC con la clave de servicio, cliente de Stripe) y
// devuelven una `Response`. Así las pruebas las ejecutan en Node con la base de
// datos real y un Stripe simulado; cada `index.ts` solo las conecta.
//
// SIN PROBAR CONTRA STRIPE REAL (ver stripe.ts).
//
//   billing-checkout  propietario/administrador → URL de Stripe Checkout para contratar un plan
//   billing-portal    propietario/administrador → URL del portal de cliente de Stripe
//   billing-webhook   avisos firmados de Stripe → estado de la suscripción en la base de datos
//
// Ningún dato de pago pasa por aquí: la tarjeta se escribe en Stripe.
import type { RpcClient } from '../ai/contract.ts';
import {
  HANDLED_EVENTS,
  organizationIdOfEvent,
  readSubscription,
  StripeApiError,
  subscriptionIdOfEvent,
  verifyStripeSignature,
  type StripeClient,
} from './stripe.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_CODE = /^[a-z][a-z0-9_-]{1,39}$/;
const MAX_BODY_BYTES = 1_000_000;

type Log = (event: string, data: Record<string, unknown>) => void;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ─────────────────────────── Alta y portal ───────────────────────────

export interface BillingSessionDeps {
  /** Valida el token de sesión y devuelve el usuario, o `null`. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  rpc: RpcClient;
  /** `null` si falta STRIPE_SECRET_KEY: la función responde que el pago no está disponible. */
  stripe: StripeClient | null;
  /** Dirección de la aplicación (BILLING_APP_URL), a la que Stripe devuelve al usuario. */
  appUrl: string | null;
  allowedOrigin?: string;
  log?: Log;
}

const NOT_AVAILABLE = 'El pago en línea no está disponible en este entorno.';

/** Normaliza BILLING_APP_URL: https (o http en localhost), sin barra final. `null` si no vale. */
export function normalizeAppUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function createSessionHandler(
  deps: BillingSessionDeps,
  kind: 'checkout' | 'portal',
): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const fail = (status: number, code: string, message: string) =>
    jsonResponse(status, { error: { code, message } }, cors);

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const user = token ? await deps.authenticate(token).catch(() => null) : null;
    if (!user) return fail(401, 'unauthorized', 'Tu sesión ha caducado. Vuelve a iniciar sesión.');

    let body: Record<string, unknown>;
    try {
      body = rec(await request.json());
    } catch {
      return fail(400, 'invalid_request', 'La petición no es válida.');
    }
    const organizationId = body.organizationId;
    const planCode = kind === 'checkout' ? body.planCode : undefined;
    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
      return fail(400, 'invalid_request', 'Falta la organización.');
    }
    if (kind === 'checkout' && (typeof planCode !== 'string' || !PLAN_CODE.test(planCode))) {
      return fail(400, 'invalid_request', 'Falta el plan.');
    }

    // Permiso y plan, en la base de datos, antes de hablar con Stripe.
    const context = await deps.rpc('billing_checkout_context', {
      p_user_id: user.userId,
      p_organization_id: organizationId,
      p_plan_code: planCode ?? null,
    });
    if (context.error) {
      if (context.error.code === '42501') return fail(403, 'forbidden', context.error.message);
      if (context.error.code === '22023') return fail(400, 'invalid_request', context.error.message);
      deps.log?.('context_failed', { code: context.error.code ?? null });
      return fail(500, 'internal', 'No se ha podido preparar el pago. Inténtalo de nuevo.');
    }
    const ctx = rec(context.data);

    if (!deps.stripe || !deps.appUrl) return fail(503, 'not_configured', NOT_AVAILABLE);
    const planPage = `${deps.appUrl}/o/${organizationId}/ajustes/plan`;
    const customer = typeof ctx.stripe_customer_id === 'string' ? ctx.stripe_customer_id : null;

    try {
      if (kind === 'portal') {
        if (!customer) {
          return fail(409, 'no_billing_account', 'Esta organización todavía no ha pagado con Stripe.');
        }
        const session = await deps.stripe.request('POST', '/v1/billing_portal/sessions', {
          customer,
          return_url: planPage,
        });
        return jsonResponse(200, { url: session.url }, cors);
      }

      if (ctx.stripe_subscription_active === true) {
        return fail(
          409,
          'use_portal',
          'Esta organización ya tiene una suscripción: cambia de plan desde «Gestionar el pago en Stripe».',
        );
      }
      const session = await deps.stripe.request('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price: ctx.stripe_price_id, quantity: 1 }],
        success_url: `${planPage}?pago=ok`,
        cancel_url: `${planPage}?pago=cancelado`,
        // Así el aviso de Stripe sabe de qué organización es (además del cliente).
        client_reference_id: organizationId,
        metadata: { organization_id: organizationId },
        subscription_data: { metadata: { organization_id: organizationId } },
        ...(customer ? { customer } : {}),
      });
      return jsonResponse(200, { url: session.url }, cors);
    } catch (error) {
      deps.log?.('stripe_failed', {
        kind,
        status: error instanceof StripeApiError ? error.status : null,
        type: error instanceof StripeApiError ? error.type : null,
      });
      return fail(502, 'provider_failed', 'Stripe no ha respondido. Inténtalo de nuevo en un momento.');
    }
  };
}

export const createBillingCheckoutHandler = (deps: BillingSessionDeps) => createSessionHandler(deps, 'checkout');
export const createBillingPortalHandler = (deps: BillingSessionDeps) => createSessionHandler(deps, 'portal');

// ───────────────────────────── Avisos de Stripe ─────────────────────────────

export interface BillingWebhookDeps {
  rpc: RpcClient;
  /** Para leer el estado actual de la suscripción. `null` si falta la clave. */
  stripe: StripeClient | null;
  /** STRIPE_WEBHOOK_SECRET (varios, separados por comas, mientras se rota). */
  webhookSecrets: string[];
  /** Milisegundos desde 1970 (para probar la caducidad de la firma). */
  now?: () => number;
  log?: Log;
}

/**
 * Respuestas: 200 si el aviso está procesado, repetido o ignorado a propósito
 * (Stripe deja de reenviarlo); 400 si la firma no vale; 5xx si algo falló de
 * nuestro lado o de Stripe, para que Stripe lo reintente (es idempotente).
 */
export function createBillingWebhookHandler(deps: BillingWebhookDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const secrets = deps.webhookSecrets.filter(Boolean);
  const handled = new Set<string>(HANDLED_EVENTS);

  const apply = async (args: Record<string, unknown>) => {
    const result = await deps.rpc('billing_apply_stripe_event', args);
    if (result.error) {
      deps.log?.('apply_failed', { code: result.error.code ?? null, event: args.p_event_id });
      return jsonResponse(500, { error: 'No se ha podido guardar el aviso' });
    }
    return jsonResponse(200, { received: true, ...rec(result.data) });
  };

  return async (request) => {
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Solo POST' });
    if (secrets.length === 0 || !deps.stripe) return jsonResponse(503, { error: 'Facturación sin configurar' });

    const payload = await request.text();
    if (payload.length > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Aviso demasiado grande' });

    const check = await verifyStripeSignature(
      payload,
      request.headers.get('stripe-signature'),
      secrets,
      Math.floor(now() / 1000),
    );
    if (!check.ok) {
      deps.log?.('bad_signature', { reason: check.reason });
      return jsonResponse(400, { error: 'Firma no válida' });
    }

    let event: Record<string, unknown>;
    try {
      event = rec(JSON.parse(payload));
    } catch {
      return jsonResponse(400, { error: 'Aviso no válido' });
    }
    const id = typeof event.id === 'string' ? event.id : '';
    const type = typeof event.type === 'string' ? event.type : '';
    if (!id || !type) return jsonResponse(400, { error: 'Aviso no válido' });
    const object = rec(event.data).object;

    if (!handled.has(type)) return apply({ p_event_id: id, p_event_type: type, p_ignore_reason: 'unhandled_type' });
    const subscriptionId = subscriptionIdOfEvent(type, object);
    if (!subscriptionId) {
      return apply({ p_event_id: id, p_event_type: type, p_ignore_reason: 'no_subscription' });
    }

    // El estado se lee de Stripe ahora: el aviso puede llegar tarde o desordenado.
    let subscription: Record<string, unknown>;
    try {
      subscription = await deps.stripe.request('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 404) {
        return apply({ p_event_id: id, p_event_type: type, p_ignore_reason: 'subscription_not_found' });
      }
      deps.log?.('stripe_failed', { event: id, status: error instanceof StripeApiError ? error.status : null });
      return jsonResponse(502, { error: 'Stripe no responde' });
    }
    const state = readSubscription(subscription);
    if (!state) return apply({ p_event_id: id, p_event_type: type, p_ignore_reason: 'unreadable_subscription' });

    return apply({
      p_event_id: id,
      p_event_type: type,
      p_organization_id: state.organizationId ?? organizationIdOfEvent(type, object),
      p_customer_id: state.customerId,
      p_subscription_id: state.subscriptionId,
      p_price_id: state.priceId,
      p_status: state.status,
      p_current_period_end: state.currentPeriodEnd,
      p_cancel_at_period_end: state.cancelAtPeriodEnd,
    });
  };
}
