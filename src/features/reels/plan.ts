// Lógica pura de la pantalla de reels: duración estimada, comprobaciones antes
// de encargar, la petición a `request_media_job` y cómo se cuenta el estado de
// un trabajo. Sin red ni React, para probarla aparte.
import type { Json, JobRow, JobStatus } from '@/lib/database.types';
import type { ReelTemplateSummary } from './templates';

export type TextPosition = 'top' | 'center' | 'bottom';

export interface ReelPiece {
  /** Clave local de la fila (una misma foto puede salir dos veces). */
  key: string;
  assetId: string;
  path: string;
  fileName: string;
  type: 'photo' | 'video';
  /** Segundos en pantalla. Vacío = los de la plantilla. */
  seconds: number | null;
  /** Desenfoque de la foto, de 0 (nítida) a 100. Vacío o 0 = sin desenfoque. Solo fotos. */
  blur?: number;
  /** Duración del clip en la biblioteca, si se conoce. */
  clipSeconds: number | null;
}

export interface ReelText {
  key: string;
  text: string;
  start: number;
  end: number;
  position: TextPosition | null;
}

export const MAX_PIECES = 20;
export const MAX_TEXTS = 20;
export const MAX_TEXT_LENGTH = 200;
/** Lo mínimo que el trabajador toma de un clip (worker/src/reel/build.ts). */
const MIN_SEGMENT_SECONDS = 0.5;

/**
 * Duración del reel tal como la calcula el motor (worker/src/reel/build.ts):
 * cada foto, sus segundos ajustados a fotogramas; cada clip, lo pedido sin
 * pasar de lo que dura; y cada transición (salvo el corte seco) solapa dos
 * piezas. Es una estimación: el trabajador la vuelve a calcular y rechaza un
 * plan que pase del máximo.
 */
export function estimateDuration(template: ReelTemplateSummary, pieces: ReelPiece[]) {
  const fps = template.canvas.fps;
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * fps));
  const durations = pieces.map((piece) => {
    if (piece.type === 'photo') return frames(piece.seconds ?? template.timing.photoSeconds) / fps;
    const wanted = piece.seconds ?? template.timing.maxClipSeconds;
    const available = piece.clipSeconds ?? wanted;
    return Math.floor(Math.max(0, Math.min(wanted, available)) * fps) / fps;
  });
  if (durations.length === 0) return { total: 0, durations, transition: 0 };
  const shortest = Math.min(...durations);
  const transition =
    template.transition.type === 'cut' || durations.length === 1
      ? 0
      : Math.floor(Math.min(template.transition.seconds, shortest / 2) * fps) / fps;
  const total = durations.reduce((sum, seconds) => sum + seconds, 0) - transition * (durations.length - 1);
  return { total: Number(total.toFixed(3)), durations, transition };
}

/** Problemas que impiden encargar el reel, en español y en el orden en que se ven en pantalla. */
export function reelProblems(template: ReelTemplateSummary | undefined, pieces: ReelPiece[], texts: ReelText[]) {
  const problems: string[] = [];
  if (!template) problems.push('Elige una plantilla.');
  if (pieces.length === 0) problems.push('Añade al menos una foto o un clip.');
  if (pieces.length > MAX_PIECES) problems.push(`Como mucho ${MAX_PIECES} fotos o clips.`);
  for (const [index, piece] of pieces.entries()) {
    if (piece.type === 'video' && piece.clipSeconds !== null && piece.clipSeconds < MIN_SEGMENT_SECONDS) {
      problems.push(`El clip ${index + 1} es demasiado corto.`);
    }
  }
  if (template && pieces.length > 0) {
    const { total } = estimateDuration(template, pieces);
    if (total > template.timing.maxTotalSeconds + 1e-6) {
      problems.push(
        `El reel duraría ${formatSeconds(total)} y la plantilla admite ${formatSeconds(template.timing.maxTotalSeconds)} como máximo.`,
      );
    }
  }
  if (texts.length > MAX_TEXTS) problems.push(`Como mucho ${MAX_TEXTS} textos.`);
  for (const [index, text] of texts.entries()) {
    if (!text.text.trim()) problems.push(`El texto ${index + 1} está vacío.`);
    else if (text.text.length > MAX_TEXT_LENGTH)
      problems.push(`El texto ${index + 1} pasa de ${MAX_TEXT_LENGTH} caracteres.`);
    if (!(text.end > text.start) || text.start < 0) {
      problems.push(`El texto ${index + 1} debe terminar después de empezar.`);
    }
  }
  return problems;
}

