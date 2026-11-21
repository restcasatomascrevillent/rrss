// Prepara el trabajador de medios en Fly.io desde un ordenador con `flyctl`
// ya autenticado (`flyctl auth login`). ALTERNATIVA: el camino principal es el
// «Deploy from GitHub» del panel de Fly y, si no, GitHub Actions
// (docs/alojamiento.md, §4). Sirve donde flyctl sí se puede ejecutar.
//
//   node worker/scripts/fly-preparar.mjs             # solo enseña lo que haría (por defecto)
//   node worker/scripts/fly-preparar.mjs --aplicar   # lo hace
//   opciones: --app rrss-worker --org personal --expiry 4320h
//
// Pasos (con --aplicar):
//   1. crea la app en Fly si no existe;
//   2. pone como secretos de la app SUPABASE_URL y WORKER_GATEWAY_TOKEN, el
//      token del trabajador que se genera en Plataforma → Integraciones →
//      Trabajador de medios («Generar token») y se pasa a este script en la
//      variable de entorno WORKER_GATEWAY_TOKEN (`flyctl secrets import` por
//      la entrada estándar). La clave de servicio de Supabase NO va a Fly
//      (docs/alojamiento.md, §5): si la app tenía SUPABASE_SERVICE_ROLE_KEY de
//      antes, se quita;
//   3. despliega con el constructor remoto (`flyctl deploy --remote-only`);
//   4. crea un token de despliegue de la app (el de menor permiso que puede
//      arrancar su máquina) y guarda token, app y máquina en el Vault de
//      staging (`rrss_fly_api_token`, `rrss_fly_app`, `rrss_fly_machine_id`),
//      de donde los lee `private.media_worker_wake()` si no están en
//      Plataforma → Integraciones.
// El token de rrss para Supabase (~/.supabase-rrss/token, o
// RRSS_SUPABASE_TOKEN_FILE) solo se usa en el paso 4.
// Nunca imprime ni escribe en disco los tokens: viven solo en la memoria del
// proceso y en la entrada estándar de flyctl o en la petición HTTPS a Supabase. El proyecto de Supabase está fijado aquí (staging).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGING_REF = 'zzkdrfhqmjfvrdsoguio';
export const SUPABASE_URL = `https://${STAGING_REF}.supabase.co`;
const MANAGEMENT_API = 'https://api.supabase.com';
const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MACHINE_RE = /^[a-z0-9]{6,32}$/;
const FLY_TOKEN_RE = /FlyV1 fm\d_[A-Za-z0-9_+/=-]+(?:,fm\d_[A-Za-z0-9_+/=-]+)*/;
/** Token del trabajador para worker-gateway (supabase/functions/_shared/integrations/catalog.ts). */
export const WORKER_GATEWAY_TOKEN_RE = /^rrss_wgt_[A-Za-z0-9_-]{43}$/;

export class UsageError extends Error {}

/** Opciones de la línea de órdenes. Por defecto, solo enseña lo que haría. */
export function parseArgs(argv) {
  const options = { apply: false, app: 'rrss-worker', org: 'personal', expiry: '4320h' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`Falta el valor de ${arg}`);
      i += 1;
      return v;
    };
    if (arg === '--aplicar') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--app') options.app = next();
    else if (arg === '--org') options.org = next();
    else if (arg === '--expiry') options.expiry = next();
    else throw new UsageError(`Opción desconocida: ${arg}`);
  }
  if (!APP_RE.test(options.app)) throw new UsageError('Nombre de app no válido (minúsculas, cifras y guiones).');
  if (!APP_RE.test(options.org)) throw new UsageError('Organización no válida.');
  if (!/^\d{1,5}h$/.test(options.expiry)) throw new UsageError('Caducidad no válida (horas, por ejemplo 4320h).');
  return options;
}

/** Id de la máquina de `flyctl machines list --json` (la de Fráncfort si hay varias). */
export function parseMachineId(json) {
  let machines;
  try {
    machines = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(machines)) return null;
  const valid = machines.filter((m) => typeof m?.id === 'string' && MACHINE_RE.test(m.id));
  const chosen = valid.find((m) => m.region === 'fra') ?? valid[0];
  return chosen ? { id: chosen.id, total: valid.length } : null;
}

/** El token de la salida de `flyctl tokens create deploy`. */
export function parseFlyToken(output) {
  return FLY_TOKEN_RE.exec(output ?? '')?.[0] ?? null;
}

