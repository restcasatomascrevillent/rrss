// Configuración de la herramienta: dónde están las credenciales de la cuenta de
// la agencia y dónde se deja el trabajo. Las credenciales viven en un archivo
// local FUERA del repositorio; nunca en variables del repositorio ni en el código.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Credentials {
  /** URL del proyecto de Supabase (pública). */
  url: string;
  /** Clave pública (anon) del proyecto. Nunca la clave de servicio. */
  anonKey: string;
  /** Cuenta de la agencia: un usuario normal de la plataforma. */
  email: string;
  password: string;
}

export interface AgencyConfig {
  credentialsPath: string;
  workDir: string;
  /** Minutos que dura el cerrojo al tomar un encargo. */
  leaseMinutes: number;
}

/** Raíz del repositorio (la carpeta que contiene agency/). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AgencyConfig {
  const home = os.homedir();
  const expand = (value: string) => (value.startsWith('~') ? path.join(home, value.slice(1)) : value);
  const lease = Number(env.RRSS_AGENCIA_CERROJO_MINUTOS ?? 240);
  return {
    credentialsPath: path.resolve(expand(env.RRSS_AGENCIA_CREDENCIALES ?? '~/.rrss-agencia/credenciales.json')),
    workDir: path.resolve(expand(env.RRSS_AGENCIA_TRABAJO ?? '~/.rrss-agencia/trabajo')),
    leaseMinutes: Number.isInteger(lease) && lease >= 5 && lease <= 1440 ? lease : 240,
  };
}

/** ¿Está `file` dentro de `dir`? */
export function isInside(file: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Lee las credenciales. Se niega a usar un archivo dentro del repositorio (se
 * acabaría subiendo) y a usar una clave que parezca la de servicio.
 */
export async function loadCredentials(file: string, repoRoot: string = REPO_ROOT): Promise<Credentials> {
  if (isInside(file, repoRoot)) {
    throw new ConfigError(
      `El archivo de credenciales (${file}) está dentro del repositorio. Muévelo fuera (por defecto ~/.rrss-agencia/credenciales.json).`,
    );
  }
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new ConfigError(
      `No encuentro el archivo de credenciales (${file}). Créalo con url, anonKey, email y password, o indica otra ruta en RRSS_AGENCIA_CREDENCIALES.`,
    );
  }
  let parsed: Partial<Record<keyof Credentials, unknown>>;
  try {
    parsed = JSON.parse(raw) as Partial<Record<keyof Credentials, unknown>>;
  } catch {
    throw new ConfigError(`El archivo de credenciales (${file}) no es un JSON válido.`);
  }
  const missing = (['url', 'anonKey', 'email', 'password'] as const).filter(
    (key) => typeof parsed[key] !== 'string' || !(parsed[key] as string).trim(),
  );
  if (missing.length) throw new ConfigError(`Faltan datos en el archivo de credenciales: ${missing.join(', ')}.`);
  const credentials = parsed as Credentials;
  if (!/^https?:\/\//.test(credentials.url))
    throw new ConfigError('La url de las credenciales debe empezar por https://.');
  if (jwtRole(credentials.anonKey) === 'service_role' || credentials.anonKey.startsWith('sb_secret_')) {
    throw new ConfigError(
      'La clave de las credenciales es la clave de servicio. La herramienta solo admite la clave pública (anon): entra como un usuario normal.',
    );
  }
  return { ...credentials, url: credentials.url.replace(/\/+$/, '') };
}

/** Rol de un JWT de Supabase sin verificar la firma (solo para rechazar la clave de servicio). */
export function jwtRole(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof data.role === 'string' ? data.role : null;
  } catch {
    return null;
  }
}
