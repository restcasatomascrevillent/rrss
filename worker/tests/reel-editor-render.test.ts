// Montaje real (FFmpeg) de un plan v2 del editor de reels: transiciones
// mixtas, recortes de principio y final, textos con estilo y tipografía
// propios, subtítulos quemados y mezcla de sonido (volumen por clip, música).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReelTemplateHandler } from '../src/handlers/reel-template.ts';
import type { ReelPlanV2 } from '../src/reel/schema.ts';
import {
  averageColor,
  createBucket,
  deps,
  inBrand,
  makeClip,
  makeMusic,
  makePatternPhoto,
  makeSplitPhoto,
  meanVolume,
  ORG,
  OTHER_BRAND,
  probe,
  runHandler,
  tools,
  type Bucket,
} from './helpers/media.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Ejemplo compartido con la aplicación: sus rutas son las del cubo de pruebas. */
const FIXTURE = JSON.parse(readFileSync(path.join(here, 'fixtures/plan-v2.json'), 'utf8')) as ReelPlanV2;
const exec = promisify(execFile);
const handler = createReelTemplateHandler(deps);

/** Clip con el primer segundo rojo y el resto azul, con un tono: se ve dónde empieza el recorte. */
async function makeTwoColorClip(file: string): Promise<void> {
  await exec(tools.ffmpeg, [
    ...['-hide_banner', '-nostdin', '-v', 'error', '-y'],
    ...['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1'],
    ...['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=2'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3'],
    ...['-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k'],
    file,
  ]);
}

const difference = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0);

let bucket: Bucket;
const run = (plan: unknown, name: string, extra: Record<string, unknown> = {}) =>
  runHandler(handler, bucket, {
    template: { id: 'fundido-suave' },
    plan,
    output: { path: inBrand(`reels/${name}.mp4`), width: 270 },
    ...extra,
  });

beforeAll(async () => {
  bucket = await createBucket();
  await makePatternPhoto(bucket.file(inBrand('plato.jpg')), 640, 480);
  await makeSplitPhoto(bucket.file(inBrand('local.jpg')), 480, 320);
  await makeClip(bucket.file(inBrand('cocina.mp4')), { width: 320, height: 240, seconds: 3 });
  await makeTwoColorClip(bucket.file(inBrand('colores.mp4')));
  await makeMusic(bucket.file(inBrand('musica.m4a')), 2);
  await mkdir(path.dirname(bucket.file(inBrand('fonts/x'))), { recursive: true });
});

afterAll(async () => {
  await bucket?.cleanup();
});

