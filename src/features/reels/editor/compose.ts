// Qué se ve y qué suena en cada instante del reel, para la vista previa del
// navegador. Puro (sin lienzo ni elementos de vídeo): el reproductor
// (ReelPlayer.tsx) solo dibuja lo que dice esto.
//
// Imita al motor (worker/src/reel/build.ts): mismas duraciones, mismos
// solapes en las transiciones, el mismo movimiento de las fotos, el mismo
// desenfoque relativo y las mismas cuentas de texto. Las transiciones de
// FFmpeg (`xfade`) se aproximan: fundido, a negro y deslizamientos.
import type { ReelTemplateSummary } from '../templates';
import {
  MAX_SUBTITLE_LINES,
  MAX_TEXT_LINES,
  textLines,
  timelineSubtitles,
  type Clip,
  type DraftPlan,
  type PhotoMotion,
  type PlanTimeline,
  type TextPosition,
  type TextStyle,
  type TransitionType,
} from './project';

export const MOTION_CYCLE: PhotoMotion[] = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'];

export interface FrameLayer {
  clip: number;
  alpha: number;
  /** Desplazamiento como fracción del lienzo (deslizamientos). */
  dx: number;
  dy: number;
  /** Segundo del archivo (clips). */
  sourceTime: number | null;
  /** Fotos: ampliación y desplazamiento horizontal del recorte (0 = izquierda, 1 = derecha). */
  zoom: number;
  panX: number;
}

export interface FrameText {
  key: string;
  lines: string[];
  style: TextStyle;
  position: TextPosition;
  alpha: number;
}

