// Reel por plantilla: fotos y clips reales + textos con tiempos + música
// opcional → vídeo vertical 9:16 en H.264, montado con FFmpeg.
import { existsSync } from 'node:fs';
import { copyFile, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PermanentError } from '../errors.ts';
import { takeJpegOrientation } from '../ffmpeg/exif.ts';
import { probeMedia } from '../ffmpeg/probe.ts';
import { num, runFfmpeg } from '../ffmpeg/run.ts';
import type { Handler, HandlerContext } from '../handler.ts';
import { buildReel, type ResolvedClip, type ResolvedPlan } from '../reel/build.ts';
import { planAsV2, reelPayloadSchema, type ReelTemplate } from '../reel/schema.ts';
import { findTemplate, loadTemplates } from '../reel/templates.ts';
import { assertOutputPaths, fetchInput, parsePayload, storeOutput, type MediaDeps } from './shared.ts';

export const REEL_TEMPLATE_KIND = 'media.reel.template';

const FONT_NAME = 'font.ttf';

/** Firma de un archivo TrueType u OpenType (lo que lee FFmpeg con FreeType sin sorpresas). */
export function isTrueTypeOrOpenType(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const tag = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
  return (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0) || ['OTTO', 'true', 'ttcf'].includes(tag);
}

/** De dónde sale la tipografía de los textos del reel. */
export type ReelFontSource = 'brand' | 'template' | 'default' | 'none';

async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  const head = new Uint8Array(4);
  try {
    await handle.read(head, 0, 4, 0);
  } finally {
    await handle.close();
  }
  return head;
}

/** Baja la tipografía propia de un texto; null si el archivo no es TrueType ni OpenType. */
async function prepareOwnFont(context: HandlerContext, fontPath: string, index: number): Promise<string | null> {
  const file = await fetchInput(context, fontPath, `text-font-${index}`);
  if (!isTrueTypeOrOpenType(await readHead(file))) return null;
  const name = `font-${index}.ttf`;
  await copyFile(file, path.join(context.workDir, name));
  return name;
}

/** Deja la tipografía en la carpeta de trabajo y devuelve su nombre relativo y su origen. */
async function prepareFont(
  context: HandlerContext,
  deps: MediaDeps,
  template: ReelTemplate,
  brandFontPath: string | undefined,
): Promise<{ file?: string; source: ReelFontSource; warning?: string }> {
  const target = path.join(context.workDir, FONT_NAME);
  let warning: string | undefined;
  if (brandFontPath) {
    // fetchInput comprueba que la ruta es de la marca del trabajo.
    const file = await fetchInput(context, brandFontPath, 'brand-font');
    if (isTrueTypeOrOpenType(await readHead(file))) {
      await copyFile(file, target);
      return { file: FONT_NAME, source: 'brand' };
    }
    warning = 'El archivo de la tipografía de la marca no es TrueType ni OpenType: se usa la de reserva';
  }
  let source = deps.defaultFontFile;
  let origin: ReelFontSource = 'default';
  if (template.text.font !== 'default') {
    const installed = ['.ttf', '.otf']
      .map((extension) => path.join(deps.fontsDir ?? '', `${template.text.font}${extension}`))
      .find((file) => deps.fontsDir && existsSync(file));
    if (!installed) {
      throw new PermanentError(`La tipografía «${template.text.font}» no está instalada en el trabajador`);
    }
    source = installed;
    origin = 'template';
  }
  if (!source || !existsSync(source)) return { source: 'none', warning };
  await copyFile(source, target);
  return { file: FONT_NAME, source: origin, warning };
}