/** Lo que se envía a `request_media_job` para un reel (la salida la pone la base de datos). */
export function buildReelInput(
  template: ReelTemplateSummary,
  pieces: ReelPiece[],
  texts: ReelText[],
  musicPath: string | null,
): Json {
  return {
    template: { id: template.id },
    plan: {
      media: pieces.map((piece) => ({
        type: piece.type,
        path: piece.path,
        ...(piece.seconds !== null ? { seconds: piece.seconds } : {}),
        ...(piece.type === 'photo' && piece.blur && piece.blur > 0 ? { blur: Math.min(100, Math.round(piece.blur)) } : {}),
      })),
      texts: texts.map((text) => ({
        text: text.text.trim(),
        start: text.start,
        end: text.end,
        ...(text.position ? { position: text.position } : {}),
      })),
      ...(musicPath ? { music: { path: musicPath } } : {}),
    },
  };
}

export function formatSeconds(seconds: number): string {
  return `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(seconds)} s`;
}

// ───────────────────────────── Estado de un trabajo ─────────────────────────────

export type JobTone = 'neutral' | 'progress' | 'success' | 'danger';

export interface JobView {
  label: string;
  tone: JobTone;
  /** Motivo del fallo (o del último intento fallido, si se está reintentando). */
  detail: string | null;
  /** Recurso creado en la biblioteca, cuando ha terminado. */
  assetId: string | null;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'En cola',
  running: 'Montando',
  succeeded: 'Listo',
  failed: 'Falló',
  cancelled: 'Cancelado',
};

export type MediaJobSummary = Pick<
  JobRow,
  'id' | 'kind' | 'status' | 'attempts' | 'max_attempts' | 'last_error' | 'result' | 'payload' | 'created_at'
>;

export function describeJob(job: MediaJobSummary): JobView {
  const assets = (job.result as { assets?: Array<{ id?: unknown }> } | null)?.assets;
  const assetId = Array.isArray(assets) && typeof assets[0]?.id === 'string' ? assets[0].id : null;
  if (job.status === 'queued' && job.attempts > 0) {
    return { label: 'En cola (reintento)', tone: 'progress', detail: job.last_error, assetId: null };
  }
  const tone: JobTone =
    job.status === 'succeeded'
      ? 'success'
      : job.status === 'failed'
        ? 'danger'
        : job.status === 'cancelled'
          ? 'neutral'
          : 'progress';
  return {
    label: STATUS_LABEL[job.status],
    tone,
    detail: job.status === 'failed' ? (job.last_error ?? 'Sin motivo registrado') : null,
    assetId: job.status === 'succeeded' ? assetId : null,
  };
}

export const isActive = (job: Pick<JobRow, 'status'>) => job.status === 'queued' || job.status === 'running';

/** Nombre de la plantilla de un trabajo de reel (o su id si ya no existe). */
export function jobTemplateName(job: MediaJobSummary, templates: ReelTemplateSummary[]): string {
  const id = (job.payload as { template?: { id?: unknown } } | null)?.template?.id;
  if (typeof id !== 'string') return 'Reel';
  return templates.find((t) => t.id === id)?.name ?? id;
}

/** Número de piezas de un trabajo de reel. */
export function jobPieceCount(job: MediaJobSummary): number {
  const media = (job.payload as { plan?: { media?: unknown } } | null)?.plan?.media;
  return Array.isArray(media) ? media.length : 0;
}
