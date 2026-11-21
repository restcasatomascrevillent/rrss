// Edge Function `platform-integrations`: Plataforma → Integraciones (handler.ts).
// Claves de Meta, ComfyUI, IA y Stripe metidas desde la interfaz, guardadas
// cifradas en Vault (migración 20261120010000), «Probar conexión» y, para
// cualquiera con sesión, qué integraciones están listas (sin valores).
//
// La llamada inocua de cada «Probar conexión» está en
// ../_shared/integrations/probes.ts. En la prueba local con
// SOCIAL_E2E_SIMULATED_GRAPH=true, la de Meta va a la Graph API simulada.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import type { MediaModelRow } from '../_shared/ai/media/models.ts';
import { probeIntegration } from '../_shared/integrations/probes.ts';
import { createRpcSettingsLoader } from '../_shared/integrations/settings.ts';
import { loadSocialLocalTest } from '../_shared/social/local-test.ts';
import { createPlatformIntegrationsHandler } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY ?? '', options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[platform-integrations] ${event}`, JSON.stringify(data));

Deno.serve(
  createPlatformIntegrationsHandler({
    rpc,
    baseEnv: env,
    settings: createRpcSettingsLoader(rpc, env, log),
    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user ? null : { userId: data.user.id };
    },
    userRpc(accessToken) {
      const asUser = createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      return (fn, args) => asUser.rpc(fn, args);
    },
    async imageModelRows() {
      const { data, error } = await admin
        .from('ai_media_models')
        .select(
          'provider, model, task, display_name, billing_unit, price_micros, price_details, price_verified, data_region, trains_on_inputs, delivery, settings, priority, active',
        )
        .eq('active', true);
      if (error) throw new Error('No se ha podido leer el registro de modelos');
      return (data ?? []) as MediaModelRow[];
    },
    probe(id, effective) {
      const realFetch = (input: string, init?: RequestInit) => fetch(input, init);
      const local = loadSocialLocalTest(effective);
      return probeIntegration(id, effective, { fetch: realFetch, graphFetch: local ? local.fetch : realFetch });
    },
    allowedOrigin: env.PLATFORM_ALLOWED_ORIGIN?.trim() || env.AI_ALLOWED_ORIGIN?.trim() || undefined,
    log,
  }),
);
