// Edge Function `social-import`: importar las publicaciones que una cuenta de
// Instagram ya tiene (y, si se pide, copiar sus imágenes a la biblioteca).
// Lógica en handler.ts y ../_shared/social/importer.ts; docs/importar-publicaciones.md.
//
// Lleva `verify_jwt = false` en config.toml como el resto: la sesión se comprueba
// aquí con la clave de servicio y la base de datos vuelve a comprobar los permisos.
// Secretos: los mismos que el publicador (META_*, SOCIAL_TOKEN_KEYS…). Lectura del
// histórico SIN PROBAR contra el servicio real; en la prueba local, Graph API
// simulada (local-test.ts).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { loadSocialConfig } from '../_shared/social/config.ts';
import { createImportGraph } from '../_shared/social/import-graph.ts';
import { META_CDN_HOST, runImportStep } from '../_shared/social/importer.ts';
import { loadSocialLocalTest } from '../_shared/social/local-test.ts';
import { DEFAULT_GRAPH_API_VERSION } from '../_shared/social/meta-graph.ts';
import { SIMULATED_CDN_HOST } from '../_shared/social/simulated-graph.ts';
import { mediaStoresFor, uploadStoreFor } from '../_shared/storage/resolve.ts';
import { createSupabaseObjectStorage } from '../_shared/storage/supabase.ts';
import { createSocialImportHandler } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY ?? '', options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[social-import] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);
const supabaseStorage = createSupabaseObjectStorage({
  url: supabaseUrl,
  serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
});

const handlerFor = memoByEnv((effective) => {
  const config = loadSocialConfig(effective, (input, init) => fetch(input, init));
  for (const problem of config.problems) console.warn(`[social-import] configuración: ${problem}`);
  const local = loadSocialLocalTest(effective);
  const doFetch = local ? local.fetch : (input: string, init?: RequestInit) => fetch(input, init);
  const api = createImportGraph({
    fetch: doFetch,
    apiVersion: effective.META_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION,
  });
  const stores = mediaStoresFor(effective, supabaseStorage, log);
  const simulatedHost = local ? new URL(SIMULATED_CDN_HOST).hostname : null;
  return createSocialImportHandler({
    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user ? null : { userId: data.user.id };
    },
    userRpc(accessToken) {
      const client = createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      return (fn, args) => client.rpc(fn, args);
    },
    step: (runId, userId) =>
      config.keyRing
        ? runImportStep(runId, {
            rpc,
            api,
            keyRing: config.keyRing,
            userId,
            fetch: doFetch,
            allowedImageHost: (host) => META_CDN_HOST.test(host) || host === simulatedHost,
            uploadStore: (path) => uploadStoreFor(stores, rpc, path),
            log,
          })
        : null,
    allowedOrigin: env.SOCIAL_ALLOWED_ORIGIN?.trim() || undefined,
    log,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
