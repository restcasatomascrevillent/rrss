// Subtítulos automáticos de un clip.
//
//   1. El navegador decodifica el sonido del tramo usado del clip y lo pasa a
//      16 kHz mono (`extractClipAudio`, Web Audio).
//   2. Lo corta en trozos de voz por las pausas (`speechSegments`): cada trozo
//      dura como mucho 8 s y es un subtítulo.
//   3. Manda los trozos en WAV a la función `ai-transcribe` (OpenAI, con el
//      cupo de IA de la organización) y recibe el texto de cada uno.
//   4. Los textos largos se reparten en subtítulos de dos líneas como mucho
//      (`splitCue`), con el tiempo repartido por caracteres.
//
// Los pasos 2 y 4 y el WAV son puros y se prueban aparte.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Cue } from './project';

export const TRANSCRIBE_SAMPLE_RATE = 16000;
export const MAX_SEGMENT_SECONDS = 8;
/** Límites de la función (supabase/functions/ai-transcribe/handler.ts). */
export const MAX_REQUEST_SECONDS = 120;
export const MAX_REQUEST_CHUNKS = 40;

export interface SpeechSegment {
  start: number;
  end: number;
}

/**
 * Trozos con voz de una señal mono. Mide la energía en ventanas de 50 ms, toma
 * como silencio lo que queda por debajo de un umbral relativo al nivel de la
 * señal y corta en las pausas de al menos `minPause`; si un trozo pasa de
 * `maxSeconds`, lo parte por su ventana más silenciosa. Se descartan los trozos
 * de menos de 0,3 s.
 */
export function speechSegments(
  samples: Float32Array,
  sampleRate: number,
  options: { maxSeconds?: number; minPause?: number } = {},
): SpeechSegment[] {
  const maxSeconds = options.maxSeconds ?? MAX_SEGMENT_SECONDS;
  const minPause = options.minPause ?? 0.3;
  const window = Math.max(1, Math.round(sampleRate * 0.05));
  const energies: number[] = [];
  for (let i = 0; i < samples.length; i += window) {
    let sum = 0;
    const end = Math.min(samples.length, i + window);
    for (let j = i; j < end; j += 1) sum += samples[j]! * samples[j]!;
    energies.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  if (energies.length === 0) return [];
  const sorted = [...energies].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  if (loud < 0.003) return []; // todo silencio
  const threshold = Math.max(0.003, loud * 0.08);
  const step = window / sampleRate;
  const voiced = energies.map((e) => e >= threshold);
  const pauseWindows = Math.max(1, Math.round(minPause / step));

  // Trozos de voz separados por pausas largas.
  const raw: Array<[number, number]> = [];
  let start = -1;
  let silence = 0;
  voiced.forEach((v, i) => {
    if (v) {
      if (start < 0) start = i;
      silence = 0;
    } else if (start >= 0) {
      silence += 1;
      if (silence >= pauseWindows) {
        raw.push([start, i - silence + 1]);
        start = -1;
        silence = 0;
      }
    }
  });
  if (start >= 0) raw.push([start, voiced.length - silence]);

  // Los largos se parten por su ventana más silenciosa.
  const maxWindows = Math.max(2, Math.floor(maxSeconds / step));
  const out: Array<[number, number]> = [];
  const split = (a: number, b: number) => {
    if (b - a <= maxWindows) {
      out.push([a, b]);
      return;
    }
    let cut = a + Math.floor((b - a) / 2);
    let quietest = Infinity;
    for (let i = a + Math.floor(maxWindows / 3); i < Math.min(b - 1, a + maxWindows); i += 1) {
      if (energies[i]! < quietest) {
        quietest = energies[i]!;
        cut = i;
      }
    }
    split(a, cut);
    split(cut, b);
  };
  for (const [a, b] of raw) split(a, b);
  const round = (n: number) => Number(n.toFixed(3));
  return out
    .map(([a, b]) => ({ start: round(a * step), end: round(Math.min(samples.length / sampleRate, b * step)) }))
    .filter((s) => s.end - s.start >= 0.3);
}

/** WAV PCM de 16 bits, mono, a partir de muestras entre −1 y 1. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/**
 * Reparte un texto largo en subtítulos de como mucho `maxChars` caracteres
 * (unas dos líneas), sin partir palabras, con el tiempo repartido por longitud.
 */
export function splitCue(text: string, start: number, end: number, maxChars = 84): Cue[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const parts: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > maxChars) {
      parts.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) parts.push(current);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const cues: Cue[] = [];
  let cursor = start;
  parts.forEach((part, index) => {
    const share = index === parts.length - 1 ? end - cursor : ((end - start) * part.length) / total;
    const cueEnd = Number((cursor + share).toFixed(3));
    cues.push({ start: Number(cursor.toFixed(3)), end: cueEnd, text: part.slice(0, 200) });
    cursor = cueEnd;
  });
  return cues;
}