describe('media.reel.template con un plan v2', () => {
  it('monta el ejemplo completo: transiciones mixtas, texto con estilo, subtítulos quemados y música', async () => {
    const content = { id: '0b5c1f7e-0000-4000-8000-000000000001', version: 2 };
    const result = await run(FIXTURE, 'completo', { content });
    expect(result).toMatchObject({
      plan: { version: 2 },
      content,
      subtitles: 2,
      output: { width: 270, height: 480, videoCodec: 'h264', audioCodec: 'aac' },
      timeline: [
        { index: 0, start: 0, seconds: 2, transitionIn: 0 },
        { index: 1, start: 1.6, seconds: 2, transitionIn: 0.4 },
        { index: 2, start: 3.6, seconds: 1.5, transitionIn: 0 },
      ],
      warnings: [],
    });
    const file = bucket.file(inBrand('reels/completo.mp4'));
    const info = await probe(file);
    expect(info.durationSeconds).toBeGreaterThan(5);
    expect(info.durationSeconds).toBeLessThan(5.25);
    expect(await meanVolume(file)).toBeGreaterThan(-45);

    // El mismo reel sin subtítulos: la franja de abajo cambia mientras se ve el primero (1,7–2,7 s).
    await run({ ...FIXTURE, subtitles: { ...FIXTURE.subtitles!, enabled: false } }, 'sin-subtitulos');
    const band = { x: 20, y: 370, width: 230, height: 40 };
    const withSubs = await averageColor(file, band, 2.2);
    const without = await averageColor(bucket.file(inBrand('reels/sin-subtitulos.mp4')), band, 2.2);
    expect(difference(withSubs, without)).toBeGreaterThan(25);

    // Y el texto amarillo de arriba: se ve en el primer segundo.
    expect(await run({ ...FIXTURE, texts: [] }, 'sin-texto')).toMatchObject({ subtitles: 2 });
    const top = { x: 30, y: 55, width: 210, height: 30 };
    const a = await averageColor(file, top, 1);
    const b = await averageColor(bucket.file(inBrand('reels/sin-texto.mp4')), top, 1);
    expect(difference(a, b)).toBeGreaterThan(25);
  });

  it('recorta el principio y el final de cada clip', async () => {
    const clip = (inAt: number, out: number) => ({
      version: 2,
      clips: [{ id: 'v', type: 'video', path: inBrand('colores.mp4'), in: inAt, out, volume: 0 }],
    });
    expect(await run(clip(1.2, 2.4), 'final')).toMatchObject({ output: { durationSeconds: 1.2 } });
    const blue = await averageColor(bucket.file(inBrand('reels/final.mp4')), undefined, 0.2);
    expect(blue[2]).toBeGreaterThan(blue[0] + 80);
    await run(clip(0, 0.8), 'principio');
    const red = await averageColor(bucket.file(inBrand('reels/principio.mp4')), undefined, 0.2);
    expect(red[0]).toBeGreaterThan(red[2] + 80);
    // Un final más allá del archivo se queda en lo que dura: 3 − 2 = 1 s.
    expect(await run(clip(2, 9), 'mas-alla')).toMatchObject({ output: { durationSeconds: 1 } });
  });

  it('mezcla el sonido: clip silenciado, bajado o entero, y música con su volumen', async () => {
    const video = { id: 'v', type: 'video', path: inBrand('colores.mp4'), in: 0, out: 2, volume: 0 };
    const plan = (volume: number, music?: unknown) => ({
      version: 2,
      clips: [{ ...video, volume }],
      ...(music ? { music } : {}),
    });
    await run(plan(0), 'mudo');
    expect(await meanVolume(bucket.file(inBrand('reels/mudo.mp4')))).toBeLessThan(-80);
    await run(plan(1), 'sonido');
    const loud = await meanVolume(bucket.file(inBrand('reels/sonido.mp4')));
    expect(loud).toBeGreaterThan(-30);
    await run(plan(0.1), 'bajo');
    expect(await meanVolume(bucket.file(inBrand('reels/bajo.mp4')))).toBeLessThan(loud - 12);
    const music = { path: inBrand('musica.m4a'), startAt: 0, volume: 0.5, fadeInSeconds: 0, fadeOutSeconds: 0 };
    await run(plan(0, music), 'musica');
    expect(await meanVolume(bucket.file(inBrand('reels/musica.mp4')))).toBeGreaterThan(-45);
    await run(plan(0, { ...music, volume: 0 }), 'musica-muda');
    expect(await meanVolume(bucket.file(inBrand('reels/musica-muda.mp4')))).toBeLessThan(-80);
  });

  it('cada texto usa su tipografía de la marca; la de otra marca no se descarga', async () => {
    await copyFile(deps.defaultFontFile!, bucket.file(inBrand('fonts/titular.ttf')));
    const text = FIXTURE.texts[0]!;
    const withFont = (fontPath: string) => ({
      ...FIXTURE,
      subtitles: undefined,
      texts: [{ ...text, style: { ...text.style, fontPath } }],
    });
    expect(await run(withFont(inBrand('fonts/titular.ttf')), 'tipografia')).toMatchObject({ warnings: [] });
    await writeFile(bucket.file(inBrand('fonts/rota.ttf')), 'no soy una fuente');
    const broken = await run(withFont(inBrand('fonts/rota.ttf')), 'tipografia-rota');
    expect((broken.warnings as string[]).join(' ')).toMatch(/no es TrueType ni OpenType/);
    await expect(run(withFont(`${ORG}/${OTHER_BRAND}/fonts/x.ttf`), 'ajena')).rejects.toThrow(
      /no pertenece a la marca/,
    );
  });
});