export interface Frame {
  layers: FrameLayer[];
  /** Negro por encima de todo (transición a negro), de 0 a 1. */
  black: number;
  texts: FrameText[];
  subtitles: FrameText[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Movimiento de cada foto: el suyo o el de la plantilla (con el ciclo de «alternate»). */
export function photoMotions(clips: Clip[], template: ReelTemplateSummary): Array<PhotoMotion | null> {
  let photos = 0;
  return clips.map((clip) => {
    if (clip.type !== 'photo') return null;
    const kind =
      clip.motion ??
      (template.photoMotion.type === 'alternate'
        ? MOTION_CYCLE[photos % MOTION_CYCLE.length]!
        : (template.photoMotion.type as PhotoMotion));
    photos += 1;
    return kind;
  });
}

/** Ampliación y paneo de una foto con su movimiento y su avance (0 a 1), como `zoompan`. */
export function photoTransform(kind: PhotoMotion, amount: number, progress: number) {
  const p = clamp01(progress);
  switch (kind) {
    case 'zoom-in':
      return { zoom: 1 + amount * p, panX: 0.5 };
    case 'zoom-out':
      return { zoom: 1 + amount - amount * p, panX: 0.5 };
    case 'pan-right':
      return { zoom: 1 + amount, panX: p };
    case 'pan-left':
      return { zoom: 1 + amount, panX: 1 - p };
    default:
      return { zoom: 1, panX: 0.5 };
  }
}

/** Opacidad de un texto con su entrada y salida suaves (la misma rampa que el `alpha` de drawtext). */
export function fadeAlpha(t: number, start: number, end: number, fade: number): number {
  if (t < start || t > end) return 0;
  const f = Math.min(fade, (end - start) / 2);
  if (f < 0.02) return 1;
  if (t < start + f) return clamp01((t - start) / f);
  if (t > end - f) return clamp01((end - t) / f);
  return 1;
}

/** Volumen de la música en el segundo `t`, con su entrada y salida suaves. */
export function musicGain(
  t: number,
  total: number,
  music: { volume: number; fadeInSeconds: number; fadeOutSeconds: number },
): number {
  if (t < 0 || t > total) return 0;
  const fadeIn = Math.min(music.fadeInSeconds, total / 2);
  const fadeOut = Math.min(music.fadeOutSeconds, total / 2);
  let gain = music.volume;
  if (fadeIn > 0 && t < fadeIn) gain *= t / fadeIn;
  if (fadeOut > 0 && t > total - fadeOut) gain *= (total - t) / fadeOut;
  return clamp01(gain);
}

export function frameAt(
  t: number,
  plan: DraftPlan,
  timeline: PlanTimeline,
  template: ReelTemplateSummary,
  size: { width: number; height: number },
): Frame {
  const { clips } = plan;
  const motions = photoMotions(clips, template);
  const layers: FrameLayer[] = [];
  let black = 0;
  const time = Math.min(Math.max(0, t), Math.max(0, timeline.total - 1e-3));

  const layerFor = (index: number, alpha = 1, dx = 0, dy = 0): FrameLayer => {
    const clip = clips[index]!;
    const start = timeline.starts[index]!;
    const duration = timeline.durations[index]!;
    if (clip.type === 'video') {
      return { clip: index, alpha, dx, dy, sourceTime: clip.in + (time - start), zoom: 1, panX: 0.5 };
    }
    const progress = duration > 0 ? (time - start) / duration : 0;
    const { zoom, panX } = photoTransform(motions[index]!, template.photoMotion.amount, progress);
    return { clip: index, alpha, dx, dy, sourceTime: null, zoom, panX };
  };

  for (let i = 0; i < clips.length; i += 1) {
    const start = timeline.starts[i]!;
    const end = start + timeline.durations[i]!;
    if (time < start || time >= end) continue;
    const next = i + 1 < clips.length ? i + 1 : -1;
    const nextStart = next >= 0 ? timeline.starts[next]! : Infinity;
    const transition = next >= 0 ? timeline.transitions[next]! : 0;
    if (next >= 0 && transition > 0 && time >= nextStart) {
      // Dentro de la transición hacia el siguiente: se componen los dos.
      const p = clamp01((time - nextStart) / transition);
      const type: TransitionType = clips[next]!.transition?.type ?? template.transition.type;
      if (type === 'fadeblack') {
        if (p < 0.5) {
          layers.push(layerFor(i));
          black = p * 2;
        } else {
          layers.push(layerFor(next));
          black = (1 - p) * 2;
        }
      } else if (type === 'slideleft') {
        layers.push(layerFor(i, 1, -p), layerFor(next, 1, 1 - p));
      } else if (type === 'slideup') {
        layers.push(layerFor(i, 1, 0, -p), layerFor(next, 1, 0, 1 - p));
      } else {
        layers.push(layerFor(i), layerFor(next, p));
      }
      break;
    }
    layers.push(layerFor(i));
    break;
  }

  const texts: FrameText[] = [];
  for (const text of plan.texts) {
    const alpha = fadeAlpha(time, text.start, Math.min(text.end, timeline.total), text.style.fadeSeconds);
    if (alpha <= 0) continue;
    const { lines } = textLines(text.text, text.style, text.position, size.width, size.height, MAX_TEXT_LINES);
    if (lines.length) texts.push({ key: text.id, lines, style: text.style, position: text.position, alpha });
  }

  const subtitles: FrameText[] = [];
  if (plan.subtitles?.enabled) {
    const settings = plan.subtitles;
    for (const cue of timelineSubtitles(clips, timeline)) {
      const alpha = fadeAlpha(time, cue.start, cue.end, settings.style.fadeSeconds);
      if (alpha <= 0) continue;
      const { lines } = textLines(
        cue.text,
        settings.style,
        settings.position,
        size.width,
        size.height,
        MAX_SUBTITLE_LINES,
      );
      if (lines.length) {
        subtitles.push({
          key: `${cue.clip}:${cue.cue}`,
          lines,
          style: settings.style,
          position: settings.position,
          alpha,
        });
      }
    }
  }
  return { layers, black, texts, subtitles };
}

export interface PreviewContext {
  /** Familias de la marca que el navegador ha cargado. */
  loadedFamilies: string[];
  /** ¿Tiene la marca una tipografía .ttf/.otf para los reels? */
  brandReelFont: boolean;
  /** Tipo de archivo de cada ruta, si se sabe. */
  mimeOf: (path: string) => string | null;
}

/** Lo que la vista previa enseña distinto del vídeo que montará el trabajador, en español. */
export function previewWarnings(plan: DraftPlan, template: ReelTemplateSummary, context: PreviewContext): string[] {
  const warnings: string[] = [];
  const types = new Set(plan.clips.slice(1).map((c) => c.transition?.type ?? template.transition.type));
  if (types.has('dissolve')) warnings.push('La transición «disolver» se ve aquí como un fundido normal.');
  if (types.has('slideleft') || types.has('slideup'))
    warnings.push('Los deslizamientos son aproximados: en el vídeo pueden ir algo más suaves.');
  if (plan.clips.some((c) => c.type === 'photo' && (c.blur ?? 0) > 0))
    warnings.push('El desenfoque del navegador y el de FFmpeg se parecen, pero no son idénticos.');
  const families = new Set(context.loadedFamilies.map((f) => f.toLowerCase()));
  const styles = [...plan.texts.map((t) => t.style), ...(plan.subtitles?.enabled ? [plan.subtitles.style] : [])];
  const missing = new Set(
    styles.filter((s) => s.fontFamily && !families.has(s.fontFamily.toLowerCase())).map((s) => s.fontFamily as string),
  );
  for (const family of missing)
    warnings.push(`La tipografía «${family}» no se ha cargado en el navegador: aquí se ve otra parecida.`);
  if (styles.some((s) => !s.fontPath) && !context.brandReelFont && styles.length > 0)
    warnings.push(
      'La marca no tiene tipografía .ttf u .otf: el vídeo usará la de reserva del trabajador (DejaVu Sans) y aquí se ve la del sistema.',
    );
  if (plan.clips.some((c) => /heic|heif/i.test(context.mimeOf(c.path) ?? '')))
    warnings.push('Hay fotos HEIC: el navegador no siempre las enseña y el trabajador no las monta.');
  return warnings;
}
