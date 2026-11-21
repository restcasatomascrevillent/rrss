// Conexión con Supabase del servicio de medios, compartida por `ai-media`,
// `ai-media-poll` y `ai-media-webhook` (solo Deno; la lógica está probada en
// Node a través de runtime.ts, supabase-storage.ts y los handler.ts).
//
// Secretos: la clave de servicio y las de los proveedores solo existen en el
// servidor: las de los proveedores, en «Plataforma → Integraciones» (cifradas en
// Vault) o en las variables de entorno de la función (docs/ia-medios.md, §5). Nada de
// esto llega al navegador. `SUPABASE_URL`, `SUPABASE_ANON_KEY` y
// `SUPABASE_SERVICE_ROLE_KEY` las pone Supabase en todas las funciones.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { MediaProviderFailure, type MediaReader } from '../_shared/ai/media/contract.ts';
import type { MediaModelRow } from '../_shared/ai/media/models.ts';
import { createMediaRuntime, type MediaRuntime } from '../_shared/ai/media/runtime.ts';
import { createSupabaseMediaStorage, supabaseMediaStorageBackend } from '../_shared/ai/media/supabase-storage.ts';
import { createRpcSettingsLoader } from '../_shared/integrations/settings.ts';
import { mediaStoresFor, uploadStoreFor, type MediaStores } from '../_shared/storage/resolve.ts';
import { createSupabaseObjectStorage } from '../_shared/storage/supabase.ts';

export const env = Deno.env.toObject();
export const supabaseUrl = env.SUPABASE_URL ?? '';
export const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/** Cliente con la clave de servicio: cupo, cola, registro de modelos y almacenamiento. */
export const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY ?? '', clientOptions);
export const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);

const reader: MediaReader = {
  async getGeneration(id) {
    const { data, error } = await admin
      .from('ai_generations')
      .select('id, organization_id, brand_id, provider, status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error('No se ha podido leer la generación');
    return data;
  },
  async getJob(organizationId, idempotencyKey) {
    const { data, error } = await admin
      .from('jobs')
      .select('id, status, payload')
      .eq('organization_id', organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) throw new Error('No se ha podido leer el trabajo');
    return data;
  },
};

/** Configuración efectiva: «Plataforma → Integraciones» y, si no, las variables. */
export const settings = createRpcSettingsLoader(rpc, env, (event, data) =>
  console.error(`[ai-media] ${event}`, JSON.stringify(data)),
);

const supabaseStorage = createSupabaseObjectStorage({
  url: supabaseUrl,
  serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
});
let stores: { env: Record<string, string | undefined>; value: MediaStores } | null = null;

/** Supabase Storage y, si está configurado, Cloudflare R2 (docs/almacenamiento-r2.md). */
export async function mediaStores(): Promise<MediaStores> {
  const effective = await settings.get();
  if (stores?.env !== effective) {
    stores = {
      env: effective,
      value: mediaStoresFor(effective, supabaseStorage, (event, data) =>
        console.error(`[ai-media] ${event}`, JSON.stringify(data)),
      ),
    };
  }
  return stores.value;
}

// Lo generado se guarda donde vayan las subidas nuevas (R2 o Supabase Storage).
const baseBackend = supabaseMediaStorageBackend(admin as never);
const storage = createSupabaseMediaStorage({
  async upload(path, bytes, contentType) {
    let target;
    try {
      target = await uploadStoreFor(await mediaStores(), rpc, path);
      if (target.backend === 'r2') await target.put(path, bytes, contentType, bytes.byteLength);
    } catch {
      throw new MediaProviderFailure('storage_failed', 'No se ha podido guardar el archivo en el almacenamiento', {
        retryable: true,
      });
    }
    if (target.backend === 'supabase') await baseBackend.upload(path, bytes, contentType);
  },
  saveAsset: (row) => baseBackend.saveAsset(row),
});

let cached: { at: number; env: Record<string, string | undefined>; runtime: MediaRuntime } | null = null;
const CACHE_MS = 60_000;

/**
 * Servicio y modelos. El registro de modelos se relee como mucho una vez por
 * minuto: activar un modelo no exige redesplegar. Lanza si la imagen simulada
 * se pide fuera de un Supabase local (la función no debe atender así).
 */
export async function loadRuntime(): Promise<MediaRuntime> {
  const effective = await settings.get();
  if (cached && cached.env === effective && Date.now() - cached.at < CACHE_MS) return cached.runtime;
  const { data, error } = await admin
    .from('ai_media_models')
    .select(
      'provider, model, task, operation, display_name, billing_unit, price_micros, price_details, price_verified, data_region, trains_on_inputs, delivery, settings, priority, active',
    )
    .eq('active', true);
  if (error) throw new Error('No se ha podido leer el registro de modelos');
  const runtime = createMediaRuntime({
    env: effective,
    fetch: (input, init) => fetch(input, init),
    rpc,
    reader,
    storage,
    modelRows: (data ?? []) as MediaModelRow[],
  });
  cached = { at: Date.now(), env: effective, runtime };
  return runtime;
}

// Arranque: comprobar la guarda de la imagen simulada y dejar en el registro
// lo que falta configurar en las variables (solo nombres; lo de «Plataforma →
// Integraciones» se lee en cada petición).
export function checkConfiguration(name: string): void {
  const runtime = createMediaRuntime({ env, fetch, rpc, reader, storage, modelRows: [] });
  for (const problem of runtime.problems) console.warn(`[${name}] configuración: ${problem}`);
}
