// Configuración del almacenamiento de medios (docs/almacenamiento-r2.md). Nada
// de esto llega al navegador.
//
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
//   R2_JURISDICTION (eu | default)       cubo de Cloudflare R2 (API S3)
//   MEDIA_UPLOAD_BACKEND (r2 | supabase)  dónde van las subidas nuevas; por
//                                         defecto, r2 si está configurado
//
// Las funciones pasan aquí la configuración efectiva de «Plataforma →
// Integraciones» (../integrations/settings.ts).
//
// Prueba LOCAL con un servidor compatible con S3 (MinIO), con la misma guarda
// que los demás simulados: MEDIA_STORAGE_E2E_SIMULATED=true y un SUPABASE_URL
// local. Entonces el punto de acceso es MEDIA_STORAGE_S3_ENDPOINT (el que usa la
// función) y MEDIA_STORAGE_S3_PUBLIC_ENDPOINT (el que reciben navegador y
// trabajador en las URL firmadas), y R2_ACCOUNT_ID no hace falta.
import { isLocalSupabaseUrl, LocalTestConfigError } from '../ai/text/local-test.ts';
import type { StorageBackend } from './contract.ts';

export const MEDIA_STORAGE_LOCAL_TEST_FLAG = 'MEDIA_STORAGE_E2E_SIMULATED';
export const R2_JURISDICTIONS = ['eu', 'default'] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

export interface S3Settings {
  /** Punto de acceso de las llamadas del servidor. */
  endpoint: string;
  /** Punto de acceso de las URL firmadas que salen hacia fuera. */
  publicEndpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  jurisdiction: R2Jurisdiction | 'local';
}

export interface MediaStorageConfig {
  /** null: R2 no está configurado (todo en Supabase Storage). */
  s3: S3Settings | null;
  /** Dónde van las subidas nuevas. */
  uploadBackend: StorageBackend;
  simulated: boolean;
  /** Lo que falta o sobra (solo nombres de variables, nunca valores). */
  problems: string[];
}

export const R2_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** https://<cuenta>.r2.cloudflarestorage.com, o .eu. para la jurisdicción UE. */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction): string {
  return `https://${accountId}.${jurisdiction === 'eu' ? 'eu.' : ''}r2.cloudflarestorage.com`;
}

const value = (env: Record<string, string | undefined>, name: string) => env[name]?.trim() || undefined;

function localEndpoint(raw: string | undefined, name: string): string {
  if (!raw) throw new LocalTestConfigError(`${MEDIA_STORAGE_LOCAL_TEST_FLAG}=true necesita ${name}.`);
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return u.toString().replace(/\/+$/, '');
  } catch {
    throw new LocalTestConfigError(`${name} no es una dirección válida.`);
  }
}

export function loadMediaStorageConfig(env: Record<string, string | undefined>): MediaStorageConfig {
  const problems: string[] = [];
  const flag = value(env, MEDIA_STORAGE_LOCAL_TEST_FLAG);
  let simulated = false;
  if (flag) {
    if (flag !== 'true') {
      throw new LocalTestConfigError(
        `${MEDIA_STORAGE_LOCAL_TEST_FLAG} solo admite el valor «true»; para no usarla, quítala.`,
      );
    }
    if (!isLocalSupabaseUrl(env.SUPABASE_URL)) {
      throw new LocalTestConfigError(
        `${MEDIA_STORAGE_LOCAL_TEST_FLAG}=true solo se admite en pruebas locales: SUPABASE_URL debe ser http://127.0.0.1, http://localhost o http://kong (stack local de la CLI). Esta función no arranca; quita la variable.`,
      );
    }
    simulated = true;
    problems.push(
      `${MEDIA_STORAGE_LOCAL_TEST_FLAG}=true: almacenamiento S3 LOCAL (MinIO) para pruebas. Nunca en un entorno con clientes.`,
    );
  }

  const accountId = value(env, 'R2_ACCOUNT_ID');
  const accessKeyId = value(env, 'R2_ACCESS_KEY_ID');
  const secretAccessKey = value(env, 'R2_SECRET_ACCESS_KEY');
  const bucket = value(env, 'R2_BUCKET');
  const jurisdictionRaw = value(env, 'R2_JURISDICTION') ?? 'eu';
  const anything = Boolean(accountId || accessKeyId || secretAccessKey || bucket);

  let s3: S3Settings | null = null;
  if (anything || simulated) {
    const missing: string[] = [];
    if (!simulated && !accountId) missing.push('R2_ACCOUNT_ID');
    if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
    if (!bucket) missing.push('R2_BUCKET');
    for (const name of missing) problems.push(`Falta ${name}`);
    if (!simulated && accountId && !R2_ACCOUNT_ID_PATTERN.test(accountId))
      problems.push('R2_ACCOUNT_ID no tiene la forma de un ID de cuenta de Cloudflare');
    if (bucket && !BUCKET_PATTERN.test(bucket)) problems.push('R2_BUCKET no es un nombre de cubo válido');
    if (!(R2_JURISDICTIONS as readonly string[]).includes(jurisdictionRaw))
      problems.push('R2_JURISDICTION solo admite eu o default');
    const ok =
      missing.length === 0 &&
      (simulated || R2_ACCOUNT_ID_PATTERN.test(accountId!)) &&
      BUCKET_PATTERN.test(bucket!) &&
      (R2_JURISDICTIONS as readonly string[]).includes(jurisdictionRaw);
    if (ok) {
      const jurisdiction = jurisdictionRaw as R2Jurisdiction;
      const endpoint = simulated
        ? localEndpoint(value(env, 'MEDIA_STORAGE_S3_ENDPOINT'), 'MEDIA_STORAGE_S3_ENDPOINT')
        : r2Endpoint(accountId!, jurisdiction);
      const publicEndpoint = simulated
        ? localEndpoint(
            value(env, 'MEDIA_STORAGE_S3_PUBLIC_ENDPOINT') ?? value(env, 'MEDIA_STORAGE_S3_ENDPOINT'),
            'MEDIA_STORAGE_S3_PUBLIC_ENDPOINT',
          )
        : endpoint;
      s3 = {
        endpoint,
        publicEndpoint,
        bucket: bucket!,
        // R2 usa la región «auto»; MinIO, la suya por defecto.
        region: simulated ? 'us-east-1' : 'auto',
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        jurisdiction: simulated ? 'local' : jurisdiction,
      };
    }
  }

  const uploadRaw = value(env, 'MEDIA_UPLOAD_BACKEND');
  let uploadBackend: StorageBackend = s3 ? 'r2' : 'supabase';
  if (uploadRaw === 'supabase') uploadBackend = 'supabase';
  else if (uploadRaw === 'r2') {
    if (s3) uploadBackend = 'r2';
    else problems.push('MEDIA_UPLOAD_BACKEND=r2 sin R2 configurado: las subidas siguen en Supabase');
  } else if (uploadRaw) problems.push('MEDIA_UPLOAD_BACKEND solo admite r2 o supabase');

  return { s3, uploadBackend, simulated, problems };
}

/** ¿Está R2 listo para servir y guardar? (Lo que la interfaz llama «mediaStorage».) */
export function mediaStorageReady(config: MediaStorageConfig): boolean {
  return config.s3 !== null;
}
