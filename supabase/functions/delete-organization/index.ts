// Edge Function `delete-organization` (RGPD, derecho de supresión): un
// propietario borra su organización con todos sus datos y archivos. Lógica y
// garantías en ../_shared/gdpr/handler.ts.
// Sin desplegar todavía: probada en Node contra las migraciones reales
// (tests/db/rgpd.test.ts).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createGdprDeps, type GdprAdminClient, type GdprAnonClient } from '../_shared/gdpr/deps.ts';
import { createRpcSettingsLoader } from '../_shared/integrations/settings.ts';
import { mediaStoresFor } from '../_shared/storage/resolve.ts';
import { createSupabaseObjectStorage } from '../_shared/storage/supabase.ts';
import { createDeleteOrganizationHandler } from '../_shared/gdpr/handler.ts';

const env = Deno.env.toObject();
const url = env.SUPABASE_URL ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };

const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY ?? '', options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[delete-organization] ${event}`, JSON.stringify(data));
// Cloudflare R2, si está configurado en Plataforma → Integraciones (docs/almacenamiento-r2.md).
const settings = createRpcSettingsLoader(rpc, env, log);
const supabaseStorage = createSupabaseObjectStorage({ url, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '' });

const deps = createGdprDeps({
  name: 'delete-organization',
  admin: admin as unknown as GdprAdminClient,
  r2: async () => mediaStoresFor(await settings.get(), supabaseStorage, log).r2,
  anonClient: () => createClient(url, env.SUPABASE_ANON_KEY ?? '', options) as unknown as GdprAnonClient,
  // CORS: el origen de la aplicación (el mismo que el de la IA si no se indica otro).
  allowedOrigin: env.GDPR_ALLOWED_ORIGIN ?? env.AI_ALLOWED_ORIGIN,
});

Deno.serve(createDeleteOrganizationHandler(deps));
