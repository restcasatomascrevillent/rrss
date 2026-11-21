import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { abrir, archivoPng, aviso, dato, png, sinErrores, sql } from './apoyo';

// Editor de reels de punta a punta contra el Supabase LOCAL: una pieza de
// formato reel, una foto y un clip con voz en la línea de tiempo, un texto,
// subtítulos automáticos (función ai-transcribe con la transcripción SIMULADA,
// que solo arranca contra un Supabase local), uno corregido a mano, guardar la
// versión, aprobarla y montarla con el trabajador de verdad (FFmpeg). El vídeo
// llega a la biblioteca unido a la pieza y a la versión, y la transcripción
// queda en el registro de IA de la organización.
//
// Requisitos, además de los de la tanda: los de 11-reels.spec.ts (Node ≥ 22.18,
// `npm ci` en worker/, ffmpeg/ffprobe en el PATH). El clip es WebM (VP8 y
// Opus) porque el Chromium de Playwright no decodifica AAC.

test.describe.configure({ mode: 'serial' });

const RAIZ = path.resolve('.');
const exec = promisify(execFile);
const base = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;

function trabajadorLocal(limiteMs = 200_000): Promise<{ codigo: number | null; salida: string }> {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, ['worker/scripts/run-supabase.ts', 'local'], {
      cwd: RAIZ,
      env: {
        ...process.env,
        WORKER_MODE: 'drain',
        WORKER_ID: 'e2e-editor-reels',
        WORKER_POLL_MS: '500',
        WORKER_IDLE_EXIT_MS: '3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    hijo.stdout.on('data', (trozo: Buffer) => (salida += trozo.toString()));
    hijo.stderr.on('data', (trozo: Buffer) => (salida += trozo.toString()));
    const tope = setTimeout(() => {
      hijo.kill('SIGTERM');
      rechazar(new Error(`El trabajador no terminó en ${limiteMs / 1000} s.\n${salida}`));
    }, limiteMs);
    hijo.on('error', (error) => {
      clearTimeout(tope);
      rechazar(error);
    });
    hijo.on('exit', (codigo) => {
      clearTimeout(tope);
      resolver({ codigo, salida });
    });
  });
}

