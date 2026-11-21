// Configuración efectiva de una función: lo guardado en «Plataforma →
// Integraciones» (migración 20261120010000) y, para lo que no esté guardado,
// las variables de entorno de siempre. Así nada se rompe donde ya hay secretos
// puestos a mano, y lo que se mete desde la interfaz manda.
//
//   * Solo se aplican los nombres del catálogo (catalog.ts): lo guardado no
//     puede tocar SUPABASE_URL, la clave de servicio ni los interruptores de
//     las pruebas locales con simulados.
//   * Claves de cifrado de los tokens (SOCIAL_TOKEN_KEYS): se UNEN las de la
//     base de datos y las del entorno. Así los tokens ya cifrados con una clave
//     del entorno se siguen descifrando aunque la clave nueva viva en la base de
//     datos. El formato de lo cifrado no cambia.
//   * La lectura usa la clave de servicio (`integration_settings_for_service`) y
//     se guarda en memoria unos segundos. Si la base de datos falla, se sigue
//     con lo último leído o, si no hay, con el entorno solo (y se avisa en el
//     registro, sin valores).
//
// Sin dependencias de Deno ni de Node: lo usan las funciones y las pruebas.
import type { RpcClient } from '../ai/contract.ts';
import { INTEGRATION_SETTING_KEYS } from './catalog.ts';

export type Env = Record<string, string | undefined>;

/** Lo guardado (sin filtrar) sobre el entorno; ver el comentario de arriba. */
export function mergeIntegrationEnv(base: Env, stored: Record<string, unknown>): Env {
  const out: Env = { ...base };
  const db: Record<string, string> = {};
  for (const [key, raw] of Object.entries(stored ?? {})) {
    if (!INTEGRATION_SETTING_KEYS.has(key) || typeof raw !== 'string' || !raw.trim()) continue;
    db[key] = raw.trim();
  }
  for (const [key, value] of Object.entries(db)) out[key] = value;

  if (db.SOCIAL_TOKEN_KEYS) {
    const entries = (ring: string | undefined) =>
      (ring ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
    const dbEntries = entries(db.SOCIAL_TOKEN_KEYS);
    const ids = new Set(dbEntries.map((e) => e.slice(0, Math.max(0, e.indexOf(':')))));
    const fromEnv = entries(base.SOCIAL_TOKEN_KEYS).filter((e) => !ids.has(e.slice(0, Math.max(0, e.indexOf(':')))));
    out.SOCIAL_TOKEN_KEYS = [...dbEntries, ...fromEnv].join(',');
    // Cifra lo nuevo la clave que diga la base de datos; si no lo dice, la primera de la base de datos.
    out.SOCIAL_TOKEN_KEY_ID = db.SOCIAL_TOKEN_KEY_ID ?? (dbEntries[0]?.split(':')[0] || base.SOCIAL_TOKEN_KEY_ID);
  }
  return out;
}

export interface SettingsLoaderOptions {
  baseEnv: Env;
  /** Lee lo guardado con la clave de servicio (`integration_settings_for_service`). */
  readStored(): Promise<Record<string, unknown>>;
  /** Cuánto vale lo leído. Por defecto, 30 s. */
  ttlMs?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface SettingsLoader {
  /** Configuración efectiva. Devuelve el MISMO objeto mientras no cambie (sirve de clave de caché). */
  get(): Promise<Env>;
  /** Olvida lo leído (tras guardar desde la interfaz, en la misma instancia). */
  invalidate(): void;
}

export function createSettingsLoader(options: SettingsLoaderOptions): SettingsLoader {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; env: Env; signature: string } | null = null;
  let pending: Promise<Env> | null = null;

  const load = async (): Promise<Env> => {
    let stored: Record<string, unknown>;
    try {
      stored = await options.readStored();
    } catch {
      options.log?.('integration_settings_unavailable', {});
      // Con lo último leído si lo hay; si no, solo el entorno. Se reintenta pronto.
      const env = cached?.env ?? options.baseEnv;
      cached = { at: now() - ttl + 5_000, env, signature: cached?.signature ?? '' };
      return env;
    }
    const signature = JSON.stringify(Object.entries(stored ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    if (cached && cached.signature === signature) {
      cached = { ...cached, at: now() };
      return cached.env;
    }
    const env = mergeIntegrationEnv(options.baseEnv, stored ?? {});
    cached = { at: now(), env, signature };
    return env;
  };

  return {
    async get() {
      if (cached && now() - cached.at < ttl) return cached.env;
      pending ??= load().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate() {
      cached = null;
    },
  };
}

/** Recuerda el último resultado de `build` mientras la configuración efectiva sea la misma. */
export function memoByEnv<T>(build: (env: Env) => T): (env: Env) => T {
  let last: { env: Env; value: T } | null = null;
  return (env) => {
    if (last && last.env === env) return last.value;
    const value = build(env);
    last = { env, value };
    return value;
  };
}

/** El cargador de las funciones: lee lo guardado con la clave de servicio. */
export function createRpcSettingsLoader(
  rpc: RpcClient,
  baseEnv: Env,
  log?: (event: string, data: Record<string, unknown>) => void,
): SettingsLoader {
  return createSettingsLoader({
    baseEnv,
    log,
    async readStored() {
      const { data, error } = await rpc('integration_settings_for_service', {});
      if (error) throw new Error('No se pudieron leer las integraciones');
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    },
  });
}
