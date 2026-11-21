// Motor del reel: convierte plantilla + plan v2 (ya con los archivos en disco
// y sus duraciones medidas) en una orden de FFmpeg. Un plan v1 entra por el
// mismo camino (`media`/`texts`/`music` se pasan a v2 aquí, igual que hace
// `migratePlanV1` con la carga).
//
// Es una función pura —no toca disco ni lanza procesos—, así que se prueba
// sin FFmpeg. Trampas que evita:
//  * Rutas y textos NO viajan dentro del grafo de filtros: FFmpeg se ejecuta
//    en la carpeta del trabajo y todo se nombra con rutas relativas simples;
//    el texto va en archivos (`textfile`). Así no hay que escapar «C:\…», ni
//    dos puntos, comas, comillas o «%» (en Windows es donde más duele).
//  * Cada línea de texto es un `drawtext` propio y centrado: no depende de
//    `text_align`, que solo existe en versiones recientes.
//  * Las fotos se giran aquí según su EXIF, con `-noautorotate`.
//  * Las fotos JPEG vienen en rango completo de color; se pasan a rango de
//    vídeo (`out_range=tv`) para que el H.264 salga en `yuv420p` normal.
//  * Transiciones mixtas: un corte seco se une con `concat` y el resto con
//    `xfade`, en cadena (el desplazamiento de cada `xfade` es el segundo del
//    reel en el que empieza el elemento).
//  * Los subtítulos se queman con `drawtext`, como los textos (no hace falta
//    libass), con la tipografía de la marca.
import { PermanentError } from '../errors.ts';
import { orientationFilters } from '../ffmpeg/exif.ts';
import { num } from '../ffmpeg/run.ts';
import { CENTER, focalCropExpr, h264Args, type FocalPoint } from '../handlers/shared.ts';
import {
  REEL_PLAN_V2_MAX_SECONDS,
  templateTextStyle,
  type ReelCue,
  type ReelTemplate,
  type ReelTextStyle,
  type ReelTextV2,
  type ReelTransition,
} from './schema.ts';

/** Pieza de un plan v1 ya bajada y medida. */
export type ResolvedMedia =
  | { type: 'photo'; file: string; orientation: number; focalPoint?: FocalPoint; seconds?: number; blur?: number }
  | {
      type: 'video';
      file: string;
      focalPoint?: FocalPoint;
      /** Desenfoque de 0 a 100 (ver `blurSigma`). */
      blur?: number;
      startAt: number;
      seconds?: number;
      /** Duración real del clip y si trae sonido, según ffprobe. */
      durationSeconds: number;
      hasAudio: boolean;
    };

export interface ResolvedText {
  text: string;
  start: number;
  end: number;
  position?: 'top' | 'center' | 'bottom';
}

export type PhotoMotion = 'none' | 'zoom-in' | 'zoom-out' | 'pan-right' | 'pan-left';

/** Elemento de un plan v2 ya bajado y medido. */
export type ResolvedClip =
  | {
      type: 'photo';
      file: string;
      orientation: number;
      focalPoint?: FocalPoint;
      blur?: number;
      seconds: number;
      motion?: PhotoMotion;
      transition?: ReelTransition;
    }
  | {
      type: 'video';
      file: string;
      focalPoint?: FocalPoint;
      blur?: number;
      in: number;
      out: number;
      volume: number;
      transition?: ReelTransition;
      subtitles?: ReelCue[];
      durationSeconds: number;
      hasAudio: boolean;
    };

export interface ResolvedPlan {
  clips: ResolvedClip[];
  texts: ReelTextV2[];
  subtitles?: { enabled: boolean; position: 'top' | 'center' | 'bottom'; style: ReelTextStyle };
  music?: { file: string; startAt: number; volume: number; fadeInSeconds: number; fadeOutSeconds: number };
}

export interface ReelBuildInput {
  template: ReelTemplate;
  /** Plan v2. Si no viene, se usan `media`, `texts` y `music` (plan v1). */
  plan?: ResolvedPlan;
  media?: ResolvedMedia[];
  texts?: ResolvedText[];
  music?: { file: string; startAt: number; volume?: number };
  /** Tipografía por defecto (relativa a la carpeta de trabajo). Obligatoria si hay textos sin la suya. */
  fontFile?: string;
  /** Tipografías propias de los textos: ruta del cubo → archivo en la carpeta de trabajo. */
  fontFiles?: Record<string, string>;
  /** Duración máxima. Por defecto: la de la plantilla en v1 y 90 s en v2. */
  maxTotalSeconds?: number;
  /** Ancho de salida; por defecto, el del lienzo. */
  outputWidth?: number;
  outputFile: string;
}

