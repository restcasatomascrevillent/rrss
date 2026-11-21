// Edge Function `media-storage`: firma lecturas y subidas de los archivos de la
// biblioteca en Cloudflare R2 y borra lo que queda en la cola de limpieza, en
// el almacén de cada archivo. Lógica en handler.ts; variables en
// docs/almacenamiento-r2.md.
//
// La configuración se lee de «Plataforma → Integraciones» y, si no está, de las
// variables de entorno (../_shared/integrations/settings.ts).
//
// Sin probar contra R2 real; en la prueba local, con
// MEDIA_STORAGE_E2E_SIMULATED=true y un Supabase local, el cubo es un MinIO.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { loadMediaStorageConfig } from '../_shared/storage/config.ts';
import { createS3Storage } from '../_shared/storage/s3.ts';
import { createSupabaseObjectStorage } from '../_shared/storage/supabase.ts';
import { createMediaStorageHandler, type AssetLocation } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, serviceKey, options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[media-storage] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);
const supabaseStorage = createSupabaseObjectStorage({ url: supabaseUrl, serviceKey });

const asUser = (accessToken: string) =>
  createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
    ...options,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

const handlerFor = memoByEnv((effective) => {
  const config = loadMediaStorageConfig(effective);
  for (const problem of config.problems) console.warn(`[media-storage] configuración: ${problem}`);
  return createMediaStorageHandler({
    config,
    r2: config.s3 ? createS3Storage(config.s3) : null,
    supabase: supabaseStorage,
    rpc,
    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user ? null : { userId: data.user.id };
    },
    isServiceToken: (token) => Boolean(serviceKey) && token === serviceKey,
    async assetsForPaths(accessToken, paths) {
      // Con la sesión de la persona, la RLS de media_assets decide qué ve.
      const client = accessToken ? asUser(accessToken) : admin;
      const { data, error } = await client
        .from('media_assets')
        .select('storage_path, storage_backend')
        .eq('source', 'storage')
        .in('storage_path', paths);
      if (error) throw new Error('No se pudieron leer los recursos');
      // Las miniaturas (`thumb_path`) se firman como el original: mismo almacén y misma RLS.
      const thumbs = await client
        .from('media_assets')
        .select('thumb_path, storage_backend')
        .eq('source', 'storage')
        .in('thumb_path', paths);
      if (thumbs.error) throw new Error('No se pudieron leer los recursos');
      const thumbRows = (thumbs.data ?? []).map((r) => ({
        storage_path: r.thumb_path as string,
        storage_backend: r.storage_backend,
      }));
      return [...(data ?? []), ...thumbRows] as AssetLocation[];
    },
    async cleanupForPaths(accessToken, paths) {
      const { data, error } = await asUser(accessToken)
        .from('storage_cleanup_queue')
        .select('storage_path, storage_backend')
        .in('storage_path', paths);
      if (error) throw new Error('No se pudo leer la cola de limpieza');
      return (data ?? []) as AssetLocation[];
    },
    allowedOrigin: env.MEDIA_STORAGE_ALLOWED_ORIGIN?.trim() || undefined,
    log,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
