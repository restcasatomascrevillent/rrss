// Reel por plantilla, de extremo a extremo: fotos, un clip y música reales
// (generados aquí, pequeños) → MP4 vertical, comprobado con ffprobe.
// Esta es la prueba que se ejecuta también dentro del contenedor.
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors.ts';
import { createReelTemplateHandler } from '../src/handlers/reel-template.ts';
import { blurSigma, buildReel, wrapText } from '../src/reel/build.ts';
import { reelPayloadSchema, reelPlanSchema, reelTemplateSchema, type ReelPayload } from '../src/reel/schema.ts';
import { loadTemplates, TEMPLATES_DIR } from '../src/reel/templates.ts';
import { renderSchemas, SCHEMAS_DIR } from '../scripts/write-schemas.ts';
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
  mp4Boxes,
  ORG,
  OTHER_BRAND,
  probe,
  runHandler,
  setExifOrientation,
  type Bucket,
} from './helpers/media.ts';

const handler = createReelTemplateHandler(deps);
let bucket: Bucket;

beforeAll(async () => {
  bucket = await createBucket();
  await makePatternPhoto(bucket.file(inBrand('plato.jpg')), 640, 480);
  // Foto «de móvil»: guardada apaisada y marcada para verse vertical.
  await makeSplitPhoto(bucket.file(inBrand('local.jpg')), 480, 320);
  await setExifOrientation(bucket.file(inBrand('local.jpg')), 6);
  await makePatternPhoto(bucket.file(inBrand('detalle.png')), 360, 640, 'smptebars');
  await makeClip(bucket.file(inBrand('cocina.mp4')), { width: 320, height: 240, seconds: 3 });
  await makeMusic(bucket.file(inBrand('musica.m4a')), 2); // más corta que el reel: se repite
  await mkdir(path.dirname(bucket.file(inBrand('fonts/x'))), { recursive: true });
});

afterAll(async () => {
  await bucket?.cleanup();
});