export interface TimelineSegment {
  index: number;
  type: 'photo' | 'video';
  /** Segundo del reel en el que empieza a verse. */
  start: number;
  seconds: number;
  /** Duración de la transición con la que entra (0 = corte o primer elemento). */
  transitionIn: number;
}

export interface ReelBuild {
  /** Argumentos de FFmpeg (sin el nombre del programa). */
  args: string[];
  filterGraph: string;
  /** Archivos de texto que hay que escribir en la carpeta de trabajo antes de lanzar FFmpeg. */
  textFiles: Array<{ name: string; content: string }>;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** La transición más larga del reel (para la portada). */
  transitionSeconds: number;
  timeline: TimelineSegment[];
  /** Subtítulos dibujados, ya en segundos del reel. */
  subtitles: Array<{ start: number; end: number; text: string }>;
  warnings: string[];
}

/** Las fotos se preparan al doble del lienzo para que el zoom no tiemble. */
const SUPERSAMPLE = 2;
export const MOTION_CYCLE = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'] as const;
export const MIN_SEGMENT_SECONDS = 0.5;
export const MAX_TEXT_LINES = 6;
export const MAX_SUBTITLE_LINES = 3;
/** Ancho medio de un carácter respecto al tamaño de letra, para partir líneas. */
export const AVERAGE_GLYPH_WIDTH = 0.56;
/** Lo mínimo que se dibuja de un texto o subtítulo. */
const MIN_VISIBLE_SECONDS = 0.1;

const hex = (color: string, opacity = 1) =>
  `0x${color.slice(1).toUpperCase()}${opacity < 1 ? `@${num(opacity, 2)}` : ''}`;

/**
 * Desviación del desenfoque gaussiano de FFmpeg (`gblur`) para una intensidad
 * de 0 a 100 sobre un cuadro de `width` × `height`. Es la misma cuenta que el
 * editor (`blurRadius` en src/features/content/document/schema.ts): 100 = el
 * 5 % del lado menor. El filtro `blur()` del lienzo del navegador también toma
 * la desviación, así que se ve igual en el editor y en el reel.
 */
export function blurSigma(blur: number | undefined, width: number, height: number): number {
  if (!blur || blur <= 0) return 0;
  return (Math.min(blur, 100) / 100) * 0.05 * Math.min(width, height);
}

/** Parte un texto en líneas que quepan en el ancho dado. Respeta los saltos de línea. */
export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  // Sin caracteres de control: un salto dentro de `textfile` se dibujaría como un recuadro.
  const clean = text.replace(/\r/g, '').replace(/[^\S\n]+/g, ' ');
  for (const paragraph of clean.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(' ')) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Medidas de un bloque de texto en un cuadro de `width` × `height` (mismas cuentas que la vista previa del editor). */
export function textLayout(
  style: Pick<ReelTextStyle, 'sizeRatio' | 'lineHeight' | 'maxWidthRatio' | 'marginRatio'>,
  position: 'top' | 'center' | 'bottom',
  lineCount: number,
  width: number,
  height: number,
) {
  const fontSize = Math.max(8, Math.round(style.sizeRatio * width));
  const lineStep = Math.round(fontSize * style.lineHeight);
  const maxChars = Math.max(4, Math.floor((style.maxWidthRatio * width) / (fontSize * AVERAGE_GLYPH_WIDTH)));
  const block = lineStep * (Math.max(1, lineCount) - 1) + fontSize;
  const margin = Math.round(style.marginRatio * height);
  const top =
    position === 'top' ? margin : position === 'center' ? Math.round((height - block) / 2) : height - margin - block;
  return { fontSize, lineStep, maxChars, top };
}

