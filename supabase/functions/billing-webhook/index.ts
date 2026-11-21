// Edge Function `billing-webhook`: avisos de Stripe (alta, renovación, impago,
// cancelación). Sin sesión: la autentica la firma `Stripe-Signature`; en
// config.toml lleva `verify_jwt = false`. Idempotente por evento.
// SIN PROBAR CONTRA STRIPE REAL; la lógica está probada en Node con avisos
// simulados y firmados en la prueba. Variables en docs/facturacion.md; las claves se pueden meter en
// «Plataforma → Integraciones» (mandan sobre las variables).
//
// Dirección para dar de alta en Stripe:
//   https://<proyecto>.supabase.co/functions/v1/billing-webhook
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createBillingWebhookHandler } from '../_shared/billing/handlers.ts';
import { createStripeClient } from '../_shared/billing/stripe.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';

const env = Deno.env.toObject();
const admin = createClient(env.SUPABASE_URL ?? '', env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[billing-webhook] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);

const handlerFor = memoByEnv((effective) => {
  const secrets = (effective.STRIPE_WEBHOOK_SECRET ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) console.warn('[billing-webhook] configuración: falta STRIPE_WEBHOOK_SECRET');
  if (!effective.STRIPE_SECRET_KEY) console.warn('[billing-webhook] configuración: falta STRIPE_SECRET_KEY');
  return createBillingWebhookHandler({
    rpc,
    stripe: effective.STRIPE_SECRET_KEY ? createStripeClient({ secretKey: effective.STRIPE_SECRET_KEY }) : null,
    webhookSecrets: secrets,
    log,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
