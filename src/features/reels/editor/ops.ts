// Cambios sobre el proyecto de reel. Funciones puras: reciben el proyecto y
// devuelven otro (nunca lo modifican). El historial (history.ts) las guarda
// para deshacer y rehacer.
import type { ReelTemplateSummary } from '../templates';
import {
  MAX_CLIP_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  PHOTO_SECONDS,
  REEL_MAX_CLIPS,
  REEL_MAX_TEXTS,
  templateTextStyle,
  templateTransition,
  type Clip,
  type Cue,
  type Music,
  type PhotoClip,
  type ReelProject,
  type ReelText,
  type SubtitleSettings,
  type TextStyle,
  type Transition,
  type VideoClip,
} from './project';

/** Recurso de la biblioteca que se puede añadir al reel. */
export interface SourceAsset {
  id: string;
  kind: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  duration_ms: number | null;
}

const round = (n: number, decimals = 2) => Number(n.toFixed(decimals));
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Identificador corto que no se repite dentro del proyecto. */
export function newId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i += 1) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

const allIds = (project: ReelProject) => [
  ...project.plan.clips.map((c) => c.id),
  ...project.plan.texts.map((t) => t.id),
];

const withPlan = (project: ReelProject, plan: Partial<ReelProject['plan']>): ReelProject => ({
  ...project,
  plan: { ...project.plan, ...plan },
});

const mapClip = (project: ReelProject, id: string, change: (clip: Clip) => Clip): ReelProject =>
  withPlan(project, { clips: project.plan.clips.map((c) => (c.id === id ? change(c) : c)) });

const mapText = (project: ReelProject, id: string, change: (text: ReelText) => ReelText): ReelProject =>
  withPlan(project, { texts: project.plan.texts.map((t) => (t.id === id ? change(t) : t)) });

// ───────────────────────────── Fotos y clips ─────────────────────────────

/** Añade una foto o un clip al final (o en `index`), con los valores de la plantilla. */
export function addClip(project: ReelProject, asset: SourceAsset, template: ReelTemplateSummary, index?: number) {
  if (project.plan.clips.length >= REEL_MAX_CLIPS) return project;
  const id = newId('c', allIds(project));
  const transition = templateTransition(template);
  const clip: Clip =
    asset.kind === 'video'
      ? {
          id,
          type: 'video',
          path: asset.storage_path,
          in: 0,
          out: round(
            Math.min(
              template.timing.maxClipSeconds,
              asset.duration_ms ? asset.duration_ms / 1000 : template.timing.maxClipSeconds,
            ),
          ),
          volume: template.audio.clipVolume,
          transition,
        }
      : { id, type: 'photo', path: asset.storage_path, seconds: template.timing.photoSeconds, transition };
  const clips = [...project.plan.clips];
  clips.splice(index ?? clips.length, 0, clip);
  return withPlan(project, { clips });
}

export function removeClip(project: ReelProject, id: string) {
  return withPlan(project, { clips: project.plan.clips.filter((c) => c.id !== id) });
}

/** Mueve un elemento de la posición `from` a la `to` (las demás se corren). */
export function moveClip(project: ReelProject, from: number, to: number) {
  const clips = [...project.plan.clips];
  if (from < 0 || from >= clips.length) return project;
  const target = clamp(to, 0, clips.length - 1);
  if (target === from) return project;
  const [moved] = clips.splice(from, 1);
  clips.splice(target, 0, moved!);
  return withPlan(project, { clips });
}

export function duplicateClip(project: ReelProject, id: string) {
  const index = project.plan.clips.findIndex((c) => c.id === id);
  if (index < 0 || project.plan.clips.length >= REEL_MAX_CLIPS) return project;
  const copy = { ...project.plan.clips[index]!, id: newId('c', allIds(project)) };
  const clips = [...project.plan.clips];
  clips.splice(index + 1, 0, copy);
  return withPlan(project, { clips });
}

export function setPhotoSeconds(project: ReelProject, id: string, seconds: number) {
  return mapClip(project, id, (c) =>
    c.type === 'photo' ? { ...c, seconds: round(clamp(seconds, PHOTO_SECONDS.min, PHOTO_SECONDS.max)) } : c,
  );
}

/**
 * Recorta un clip por un extremo: `start` mueve el punto de entrada (`in`) y
 * `end` el de salida (`out`), sin bajar de 0,5 s de tramo, sin pasar de 60 s
 * ni salirse del archivo (si se sabe lo que dura). En una foto, el extremo
 * final cambia su duración.
 */
export function trimClip(
  project: ReelProject,
  id: string,
  edge: 'start' | 'end',
  value: number,
  fileSeconds: number | null = null,
) {
  return mapClip(project, id, (c) => {
    if (c.type === 'photo') {
      return edge === 'end' ? { ...c, seconds: round(clamp(value, PHOTO_SECONDS.min, PHOTO_SECONDS.max)) } : c;
    }
    const end = fileSeconds ?? Infinity;
    if (edge === 'start') {
      const min = Math.max(0, c.out - MAX_CLIP_SEGMENT_SECONDS);
      return { ...c, in: round(clamp(value, min, c.out - MIN_SEGMENT_SECONDS)) };
    }
    const max = Math.min(end, c.in + MAX_CLIP_SEGMENT_SECONDS);
    return { ...c, out: round(clamp(value, c.in + MIN_SEGMENT_SECONDS, max)) };
  });
}

export function setTransition(project: ReelProject, id: string, transition: Transition) {
  return mapClip(project, id, (c) => ({ ...c, transition: { ...transition, seconds: round(transition.seconds) } }));
}