/** Plan v1 ya resuelto → plan v2 resuelto, con la plantilla (mismo vídeo). */
function legacyPlan(input: ReelBuildInput): ResolvedPlan {
  const { template } = input;
  const transition = { type: template.transition.type, seconds: template.transition.seconds };
  return {
    clips: (input.media ?? []).map((item): ResolvedClip => {
      if (item.type === 'photo') {
        return {
          type: 'photo',
          file: item.file,
          orientation: item.orientation,
          focalPoint: item.focalPoint,
          blur: item.blur,
          seconds: item.seconds ?? template.timing.photoSeconds,
          transition,
        };
      }
      return {
        type: 'video',
        file: item.file,
        focalPoint: item.focalPoint,
        blur: item.blur,
        in: item.startAt,
        out: item.startAt + (item.seconds ?? template.timing.maxClipSeconds),
        volume: template.audio.clipVolume,
        transition,
        durationSeconds: item.durationSeconds,
        hasAudio: item.hasAudio,
      };
    }),
    texts: (input.texts ?? []).map((text, index) => ({
      id: `t${index + 1}`,
      text: text.text,
      start: text.start,
      end: text.end,
      position: text.position ?? template.text.position,
      style: templateTextStyle(template),
    })),
    music: input.music
      ? {
          file: input.music.file,
          startAt: input.music.startAt,
          volume: input.music.volume ?? template.audio.musicVolume,
          fadeInSeconds: template.audio.fadeInSeconds,
          fadeOutSeconds: template.audio.fadeOutSeconds,
        }
      : undefined,
  };
}

export interface PlanTimeline {
  durations: number[];
  /** Transición con la que entra cada elemento (la del primero es 0). */
  transitions: number[];
  starts: number[];
  total: number;
}

/**
 * Línea de tiempo de un plan v2: duración de cada elemento ajustada a
 * fotogramas, transición de entrada de cada uno (como mucho la mitad del más
 * corto de los dos que une) y segundo en que empieza. La misma cuenta hace el
 * editor (src/features/reels/editor/project.ts) para la vista previa.
 */
export function planTimeline(
  clips: Array<
    | { type: 'photo'; seconds: number; transition?: ReelTransition }
    | { type: 'video'; in: number; out: number; durationSeconds?: number; transition?: ReelTransition }
  >,
  template: ReelTemplate,
  fps: number = template.canvas.fps,
): PlanTimeline {
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * fps));
  const durations = clips.map((clip, index) => {
    if (clip.type === 'photo') return frames(clip.seconds) / fps;
    const end = Math.min(clip.out, clip.durationSeconds ?? clip.out);
    const length = end - clip.in;
    if (length < MIN_SEGMENT_SECONDS) {
      throw new PermanentError(
        `El clip ${index + 1} no tiene ${MIN_SEGMENT_SECONDS} s a partir del segundo ${clip.in}`,
      );
    }
    // Por debajo, para no pedir fotogramas que el clip no tiene.
    return Math.floor(length * fps) / fps;
  });
  const transitions = clips.map((clip, index) => {
    if (index === 0) return 0;
    const t = clip.transition ?? template.transition;
    if (t.type === 'cut' || t.seconds <= 0) return 0;
    const limit = Math.min(durations[index - 1]!, durations[index]!) / 2;
    return Math.floor(Math.min(t.seconds, limit) * fps) / fps;
  });
  const starts: number[] = [];
  let cursor = 0;
  durations.forEach((seconds, index) => {
    cursor -= transitions[index]!;
    starts.push(Number(cursor.toFixed(4)));
    cursor += seconds;
  });
  return { durations, transitions, starts, total: Number(cursor.toFixed(4)) };
}

/** Subtítulos de los clips pasados a segundos del reel (solo la parte que se ve de cada clip). */
export function timelineSubtitles(
  clips: ResolvedClip[],
  timeline: Pick<PlanTimeline, 'durations' | 'starts'>,
): Array<{ start: number; end: number; text: string; clip: number }> {
  const out: Array<{ start: number; end: number; text: string; clip: number }> = [];
  clips.forEach((clip, index) => {
    if (clip.type !== 'video' || !clip.subtitles) return;
    const from = clip.in;
    const to = clip.in + timeline.durations[index]!;
    for (const cue of clip.subtitles) {
      const a = Math.max(cue.start, from);
      const b = Math.min(cue.end, to);
      if (b - a < MIN_VISIBLE_SECONDS * 2) continue;
      const start = timeline.starts[index]! + (a - from);
      out.push({
        start: Number(start.toFixed(3)),
        end: Number((start + (b - a)).toFixed(3)),
        text: cue.text,
        clip: index,
      });
    }
  });
  return out.sort((x, y) => x.start - y.start);
}

