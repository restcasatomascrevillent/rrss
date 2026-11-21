// Arranca el trabajador contra un Supabase de rrss sin escribir la clave de
// servicio en ningún archivo: se obtiene en el momento y solo vive en el
// entorno del proceso hijo (ni se imprime ni se guarda).
//
//   node scripts/run-supabase.ts local     # stack local (`supabase start`)
//   node scripts/run-supabase.ts local-gateway  # stack local por worker-gateway,
//                                               # con WORKER_GATEWAY_TOKEN y sin la clave
//   node scripts/run-supabase.ts staging   # proyecto de staging de rrss
//
// Desde `worker/`: `npm run start:local` y `npm run start:staging`. Las
// variables `WORKER_*` del entorno pasan tal cual (p. ej. WORKER_MODE=continuous).
//
//   * local: URL y clave de servicio de `supabase status -o env`, ejecutado en
//     la raíz del repositorio. Solo se acepta una URL de 127.0.0.1/localhost.
//     La clave del stack local es la de demostración de la CLI, pero igualmente
//     no se escribe en ningún sitio.
//   * staging: la clave de servicio se pide a la API de gestión de Supabase con
//     el token de rrss (el mismo archivo que usan scripts/supabase-rrss.sh y
//     scripts/dev-staging.mjs). El proyecto está fijado aquí: no hay forma de
//     apuntar a otro.
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STAGING_REF = 'zzkdrfhqmjfvrdsoguio';
const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(WORKER_DIR, '..');

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Lee una variable de la salida de `supabase status -o env`. */
export function readStatusVar(output: string, name: string): string {
  return new RegExp(`^${name}="?([^"\\r\\n]*)"?`, 'm').exec(output)?.[1] ?? '';
}

function localTarget(): { url: string; serviceKey: string } {
  let output = '';
  try {
    // Con intérprete de órdenes: en Windows la CLI instalada con npm es un `.cmd`.
    output = execSync('supabase status -o env', {
      cwd: REPO_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    fail('No se pudo leer `supabase status`: arranca el stack local con `supabase start` en la raíz del repositorio.');
  }
  const url = readStatusVar(output, 'API_URL');
  const serviceKey = readStatusVar(output, 'SERVICE_ROLE_KEY');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    fail(`\`supabase status\` no da un stack local (API_URL=«${url}»): no se arranca nada.`);
  }
  if (!serviceKey) fail('`supabase status` no trae la clave de servicio (SERVICE_ROLE_KEY).');
  return { url, serviceKey };
}

async function stagingTarget(): Promise<{ url: string; serviceKey: string }> {
  const tokenFile = process.env.RRSS_SUPABASE_TOKEN_FILE ?? path.join(homedir(), '.supabase-rrss', 'token');
  let token = '';
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    fail(`Falta el token de rrss en ${tokenFile} (una sola línea, sin extensión).`);
  }
  if (!token) fail(`El archivo del token de rrss está vacío: ${tokenFile}`);
  const response = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) fail(`No se pudo obtener la clave de servicio de staging (HTTP ${response.status}).`);
  const keys = (await response.json()) as Array<{ name?: string; api_key?: string }>;
  const serviceKey = Array.isArray(keys) ? keys.find((k) => k.name === 'service_role')?.api_key : undefined;
  if (!serviceKey) fail('La respuesta de Supabase no trae la clave de servicio (service_role).');
  return { url: `https://${STAGING_REF}.supabase.co`, serviceKey };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target !== 'local' && target !== 'staging' && target !== 'local-gateway') {
    fail('Uso: node scripts/run-supabase.ts local|local-gateway|staging');
  }
  if (target === 'local-gateway') {
    // Como en Fly: por el intermediario `worker-gateway` del stack local, con
    // el token del trabajador (WORKER_GATEWAY_TOKEN del entorno) y SIN la
    // clave de servicio.
    const { url } = localTarget();
    if (!process.env.WORKER_GATEWAY_TOKEN) fail('local-gateway necesita WORKER_GATEWAY_TOKEN en el entorno.');
    const env: NodeJS.ProcessEnv = { ...process.env, SUPABASE_URL: url, WORKER_SUPABASE_ACCESS: 'gateway' };
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    delete env.RRSS_SUPABASE_TOKEN_FILE;
    process.stdout
      .write(`Trabajador de medios contra local por worker-gateway (${url}), modo ${env.WORKER_MODE ?? 'drain'}
`);
    const child = spawn(process.execPath, ['src/main.ts'], { cwd: WORKER_DIR, env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const { url, serviceKey } = target === 'local' ? localTarget() : await stagingTarget();

  // Modo explícito con la clave de servicio: el de por defecto (el
  // intermediario) es el de Fly; aquí se arranca a mano o en las pruebas.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    WORKER_SUPABASE_ACCESS: 'service-key',
  };
  delete env.WORKER_GATEWAY_TOKEN;
  delete env.RRSS_SUPABASE_TOKEN_FILE;
  process.stdout.write(`Trabajador de medios contra ${target} (${url}), modo ${env.WORKER_MODE ?? 'drain'}\n`);

  const child = spawn(process.execPath, ['src/main.ts'], { cwd: WORKER_DIR, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