export function createReelTemplateHandler(deps: MediaDeps): Handler {
  const templates = loadTemplates();
  return {
    kind: REEL_TEMPLATE_KIND,
    async run(context) {
      const payload = parsePayload(reelPayloadSchema, context.job.payload);
      assertOutputPaths(context, [payload.output.path, payload.output.posterPath]);
      const template =
        'schemaVersion' in payload.template ? payload.template : findTemplate(templates, payload.template.id);
      const isV2 = 'version' in payload.plan;
      const plan = planAsV2(payload.plan, template);

      // ── Bajar y medir los elementos ────────────────────────────────────
      const downloadStartedAt = Date.now();
      const clips: ResolvedClip[] = [];
      for (const [index, item] of plan.clips.entries()) {
        const file = await fetchInput(context, item.path, `media-${index}`);
        const orientation = item.type === 'photo' ? await takeJpegOrientation(file) : 1;
        const info = await probeMedia(deps.tools, file, context.signal);
        if (!info.video) throw new PermanentError(`La pieza ${index + 1} no tiene imagen`);
        const name = path.basename(file);
        if (item.type === 'photo') {
          clips.push({
            type: 'photo',
            file: name,
            orientation,
            focalPoint: item.focalPoint,
            blur: item.blur,
            seconds: item.seconds,
            motion: item.motion,
            transition: item.transition,
          });
        } else {
          if (info.durationSeconds <= 0) throw new PermanentError(`La pieza ${index + 1} no es un vídeo`);
          clips.push({
            type: 'video',
            file: name,
            focalPoint: item.focalPoint,
            blur: item.blur,
            in: item.in,
            out: item.out,
            volume: item.volume,
            transition: item.transition,
            subtitles: item.subtitles,
            durationSeconds: info.durationSeconds,
            hasAudio: Boolean(info.audio),
          });
        }
      }
      let music: ResolvedPlan['music'];
      if (plan.music) {
        const file = await fetchInput(context, plan.music.path, 'music');
        const info = await probeMedia(deps.tools, file, context.signal);
        if (!info.audio) throw new PermanentError('El archivo de música no tiene sonido');
        if (plan.music.startAt >= info.durationSeconds) {
          throw new PermanentError('La música empieza después de su propio final');
        }
        music = {
          file: path.basename(file),
          startAt: plan.music.startAt,
          volume: plan.music.volume,
          fadeInSeconds: plan.music.fadeInSeconds,
          fadeOutSeconds: plan.music.fadeOutSeconds,
        };
      }
      const hasSubtitles =
        plan.subtitles?.enabled === true &&
        plan.clips.some((c) => c.type === 'video' && (c.subtitles?.length ?? 0) > 0);
      const needsText = plan.texts.length > 0 || hasSubtitles;
      const font = needsText ? await prepareFont(context, deps, template, plan.fontPath) : undefined;
      // Tipografías propias de cada texto (de la marca: fetchInput lo comprueba).
      const fontFiles: Record<string, string> = {};
      const fontWarnings: string[] = [];
      const ownFonts = [
        ...plan.texts.map((t) => t.style.fontPath),
        ...(hasSubtitles ? [plan.subtitles?.style.fontPath] : []),
      ].filter((p): p is string => Boolean(p));
      for (const fontPath of [...new Set(ownFonts)]) {
        if (fontPath === plan.fontPath && font?.source === 'brand') {
          fontFiles[fontPath] = FONT_NAME;
          continue;
        }
        const local = await prepareOwnFont(context, fontPath, Object.keys(fontFiles).length);
        if (local) fontFiles[fontPath] = local;
        else fontWarnings.push('Una tipografía elegida no es TrueType ni OpenType: se usa la de reserva');
      }
      const fontFile = font?.file;
      const downloadMs = Date.now() - downloadStartedAt;

      // ── Montar ─────────────────────────────────────────────────────────
      const outputName = 'reel.mp4';
      const build = buildReel({
        template,
        plan: { clips, texts: plan.texts, subtitles: plan.subtitles, music },
        fontFile,
        fontFiles,
        maxTotalSeconds: isV2 ? undefined : template.timing.maxTotalSeconds,
        outputWidth: payload.output.width,
        outputFile: outputName,
      });
      for (const file of build.textFiles) await writeFile(path.join(context.workDir, file.name), file.content, 'utf8');
      const renderStartedAt = Date.now();
      // Dentro de la carpeta de trabajo: todas las rutas del grafo son relativas.
      await runFfmpeg(deps.tools, build.args, { cwd: context.workDir, signal: context.signal });
      const renderMs = Date.now() - renderStartedAt;

      // ── Comprobar y subir ──────────────────────────────────────────────
      const outputFile = path.join(context.workDir, outputName);
      const info = await probeMedia(deps.tools, outputFile, context.signal);
      if (!info.video || !info.audio) throw new Error('FFmpeg no ha producido un vídeo con imagen y sonido');
      const uploadStartedAt = Date.now();
      const bytes = await storeOutput(context, outputFile, payload.output.path, 'video/mp4');

      let poster: Record<string, unknown> | undefined;
      if (payload.output.posterPath) {
        const posterFile = path.join(context.workDir, 'poster.jpg');
        // Pasada la primera transición, para que la portada no salga a medio fundido.
        const at = Math.min(build.durationSeconds / 2, Math.max(0.5, build.transitionSeconds + 0.5));
        await runFfmpeg(
          deps.tools,
          ['-ss', num(at), '-i', outputFile, '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3', posterFile],
          { signal: context.signal },
        );
        const posterBytes = await storeOutput(context, posterFile, payload.output.posterPath, 'image/jpeg');
        poster = { path: payload.output.posterPath, atSeconds: Number(at.toFixed(3)), bytes: posterBytes };
      }
      const uploadMs = Date.now() - uploadStartedAt;

      return {
        template: { id: template.id, schemaVersion: template.schemaVersion },
        plan: { version: isV2 ? 2 : 1 },
        ...(payload.content ? { content: payload.content } : {}),
        output: {
          path: payload.output.path,
          width: info.video.width,
          height: info.video.height,
          fps: Number(info.video.fps.toFixed(3)),
          durationSeconds: Number(info.durationSeconds.toFixed(3)),
          videoCodec: info.video.codec,
          audioCodec: info.audio.codec,
          bytes,
        },
        ...(poster ? { poster } : {}),
        timeline: build.timeline,
        ...(build.subtitles.length > 0 ? { subtitles: build.subtitles.length } : {}),
        ...(font ? { font: { source: font.source } } : {}),
        warnings: [...(font?.warning ? [font.warning] : []), ...fontWarnings, ...build.warnings],
        timings: { downloadMs, renderMs, uploadMs },
      };
    },
  };
}