export function buildReel(input: ReelBuildInput): ReelBuild {
  const { template } = input;
  const plan = input.plan ?? legacyPlan(input);
  const clips = plan.clips;
  if (clips.length === 0) throw new PermanentError('El reel no tiene ningún elemento');
  const warnings: string[] = [];
  const fps = template.canvas.fps;
  const width = input.outputWidth ?? template.canvas.width;
  if (width > template.canvas.width) throw new PermanentError('El ancho de salida no puede superar el del lienzo');
  const height = Math.round((width * 16) / 9 / 2) * 2;
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * fps));

  // ── Línea de tiempo ──────────────────────────────────────────────────
  const { durations, transitions, starts, total } = planTimeline(clips, template, fps);
  const maxTotal = input.maxTotalSeconds ?? (input.plan ? REEL_PLAN_V2_MAX_SECONDS : template.timing.maxTotalSeconds);
  if (total > maxTotal + 1e-6) {
    throw new PermanentError(
      input.plan
        ? `El reel duraría ${num(total, 2)} s y admite ${maxTotal} s como máximo`
        : `El reel duraría ${num(total, 2)} s y la plantilla admite ${maxTotal} s como máximo`,
    );
  }
  const timeline: TimelineSegment[] = clips.map((clip, index) => ({
    index,
    type: clip.type,
    start: starts[index]!,
    seconds: durations[index]!,
    transitionIn: transitions[index]!,
  }));

  // ── Entradas ─────────────────────────────────────────────────────────
  const args: string[] = [];
  const chains: string[] = [];
  const crop = (w: number, h: number, focal: FocalPoint = CENTER) =>
    `crop=${w}:${h}:${focalCropExpr('w', w, focal.x)}:${focalCropExpr('h', h, focal.y)}`;
  const finish = 'setsar=1,format=yuv420p,settb=AVTB';
  // Desenfoque después del recorte: el radio es relativo al cuadro que se ve.
  const blurFilter = (blur: number | undefined, w: number, h: number) => {
    const sigma = blurSigma(blur, w, h);
    return sigma > 0 ? [`gblur=sigma=${num(sigma, 2)}`] : [];
  };
  let photoCount = 0;

  clips.forEach((item, index) => {
    const seconds = durations[index]!;
    if (item.type === 'photo') {
      args.push('-noautorotate', '-i', item.file);
      const sw = width * SUPERSAMPLE;
      const sh = height * SUPERSAMPLE;
      const count = frames(seconds);
      const progress = `on/${Math.max(1, count - 1)}`;
      const amount = num(template.photoMotion.amount);
      const kind: PhotoMotion =
        item.motion ??
        (template.photoMotion.type === 'alternate'
          ? MOTION_CYCLE[photoCount % MOTION_CYCLE.length]!
          : template.photoMotion.type);
      photoCount += 1;
      const centerX = 'iw/2-(iw/zoom/2)';
      const centerY = 'ih/2-(ih/zoom/2)';
      const motion = {
        none: { z: '1', x: centerX },
        'zoom-in': { z: `1+${amount}*${progress}`, x: centerX },
        'zoom-out': { z: `1+${amount}-${amount}*${progress}`, x: centerX },
        'pan-right': { z: `1+${amount}`, x: `(iw-iw/zoom)*${progress}` },
        'pan-left': { z: `1+${amount}`, x: `(iw-iw/zoom)*(1-${progress})` },
      }[kind];
      chains.push(
        `[${index}:v]${[
          // Un solo fotograma, aunque el archivo sea una imagen animada.
          'trim=end_frame=1',
          ...orientationFilters(item.orientation),
          `scale=${sw}:${sh}:force_original_aspect_ratio=increase:flags=lanczos:out_range=tv`,
          crop(sw, sh, item.focalPoint),
          ...blurFilter(item.blur, sw, sh),
          `zoompan=z='${motion.z}':x='${motion.x}':y='${centerY}':d=${count}:s=${width}x${height}:fps=${fps}`,
          `trim=duration=${num(seconds)}`,
          finish,
        ].join(',')}[v${index}]`,
      );
    } else {
      args.push('-ss', num(item.in), '-t', num(seconds + 1), '-i', item.file);
      chains.push(
        `[${index}:v]${[
          `fps=${fps}`,
          `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic:out_range=tv`,
          crop(width, height, item.focalPoint),
          ...blurFilter(item.blur, width, height),
          // Si al clip le falta algún fotograma al final, se repite el último.
          'tpad=stop_mode=clone:stop_duration=1',
          `trim=duration=${num(seconds)}`,
          'setpts=PTS-STARTPTS',
          finish,
        ].join(',')}[v${index}]`,
      );
    }
  });

  // ── Unión de los elementos: corte (concat) o transición (xfade) ──────
  let videoLabel = 'v0';
  if (clips.length > 1 && transitions.every((t) => t === 0)) {
    chains.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[joined]`);
    videoLabel = 'joined';
  } else if (clips.length > 1) {
    for (let i = 1; i < clips.length; i += 1) {
      const out = `x${i}`;
      const t = transitions[i]!;
      if (t === 0) {
        chains.push(`[${videoLabel}][v${i}]concat=n=2:v=1:a=0[${out}]`);
      } else {
        const type = (clips[i]!.transition ?? template.transition).type;
        chains.push(
          `[${videoLabel}][v${i}]xfade=transition=${type}:duration=${num(t)}:offset=${num(starts[i]!)}[${out}]`,
        );
      }
      videoLabel = out;
    }
  }

  // ── Textos y subtítulos ──────────────────────────────────────────────
  const textFiles: ReelBuild['textFiles'] = [];
  const draws: string[] = [];
  let missingFont = false;
  const fontFor = (style: ReelTextStyle) => {
    const own = style.fontPath ? input.fontFiles?.[style.fontPath] : undefined;
    const file = own ?? input.fontFile;
    if (!file) missingFont = true;
    return file;
  };
  const draw = (
    prefix: string,
    lines: string[],
    style: ReelTextStyle,
    position: 'top' | 'center' | 'bottom',
    start: number,
    end: number,
  ) => {
    const layout = textLayout(style, position, lines.length, width, height);
    const fade = Math.min(style.fadeSeconds, (end - start) / 2);
    const fontFile = fontFor(style);
    lines.forEach((line, lineIndex) => {
      const name = `${prefix}-${lineIndex}.txt`;
      textFiles.push({ name, content: line });
      const options = [
        `fontfile=${fontFile}`,
        `textfile=${name}`,
        'expansion=none',
        `fontsize=${layout.fontSize}`,
        `fontcolor=${hex(style.color)}`,
        'x=(w-text_w)/2',
        `y=${layout.top + lineIndex * layout.lineStep}`,
        `enable='between(t,${num(start)},${num(end)})'`,
      ];
      if (style.box) {
        options.push(
          'box=1',
          `boxcolor=${hex(style.box.color, style.box.opacity)}`,
          `boxborderw=${Math.round(style.box.paddingRatio * layout.fontSize)}`,
        );
      }
      if (style.outline) {
        options.push(
          `borderw=${Math.max(1, Math.round(style.outline.widthRatio * layout.fontSize))}`,
          `bordercolor=${hex(style.outline.color)}`,
        );
      }
      if (fade >= 0.02) {
        const f = num(fade);
        options.push(
          `alpha='if(lt(t,${num(start + fade)}),(t-${num(start)})/${f},if(gt(t,${num(end - fade)}),(${num(end)}-t)/${f},1))'`,
        );
      }
      draws.push(`drawtext=${options.join(':')}`);
    });
  };

  plan.texts.forEach((item, index) => {
    const start = Math.min(item.start, total);
    const end = Math.min(item.end, total);
    if (end - start < MIN_VISIBLE_SECONDS) {
      warnings.push(`El texto ${index + 1} queda fuera del vídeo (${num(total, 2)} s) y no se ha puesto`);
      return;
    }
    if (item.end > total + 0.05) warnings.push(`El texto ${index + 1} se ha recortado al final del vídeo`);
    const { maxChars } = textLayout(item.style, item.position, 1, width, height);
    let lines = wrapText(item.text, maxChars);
    if (lines.length === 0) return;
    if (lines.length > MAX_TEXT_LINES) {
      lines = lines.slice(0, MAX_TEXT_LINES);
      warnings.push(`El texto ${index + 1} no cabe: se han dejado ${MAX_TEXT_LINES} líneas`);
    }
    draw(`text-${index}`, lines, item.style, item.position, start, end);
  });

  const subtitles: ReelBuild['subtitles'] = [];
  if (plan.subtitles?.enabled) {
    const style = plan.subtitles.style;
    const cues = timelineSubtitles(clips, { durations, starts });
    cues.forEach((cue, index) => {
      const start = Math.min(cue.start, total);
      const end = Math.min(cue.end, total);
      if (end - start < MIN_VISIBLE_SECONDS) return;
      const { maxChars } = textLayout(style, plan.subtitles!.position, 1, width, height);
      let lines = wrapText(cue.text, maxChars);
      if (lines.length === 0) return;
      if (lines.length > MAX_SUBTITLE_LINES) {
        lines = lines.slice(0, MAX_SUBTITLE_LINES);
        warnings.push(`El subtítulo ${index + 1} no cabe: se han dejado ${MAX_SUBTITLE_LINES} líneas`);
      }
      subtitles.push({ start, end, text: lines.join('\n') });
      draw(`sub-${index}`, lines, style, plan.subtitles!.position, start, end);
    });
  }
  if (draws.length > 0 && missingFont) {
    throw new Error('Hay textos pero el trabajador no tiene ninguna tipografía (WORKER_FONT_FILE)');
  }
  chains.push(`[${videoLabel}]${[...draws, 'format=yuv420p'].join(',')}[vout]`);

  // ── Sonido: silencio de base + música + sonido de los clips ──────────
  const audioFormat = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const mix: string[] = [];
  let nextInput = clips.length;
  args.push('-f', 'lavfi', '-t', num(total), '-i', 'anullsrc=r=48000:cl=stereo');
  chains.push(`[${nextInput}:a]${audioFormat}[abase]`);
  mix.push('[abase]');
  nextInput += 1;

  if (plan.music) {
    const music = plan.music;
    const fadeIn = Math.min(music.fadeInSeconds, total / 2);
    const fadeOut = Math.min(music.fadeOutSeconds, total / 2);
    args.push('-stream_loop', '-1', '-i', music.file);
    const filters = [
      `atrim=start=${num(music.startAt)}:end=${num(music.startAt + total)}`,
      'asetpts=PTS-STARTPTS',
      audioFormat,
      `volume=${num(music.volume, 3)}`,
    ];
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${num(fadeIn)}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${num(total - fadeOut)}:d=${num(fadeOut)}`);
    chains.push(`[${nextInput}:a]${filters.join(',')}[amusic]`);
    mix.push('[amusic]');
    nextInput += 1;
  }

  clips.forEach((item, index) => {
    if (item.type !== 'video' || !item.hasAudio || item.volume <= 0) return;
    const seconds = durations[index]!;
    // Fundido corto en los extremos: con la transición, o mínimo para que no chasquee.
    const around = Math.max(transitions[index]!, transitions[index + 1] ?? 0);
    const edge = Math.min(Math.max(around, 0.03), seconds / 2);
    const filters = [
      `atrim=duration=${num(seconds)}`,
      'asetpts=PTS-STARTPTS',
      audioFormat,
      `volume=${num(item.volume, 3)}`,
      `afade=t=in:st=0:d=${num(edge)}`,
      `afade=t=out:st=${num(seconds - edge)}:d=${num(edge)}`,
    ];
    const delay = Math.round(starts[index]! * 1000);
    if (delay > 0) filters.push(`adelay=${delay}:all=1`);
    chains.push(`[${index}:a]${filters.join(',')}[aclip${index}]`);
    mix.push(`[aclip${index}]`);
  });
  chains.push(
    mix.length === 1
      ? `${mix[0]}anull[aout]`
      : `${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0[aout]`,
  );

  const filterGraph = chains.join(';\n');
  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...h264Args({ crf: template.export.crf, preset: template.export.preset }),
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    `${template.export.audioBitrateKbps}k`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    num(total),
    input.outputFile,
  );

  return {
    args,
    filterGraph,
    textFiles,
    width,
    height,
    fps,
    durationSeconds: total,
    transitionSeconds: Math.max(0, ...transitions),
    timeline,
    subtitles,
    warnings,
  };
}
