// Facturación con Stripe (Fase 6): las funciones `billing-checkout`,
// `billing-portal` y `billing-webhook` contra la base de datos real y un
// Stripe SIMULADO. Los avisos se firman aquí con el mismo algoritmo que
// documenta Stripe. Nada de esto se ha probado contra Stripe real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import {
  createBillingCheckoutHandler,
  createBillingPortalHandler,
  createBillingWebhookHandler,
  normalizeAppUrl,
} from '../../supabase/functions/_shared/billing/handlers.ts';
import {
  createStripeClient,
  formEncode,
  hmacSha256Hex,
  readSubscription,
  StripeApiError,
  verifyStripeSignature,
  type StripeClient,
} from '../../supabase/functions/_shared/billing/stripe.ts';
import { as, createBrand, createDb, createOrg, createUser, join, serviceRpc, type Db, type TestUser } from './helpers';

const SECRET = 'whsec_prueba_de_firma';
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const APP = 'https://app.ejemplo.test';

let db: Db;
let root: TestUser;
let n = 0;
const sessions = new Map<string, TestUser>();

const rpc: RpcClient = async (fn, args) => {
  try {
    return { data: await serviceRpc(db, fn, args), error: null };
  } catch (error) {
    const { code, message, detail } = error as { code?: string; message: string; detail?: string };
    return { data: null, error: { code, message, details: detail ?? null } };
  }
};

/** Stripe simulado: guarda suscripciones y anota cada petición. */
class FakeStripe implements StripeClient {
  subscriptions = new Map<string, Record<string, unknown>>();
  calls: { method: string; path: string; params: Record<string, unknown> }[] = [];
  failNext: StripeApiError | null = null;

  async request(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, path, params });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (method === 'GET' && path.startsWith('/v1/subscriptions/')) {
      const sub = this.subscriptions.get(decodeURIComponent(path.slice('/v1/subscriptions/'.length)));
      if (!sub) throw new StripeApiError(404, 'No such subscription', 'invalid_request_error');
      return sub;
    }
    if (path === '/v1/checkout/sessions')
      return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
    if (path === '/v1/billing_portal/sessions') return { id: 'bps_1', url: 'https://billing.stripe.com/p/session/x' };
    throw new StripeApiError(404, 'Ruta no simulada', 'invalid_request_error');
  }

  /** Suscripción con la forma de la API actual (periodo en los elementos). */
  put(id: string, fields: { org?: string; customer?: string; price?: string; status?: string; periodEnd?: number }) {
    this.subscriptions.set(id, {
      id,
      object: 'subscription',
      customer: fields.customer ?? 'cus_A',
      status: fields.status ?? 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      metadata: fields.org ? { organization_id: fields.org } : {},
      items: {
        object: 'list',
        data: [
          {
            id: 'si_1',
            current_period_end: fields.periodEnd ?? 1_797_000_000,
            price: { id: fields.price ?? 'price_pro_test', object: 'price' },
          },
        ],
      },
    });
  }
}

async function signed(event: Record<string, unknown>, options: { secret?: string; at?: number; header?: string } = {}) {
  const body = JSON.stringify(event);
  const t = Math.floor((options.at ?? NOW) / 1000);
  const v1 = await hmacSha256Hex(options.secret ?? SECRET, `${t}.${body}`);
  return new Request('https://x.supabase.co/functions/v1/billing-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': options.header ?? `t=${t},v1=${v1},v0=deadbeef` },
    body,
  });
}

const evt = (id: string, type: string, object: Record<string, unknown>) => ({
  id,
  object: 'event',
  type,
  created: Math.floor(NOW / 1000),
  data: { object },
});