/** Clip WebM de 4 s con dos frases (dos tonos separados por silencio). */
async function clipConVoz(nombre: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const carpeta = await mkdtemp(path.join(os.tmpdir(), 'rrss-e2e-clip-'));
  const archivo = path.join(carpeta, nombre);
  await exec(process.env.FFMPEG_PATH || 'ffmpeg', [
    ...['-hide_banner', '-nostdin', '-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4'],
    ...['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*220*t)*(between(t,0.3,1.3)+between(t,2,3))':s=48000:d=4"],
    ...['-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-shortest', archivo],
  ]);
  return { name: nombre, mimeType: 'video/webm', buffer: await readFile(archivo) };
}

test('montar un reel en el editor: línea de tiempo, subtítulos automáticos, versión, aprobación y montaje', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const s = await abrir(browser, 'ana');
  const { page } = s;
  const vez = Date.now().toString(36);
  const foto = `editor-foto-${vez}.png`;
  const clip = `editor-clip-${vez}.webm`;

  // 1. Una foto y un clip con voz en la biblioteca.
  await page.goto(`${base()}/biblioteca`);
  await page.getByTestId('library-upload-toggle').click();
  await page
    .getByTestId('library-file-input')
    .setInputFiles([archivoPng(foto, png(640, 480, [200, 120, 40])), await clipConVoz(clip)]);
  await expect(page.getByTestId('upload-item-done')).toHaveCount(2);

  // 2. Pieza de formato reel: se abre el editor de reels.
  await page.goto(`${base()}/contenidos`);
  await page.getByTestId('content-new').click();
  const alta = page.getByRole('dialog');
  await alta.getByTestId('create-content-title').fill(`Reel del editor ${vez}`);
  await alta.getByTestId('create-content-network').selectOption('instagram');
  await alta.getByTestId('create-content-format').selectOption('reel');
  await alta.getByTestId('create-content-submit').click();
  await expect(page.getByTestId('reel-editor')).toBeVisible();
  const contentId = page.url().split('/contenidos/')[1]!.split('?')[0]!;

  // 3. Foto y clip a la línea de tiempo; un texto.
  for (const nombre of [foto, clip]) {
    await page.getByTestId('reel-add-media').click();
    await page.getByRole('button', { name: `Añadir «${nombre}»` }).click();
  }
  await expect(page.getByTestId('reel-clip')).toHaveCount(2);
  await page.getByTestId('reel-add-text').click();
  await page.getByTestId('reel-text-content').fill('Pan recién hecho');

  // 4. Subtítulos automáticos del clip (transcripción simulada), con su coste antes.
  await page.getByTestId('reel-clip').nth(1).getByRole('button').first().click();
  await page.getByTestId('reel-auto-subtitles').click();
  await expect(page.getByTestId('reel-auto-subtitles-cost')).toContainText('Coste máximo');
  await page.getByTestId('reel-auto-subtitles-confirm').click();
  await aviso(page, /subtítulos\. Revísalos/);
  await expect(page.getByTestId('reel-cue-text')).toHaveCount(2);
  await expect(page.getByTestId('reel-cue-text').first()).toHaveValue(/\[simulado\] Frase 1 de 2/);
  // Corregido a mano antes de montar.
  await page.getByTestId('reel-cue-text').first().fill('Buenos días desde el obrador');
  await expect(page.getByTestId('reel-cue-block').first()).toHaveText('Buenos días desde el obrador');

  // 5. Guardar la versión y aprobarla.
  await page.getByTestId('reel-save').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Guardar/ })
    .click();
  await aviso(page, /Versión 1 guardada/);
  await page.getByTestId('reel-status-approved').click();
  await expect(page.getByTestId('reel-status')).toHaveText('Aprobada');

  const [version] = await sql<{ schema_version: number; data: { kind: string; plan: { version: number } } }>(
    `select schema_version, data from public.content_versions where content_id = $1 and version = 1`,
    [contentId],
  );
  expect(version).toMatchObject({ schema_version: 2, data: { kind: 'reel', plan: { version: 2 } } });
  const [transcripcion] = await sql<{ task: string; provider: string; status: string; cost_micros: string }>(
    `select task, provider, status, cost_micros from public.ai_generations
     where brand_id = $1 and purpose = 'reel.subtitles' order by created_at desc limit 1`,
    [dato('marcaA')],
  );
  expect(transcripcion).toMatchObject({ task: 'transcription', provider: 'simulated', status: 'succeeded' });
  expect(Number(transcripcion!.cost_micros)).toBeGreaterThan(0);

  // 6. Montar la versión guardada con el trabajador de verdad.
  await page.getByTestId('reel-render').click();
  await aviso(page, /Montaje encargado/);
  const { codigo, salida } = await trabajadorLocal();
  expect(codigo, salida).toBe(0);
  expect(salida).toContain('"outcome":"succeeded"');
  await expect(page.getByTestId('reel-piece-job').first()).toContainText('Listo', { timeout: 30_000 });

  const [trabajo] = await sql<{ id: string; result: { subtitles?: number; plan?: { version: number } } }>(
    `select id, result from public.jobs where brand_id = $1 and payload -> 'content' ->> 'id' = $2
     order by created_at desc limit 1`,
    [dato('marcaA'), contentId],
  );
  expect(trabajo!.result).toMatchObject({ subtitles: 2, plan: { version: 2 } });
  const [video] = await sql<{ kind: string; provenance: Record<string, unknown> }>(
    `select kind, provenance from public.media_assets where provenance ->> 'job_id' = $1`,
    [trabajo!.id],
  );
  expect(video).toMatchObject({
    kind: 'video',
    provenance: { content_id: contentId, content_version: 1, plan_version: 2 },
  });

  sinErrores(s);
  await s.context.close();
});
