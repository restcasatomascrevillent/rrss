// Edge Function `worker-gateway`: el trabajador de medios (Fly.io) entra a
// Supabase por aquí con su token propio, sin la clave de servicio (lógica y
// operaciones en handler.ts; permisos en la migración 20261210010000;
// docs/alojamiento.md, §5).
//
// En config.toml lleva `verify_jwt = false`: el token del trabajador no es un
// JWT de Supabase. Lo comprueba la base de datos (huella SHA-256).
//
// La clave de servicio se queda aquí, en los secretos de las funciones de
// Supabase. La configuración de R2 se lee de «Plataforma → Integraciones» y,
// si no está, de las variables de entorno, igual que en `media-storage`.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { loadMediaStorageConfig } from '../_shared/storage/config.ts';
import { createS3Storage } from '../_shared/storage/s3.ts';
import { createSupabaseObjectStorage } from '../_shared/storage/supabase.ts';
import { createWorkerGatewayHandler } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[worker-gateway] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);
const supabaseStorage = createSupabaseObjectStorage({ url: supabaseUrl, serviceKey });
const maxUpload = Number(env.WORKER_GATEWAY_MAX_UPLOAD_BYTES ?? '') || undefined;

/** Imágenes de Drive: las firma `drive-media` (la llamada no sale de Supabase). */
async function driveUrl(path: string): Promise<string | null> {
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/drive-media/sign`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [path] }),
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(`drive-media respondió ${response.status}`);
  }
  const body = (await response.json()) as { tickets?: Record<string, { full?: string }> };
  const ticket = body.tickets?.[path]?.full;
  return ticket ? `/functions/v1/drive-media/file/${encodeURIComponent(ticket)}` : null;
}

const handlerFor = memoByEnv((effective) => {
  const config = loadMediaStorageConfig(effective);
  for (const problem of config.problems) console.warn(`[worker-gateway] configuración: ${problem}`);
  return createWorkerGatewayHandler({
    rpc,
    config,
    r2: config.s3 ? createS3Storage(config.s3) : null,
    supabase: supabaseStorage,
    supabaseUrl,
    driveUrl,
    maxSupabaseUploadBytes: maxUpload,
    log,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
