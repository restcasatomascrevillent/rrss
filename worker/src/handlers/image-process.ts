// Procesado de imagen: de una foto salen las versiones recortadas a las
// proporciones de las redes, con el recorte centrado en un punto focal.
import path from 'node:path';
import { z } from 'zod';
import { PermanentError } from '../errors.ts';
import { orientationFilters, orientationSwapsAxes, takeJpegOrientation } from '../ffmpeg/exif.ts';
import { probeMedia } from '../ffmpeg/probe.ts';
import { runFfmpeg } from '../ffmpeg/run.ts';
import type { Handler } from '../handler.ts';
import {
  ASPECTS,
  aspectSchema,
  assertOutputPaths,
  CENTER,
  cropToAspect,
  fetchInput,
  focalPointSchema,
  IMAGE_FORMATS,
  imageEncodeArgs,
  imageFormatSchema,
  parsePayload,
  storagePathSchema,
  storeOutput,
  type MediaDeps,
} from './shared.ts';

export const IMAGE_PROCESS_KIND = 'media.image.process';

export const imageProcessPayloadSchema = z.strictObject({
  source: z.strictObject({ path: storagePathSchema }),
  /** Punto de interés de la foto; por defecto, el centro. */
  focalPoint: focalPointSchema.default(CENTER),
  outputs: z
    .array(
      z.strictObject({
        path: storagePathSchema,
        aspect: aspectSchema,
        /** Ancho deseado en píxeles. Nunca se amplía por encima del original. */
        width: z.number().int().min(16).max(4096),
        format: imageFormatSchema.default('jpeg'),
        quality: z.number().int().min(1).max(100).default(85),
      }),
    )
    .min(1)
    .max(12),
});
export type ImageProcessPayload = z.input<typeof imageProcessPayloadSchema>;

export function createImageProcessHandler(deps: MediaDeps): Handler {
  return {
    kind: IMAGE_PROCESS_KIND,
    async run(context) {
      const payload = parsePayload(imageProcessPayloadSchema, context.job.payload);
      assertOutputPaths(
        context,
        payload.outputs.map((o) => o.path),
      );

      const source = await fetchInput(context, payload.source.path, 'source');
      // El giro lo decide el trabajador (EXIF) y no la versión de FFmpeg.
      const orientation = await takeJpegOrientation(source);
      const info = await probeMedia(deps.tools, source, context.signal);
      if (!info.video) throw new PermanentError('El archivo de origen no es una imagen');
      const swap = orientationSwapsAxes(orientation);
      const size = {
        width: swap ? info.video.codedHeight : info.video.codedWidth,
        height: swap ? info.video.codedWidth : info.video.codedHeight,
      };

      const outputs = [];
      for (const [index, output] of payload.outputs.entries()) {
        const crop = cropToAspect(size, output.aspect, payload.focalPoint);
        const width = Math.min(output.width, crop.width);
        // El alto sale de la proporción pedida, no del recorte: 1080 de ancho en 9:16 son 1920 exactos.
        const [aw, ah] = ASPECTS[output.aspect];
        const height = Math.max(1, Math.round((width * ah) / aw));
        const format = IMAGE_FORMATS[output.format];
        const file = path.join(context.workDir, `output-${index}.${format.extension}`);
        const filters = [
          ...orientationFilters(orientation),
          `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
          `scale=${width}:${height}:flags=lanczos`,
        ];
        await runFfmpeg(
          deps.tools,
          [
            '-noautorotate',
            '-i',
            source,
            '-vf',
            filters.join(','),
            '-frames:v',
            '1',
            ...imageEncodeArgs(output.format, output.quality),
            file,
          ],
          { signal: context.signal },
        );
        const bytes = await storeOutput(context, file, output.path, format.contentType);
        outputs.push({ path: output.path, aspect: output.aspect, width, height, format: output.format, bytes });
      }
      return { source: size, outputs };
    },
  };
}
