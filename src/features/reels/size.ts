// Peso estimado de un reel antes de encargarlo.
//
// El trabajador exporta H.264 con calidad constante (CRF): el peso depende de
// lo que se vea, no solo de la duración, así que no se puede saber exacto
// antes de montar. Se da una horquilla a partir de la duración de cada pieza,
// la resolución, los fotogramas por segundo y la exportación de la plantilla
// (CRF, preajuste y audio):
//
//   bits de vídeo ≈ segundos × ancho × alto × fps × bits por píxel
//
// con bits por píxel de referencia para CRF 23 y preajuste «medium» (las
// fotos con movimiento suave comprimen mucho mejor que los clips de cámara),
// multiplicados por 2^((23 − CRF) / 6) (cada 6 puntos de CRF el peso se dobla,
// aproximadamente) y por lo que pierde un preajuste rápido. El audio va a su
// tasa fija. La cifra alta es pesimista a propósito: sirve para avisar de que
// el reel puede no caber en el almacenamiento (50 MB por archivo en el plan
// gratuito de Supabase) antes de gastar minutos de máquina.
import { MAX_FILE_BYTES } from '@/config/app';
import { estimateDuration, type ReelPiece } from './plan';
import type { ReelTemplateSummary } from './templates';

/** Bits por píxel y fotograma a CRF 23 con el preajuste «medium»: [bajo, alto]. */
const BITS_PER_PIXEL = {
  photo: [0.02, 0.06],
  video: [0.06, 0.18],
} as const;

/** Cuánto más pesa cada preajuste que «medium» a igual CRF. */
const PRESET_FACTOR: Record<string, number> = {
  ultrafast: 1.6,
  superfast: 1.4,
  veryfast: 1.15,
  faster: 1.05,
  fast: 1,
  medium: 1,
};

/** Cajas y metadatos del MP4. */
const CONTAINER_OVERHEAD = 1.02;

export interface ReelSizeEstimate {
  /** Bytes en el caso favorable y en el pesimista. */
  low: number;
  high: number;
  /** Límite del almacenamiento por archivo. */
  limit: number;
  /** `fits`: cabe seguro · `maybe`: puede pasar del límite · `exceeds`: pasará incluso en el caso favorable. */
  verdict: 'fits' | 'maybe' | 'exceeds';
}

export function estimateReelSize(
  template: ReelTemplateSummary,
  pieces: ReelPiece[],
  limit: number = MAX_FILE_BYTES,
): ReelSizeEstimate {
  const { total, durations } = estimateDuration(template, pieces);
  if (pieces.length === 0 || total <= 0) return { low: 0, high: 0, limit, verdict: 'fits' };
  const { width, height, fps } = template.canvas;
  const quality = 2 ** ((23 - template.export.crf) / 6) * (PRESET_FACTOR[template.export.preset] ?? 1.15);
  const pixelsPerSecond = width * height * fps;
  // Las transiciones solapan piezas: se reparte la duración real en proporción.
  const sum = durations.reduce((a, b) => a + b, 0);
  const scale = sum > 0 ? total / sum : 0;
  let low = 0;
  let high = 0;
  for (const [index, piece] of pieces.entries()) {
    const seconds = (durations[index] ?? 0) * scale;
    const [bppLow, bppHigh] = BITS_PER_PIXEL[piece.type];
    low += seconds * pixelsPerSecond * bppLow * quality;
    high += seconds * pixelsPerSecond * bppHigh * quality;
  }
  const audio = total * template.export.audioBitrateKbps * 1000;
  const bytes = (bits: number) => Math.round(((bits + audio) / 8) * CONTAINER_OVERHEAD);
  const result = { low: bytes(low), high: bytes(high), limit };
  return { ...result, verdict: result.low > limit ? 'exceeds' : result.high > limit ? 'maybe' : 'fits' };
}