/** Campos que se pueden cambiar de una foto o de un clip (los que no tenga su tipo se ignoran al validar). */
export type ClipPatch = Partial<{
  blur: number | undefined;
  motion: PhotoClip['motion'];
  volume: number;
  focalPoint: Clip['focalPoint'];
}>;

export function updateClip(project: ReelProject, id: string, patch: ClipPatch) {
  return mapClip(project, id, (c) => {
    const next: Record<string, unknown> = { ...c };
    for (const [key, value] of Object.entries(patch)) {
      if ((key === 'motion' && c.type !== 'photo') || (key === 'volume' && c.type !== 'video')) continue;
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next as Clip;
  });
}

// ───────────────────────────── Textos ─────────────────────────────

/** Estilo de partida de un texto nuevo: el de la plantilla con la tipografía y el color de la marca. */
export function brandTextStyle(
  template: ReelTemplateSummary,
  brand: { fontPath?: string; fontFamily?: string; color?: string },
): TextStyle {
  return {
    ...templateTextStyle(template),
    ...(brand.fontPath ? { fontPath: brand.fontPath } : {}),
    ...(brand.fontFamily ? { fontFamily: brand.fontFamily } : {}),
    ...(brand.color ? { color: brand.color.toUpperCase() } : {}),
  };
}

export function addText(
  project: ReelProject,
  template: ReelTemplateSummary,
  at: number,
  style: TextStyle,
  total: number,
): ReelProject {
  if (project.plan.texts.length >= REEL_MAX_TEXTS) return project;
  const start = round(clamp(at, 0, Math.max(0, total - 0.5)));
  const end = round(Math.max(start + 0.5, Math.min(start + 2, total || start + 2)));
  const text: ReelText = {
    id: newId('t', allIds(project)),
    text: 'Texto',
    start,
    end,
    position: template.text.position,
    style,
  };
  return withPlan(project, { texts: [...project.plan.texts, text] });
}

export function updateText(project: ReelProject, id: string, patch: Partial<Omit<ReelText, 'id'>>) {
  return mapText(project, id, (t) => ({ ...t, ...patch }));
}

export function updateTextStyle(project: ReelProject, id: string, patch: Partial<TextStyle>) {
  return mapText(project, id, (t) => ({ ...t, style: { ...t.style, ...patch } }));
}

export function removeText(project: ReelProject, id: string) {
  return withPlan(project, { texts: project.plan.texts.filter((t) => t.id !== id) });
}

/** Mueve un texto en el tiempo conservando su duración (sin salirse de 0). */
export function moveText(project: ReelProject, id: string, start: number) {
  return mapText(project, id, (t) => {
    const length = t.end - t.start;
    const s = round(Math.max(0, start));
    return { ...t, start: s, end: round(s + length) };
  });
}

/** Cambia cuándo entra (`start`) o sale (`end`) un texto; dura al menos 0,2 s. */
export function trimText(project: ReelProject, id: string, edge: 'start' | 'end', value: number) {
  return mapText(project, id, (t) =>
    edge === 'start'
      ? { ...t, start: round(clamp(value, 0, t.end - 0.2)) }
      : { ...t, end: round(Math.max(t.start + 0.2, value)) },
  );
}

// ───────────────────────────── Música ─────────────────────────────

export function setMusic(project: ReelProject, path: string, template: ReelTemplateSummary, note?: string) {
  const music: Music = {
    path,
    startAt: 0,
    volume: template.audio.musicVolume,
    fadeInSeconds: template.audio.fadeInSeconds,
    fadeOutSeconds: template.audio.fadeOutSeconds,
    license: { confirmed: true, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) },
  };
  return withPlan(project, { music });
}

export function updateMusic(project: ReelProject, patch: Partial<Omit<Music, 'path' | 'license'>>) {
  return project.plan.music ? withPlan(project, { music: { ...project.plan.music, ...patch } }) : project;
}

export function removeMusic(project: ReelProject) {
  const plan = { ...project.plan };
  delete plan.music;
  return { ...project, plan };
}

// ───────────────────────────── Subtítulos ─────────────────────────────

export function setSubtitleSettings(project: ReelProject, settings: SubtitleSettings) {
  return withPlan(project, { subtitles: settings });
}

/** Sustituye los subtítulos de un clip (en segundos del archivo). */
export function setClipCues(project: ReelProject, id: string, cues: Cue[]) {
  return mapClip(project, id, (c) => (c.type === 'video' ? { ...c, subtitles: cues } : c));
}

export function updateCue(project: ReelProject, clipId: string, index: number, patch: Partial<Cue>) {
  return mapClip(project, clipId, (c) => {
    if (c.type !== 'video' || !c.subtitles?.[index]) return c;
    const subtitles = c.subtitles.map((cue, i) => (i === index ? { ...cue, ...patch } : cue));
    return { ...c, subtitles };
  });
}

export function removeCue(project: ReelProject, clipId: string, index: number) {
  return mapClip(project, clipId, (c) =>
    c.type === 'video' && c.subtitles ? { ...c, subtitles: c.subtitles.filter((_, i) => i !== index) } : c,
  );
}

/** Añade un subtítulo escrito a mano al clip, en el segundo del archivo dado. */
export function addCue(project: ReelProject, clipId: string, at: number) {
  return mapClip(project, clipId, (c) => {
    if (c.type !== 'video') return c;
    const start = round(clamp(at, c.in, Math.max(c.in, c.out - 0.5)));
    const cue: Cue = { start, end: round(Math.min(c.out, start + 2)), text: 'Subtítulo' };
    const subtitles = [...(c.subtitles ?? []), cue].sort((a, b) => a.start - b.start);
    return { ...c, subtitles };
  });
}

export const isVideo = (clip: Clip | undefined): clip is VideoClip => clip?.type === 'video';
