// Ejecuta UN trabajo a mano, sin cola y sin Supabase, contra una carpeta local
// que hace de cubo. Sirve para probar plantillas y medir tiempos:
//
//   node src/cli.ts <tipo> <carga.json> --storage <carpeta> [--org <id>] [--brand <id>]
//
// La carpeta debe tener la misma forma que el cubo: <org>/<marca>/<carpeta>/<archivo>.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { errorMessage } from './errors.ts';
import { findDefaultFont } from './ffmpeg/fonts.ts';
import { toolsFromEnv } from './ffmpeg/run.ts';
import { createMediaHandlers } from './handlers/index.ts';
import { createJsonLogger } from './logger.ts';
import { createFolderStorage } from './storage.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      storage: { type: 'string' },
      org: { type: 'string', default: 'org' },
      brand: { type: 'string', default: 'marca' },
    },
  });
  const [kind, payloadFile] = positionals;
  const handlers = createMediaHandlers({
    tools: toolsFromEnv(),
    defaultFontFile: findDefaultFont(),
    fontsDir: process.env.WORKER_FONTS_DIR,
  });
  const handler = handlers.find((h) => h.kind === kind);
  if (!handler || !payloadFile || !values.storage) {
    throw new Error(
      `Uso: node src/cli.ts <tipo> <carga.json> --storage <carpeta> [--org <id>] [--brand <id>]\n` +
        `Tipos: ${handlers.map((h) => h.kind).join(', ')}`,
    );
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'rrss-worker-cli-'));
  const startedAt = Date.now();
  try {
    const result = await handler.run({
      job: {
        id: 'manual',
        organization_id: values.org,
        brand_id: values.brand,
        kind: handler.kind,
        payload: JSON.parse(await readFile(payloadFile, 'utf8')) as Record<string, unknown>,
        attempts: 1,
        max_attempts: 1,
      },
      signal: new AbortController().signal,
      storage: createFolderStorage(values.storage),
      workDir,
      log: createJsonLogger({}, (line) => process.stderr.write(`${line}\n`)),
    });
    process.stdout.write(`${JSON.stringify({ ms: Date.now() - startedAt, result }, null, 2)}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
