// Procesado de imagen con archivos reales generados aquí mismo.
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors.ts';
import { createImageProcessHandler, type ImageProcessPayload } from '../src/handlers/image-process.ts';
import { cropToAspect } from '../src/handlers/shared.ts';
import {
  averageColor,
  createBucket,
  deps,
  inBrand,
  makeSplitPhoto,
  ORG,
  OTHER_BRAND,
  probe,
  runHandler,
  setExifOrientation,
  type Bucket,
} from './helpers/media.ts';

const handler = createImageProcessHandler(deps);
let bucket: Bucket;

const isRed = ([r, , b]: [number, number, number]) => r > 180 && b < 80;
const isBlue = ([r, , b]: [number, number, number]) => b > 180 && r < 80;

beforeAll(async () => {
  bucket = await createBucket();
  // 640×240: mitad izquierda roja, mitad derecha azul.
  await makeSplitPhoto(bucket.file(inBrand('apaisada.jpg')), 640, 240);
  await makeSplitPhoto(bucket.file(inBrand('movil.jpg')), 640, 240);
  await setExifOrientation(bucket.file(inBrand('movil.jpg')), 6);
  await writeFile(bucket.file(inBrand('notas.txt')), 'esto no es una imagen');
});

afterAll(async () => {
  await bucket?.cleanup();
});

describe('recorte por punto focal (cálculo)', () => {
  it('saca el mayor recorte de cada proporción y lo pega al borde cuando el punto focal está cerca', () => {
    const source = { width: 640, height: 240 };
    expect(cropToAspect(source, '1:1', { x: 0.5, y: 0.5 })).toEqual({ width: 240, height: 240, x: 200, y: 0 });
    expect(cropToAspect(source, '1:1', { x: 0, y: 0 })).toEqual({ width: 240, height: 240, x: 0, y: 0 });
    expect(cropToAspect(source, '1:1', { x: 1, y: 1 })).toEqual({ width: 240, height: 240, x: 400, y: 0 });
    expect(cropToAspect(source, '4:5')).toMatchObject({ width: 192, height: 240 });
    expect(cropToAspect(source, '9:16')).toMatchObject({ width: 135, height: 240 });
    expect(cropToAspect(source, '16:9')).toMatchObject({ width: 426, height: 240 });
    // Foto vertical a horizontal: manda el ancho y el punto focal mueve el recorte en vertical.
    expect(cropToAspect({ width: 1080, height: 1920 }, '16:9', { x: 0.5, y: 0.25 })).toEqual({
      width: 1080,
      height: 607,
      x: 0,
      y: 177,
    });
    // Para vídeo, medidas pares.
    expect(cropToAspect(source, '9:16', { x: 0.5, y: 0.5 }, true)).toMatchObject({ width: 134, height: 240 });
  });
});

