// Edge Function `drive-media`: conectar Google Drive a una organización, elegir
// fotos de Drive para la biblioteca de una marca y servir esas imágenes sin
// copiarlas a Storage. Lógica en handler.ts y ../_shared/drive/; variables en
// docs/biblioteca-drive.md.
//
// La configuración se lee de «Plataforma → Integraciones» y, si no está, de las
// variables de entorno (../_shared/integrations/settings.ts).
//
// Adaptador de Google SIN PROBAR contra el servicio real (no hay cliente OAuth
// todavía). En la prueba local, con DRIVE_E2E_SIMULATED=true y un Supabase
// local, Drive es el simulado.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { loadDriveConfig } from '../_shared/drive/config.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { createDriveMediaHandler, type DriveAssetRef } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, serviceKey, options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[drive-media] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);

const asUser = (accessToken: string) =>
  createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
    ...options,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

const handlerFor = memoByEnv((effective) => {
  const config = loadDriveConfig(effective, (input, init) => fetch(input, init));
  for (const problem of config.problems) console.warn(`[drive-media] configuración: ${problem}`);
  return createDriveMediaHandler({
    config,
    rpc,
    userRpc(accessToken) {
      const client = asUser(accessToken);
      return (fn, args) => client.rpc(fn, args);
    },
    async assetsForPaths(accessToken, paths) {
      // Con la sesión de la persona, la RLS de media_assets decide qué ve.
      const client = accessToken ? asUser(accessToken) : admin;
      const { data, error } = await client
        .from('media_assets')
        .select('storage_path, drive_connection_id, drive_file_id')
        .eq('source', 'google_drive')
        .in('storage_path', paths);
      if (error) throw new Error('No se pudieron leer los recursos');
      return (data ?? []) as DriveAssetRef[];
    },
    isServiceToken: (token) => Boolean(serviceKey) && token === serviceKey,
    allowedOrigin: env.DRIVE_ALLOWED_ORIGIN?.trim() || undefined,
    log,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