/** SQL que crea o sustituye un secreto de Vault. Solo valores ya validados (sin comillas). */
export function vaultUpsertSql(name, value) {
  if (!/^rrss_fly_[a-z_]+$/.test(name)) throw new Error('Nombre de secreto no permitido');
  if (!/^[A-Za-z0-9 _+/=,.-]+$/.test(value)) throw new Error('Valor con caracteres no permitidos');
  return [
    'do $rrss$ begin',
    `  if exists (select 1 from vault.secrets where name = '${name}') then`,
    `    perform vault.update_secret((select id from vault.secrets where name = '${name}'), '${value}');`,
    '  else',
    `    perform vault.create_secret('${value}', '${name}', 'rrss · trabajador de medios en Fly.io (fly-preparar)');`,
    '  end if;',
    'end $rrss$;',
  ].join('\n');
}

/** Pasos en orden, tal como se enseñan (sin ningún valor secreto). */
export function describePlan(options) {
  const a = options.app;
  return [
    `flyctl status --app ${a}  →  si no existe: flyctl apps create ${a} --org ${options.org}`,
    `flyctl secrets import --app ${a} --stage  ←  SUPABASE_URL=${SUPABASE_URL}, WORKER_GATEWAY_TOKEN=•••• (de la variable de entorno, por la entrada estándar)`,
    `flyctl secrets unset SUPABASE_SERVICE_ROLE_KEY --app ${a} --stage  (si quedaba de antes: la clave de servicio no va a Fly)`,
    `(en worker/) flyctl deploy . --config fly.toml --app ${a} --remote-only --ha=false --strategy immediate --smoke-checks=false --yes`,
    `flyctl machines list --app ${a} --json  →  id de la máquina`,
    `flyctl tokens create deploy --app ${a} --name rrss-despertador --expiry ${options.expiry}  →  token (no se muestra)`,
    `POST ${MANAGEMENT_API}/v1/projects/${STAGING_REF}/database/query  →  Vault: rrss_fly_api_token=••••, rrss_fly_app=${a}, rrss_fly_machine_id=<id>`,
  ];
}

