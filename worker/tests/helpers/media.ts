// Ayudas de las pruebas: generan archivos de medios pequeños y REALES con
// FFmpeg (nada de binarios en el repositorio) y ejecutan un manejador contra
// una carpeta local que hace de cubo.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findDefaultFont } from '../../src/ffmpeg/fonts.ts';
import { probeMedia, type MediaInfo } from '../../src/ffmpeg/probe.ts';
import { toolsFromEnv } from '../../src/ffmpeg/run.ts';
import type { Handler } from '../../src/handler.ts';
import type { MediaDeps } from '../../src/handlers/shared.ts';
import { createMemoryLogger } from '../../src/logger.ts';
import type { JsonObject } from '../../src/queue.ts';
import { createFolderStorage } from '../../src/storage.ts';

const exec = promisify(execFile);

export const tools = toolsFromEnv();
export const deps: MediaDeps = { tools, defaultFontFile: findDefaultFont() };

export const ORG = '11111111-1111-4111-8111-111111111111';
export const BRAND = '22222222-2222-4222-8222-222222222222';
export const OTHER_BRAND = '33333333-3333-4333-8333-333333333333';
/** Ruta dentro del cubo para un archivo de la marca de pruebas. */
export const inBrand = (name: string) => `${ORG}/${BRAND}/pruebas/${name}`;

export interface Bucket {
  root: string;
  /** Ruta en disco de un objeto del cubo. */
  file(objectPath: string): string;
  cleanup(): Promise<void>;
}

export async function createBucket(): Promise<Bucket> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rrss-worker-test-'));
  await mkdir(path.join(root, ORG, BRAND, 'pruebas'), { recursive: true });
  return {
    root,
    file: (objectPath) => path.join(root, objectPath),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const ffmpeg = (args: string[]) => exec(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args]);

/** Foto con la mitad izquierda roja y la derecha azul: se ve dónde cae el recorte. */
export async function makeSplitPhoto(file: string, width: number, height: number): Promise<void> {
  const half = `${width / 2}x${height}`;
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=${half}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=${half}`,
    '-filter_complex',
    'hstack',
    '-frames:v',
    '1',
    file,
  ]);
}

/** Foto con una carta de ajuste (mucho detalle y color). */
export async function makePatternPhoto(
  file: string,
  width: number,
  height: number,
  pattern = 'testsrc2',
): Promise<void> {
  await ffmpeg(['-f', 'lavfi', '-i', `${pattern}=size=${width}x${height}:rate=1`, '-frames:v', '1', file]);
}

/** Clip H.264 con imagen en movimiento y, si se pide, un tono de sonido. */
export async function makeClip(
  file: string,
  options: { width: number; height: number; seconds: number; fps?: number; audio?: boolean },
): Promise<void> {
  const { width, height, seconds, fps = 25, audio = true } = options;
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${width}x${height}:rate=${fps}`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : []),
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    ...(audio ? ['-c:a', 'aac', '-b:a', '64k'] : []),
    file,
  ]);
}

/** Pista de música: un tono, en AAC. */
export async function makeMusic(file: string, seconds: number): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=44100',
    '-t',
    String(seconds),
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    file,
  ]);
}

/** Añade a un JPEG una cabecera EXIF con la orientación dada, como las fotos de móvil. */
export async function setExifOrientation(file: string, orientation: number): Promise<void> {
  const jpeg = await readFile(file);
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // primer directorio
  tiff.writeUInt16LE(1, 8); // una entrada
  tiff.writeUInt16LE(0x0112, 10); // etiqueta: orientación
  tiff.writeUInt16LE(3, 12); // tipo SHORT
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22); // sin más directorios
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  await writeFile(file, Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]));
}

/** Color medio (RGB) de una zona de una imagen o de un fotograma de vídeo. */
export async function averageColor(
  file: string,
  region?: { x: number; y: number; width: number; height: number },
  atSeconds?: number,
): Promise<[number, number, number]> {
  const filters = [
    ...(region ? [`crop=${region.width}:${region.height}:${region.x}:${region.y}`] : []),
    'scale=1:1:flags=area',
  ];
  const { stdout } = await exec(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      ...(atSeconds === undefined ? [] : ['-ss', String(atSeconds)]),
      '-i',
      file,
      '-vf',
      filters.join(','),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer' },
  );
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

/** Volumen medio de la pista de sonido, en dB (−91 ≈ silencio). */
export async function meanVolume(file: string): Promise<number> {
  const { stderr } = await exec(tools.ffmpeg, [
    '-hide_banner',
    '-nostdin',
    '-i',
    file,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error('No se pudo medir el volumen');
  return Number(match[1]);
}

/** Cajas de primer nivel de un MP4, en orden. Con `+faststart`, `moov` va antes que `mdat`. */
export async function mp4Boxes(file: string): Promise<string[]> {
  const data = await readFile(file);
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset);
    boxes.push(data.toString('latin1', offset + 4, offset + 8));
    if (size === 1) size = Number(data.readBigUInt64BE(offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return boxes;
}

export const probe = (file: string): Promise<MediaInfo> => probeMedia(tools, file);

/** Ejecuta un manejador como lo haría el bucle, con la carpeta local como cubo. */
export async function runHandler(
  handler: Handler,
  bucket: Bucket,
  payload: unknown,
  job: { organization_id?: string; brand_id?: string | null } = {},
): Promise<JsonObject> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'rrss-worker-job-'));
  try {
    return await handler.run({
      job: {
        id: 'prueba',
        organization_id: job.organization_id ?? ORG,
        brand_id: job.brand_id === undefined ? BRAND : job.brand_id,
        kind: handler.kind,
        payload: payload as JsonObject,
        attempts: 1,
        max_attempts: 3,
      },
      signal: new AbortController().signal,
      storage: createFolderStorage(bucket.root),
      workDir,
      log: createMemoryLogger(),
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
