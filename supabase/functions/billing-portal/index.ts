// Edge Function `billing-portal`: un propietario o administrador pide la URL
// del portal de cliente de Stripe (plan, tarjeta, facturas). SIN PROBAR CONTRA STRIPE REAL; la
// lógica (../_shared/billing/handlers.ts) está probada en Node con la base de
// datos real y un Stripe simulado. Variables en docs/facturacion.md; las
// claves se pueden meter en «Plataforma → Integraciones» (mandan sobre las variables).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createBillingPortalHandler, normalizeAppUrl } from '../_shared/billing/handlers.ts';
import { createStripeClient } from '../_shared/billing/stripe.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';

const env = Deno.env.toObject();
const admin = createClient(env.SUPABASE_URL ?? '', env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[billing-portal] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);

const handlerFor = memoByEnv((effective) => {
  const appUrl = normalizeAppUrl(effective.BILLING_APP_URL);
  if (!effective.STRIPE_SECRET_KEY) console.warn('[billing-portal] configuración: falta STRIPE_SECRET_KEY');
  if (!appUrl) console.warn('[billing-portal] configuración: falta BILLING_APP_URL (https)');
  return createBillingPortalHandler({
    rpc,
    stripe: effective.STRIPE_SECRET_KEY ? createStripeClient({ secretKey: effective.STRIPE_SECRET_KEY }) : null,
    appUrl,
    allowedOrigin: env.BILLING_ALLOWED_ORIGIN,
    async authenticate(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : { userId: data.user.id };
    },
    log,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
