// Derivados de un vídeo: póster (fotograma fijo), versión comprimida y
// adaptación a otra proporción por recorte alrededor de un punto focal.
import path from 'node:path';
import { z } from 'zod';
import { PermanentError } from '../errors.ts';
import { probeMedia } from '../ffmpeg/probe.ts';
import { num, runFfmpeg } from '../ffmpeg/run.ts';
import type { Handler } from '../handler.ts';
import {
  aspectSchema,
  assertOutputPaths,
  CENTER,
  cropToAspect,
  fetchInput,
  focalPointSchema,
  h264Args,
  IMAGE_FORMATS,
  imageEncodeArgs,
  imageFormatSchema,
  parsePayload,
  storagePathSchema,
  storeOutput,
  type MediaDeps,
} from './shared.ts';

export const VIDEO_DERIVATIVES_KIND = 'media.video.derivatives';

const crfSchema = z.number().int().min(16).max(40);

export const videoDerivativesPayloadSchema = z
  .strictObject({
    source: z.strictObject({ path: storagePathSchema }),
    /** Fotograma fijo para usar de portada. */
    poster: z
      .strictObject({
        path: storagePathSchema,
        /** Instante del fotograma. Si el vídeo es más corto, se toma su punto medio. */
        atSeconds: z.number().min(0).default(1),
        width: z.number().int().min(16).max(4096).optional(),
        format: imageFormatSchema.default('jpeg'),
        quality: z.number().int().min(1).max(100).default(85),
      })
      .optional(),
    /** Copia más ligera, sin cambiar la proporción. */
    compressed: z
      .strictObject({
        path: storagePathSchema,
        maxHeight: z.number().int().min(90).max(2160).default(720),
        maxFps: z.number().int().min(10).max(60).default(30),
        crf: crfSchema.default(26),
        audioBitrateKbps: z.number().int().min(32).max(256).default(96),
      })
      .optional(),
    /** Misma pieza en otra proporción, recortando alrededor del punto focal. */
    reframe: z
      .strictObject({
        path: storagePathSchema,
        aspect: aspectSchema,
        focalPoint: focalPointSchema.default(CENTER),
        maxHeight: z.number().int().min(90).max(2160).default(1920),
        crf: crfSchema.default(23),
      })
      .optional(),
  })
  .refine((p) => p.poster || p.compressed || p.reframe, { message: 'Hay que pedir al menos un derivado' });
export type VideoDerivativesPayload = z.input<typeof videoDerivativesPayloadSchema>;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function createVideoDerivativesHandler(deps: MediaDeps): Handler {
  return {
    kind: VIDEO_DERIVATIVES_KIND,
    async run(context) {
      const payload = parsePayload(videoDerivativesPayloadSchema, context.job.payload);
      assertOutputPaths(context, [payload.poster?.path, payload.compressed?.path, payload.reframe?.path]);

      const source = await fetchInput(context, payload.source.path, 'source');
      const info = await probeMedia(deps.tools, source, context.signal);
      if (!info.video || info.durationSeconds <= 0) throw new PermanentError('El archivo de origen no es un vídeo');
      const { video } = info;
      const audioArgs = (kbps: number) =>
        info.audio ? ['-c:a', 'aac', '-b:a', `${kbps}k`, '-ac', '2', '-ar', '48000'] : ['-an'];
      const run = (args: string[]) => runFfmpeg(deps.tools, args, { signal: context.signal });

      const result: Record<string, unknown> = {
        source: {
          width: video.width,
          height: video.height,
          durationSeconds: info.durationSeconds,
          fps: Number(video.fps.toFixed(3)),
          hasAudio: Boolean(info.audio),
        },
      };

      if (payload.poster) {
        const { poster } = payload;
        const format = IMAGE_FORMATS[poster.format];
        const file = path.join(context.workDir, `poster.${format.extension}`);
        const at = poster.atSeconds < info.durationSeconds ? poster.atSeconds : info.durationSeconds / 2;
        const width = Math.min(poster.width ?? video.width, video.width);
        const height = Math.max(1, Math.round((width * video.height) / video.width));
        await run([
          '-ss',
          num(at),
          '-i',
          source,
          '-frames:v',
          '1',
          '-vf',
          `scale=${width}:${height}:flags=lanczos`,
          ...imageEncodeArgs(poster.format, poster.quality),
          file,
        ]);
        const bytes = await storeOutput(context, file, poster.path, format.contentType);
        result.poster = { path: poster.path, width, height, atSeconds: Number(at.toFixed(3)), bytes };
      }

      if (payload.compressed) {
        const { compressed } = payload;
        const file = path.join(context.workDir, 'compressed.mp4');
        const height = even(Math.min(video.height, compressed.maxHeight));
        const width = even((video.width * height) / video.height);
        const filters = [`scale=${width}:${height}:flags=bicubic`];
        if (video.fps > compressed.maxFps + 0.01) filters.push(`fps=${compressed.maxFps}`);
        const startedAt = Date.now();
        await run([
          '-i',
          source,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          filters.join(','),
          ...h264Args({ crf: compressed.crf, preset: 'veryfast' }),
          ...audioArgs(compressed.audioBitrateKbps),
          file,
        ]);
        const ms = Date.now() - startedAt;
        const bytes = await storeOutput(context, file, compressed.path, 'video/mp4');
        result.compressed = { path: compressed.path, width, height, bytes, encodeMs: ms };
      }

      if (payload.reframe) {
        const { reframe } = payload;
        const file = path.join(context.workDir, 'reframe.mp4');
        const crop = cropToAspect(video, reframe.aspect, reframe.focalPoint, true);
        const height = even(Math.min(crop.height, reframe.maxHeight));
        const width = even((crop.width * height) / crop.height);
        const filters = [
          `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
          `scale=${width}:${height}:flags=bicubic`,
          'setsar=1',
        ];
        const startedAt = Date.now();
        await run([
          '-i',
          source,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          filters.join(','),
          ...h264Args({ crf: reframe.crf, preset: 'veryfast' }),
          ...audioArgs(128),
          file,
        ]);
        const ms = Date.now() - startedAt;
        const bytes = await storeOutput(context, file, reframe.path, 'video/mp4');
        result.reframe = { path: reframe.path, aspect: reframe.aspect, width, height, bytes, encodeMs: ms };
      }

      return result;
    },
  };
}