beforeAll(async () => {
  db = await createDb({ plans: 'real' });
  root = await createUser(db, 'root@plataforma.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  await db.query(`update public.plans set stripe_price_id = 'price_pro_test' where code = 'professional'`);
  await db.query(`update public.plans set stripe_price_id = 'price_agency_test' where code = 'agency'`);
});

afterAll(async () => {
  await db?.close();
});

async function tenant() {
  n += 1;
  const owner = await createUser(db, `duena${n}@org${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  return { owner, org };
}

function login(user: TestUser): string {
  const token = `sesion-${user.id}`;
  sessions.set(token, user);
  return token;
}

const authenticate = async (token: string) => {
  const user = sessions.get(token);
  return user ? { userId: user.id } : null;
};

async function planOf(owner: TestUser, org: string) {
  const [row] = await as<{ data: { plan: { code: string }; subscription: { status: string; source: string } } }>(
    db,
    owner,
    `select public.organization_plan_usage($1) as data`,
    [org],
  );
  return row!.data;
}

describe('firma de los avisos', () => {
  it('acepta la firma correcta (aunque haya varias v1 y una v0) y rechaza el resto', async () => {
    const body = '{"id":"evt_x"}';
    const t = Math.floor(NOW / 1000);
    const good = await hmacSha256Hex(SECRET, `${t}.${body}`);
    const now = t + 10;
    expect(await verifyStripeSignature(body, `t=${t},v1=${good}`, [SECRET], now)).toEqual({ ok: true });
    // Rotación del secreto: dos v1 y dos secretos activos.
    expect(
      await verifyStripeSignature(
        body,
        `t=${t},v1=${'0'.repeat(64)},v1=${good},secret=whsec_***`,
        ['otro', SECRET],
        now,
      ),
    ).toEqual({ ok: true });
    expect(await verifyStripeSignature(body, null, [SECRET], now)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyStripeSignature(body, `v1=${good}`, [SECRET], now)).toEqual({ ok: false, reason: 'malformed' });
    // Una v0 no vale para verificar (ataque de degradación).
    expect(await verifyStripeSignature(body, `t=${t},v0=${good}`, [SECRET], now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyStripeSignature(`${body} `, `t=${t},v1=${good}`, [SECRET], now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await verifyStripeSignature(body, `t=${t},v1=${good}`, ['whsec_otro'], now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await verifyStripeSignature(body, `t=${t},v1=${good}`, [SECRET], t + 301)).toEqual({
      ok: false,
      reason: 'too_old',
    });
  });

  it('el webhook rechaza con 400 un aviso sin firma válida y no anota nada', async () => {
    const stripe = new FakeStripe();
    const handler = createBillingWebhookHandler({ rpc, stripe, webhookSecrets: [SECRET], now: () => NOW });
    const event = evt('evt_falso', 'customer.subscription.updated', { id: 'sub_x' });
    for (const request of [
      await signed(event, { secret: 'whsec_atacante' }),
      await signed(event, { at: NOW - 3_600_000 }),
      await signed(event, { header: 'nada' }),
    ]) {
      expect((await handler(request)).status).toBe(400);
    }
    expect(stripe.calls).toEqual([]);
    expect(await db.query(`select 1 from public.billing_events where id = 'evt_falso'`)).toEqual([]);
  });

  it('sin secreto o sin clave de Stripe responde que la facturación no está configurada', async () => {
    const handler = createBillingWebhookHandler({ rpc, stripe: null, webhookSecrets: [SECRET], now: () => NOW });
    expect((await handler(await signed(evt('evt_nc', 'invoice.paid', {})))).status).toBe(503);
    const sinSecreto = createBillingWebhookHandler({ rpc, stripe: new FakeStripe(), webhookSecrets: [] });
    expect((await sinSecreto(await signed(evt('evt_nc', 'invoice.paid', {})))).status).toBe(503);
  });
});

describe('ciclo de vida de una suscripción por avisos simulados', () => {
  it('alta, impago, renovación y cancelación; los avisos repetidos no hacen nada', async () => {
    const t = await tenant();
    const stripe = new FakeStripe();
    const handler = createBillingWebhookHandler({ rpc, stripe, webhookSecrets: [SECRET], now: () => NOW });
    const deliver = async (event: Record<string, unknown>) => {
      const response = await handler(await signed(event));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    // Alta: Checkout termina; la suscripción se lee de Stripe.
    stripe.put('sub_ciclo', { org: t.org, customer: 'cus_ciclo' });
    const alta = evt('evt_alta', 'checkout.session.completed', {
      id: 'cs_1',
      object: 'checkout.session',
      mode: 'subscription',
      client_reference_id: t.org,
      customer: 'cus_ciclo',
      subscription: 'sub_ciclo',
    });
    expect(await deliver(alta)).toMatchObject({ status: 200, body: { result: 'applied', status: 'active' } });
    expect(stripe.calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/subscriptions/sub_ciclo' });
    expect(await planOf(t.owner, t.org)).toMatchObject({
      plan: { code: 'professional' },
      subscription: { source: 'stripe', status: 'active' },
    });
    // Stripe reenvía el mismo aviso: no se aplica otra vez.
    expect(await deliver(alta)).toMatchObject({ status: 200, body: { result: 'duplicate' } });

    // Impago: la factura falla y la suscripción pasa a past_due (formato nuevo de factura).
    stripe.put('sub_ciclo', { org: t.org, customer: 'cus_ciclo', status: 'past_due' });
    expect(
      await deliver(
        evt('evt_impago', 'invoice.payment_failed', {
          id: 'in_1',
          object: 'invoice',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_ciclo' } },
        }),
      ),
    ).toMatchObject({ status: 200, body: { result: 'applied', status: 'past_due' } });
    expect((await planOf(t.owner, t.org)).subscription.status).toBe('past_due');

    // Renovación pagada (formato antiguo de factura): vuelve a activa, periodo nuevo.
    stripe.put('sub_ciclo', { org: t.org, customer: 'cus_ciclo', periodEnd: 1_800_000_000 });
    await deliver(evt('evt_renueva', 'invoice.paid', { id: 'in_2', object: 'invoice', subscription: 'sub_ciclo' }));
    const [row] = await db.query<{ status: string; end: string }>(
      `select status::text, current_period_end::text as end from public.subscriptions where organization_id = $1`,
      [t.org],
    );
    expect(row!.status).toBe('active');
    expect(new Date(row!.end).getTime()).toBe(1_800_000_000 * 1000);

    // Cambio de plan desde el portal (otro precio).
    stripe.put('sub_ciclo', { org: t.org, customer: 'cus_ciclo', price: 'price_agency_test' });
    await deliver(evt('evt_cambio', 'customer.subscription.updated', { id: 'sub_ciclo', object: 'subscription' }));
    expect((await planOf(t.owner, t.org)).plan.code).toBe('agency');

    // Cancelación: vuelve al plan por defecto sin borrar nada.
    stripe.put('sub_ciclo', { org: t.org, customer: 'cus_ciclo', status: 'canceled', price: 'price_agency_test' });
    await deliver(evt('evt_baja', 'customer.subscription.deleted', { id: 'sub_ciclo', object: 'subscription' }));
    expect(await planOf(t.owner, t.org)).toMatchObject({
      plan: { code: 'trial' },
      subscription: { source: 'stripe', status: 'canceled' },
    });
  });

  it('un aviso que llega tarde no deshace el estado actual: manda lo que dice Stripe ahora', async () => {
    const t = await tenant();
    const stripe = new FakeStripe();
    const handler = createBillingWebhookHandler({ rpc, stripe, webhookSecrets: [SECRET], now: () => NOW });
    stripe.put('sub_orden', { org: t.org, customer: 'cus_orden', status: 'active' });
    // Llega un «past_due» antiguo cuando la suscripción ya está al día.
    await handler(
      await signed(
        evt('evt_viejo', 'customer.subscription.updated', {
          id: 'sub_orden',
          object: 'subscription',
          status: 'past_due',
        }),
      ),
    );
    expect((await planOf(t.owner, t.org)).subscription.status).toBe('active');
  });

  it('si Stripe falla, responde 5xx sin anotar el aviso, y el reintento lo aplica', async () => {
    const t = await tenant();
    const stripe = new FakeStripe();
    const handler = createBillingWebhookHandler({ rpc, stripe, webhookSecrets: [SECRET], now: () => NOW });
    stripe.put('sub_reintento', { org: t.org, customer: 'cus_reintento' });
    const event = evt('evt_reintento', 'customer.subscription.created', { id: 'sub_reintento' });
    stripe.failNext = new StripeApiError(500, 'Error interno', 'api_error');
    expect((await handler(await signed(event))).status).toBe(502);
    expect(await db.query(`select 1 from public.billing_events where id = 'evt_reintento'`)).toEqual([]);
    expect((await handler(await signed(event))).status).toBe(200);
    expect((await planOf(t.owner, t.org)).plan.code).toBe('professional');
  });

  it('los avisos que no interesan, o de suscripciones que ya no existen, se anotan como ignorados', async () => {
    const stripe = new FakeStripe();
    const handler = createBillingWebhookHandler({ rpc, stripe, webhookSecrets: [SECRET], now: () => NOW });
    const body = async (event: Record<string, unknown>) =>
      (await (await handler(await signed(event))).json()) as unknown;
    expect(await body(evt('evt_cargo', 'charge.succeeded', { id: 'ch_1' }))).toMatchObject({
      result: 'ignored',
      reason: 'unhandled_type',
    });
    expect(
      await body(evt('evt_pago_unico', 'checkout.session.completed', { id: 'cs_2', mode: 'payment' })),
    ).toMatchObject({ result: 'ignored', reason: 'no_subscription' });
    expect(await body(evt('evt_fantasma', 'customer.subscription.updated', { id: 'sub_fantasma' }))).toMatchObject({
      result: 'ignored',
      reason: 'subscription_not_found',
    });
    const rows = await as(db, root, `select id, outcome from public.billing_events where id like 'evt_%' order by id`);
    expect(rows).toEqual(expect.arrayContaining([{ id: 'evt_cargo', outcome: 'ignored' }]));
  });
});

describe('alta en Stripe Checkout y portal de cliente', () => {
  const deps = (stripe: StripeClient | null = new FakeStripe()) => ({
    rpc,
    stripe,
    appUrl: APP,
    authenticate,
  });
  const post = (token: string | null, body: unknown) =>
    new Request('https://x.supabase.co/functions/v1/billing-checkout', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });

  it('la propietaria obtiene la URL de Checkout; la sesión lleva la organización y nunca datos de pago', async () => {
    const t = await tenant();
    const stripe = new FakeStripe();
    const handler = createBillingCheckoutHandler(deps(stripe));
    const response = await handler(post(login(t.owner), { organizationId: t.org, planCode: 'professional' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(stripe.calls).toEqual([
      {
        method: 'POST',
        path: '/v1/checkout/sessions',
        params: {
          mode: 'subscription',
          line_items: [{ price: 'price_pro_test', quantity: 1 }],
          success_url: `${APP}/o/${t.org}/ajustes/plan?pago=ok`,
          cancel_url: `${APP}/o/${t.org}/ajustes/plan?pago=cancelado`,
          client_reference_id: t.org,
          metadata: { organization_id: t.org },
          subscription_data: { metadata: { organization_id: t.org } },
        },
      },
    ]);
  });

  it('nadie más pide el pago, y solo de planes que se contratan en línea', async () => {
    const t = await tenant();
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const editor = await createUser(db, `editor${n}@x.test`);
    await as(
      db,
      root,
      `select public.admin_set_organization_plan($1, (select id from public.plans where code = 'agency'))`,
      [t.org],
    );
    await join(db, t.owner, editor, t.org, 'member', brand, 'editor');
    const stripe = new FakeStripe();
    const handler = createBillingCheckoutHandler(deps(stripe));
    expect((await handler(post(null, { organizationId: t.org, planCode: 'professional' }))).status).toBe(401);
    expect((await handler(post(login(editor), { organizationId: t.org, planCode: 'professional' }))).status).toBe(403);
    const ajena = await tenant();
    expect((await handler(post(login(ajena.owner), { organizationId: t.org, planCode: 'professional' }))).status).toBe(
      403,
    );
    const enterprise = await handler(post(login(t.owner), { organizationId: t.org, planCode: 'enterprise' }));
    expect(enterprise.status).toBe(400);
    expect(await enterprise.json()).toMatchObject({ error: { message: 'Ese plan no se puede contratar en línea' } });
    expect((await handler(post(login(t.owner), { organizationId: 'x', planCode: 'professional' }))).status).toBe(400);
    expect(stripe.calls).toEqual([]);
  });

  it('quien ya paga va al portal; el portal pide haber pagado antes', async () => {
    const t = await tenant();
    const stripe = new FakeStripe();
    const checkout = createBillingCheckoutHandler(deps(stripe));
    const portal = createBillingPortalHandler(deps(stripe));
    const token = login(t.owner);

    const sinCliente = await portal(post(token, { organizationId: t.org }));
    expect(sinCliente.status).toBe(409);
    expect(await sinCliente.json()).toMatchObject({ error: { code: 'no_billing_account' } });

    await serviceRpc(db, 'billing_apply_stripe_event', {
      p_event_id: `evt_portal_${n}`,
      p_event_type: 'customer.subscription.created',
      p_organization_id: t.org,
      p_customer_id: `cus_portal${n}`,
      p_subscription_id: `sub_portal${n}`,
      p_price_id: 'price_pro_test',
      p_status: 'active',
    });
    const repetido = await checkout(post(token, { organizationId: t.org, planCode: 'agency' }));
    expect(repetido.status).toBe(409);
    expect(await repetido.json()).toMatchObject({ error: { code: 'use_portal' } });

    const ok = await portal(post(token, { organizationId: t.org }));
    expect(await ok.json()).toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect(stripe.calls.at(-1)).toEqual({
      method: 'POST',
      path: '/v1/billing_portal/sessions',
      params: { customer: `cus_portal${n}`, return_url: `${APP}/o/${t.org}/ajustes/plan` },
    });
  });

  it('sin Stripe configurado lo dice; si Stripe falla, también', async () => {
    const t = await tenant();
    const sinStripe = createBillingCheckoutHandler(deps(null));
    const response = await sinStripe(post(login(t.owner), { organizationId: t.org, planCode: 'professional' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: 'El pago en línea no está disponible en este entorno.' },
    });
    const stripe = new FakeStripe();
    stripe.failNext = new StripeApiError(400, 'No such price', 'invalid_request_error');
    const roto = createBillingCheckoutHandler(deps(stripe));
    expect((await roto(post(login(t.owner), { organizationId: t.org, planCode: 'professional' }))).status).toBe(502);
  });
});

describe('cliente de Stripe con fetch', () => {
  it('codifica los parámetros con corchetes y envía clave y versión en cabeceras', async () => {
    expect(
      formEncode({
        mode: 'subscription',
        line_items: [{ price: 'price_1', quantity: 1 }],
        metadata: { organization_id: 'o 1' },
        nada: null,
      }),
    ).toBe(
      'mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Borganization_id%5D=o%201',
    );

    const seen: { url: string; init: RequestInit }[] = [];
    const client = createStripeClient({
      secretKey: 'sk_test_x',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ error: { message: 'No such customer', type: 'invalid_request_error' } }), {
          status: 404,
        });
      }) as unknown as typeof fetch,
    });
    await expect(client.request('POST', '/v1/billing_portal/sessions', { customer: 'cus_x' })).rejects.toMatchObject({
      status: 404,
      message: 'No such customer',
    });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(seen[0]!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(headers.authorization).toBe('Bearer sk_test_x');
    expect(headers['stripe-version']).toMatch(/^\d{4}-\d{2}-\d{2}\./);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(seen[0]!.init.body).toBe('customer=cus_x');
  });

  it('lee el periodo de los elementos (API actual) o del nivel superior (antigua)', () => {
    const base = { id: 'sub_1', status: 'active', customer: { id: 'cus_1' } };
    expect(
      readSubscription({ ...base, items: { data: [{ current_period_end: 1_800_000_000, price: { id: 'price_1' } }] } }),
    ).toMatchObject({ customerId: 'cus_1', priceId: 'price_1', currentPeriodEnd: '2027-01-15T08:00:00.000Z' });
    expect(
      readSubscription({ ...base, current_period_end: 1_800_000_000, items: { data: [{ price: 'price_2' }] } }),
    ).toMatchObject({ priceId: 'price_2', currentPeriodEnd: '2027-01-15T08:00:00.000Z' });
    expect(readSubscription({ id: 'no', status: 'active' })).toBeNull();
    expect(readSubscription({ ...base, metadata: { organization_id: 'inyectado' } })?.organizationId).toBeNull();
  });

  it('la dirección de la aplicación tiene que ser https (o localhost)', () => {
    expect(normalizeAppUrl('https://app.ejemplo.test/')).toBe('https://app.ejemplo.test');
    expect(normalizeAppUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeAppUrl('http://app.ejemplo.test')).toBeNull();
    expect(normalizeAppUrl('https://app.ejemplo.test/?x=1')).toBeNull();
    expect(normalizeAppUrl(undefined)).toBeNull();
  });
});
