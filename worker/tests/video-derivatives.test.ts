// Derivados de un vídeo real (3 s, 320×240) generado aquí mismo.
import { stat } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors.ts';
import { createVideoDerivativesHandler, type VideoDerivativesPayload } from '../src/handlers/video-derivatives.ts';
import {
  createBucket,
  deps,
  inBrand,
  makeClip,
  makeSplitPhoto,
  mp4Boxes,
  probe,
  runHandler,
  type Bucket,
} from './helpers/media.ts';

const handler = createVideoDerivativesHandler(deps);
let bucket: Bucket;

beforeAll(async () => {
  bucket = await createBucket();
  await makeClip(bucket.file(inBrand('clip.mp4')), { width: 320, height: 240, seconds: 3, fps: 50 });
  await makeClip(bucket.file(inBrand('mudo.mp4')), { width: 320, height: 240, seconds: 1, audio: false });
  await makeSplitPhoto(bucket.file(inBrand('foto.jpg')), 64, 32);
});

afterAll(async () => {
  await bucket?.cleanup();
});

describe('media.video.derivatives', () => {
  it('saca póster, versión comprimida y adaptación a 9:16 de un mismo vídeo', async () => {
    const payload: VideoDerivativesPayload = {
      source: { path: inBrand('clip.mp4') },
      poster: { path: inBrand('derivados/poster.jpg'), atSeconds: 1, width: 160 },
      compressed: { path: inBrand('derivados/ligero.mp4'), maxHeight: 120, maxFps: 25, crf: 30 },
      reframe: { path: inBrand('derivados/vertical.mp4'), aspect: '9:16', focalPoint: { x: 0.5, y: 0.5 } },
    };
    const result = await runHandler(handler, bucket, payload);

    expect(result.source).toMatchObject({ width: 320, height: 240, fps: 50, hasAudio: true });
    expect(result.poster).toMatchObject({ width: 160, height: 120, atSeconds: 1 });
    expect(result.compressed).toMatchObject({ width: 160, height: 120 });
    expect(result.reframe).toMatchObject({ aspect: '9:16', width: 134, height: 240 });

    const poster = await probe(bucket.file(inBrand('derivados/poster.jpg')));
    expect(poster.video).toMatchObject({ codec: 'mjpeg', width: 160, height: 120 });

    const light = await probe(bucket.file(inBrand('derivados/ligero.mp4')));
    expect(light.video).toMatchObject({ codec: 'h264', width: 160, height: 120, pixelFormat: 'yuv420p' });
    expect(light.video!.fps).toBeCloseTo(25, 1);
    expect(light.audio).toMatchObject({ codec: 'aac' });
    expect(light.durationSeconds).toBeGreaterThan(2.8);
    expect(light.durationSeconds).toBeLessThan(3.2);
    const original = await stat(bucket.file(inBrand('clip.mp4')));
    expect((await stat(bucket.file(inBrand('derivados/ligero.mp4')))).size).toBeLessThan(original.size);
    // Listo para reproducir en streaming: el índice va delante de los datos.
    const boxes = await mp4Boxes(bucket.file(inBrand('derivados/ligero.mp4')));
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));

    const vertical = await probe(bucket.file(inBrand('derivados/vertical.mp4')));
    expect(vertical.video).toMatchObject({ codec: 'h264', width: 134, height: 240 });
    expect(vertical.audio).toMatchObject({ codec: 'aac' });
  });

  it('un vídeo sin sonido da derivados sin pista de sonido, y el póster de un vídeo corto sale de su mitad', async () => {
    const result = await runHandler(handler, bucket, {
      source: { path: inBrand('mudo.mp4') },
      poster: { path: inBrand('derivados/mudo.png'), atSeconds: 30, format: 'png' },
      compressed: { path: inBrand('derivados/mudo.mp4') },
    });
    expect(result.source).toMatchObject({ hasAudio: false });
    expect(result.poster).toMatchObject({ atSeconds: 0.5, width: 320, height: 240 });
    const info = await probe(bucket.file(inBrand('derivados/mudo.mp4')));
    expect(info.audio).toBeUndefined();
    // No se amplía: 240 de alto aunque el máximo por defecto sea 720.
    expect(info.video).toMatchObject({ width: 320, height: 240 });
  });

  it('rechaza sin reintento una carga sin derivados o un origen que no es vídeo', async () => {
    const run = (payload: unknown) => runHandler(handler, bucket, payload);
    await expect(run({ source: { path: inBrand('clip.mp4') } })).rejects.toThrow(/al menos un derivado/);
    await expect(
      run({ source: { path: inBrand('foto.jpg') }, compressed: { path: inBrand('derivados/x.mp4') } }),
    ).rejects.toThrow(PermanentError);
  });
});