describe('plantillas', () => {
  it('las plantillas de ejemplo son válidas, verticales y no llevan nada de ningún cliente', () => {
    const templates = loadTemplates();
    expect([...templates.keys()]).toEqual(['corte-ritmico', 'fundido-suave', 'pase-lateral']);
    for (const template of templates.values()) {
      expect(template.schemaVersion).toBe(1);
      expect(template.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    }
    expect(readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'))).toHaveLength(templates.size);
  });

  it('el esquema rechaza versiones desconocidas, campos de más y lienzos que no son 9:16', () => {
    const base = JSON.parse(JSON.stringify(loadTemplates().get('fundido-suave')));
    expect(reelTemplateSchema.safeParse(base).success).toBe(true);
    expect(reelTemplateSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
    expect(reelTemplateSchema.safeParse({ ...base, cliente: 'x' }).success).toBe(false);
    expect(reelTemplateSchema.safeParse({ ...base, canvas: { width: 1080, height: 1080, fps: 30 } }).success).toBe(
      false,
    );
    expect(
      reelPayloadSchema.safeParse({
        template: { id: 'fundido-suave' },
        plan: { media: [] },
        output: { path: inBrand('reel.mp4') },
      }).success,
    ).toBe(false);
  });

  it('los esquemas JSON publicados están al día con el código (npm run schemas)', async () => {
    for (const [name, content] of Object.entries(renderSchemas())) {
      // Comparación por contenido: git puede cambiar los finales de línea al descargar.
      expect(JSON.parse(await readFile(path.join(SCHEMAS_DIR, name), 'utf8')), name).toEqual(JSON.parse(content));
    }
  });
});

describe('motor (cálculo de la línea de tiempo)', () => {
  const template = loadTemplates().get('fundido-suave')!;
  const photo = (seconds?: number) => ({ type: 'photo' as const, file: 'a.jpg', orientation: 1, seconds });

  it('solapa las piezas en cada fundido y ajusta los tiempos a fotogramas', () => {
    const build = buildReel({
      template,
      media: [photo(2), photo(2), photo(3)],
      texts: [],
      outputFile: 'reel.mp4',
      outputWidth: 270,
    });
    expect(build).toMatchObject({ width: 270, height: 480, fps: 30, durationSeconds: 6, transitionSeconds: 0.5 });
    expect(build.timeline.map((s) => [s.start, s.seconds])).toEqual([
      [0, 2],
      [1.5, 2],
      [3, 3],
    ]);
    expect(build.filterGraph).toContain('xfade=transition=fade:duration=0.5:offset=1.5');
    expect(build.filterGraph).toContain('xfade=transition=fade:duration=0.5:offset=3');
  });

  it('desenfoca las piezas con desenfoque, con el mismo radio relativo que el editor', () => {
    expect(blurSigma(undefined, 1080, 1920)).toBe(0);
    expect(blurSigma(100, 1080, 1920)).toBeCloseTo(54);
    const build = buildReel({
      template,
      media: [{ ...photo(2), blur: 40 }, photo(2)],
      texts: [],
      outputFile: 'reel.mp4',
      outputWidth: 270,
    });
    // Fotos al doble del lienzo (540 × 960): 40 % del 5 % de 540 = 10,8.
    expect(build.filterGraph.match(/gblur=sigma=[0-9.]+/g)).toEqual(['gblur=sigma=10.8']);
    expect(build.filterGraph.split(';\n')[0]).toMatch(/crop=.*gblur=sigma=10\.8,zoompan/);
    const clip = { type: 'video' as const, file: 'c.mp4', startAt: 0, durationSeconds: 3, hasAudio: false, blur: 100 };
    const video = buildReel({ template, media: [clip], texts: [], outputFile: 'r.mp4', outputWidth: 270 });
    expect(video.filterGraph).toContain('gblur=sigma=13.5');
  });

  it('el plan admite el desenfoque de 0 a 100 y nada fuera de ese rango', () => {
    const plan = (blur: number) => ({ media: [{ type: 'photo', path: 'o/m/a.jpg', blur }] });
    expect(reelPlanSchema.safeParse(plan(40)).success).toBe(true);
    expect(reelPlanSchema.safeParse(plan(101)).success).toBe(false);
    expect(reelPlanSchema.safeParse(plan(-1)).success).toBe(false);
  });

  it('rechaza un plan que supera la duración máxima de la plantilla o un clip demasiado corto', () => {
    const many = Array.from({ length: 16 }, () => photo(2.5));
    expect(() => buildReel({ template, media: many, texts: [], outputFile: 'r.mp4' })).toThrow(/como máximo/);
    const clip = { type: 'video' as const, file: 'c.mp4', startAt: 2.8, durationSeconds: 3, hasAudio: true };
    expect(() => buildReel({ template, media: [clip], texts: [], outputFile: 'r.mp4' })).toThrow(PermanentError);
  });

  it('parte el texto en líneas y avisa de los textos que quedan fuera del vídeo', () => {
    expect(wrapText('Hoy, menú del día con arroz y postre casero', 16)).toEqual([
      'Hoy, menú del',
      'día con arroz y',
      'postre casero',
    ]);
    expect(wrapText('uno\ndos', 40)).toEqual(['uno', 'dos']);
    const build = buildReel({
      template,
      media: [photo(2)],
      texts: [
        { text: 'Se ve', start: 0, end: 1.5 },
        { text: 'Tarde', start: 5, end: 6 },
      ],
      fontFile: 'font.ttf',
      outputFile: 'r.mp4',
    });
    expect(build.textFiles).toEqual([{ name: 'text-0-0.txt', content: 'Se ve' }]);
    expect(build.warnings).toEqual(['El texto 2 queda fuera del vídeo (2 s) y no se ha puesto']);
    // El texto no viaja en el grafo de filtros: va en un archivo.
    expect(build.filterGraph).not.toContain('Se ve');
  });
});

describe('media.reel.template', () => {
  const plan: ReelPayload['plan'] = {
    media: [
      { type: 'photo', path: inBrand('plato.jpg'), seconds: 2, focalPoint: { x: 0.3, y: 0.5 } },
      { type: 'video', path: inBrand('cocina.mp4'), startAt: 0.5, seconds: 2 },
      { type: 'photo', path: inBrand('local.jpg'), seconds: 2 },
    ],
    texts: [
      { text: '¡Hoy, menú 100% casero: «arroz» & postre!', start: 0.3, end: 2.5 },
      { text: "Reserva ya: it's [fácil]; ven", start: 3, end: 4.8, position: 'top' },
    ],
    music: { path: inBrand('musica.m4a') },
  };

  it('monta un reel vertical H.264 con texto y música, listo para subir a una red', async () => {
    const payload: ReelPayload = {
      template: { id: 'fundido-suave' },
      plan,
      output: { path: inBrand('reels/fundido.mp4'), posterPath: inBrand('reels/fundido.jpg'), width: 270 },
    };
    const result = await runHandler(handler, bucket, payload);

    // 2 + 2 + 2 s menos dos fundidos de 0,5 s.
    expect(result).toMatchObject({
      template: { id: 'fundido-suave', schemaVersion: 1 },
      output: { width: 270, height: 480, fps: 30, videoCodec: 'h264', audioCodec: 'aac' },
      timeline: [
        { index: 0, type: 'photo', start: 0, seconds: 2 },
        { index: 1, type: 'video', start: 1.5, seconds: 2 },
        { index: 2, type: 'photo', start: 3, seconds: 2 },
      ],
      warnings: [],
    });

    // Comprobación independiente con ffprobe sobre el archivo subido.
    const file = bucket.file(inBrand('reels/fundido.mp4'));
    const info = await probe(file);
    expect(info.formatName).toContain('mp4');
    expect(info.durationSeconds).toBeGreaterThan(4.9);
    expect(info.durationSeconds).toBeLessThan(5.15);
    expect(info.video).toMatchObject({ codec: 'h264', width: 270, height: 480, pixelFormat: 'yuv420p' });
    expect(info.video!.fps).toBeCloseTo(30, 1);
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    // `+faststart`: el índice va delante de los datos.
    const boxes = await mp4Boxes(file);
    expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    // La música suena (atenuada), también después de sus 2 s: se repite.
    expect(await meanVolume(file)).toBeGreaterThan(-45);
    expect(await meanVolume(file)).toBeLessThan(-8);

    const poster = await probe(bucket.file(inBrand('reels/fundido.jpg')));
    expect(poster.video).toMatchObject({ codec: 'mjpeg', width: 270, height: 480 });

    // El texto está dibujado: la misma zona del fotograma cambia respecto al reel sin textos.
    await runHandler(handler, bucket, {
      ...payload,
      plan: { ...plan, texts: [] },
      output: { path: inBrand('reels/sin-texto.mp4'), width: 270 },
    });
    const band = { x: 20, y: 300, width: 230, height: 90 };
    const withText = await averageColor(file, band, 1);
    const without = await averageColor(bucket.file(inBrand('reels/sin-texto.mp4')), band, 1);
    const difference = withText.reduce((sum, value, i) => sum + Math.abs(value - without[i]!), 0);
    expect(difference).toBeGreaterThan(25);

    // La foto de móvil sale enderezada: en su tramo, rojo arriba y azul abajo.
    const top = await averageColor(file, { x: 60, y: 130, width: 150, height: 60 }, 4.6);
    const bottom = await averageColor(file, { x: 60, y: 400, width: 150, height: 60 }, 4.6);
    expect(top[0]).toBeGreaterThan(top[2] + 80);
    expect(bottom[2]).toBeGreaterThan(bottom[0] + 80);
  });

  it('usa la tipografía de la marca (.ttf del cubo de la marca) y, si no vale, la de reserva avisando', async () => {
    // Otra tipografía del sistema, distinta de la de reserva, hace de «fuente de la marca».
    const candidates = [
      '/usr/share/fonts/dejavu/DejaVuSerif-Bold.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
      '/usr/share/fonts/TTF/DejaVuSerif-Bold.ttf',
      'C:/Windows/Fonts/georgiab.ttf',
      'C:/Windows/Fonts/timesbd.ttf',
      '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    ];
    const brandFont = candidates.find((file) => existsSync(file)) ?? deps.defaultFontFile!;
    await copyFile(brandFont, bucket.file(inBrand('fonts/propia.ttf')));
    const texts = [{ text: 'TIPOGRAFÍA DE LA MARCA', start: 0, end: 3 }];
    const media = [{ type: 'photo' as const, path: inBrand('plato.jpg'), seconds: 3 }];

    const branded = await runHandler(handler, bucket, {
      template: { id: 'corte-ritmico' },
      plan: { media, texts, fontPath: inBrand('fonts/propia.ttf') },
      output: { path: inBrand('reels/marca.mp4'), width: 270 },
    });
    expect(branded).toMatchObject({ font: { source: 'brand' }, warnings: [] });
    const fallback = await runHandler(handler, bucket, {
      template: { id: 'corte-ritmico' },
      plan: { media, texts },
      output: { path: inBrand('reels/reserva.mp4'), width: 270 },
    });
    expect(fallback).toMatchObject({ font: { source: 'default' } });
    if (brandFont !== deps.defaultFontFile) {
      // Con otra tipografía, el texto dibujado es distinto.
      const band = { x: 10, y: 200, width: 250, height: 80 };
      const a = await averageColor(bucket.file(inBrand('reels/marca.mp4')), band, 1);
      const b = await averageColor(bucket.file(inBrand('reels/reserva.mp4')), band, 1);
      expect(a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0)).toBeGreaterThan(0);
    }

    // Un archivo que no es una fuente: se monta con la de reserva y se dice.
    await writeFile(bucket.file(inBrand('fonts/rota.ttf')), 'no soy una fuente');
    const broken = await runHandler(handler, bucket, {
      template: { id: 'corte-ritmico' },
      plan: { media, texts, fontPath: inBrand('fonts/rota.ttf') },
      output: { path: inBrand('reels/rota.mp4'), width: 270 },
    });
    expect(broken.font).toEqual({ source: 'default' });
    expect((broken.warnings as string[])[0]).toMatch(/no es TrueType ni OpenType/);

    // La tipografía de otra marca no se descarga.
    await expect(
      runHandler(handler, bucket, {
        template: { id: 'corte-ritmico' },
        plan: { media, texts, fontPath: `${ORG}/${OTHER_BRAND}/fonts/ajena.ttf` },
        output: { path: inBrand('reels/ajena.mp4'), width: 270 },
      }),
    ).rejects.toThrow(/no pertenece a la marca/);
  });

  it('con cortes secos conserva el sonido de los clips y no necesita música', async () => {
    const result = await runHandler(handler, bucket, {
      template: { id: 'corte-ritmico' },
      plan: {
        media: [
          { type: 'photo', path: inBrand('detalle.png') },
          { type: 'video', path: inBrand('cocina.mp4'), seconds: 1.5 },
        ],
        texts: [{ text: 'Abierto todos los días', start: 0, end: 3 }],
      },
      output: { path: inBrand('reels/cortes.mp4'), width: 180 },
    });
    expect(result).toMatchObject({ output: { width: 180, height: 320, durationSeconds: 3 } });
    const file = bucket.file(inBrand('reels/cortes.mp4'));
    expect((await probe(file)).audio).toMatchObject({ codec: 'aac' });
    expect(await meanVolume(file)).toBeGreaterThan(-45); // el tono del clip
  });

  it('sin música ni sonido de clips, el reel lleva igualmente una pista de sonido (en silencio)', async () => {
    await runHandler(handler, bucket, {
      template: { id: 'pase-lateral' },
      plan: {
        media: [
          { type: 'photo', path: inBrand('plato.jpg'), seconds: 1 },
          { type: 'photo', path: inBrand('detalle.png'), seconds: 1 },
        ],
      },
      output: { path: inBrand('reels/mudo.mp4'), width: 180 },
    });
    const file = bucket.file(inBrand('reels/mudo.mp4'));
    const info = await probe(file);
    expect(info.audio).toMatchObject({ codec: 'aac' });
    expect(info.durationSeconds).toBeCloseTo(1.6, 1);
    expect(await meanVolume(file)).toBeLessThan(-80);
  });

  it('acepta una plantilla completa en la carga y rechaza lo que no puede montar', async () => {
    const inline = {
      ...loadTemplates().get('fundido-suave')!,
      id: 'a-medida',
      canvas: { width: 360, height: 640, fps: 24 },
    };
    const result = await runHandler(handler, bucket, {
      template: inline,
      plan: { media: [{ type: 'photo', path: inBrand('plato.jpg'), seconds: 1 }] },
      output: { path: inBrand('reels/a-medida.mp4') },
    });
    expect(result).toMatchObject({ template: { id: 'a-medida' }, output: { width: 360, height: 640, fps: 24 } });

    const run = (payload: unknown) => runHandler(handler, bucket, payload);
    const output = { path: inBrand('reels/x.mp4') };
    const media = [{ type: 'photo', path: inBrand('plato.jpg') }];
    await expect(run({ template: { id: 'no-existe' }, plan: { media }, output })).rejects.toThrow(
      /No existe la plantilla/,
    );
    await expect(
      run({
        template: { id: 'fundido-suave' },
        plan: { media: [{ type: 'video', path: inBrand('plato.jpg') }] },
        output,
      }),
    ).rejects.toThrow(PermanentError);
    await expect(
      run({ template: { id: 'fundido-suave' }, plan: { media, music: { path: inBrand('plato.jpg') } }, output }),
    ).rejects.toThrow(/no tiene sonido/);
    await expect(
      run({
        template: { id: 'fundido-suave' },
        plan: { media },
        output: { path: `${ORG}/${OTHER_BRAND}/reels/x.mp4` },
      }),
    ).rejects.toThrow(/no pertenece a la marca/);
  });
});