describe('media.image.process', () => {
  it('genera las cuatro proporciones de las redes, en el tamaño y formato pedidos', async () => {
    const payload: ImageProcessPayload = {
      source: { path: inBrand('apaisada.jpg') },
      outputs: [
        { path: inBrand('salida/cuadrada.jpg'), aspect: '1:1', width: 200 },
        { path: inBrand('salida/retrato.png'), aspect: '4:5', width: 160, format: 'png' },
        { path: inBrand('salida/vertical.webp'), aspect: '9:16', width: 90, format: 'webp', quality: 70 },
        { path: inBrand('salida/horizontal.jpg'), aspect: '16:9', width: 1080 },
      ],
    };
    const result = await runHandler(handler, bucket, payload);

    expect(result.source).toEqual({ width: 640, height: 240 });
    expect(result.outputs).toMatchObject([
      { aspect: '1:1', width: 200, height: 200, format: 'jpeg' },
      { aspect: '4:5', width: 160, height: 200, format: 'png' },
      { aspect: '9:16', width: 90, height: 160, format: 'webp' },
      // No se amplía: el recorte 16:9 de una foto de 640×240 mide 426×240.
      { aspect: '16:9', width: 426, height: 240, format: 'jpeg' },
    ]);
    // Lo que dice el resultado es lo que hay en los archivos.
    const files = [
      ['salida/cuadrada.jpg', 'mjpeg', 200, 200],
      ['salida/retrato.png', 'png', 160, 200],
      ['salida/vertical.webp', 'webp', 90, 160],
      ['salida/horizontal.jpg', 'mjpeg', 426, 240],
    ] as const;
    for (const [name, codec, width, height] of files) {
      const info = await probe(bucket.file(inBrand(name)));
      expect(info.video, name).toMatchObject({ codec, width, height });
    }
  });

  it('centra el recorte en el punto focal', async () => {
    const output = (name: string) => ({ path: inBrand(name), aspect: '1:1' as const, width: 120 });
    await runHandler(handler, bucket, {
      source: { path: inBrand('apaisada.jpg') },
      focalPoint: { x: 0.1, y: 0.5 },
      outputs: [output('foco/izquierda.jpg')],
    });
    await runHandler(handler, bucket, {
      source: { path: inBrand('apaisada.jpg') },
      focalPoint: { x: 0.9, y: 0.5 },
      outputs: [output('foco/derecha.jpg')],
    });
    expect(isRed(await averageColor(bucket.file(inBrand('foco/izquierda.jpg'))))).toBe(true);
    expect(isBlue(await averageColor(bucket.file(inBrand('foco/derecha.jpg'))))).toBe(true);
  });

  it('endereza las fotos de móvil según su orientación EXIF, sea cual sea la versión de FFmpeg', async () => {
    // Guardada apaisada (640×240) pero marcada «girar 90° a la derecha»: se ve
    // vertical (240×640), con el rojo arriba y el azul abajo.
    const result = await runHandler(handler, bucket, {
      source: { path: inBrand('movil.jpg') },
      outputs: [{ path: inBrand('salida/movil.png'), aspect: '9:16', width: 90, format: 'png' }],
    });
    expect(result.source).toEqual({ width: 240, height: 640 });
    const file = bucket.file(inBrand('salida/movil.png'));
    expect((await probe(file)).video).toMatchObject({ width: 90, height: 160 });
    expect(isRed(await averageColor(file, { x: 0, y: 0, width: 90, height: 60 }))).toBe(true);
    expect(isBlue(await averageColor(file, { x: 0, y: 100, width: 90, height: 60 }))).toBe(true);
  });

  it('rechaza sin reintento una carga inválida, un archivo que no es imagen y rutas de otra marca', async () => {
    const run = (payload: unknown) => runHandler(handler, bucket, payload);
    const good = { path: inBrand('salida/x.jpg'), aspect: '1:1', width: 100 };

    await expect(run({ source: { path: inBrand('apaisada.jpg') }, outputs: [] })).rejects.toThrow(PermanentError);
    await expect(
      run({ source: { path: inBrand('apaisada.jpg') }, outputs: [{ ...good, aspect: '3:2' }] }),
    ).rejects.toThrow(/Carga del trabajo inválida.*aspect/);
    await expect(run({ source: { path: inBrand('apaisada.jpg') }, outputs: [good], extra: 1 })).rejects.toThrow(
      PermanentError,
    );
    await expect(run({ source: { path: inBrand('notas.txt') }, outputs: [good] })).rejects.toThrow(PermanentError);
    await expect(run({ source: { path: inBrand('no-existe.jpg') }, outputs: [good] })).rejects.toThrow(/No existe/);

    // El trabajo es de una marca: no puede leer ni escribir en la de otra.
    const foreign = `${ORG}/${OTHER_BRAND}/pruebas/ajena.jpg`;
    await expect(run({ source: { path: foreign }, outputs: [good] })).rejects.toThrow(/no pertenece a la marca/);
    await expect(
      run({ source: { path: inBrand('apaisada.jpg') }, outputs: [{ ...good, path: foreign }] }),
    ).rejects.toThrow(/no pertenece a la marca/);
    await expect(
      run({ source: { path: inBrand('apaisada.jpg') }, outputs: [{ ...good, path: `${inBrand('..')}/../x.jpg` }] }),
    ).rejects.toThrow(/no pertenece a la marca/);
    await expect(
      runHandler(handler, bucket, { source: { path: inBrand('apaisada.jpg') }, outputs: [good] }, { brand_id: null }),
    ).rejects.toThrow(/debe pertenecer a una marca/);
  });
});

describe('medidas exactas', () => {
  it('una foto de 12 MP a 1080 de ancho da 1080×1920 justos en 9:16, no 1921', async () => {
    const bucket = await createBucket();
    try {
      await makeSplitPhoto(bucket.file(inBrand('grande.jpg')), 4000, 3000);
      const result = await runHandler(handler, bucket, {
        source: { path: inBrand('grande.jpg') },
        outputs: [
          { path: inBrand('salida/v.jpg'), aspect: '9:16', width: 1080 },
          { path: inBrand('salida/r.jpg'), aspect: '4:5', width: 1080 },
        ],
      });
      expect(result.outputs).toMatchObject([
        { width: 1080, height: 1920 },
        { width: 1080, height: 1350 },
      ]);
      expect((await probe(bucket.file(inBrand('salida/v.jpg')))).video).toMatchObject({ width: 1080, height: 1920 });
    } finally {
      await bucket.cleanup();
    }
  });
});
