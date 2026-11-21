// worker/scripts/fly-preparar.mjs (alternativa local para preparar Fly.io):
// el modo «solo enseñar» no ejecuta flyctl ni llama a ninguna red, y las piezas
// que tocan secretos (elegir la clave, leer el token, el SQL de Vault) no los
// sacan nunca por pantalla.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/fly-preparar.mjs');

interface Options {
  apply: boolean;
  app: string;
  org: string;
  expiry: string;
}
interface Module {
  parseArgs(argv: string[]): Options;
  parseMachineId(json: string): { id: string; total: number } | null;
  parseFlyToken(output: string): string | null;
  vaultUpsertSql(name: string, value: string): string;
  run(
    options: Options,
    deps: { log: (line: string) => void; exec: () => never; fetch: () => never; env: Record<string, string> },
  ): Promise<{ applied: boolean }>;
}

let mod: Module;
let home: string;

beforeAll(async () => {
  // Importación dinámica por URL: el script es JavaScript sin tipos.
  mod = (await import(pathToFileURL(SCRIPT).href)) as Module;
  home = await mkdtemp(path.join(os.tmpdir(), 'rrss-fly-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('fly-preparar', () => {
  it('por defecto solo enseña; las opciones se validan', () => {
    expect(mod.parseArgs([])).toEqual({ apply: false, app: 'rrss-worker', org: 'personal', expiry: '4320h' });
    expect(mod.parseArgs(['--aplicar', '--app', 'rrss-worker-staging']).apply).toBe(true);
    expect(mod.parseArgs(['--aplicar', '--dry-run']).apply).toBe(false);
    expect(() => mod.parseArgs(['--app', 'Mi App'])).toThrow(/app/);
    expect(() => mod.parseArgs(['--app'])).toThrow(/Falta/);
    expect(() => mod.parseArgs(['--expiry', '30d'])).toThrow(/Caducidad/);
    expect(() => mod.parseArgs(['--org', 'x;rm -rf'])).toThrow(/Organización/);
  });

  it('en modo «solo enseñar» no ejecuta flyctl ni llama a la red', async () => {
    const lines: string[] = [];
    const never = () => {
      throw new Error('no debería llamarse');
    };
    const result = await mod.run(mod.parseArgs(['--dry-run']), {
      log: (l) => lines.push(l),
      exec: never,
      fetch: never,
      env: { RRSS_SUPABASE_TOKEN_FILE: path.join(home, 'no-existe') },
    });
    expect(result.applied).toBe(false);
    const text = lines.join('\n');
    expect(text).toMatch(/worker\/fly\.toml: encontrado/);
    expect(text).toMatch(/flyctl apps create rrss-worker --org personal/);
    expect(text).toMatch(/flyctl deploy \. --config fly\.toml --app rrss-worker --remote-only/);
    expect(text).toMatch(/tokens create deploy --app rrss-worker/);
    expect(text).toMatch(/rrss_fly_machine_id/);
  });

  it('desde la línea de órdenes, sin flyctl en el PATH ni token, también enseña el plan', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      env: { PATH: '', RRSS_SUPABASE_TOKEN_FILE: path.join(home, 'no-existe'), SystemRoot: process.env.SystemRoot },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Modo «solo enseñar»/);
    expect(r.stdout).toMatch(/falta/);
  });

  it('a Fly va el token del trabajador, nunca la clave de servicio', async () => {
    const lines: string[] = [];
    const never = () => {
      throw new Error('no debería llamarse');
    };
    await mod.run(mod.parseArgs([]), {
      log: (l) => lines.push(l),
      exec: never,
      fetch: never,
      env: { RRSS_SUPABASE_TOKEN_FILE: path.join(home, 'no-existe') },
    });
    const text = lines.join('\n');
    expect(text).toMatch(/WORKER_GATEWAY_TOKEN=••••/);
    expect(text).toMatch(/Token del trabajador \(WORKER_GATEWAY_TOKEN\): falta/);
    expect(text).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY=/);
    expect(text).toMatch(/secrets unset SUPABASE_SERVICE_ROLE_KEY/);
    // Con --aplicar y sin un token del trabajador válido, no hace nada.
    const tokenFile = path.join(home, 'token');
    await writeFile(tokenFile, 'sbp_de_pruebas');
    await expect(
      mod.run(mod.parseArgs(['--aplicar']), {
        log: () => undefined,
        exec: never,
        fetch: never,
        env: { RRSS_SUPABASE_TOKEN_FILE: tokenFile, WORKER_GATEWAY_TOKEN: 'sb_secret_no_vale' },
      }),
    ).rejects.toThrow(/WORKER_GATEWAY_TOKEN/);
  });

  it('saca la máquina de Fráncfort y el token de la salida de flyctl', () => {
    const list = JSON.stringify([
      { id: 'aaaaaaaaaaaaaa', region: 'ams' },
      { id: '148e21dc7d0189', region: 'fra' },
    ]);
    expect(mod.parseMachineId(list)).toEqual({ id: '148e21dc7d0189', total: 2 });
    expect(mod.parseMachineId('no es json')).toBeNull();
    expect(mod.parseFlyToken('FlyV1 fm2_abcDEF+/=12,fm2_xyz789\n')).toBe('FlyV1 fm2_abcDEF+/=12,fm2_xyz789');
    expect(mod.parseFlyToken('Error: sin permiso')).toBeNull();
  });

  it('el SQL de Vault solo admite nombres rrss_fly_* y valores sin comillas', () => {
    expect(mod.vaultUpsertSql('rrss_fly_app', 'rrss-worker')).toMatch(
      /vault\.create_secret\('rrss-worker', 'rrss_fly_app'/,
    );
    expect(() => mod.vaultUpsertSql('rrss_service_role_key', 'x')).toThrow(/no permitido/);
    expect(() => mod.vaultUpsertSql('rrss_fly_app', "x'); drop table jobs; --")).toThrow(/no permitidos/);
  });
});
