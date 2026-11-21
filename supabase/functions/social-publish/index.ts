// Edge Function `social-publish`: el publicador de la Fase 3 (handler.ts).
// La dispara pg_cron (migración 20261119040000) y solo atiende a la clave de
// servicio. La ruta `/now` («Publicar ahora»)
// atiende a la sesión de la persona. En config.toml lleva `verify_jwt = false` porque la clave puede
// llegar en la cabecera `apikey`; la comprobación la hace handler.ts.
//
// Secretos (docs/publicacion.md): META_APP_ID, META_APP_SECRET y las claves de
// cifrado de los tokens (SOCIAL_TOKEN_KEYS, SOCIAL_TOKEN_KEY_ID), de «Plataforma
// → Integraciones» o, si no están ahí, de las variables de entorno. Sin claves
// de cifrado no publica nada (y lo deja en el registro). Adaptador de Meta SIN PROBAR contra
// el servicio real; en la prueba local, Graph API simulada (local-test.ts).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { loadSocialConfig } from '../_shared/social/config.ts';
import { checkAccountTokens } from '../_shared/social/oauth.ts';
import { mediaStoresFor, signStoredPath } from '../_shared/storage/resolve.ts';
import { createSupabaseObjectStorage } from '../_shared/storage/supabase.ts';
import type { StorageBackend } from '../_shared/storage/contract.ts';
import { createSocialPublishHandler } from './handler.ts';

const env = Deno.env.toObject();
const admin = createClient(env.SUPABASE_URL ?? '', env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[social-publish] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);
const workerName = `social-publish:${crypto.randomUUID()}`;
const supabaseStorage = createSupabaseObjectStorage({
  url: env.SUPABASE_URL ?? '',
  serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
});

/** En qué almacén está el archivo (docs/almacenamiento-r2.md); lo que no es un recurso, en Supabase. */
async function backendOf(path: string): Promise<StorageBackend> {
  const { data } = await admin.from('media_assets').select('storage_backend').eq('storage_path', path).maybeSingle();
  return data?.storage_backend === 'r2' ? 'r2' : 'supabase';
}

const handlerFor = memoByEnv((effective) => {
  const config = loadSocialConfig(effective, (input, init) => fetch(input, init));
  for (const problem of config.problems) console.warn(`[social-publish] configuración: ${problem}`);
  // Supabase Storage o Cloudflare R2: Instagram descarga la URL firmada sin cabeceras.
  const stores = mediaStoresFor(effective, supabaseStorage, log);
  return createSocialPublishHandler({
    serviceKeys: [env.SUPABASE_SERVICE_ROLE_KEY ?? ''],
    rpc,
    // «Publicar ahora»: la ruta /now actúa con la sesión de la persona.
    userRpc(accessToken) {
      const asUser = createClient(env.SUPABASE_URL ?? '', env.SUPABASE_ANON_KEY ?? '', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      return (fn, args) => asUser.rpc(fn, args);
    },
    allowedOrigin: env.SOCIAL_ALLOWED_ORIGIN?.trim() || undefined,
    workerName,
    log,
    publisher: () =>
      config.keyRing
        ? {
            api: config.graph,
            keyRing: config.keyRing,
            log,
            async signedUrl(path, seconds) {
              try {
                return await signStoredPath(stores, backendOf, path, seconds);
              } catch {
                throw new Error('No se pudo firmar la dirección del recurso');
              }
            },
          }
        : null,
    async accountsToCheck() {
      const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
      const { data, error } = await admin
        .from('social_accounts')
        .select('id, brand_id, network, external_id')
        .eq('status', 'active')
        .or(`token_checked_at.is.null,token_checked_at.lt.${since}`)
        .limit(10);
      if (error) throw new Error('No se pudieron leer las cuentas');
      return data ?? [];
    },
    checkTokens: (accounts) => checkAccountTokens(config, rpc, accounts, log),
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
