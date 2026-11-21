// Configuración del trabajador, toda por variables de entorno (ver README).
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const int = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);

/** Token del trabajador para `worker-gateway` (Plataforma → Integraciones → «Generar token»). */
export const WORKER_GATEWAY_TOKEN_PATTERN = /^rrss_wgt_[A-Za-z0-9_-]{43}$/;

/**
 * Variables que Fly.io pone en cada máquina: si está alguna, el trabajador
 * corre en Fly (https://fly.io/docs/machines/runtime-environment/).
 */
export const FLY_RUNTIME_VARS = ['FLY_APP_NAME', 'FLY_MACHINE_ID', 'FLY_ALLOC_ID'] as const;

export const configSchema = z.object({
  SUPABASE_URL: z.url(),
  /**
   * Cómo entra el trabajador en Supabase:
   *   gateway      (por defecto) por la función `worker-gateway` con su token
   *                propio (WORKER_GATEWAY_TOKEN). Sin ninguna clave de Supabase.
   *   service-key  con la clave de servicio, como antes: solo en local y en CI,
   *                y hay que pedirlo explícitamente. En Fly no arranca así.
   */
  WORKER_SUPABASE_ACCESS: z.enum(['gateway', 'service-key']).default('gateway'),
  WORKER_GATEWAY_TOKEN: z.string().trim().optional(),
  /** Dirección del intermediario; por defecto, `<SUPABASE_URL>/functions/v1/worker-gateway`. */
  WORKER_GATEWAY_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  WORKER_BUCKET: z.string().min(1).default('brand-media'),
  WORKER_MODE: z.enum(['drain', 'continuous']).default('drain'),
  WORKER_ID: z.string().min(1).max(200).default(`media-${os.hostname()}-${process.pid}`),
  WORKER_CONCURRENCY: int(1, 1, 16),
  WORKER_LEASE_SECONDS: int(300, 5, 3600),
  WORKER_MAX_ATTEMPT_SECONDS: int(3600, 5, 6 * 3600),
  WORKER_POLL_MS: int(5_000, 100, 600_000),
  WORKER_IDLE_EXIT_MS: int(0, 0, 3_600_000),
  WORKER_SHUTDOWN_GRACE_MS: int(0, 0, 600_000),
  WORKER_TMP_DIR: z.string().min(1).default(path.join(os.tmpdir(), 'rrss-worker')),
  WORKER_FONTS_DIR: z.string().min(1).optional(),
  /** Tope de cada archivo subido: el del cubo (50 MB en el plan gratuito de Supabase). */
  WORKER_MAX_UPLOAD_BYTES: int(50 * 1024 * 1024, 1024 * 1024, 5 * 1024 * 1024 * 1024),
  /**
   * auto: pregunta a la función `media-storage` dónde está cada archivo (R2 o
   * Supabase) y dónde subir; si no está desplegada, Supabase. supabase: solo
   * Supabase Storage (docs/almacenamiento-r2.md).
   */
  WORKER_MEDIA_STORAGE: z.enum(['auto', 'supabase']).default('auto'),
});
export type WorkerConfig = z.infer<typeof configSchema>;

export const runsOnFly = (env: NodeJS.ProcessEnv) => FLY_RUNTIME_VARS.some((name) => Boolean(env[name]?.trim()));

/**
 * Lee y comprueba la configuración. Reglas de acceso a Supabase
 * (docs/alojamiento.md, §5):
 *   · en Fly.io, si aparece SUPABASE_SERVICE_ROLE_KEY o se pide el modo
 *     `service-key`, NO arranca: la clave de servicio no debe estar allí;
 *   · en modo `gateway` hace falta WORKER_GATEWAY_TOKEN con forma `rrss_wgt_…`
 *     (pegar una clave de Supabase ahí también se rechaza);
 *   · en modo `service-key` hace falta la clave.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Solo nombres de variable y motivo: nunca valores.
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Configuración del trabajador inválida: ${issues}`);
  }
  const config = parsed.data;
  const serviceKey = config.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (runsOnFly(env) && (serviceKey || config.WORKER_SUPABASE_ACCESS === 'service-key')) {
    throw new Error(
      'Configuración del trabajador inválida: en Fly.io el trabajador no arranca con la clave de servicio de Supabase. ' +
        'Quita SUPABASE_SERVICE_ROLE_KEY (y WORKER_SUPABASE_ACCESS) de los secretos de la app y pon WORKER_GATEWAY_TOKEN ' +
        '(Plataforma → Integraciones → Trabajador de medios → «Generar token»).',
    );
  }
  if (config.WORKER_SUPABASE_ACCESS === 'gateway') {
    if (!config.WORKER_GATEWAY_TOKEN) {
      throw new Error(
        'Configuración del trabajador inválida: WORKER_GATEWAY_TOKEN: falta (genéralo en Plataforma → Integraciones → ' +
          'Trabajador de medios; en local, WORKER_SUPABASE_ACCESS=service-key usa la clave de servicio).',
      );
    }
    if (!WORKER_GATEWAY_TOKEN_PATTERN.test(config.WORKER_GATEWAY_TOKEN)) {
      throw new Error(
        'Configuración del trabajador inválida: WORKER_GATEWAY_TOKEN: no es un token del trabajador (empieza por rrss_wgt_). ' +
          'Nunca una clave de Supabase.',
      );
    }
    // En modo gateway la clave, si alguien la puso, ni se usa ni se guarda.
    return { ...config, SUPABASE_SERVICE_ROLE_KEY: undefined };
  }
  if (!serviceKey || serviceKey.length < 20) {
    throw new Error(
      'Configuración del trabajador inválida: SUPABASE_SERVICE_ROLE_KEY: falta (modo WORKER_SUPABASE_ACCESS=service-key)',
    );
  }
  return { ...config, SUPABASE_SERVICE_ROLE_KEY: serviceKey, WORKER_GATEWAY_TOKEN: undefined };
}
