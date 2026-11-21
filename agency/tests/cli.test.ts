// La herramienta tal como la ejecuta la sesión de Claude: un proceso de Node
// con el cargador de módulos propio (sin empaquetar), contra el Supabase simulado.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENCY_USER, ANON_KEY, PASSWORD, startFakeSupabase, type FakeSupabase } from './fakeServer.ts';

const AGENCY_DIR = fileURLToPath(new URL('..', import.meta.url));
let fake: FakeSupabase;
let dir: string;
let env: NodeJS.ProcessEnv;

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './src/register.ts', 'src/main.ts', ...args], {
      cwd: AGENCY_DIR,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  fake = await startFakeSupabase();
  dir = await mkdtemp(path.join(os.tmpdir(), 'rrss-agencia-cli-'));
  const credentials = path.join(dir, 'credenciales.json');
  await writeFile(
    credentials,
    JSON.stringify({ url: fake.url, anonKey: ANON_KEY, email: AGENCY_USER.email, password: PASSWORD }),
  );
  env = {
    ...process.env,
    RRSS_AGENCIA_CREDENCIALES: credentials,
    RRSS_AGENCIA_TRABAJO: path.join(dir, 'trabajo'),
  };
});

afterAll(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

describe('línea de órdenes', () => {
  it('pendientes --json entra con las credenciales del archivo y lista la cola', async () => {
    fake.rpc.pending_content_requests = () => ({ status: 200, body: [] });
    const result = await cli(['pendientes', '--json']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('comprobar ejecuta el verificador de la aplicación sobre el ejemplo documentado', async () => {
    const contextDir = path.join(dir, 'contexto');
    await rm(contextDir, { recursive: true, force: true });
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      path.join(contextDir, 'encargo.json'),
      JSON.stringify({ request: { network: 'instagram', format: 'post', mediaKind: 'image' } }),
    );
    const result = await cli(['comprobar', 'ejemplos/entrega.json', '--contexto', contextDir, '--json']);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as { main: { verdict: string }; variants: unknown[] };
    expect(['pass', 'pass_with_warnings']).toContain(output.main.verdict);
    expect(output.variants).toHaveLength(1);
    expect(result.code).toBe(0);
  });

  it('una orden desconocida o un id que no es uuid salen con error', async () => {
    expect((await cli(['publicar'])).code).toBe(2);
    const bad = await cli(['tomar', 'no-es-un-id']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/uuid/);
  });
});