/** Sonido del tramo [from, to) del archivo, en 16 kHz mono. Solo en el navegador. */
export async function extractClipAudio(url: string, from: number, to: number): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('No se ha podido descargar el clip para escucharlo.');
  const data = await response.arrayBuffer();
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || typeof OfflineAudioContext === 'undefined') {
    throw new Error('Este navegador no puede leer el sonido del clip.');
  }
  const context = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(data);
  } catch {
    throw new Error('Este clip no tiene sonido que se pueda leer en el navegador.');
  } finally {
    void context.close();
  }
  const end = Math.min(to, decoded.duration);
  const length = Math.max(0, Math.round((end - from) * TRANSCRIBE_SAMPLE_RATE));
  if (length === 0) return new Float32Array(0);
  const offline = new OfflineAudioContext(1, length, TRANSCRIBE_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, from, end - from);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export interface TranscribeResult {
  cues: Cue[];
  /** Trozos de voz que se mandaron. */
  segments: number;
}

async function functionError(error: unknown): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = (await error.context.json()) as { error?: { message?: string } };
      if (body.error?.message) return new Error(body.error.message);
    } catch {
      // sin cuerpo legible
    }
  }
  return new Error('No se ha podido transcribir el clip. Inténtalo de nuevo.');
}

/** Precio por segundo de la transcripción (para enseñar el coste antes de pedirla). */
export async function transcriptionOptions(
  brandId: string,
): Promise<{ available: boolean; microsPerSecond: number | null }> {
  const { data, error } = await supabase.functions.invoke('ai-transcribe', { body: { action: 'options', brandId } });
  if (error) throw await functionError(error);
  return data as { available: boolean; microsPerSecond: number | null };
}

/**
 * Transcribe el tramo [from, to) de un clip y devuelve los subtítulos en
 * segundos DEL ARCHIVO. `samples` es el sonido de ese tramo (16 kHz mono).
 */
export async function transcribeSamples(
  brandId: string,
  samples: Float32Array,
  from: number,
  language = 'es',
): Promise<TranscribeResult> {
  const segments = speechSegments(samples, TRANSCRIBE_SAMPLE_RATE);
  if (segments.length === 0) return { cues: [], segments: 0 };
  const seconds = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (segments.length > MAX_REQUEST_CHUNKS || seconds > MAX_REQUEST_SECONDS) {
    throw new Error(`Hay demasiada voz en este clip para una sola vez (máximo ${MAX_REQUEST_SECONDS} s). Recórtalo.`);
  }
  const form = new FormData();
  form.append('brandId', brandId);
  form.append('meta', JSON.stringify({ chunks: segments.map((s) => ({ seconds: s.end - s.start })), language }));
  segments.forEach((s, index) => {
    const slice = samples.subarray(
      Math.floor(s.start * TRANSCRIBE_SAMPLE_RATE),
      Math.ceil(s.end * TRANSCRIBE_SAMPLE_RATE),
    );
    form.append(`chunk-${index}`, new Blob([encodeWav(slice, TRANSCRIBE_SAMPLE_RATE)], { type: 'audio/wav' }));
  });
  const { data, error } = await supabase.functions.invoke('ai-transcribe', { body: form });
  if (error) throw await functionError(error);
  const results = ((data as { segments?: Array<{ index: number; text: string }> }).segments ?? []).filter(
    (r) => typeof r.text === 'string' && r.text.trim(),
  );
  const cues = results.flatMap((r) => {
    const segment = segments[r.index];
    return segment ? splitCue(r.text, from + segment.start, from + segment.end) : [];
  });
  return { cues, segments: segments.length };
}