function defaultExec(args, { input, capture = false } = {}) {
  const result = spawnSync('flyctl', args, {
    cwd: WORKER_DIR,
    input,
    encoding: 'utf8',
    // Sin intérprete de órdenes (flyctl es un ejecutable también en Windows).
    // Con la salida capturada no se enseña nada (puede llevar el token).
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  if (result.error) throw new Error(`No se pudo ejecutar flyctl (${result.error.code ?? result.error.message})`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

function readSupabaseToken(env) {
  const file = env.RRSS_SUPABASE_TOKEN_FILE ?? path.join(homedir(), '.supabase-rrss', 'token');
  return { file, exists: existsSync(file), read: () => readFileSync(file, 'utf8').trim() };
}

/**
 * Ejecuta (o, sin `apply`, solo enseña) la preparación. `deps` permite probarlo
 * sin red ni flyctl: en modo «solo enseñar» no se llama a ninguno de los dos.
 */
export async function run(options, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const exec = deps.exec ?? defaultExec;
  const doFetch = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const token = readSupabaseToken(env);

  log(
    `Trabajador de medios en Fly.io · app ${options.app} · organización ${options.org} · Supabase staging (${STAGING_REF})`,
  );
  log(`worker/fly.toml: ${existsSync(path.join(WORKER_DIR, 'fly.toml')) ? 'encontrado' : 'NO ENCONTRADO'}`);
  log(`Token de rrss para Supabase: ${token.exists ? 'presente' : `falta (${token.file})`}`);
  const workerToken = env.WORKER_GATEWAY_TOKEN?.trim() ?? '';
  log(
    `Token del trabajador (WORKER_GATEWAY_TOKEN): ${
      WORKER_GATEWAY_TOKEN_RE.test(workerToken)
        ? 'presente'
        : 'falta: genéralo en Plataforma → Integraciones → Trabajador de medios'
    }`,
  );
  if (!options.apply) {
    log('Modo «solo enseñar»: no se ejecuta flyctl ni se llama a ninguna API. Pasos:');
    describePlan(options).forEach((step, i) => log(`  ${i + 1}. ${step}`));
    log('Para hacerlo de verdad: --aplicar (con flyctl autenticado: flyctl auth login).');
    return { applied: false };
  }

  if (!token.exists) throw new Error(`Falta el token de rrss en ${token.file}`);
  if (!WORKER_GATEWAY_TOKEN_RE.test(workerToken)) {
    throw new Error(
      'Falta WORKER_GATEWAY_TOKEN (o no tiene la forma rrss_wgt_…): genéralo en Plataforma → Integraciones → Trabajador de medios.',
    );
  }
  if (exec(['version'], { capture: true }).status !== 0) throw new Error('flyctl no responde');

  // 1. App
  if (exec(['status', '--app', options.app], { capture: true }).status === 0) {
    log(`1. La app ${options.app} ya existe.`);
  } else if (exec(['apps', 'create', options.app, '--org', options.org]).status !== 0) {
    throw new Error('No se pudo crear la app');
  } else log(`1. App ${options.app} creada.`);

  // 2. URL y token del trabajador → secretos de la app (nunca la clave de servicio)
  const imported = exec(['secrets', 'import', '--app', options.app, '--stage'], {
    input: `SUPABASE_URL=${SUPABASE_URL}\nWORKER_GATEWAY_TOKEN=${workerToken}\n`,
    capture: true,
  });
  if (imported.status !== 0) throw new Error('flyctl no pudo guardar los secretos');
  const listed = exec(['secrets', 'list', '--app', options.app, '--json'], { capture: true });
  if (listed.status === 0 && /"SUPABASE_SERVICE_ROLE_KEY"/.test(listed.stdout)) {
    const unset = exec(['secrets', 'unset', 'SUPABASE_SERVICE_ROLE_KEY', '--app', options.app, '--stage'], {
      capture: true,
    });
    if (unset.status !== 0) {
      throw new Error('No se pudo quitar SUPABASE_SERVICE_ROLE_KEY de Fly: quítala a mano (la app → Secrets)');
    }
    log('2. Quitada SUPABASE_SERVICE_ROLE_KEY, que quedaba de antes en Fly.');
  }
  log('2. Secretos puestos en Fly: SUPABASE_URL y WORKER_GATEWAY_TOKEN.');

  // 3. Despliegue
  // Desde worker/ (cwd de flyctl): fly.toml y el Dockerfile son relativos a esa carpeta.
  const deployArgs = ['deploy', '.', '--config', 'fly.toml', '--app', options.app];
  // Sin comprobaciones de humo: la máquina sale sola al vaciar la cola.
  deployArgs.push('--remote-only', '--ha=false', '--strategy', 'immediate', '--smoke-checks=false', '--yes');
  if (exec(deployArgs).status !== 0) throw new Error('El despliegue falló (mira la salida de flyctl)');
  const machine = parseMachineId(exec(['machines', 'list', '--app', options.app, '--json'], { capture: true }).stdout);
  if (!machine) throw new Error('No se encontró la máquina tras desplegar');
  log(`3. Desplegado. Máquina ${machine.id}${machine.total > 1 ? ` (hay ${machine.total}: se usa la de fra)` : ''}.`);

  // 4. Token de despliegue de la app → Vault de staging
  const auth = { headers: { Authorization: `Bearer ${token.read()}` } };
  const created = exec(
    ['tokens', 'create', 'deploy', '--app', options.app, '--name', 'rrss-despertador', '--expiry', options.expiry],
    { capture: true },
  );
  const flyToken = created.status === 0 ? parseFlyToken(created.stdout) : null;
  if (!flyToken) throw new Error('flyctl no devolvió un token de despliegue');
  const sql = [
    vaultUpsertSql('rrss_fly_api_token', flyToken),
    vaultUpsertSql('rrss_fly_app', options.app),
    vaultUpsertSql('rrss_fly_machine_id', machine.id),
  ].join('\n');
  const saved = await doFetch(`${MANAGEMENT_API}/v1/projects/${STAGING_REF}/database/query`, {
    method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  // Solo el código: el cuerpo de un error podría repetir la consulta.
  if (!saved.ok) throw new Error(`No se pudo guardar en el Vault de staging (HTTP ${saved.status})`);
  log('4. Token (caduca en ' + options.expiry + '), app y máquina guardados en el Vault de staging.');
  log('Listo. Comprueba en Plataforma → Integraciones → Trabajador de medios, o pega ahí los mismos datos.');
  return { applied: true, machineId: machine.id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
