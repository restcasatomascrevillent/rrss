// Quitar el fondo en el navegador, sin proveedor de IA ni coste (docs/edicion-fotos.md, §7).
//
//   removeBackgroundInBrowser(foto, onProgreso) → la misma foto con el alfa del modelo.
//
// El modelo (IS-Net) corre en un Web Worker con onnxruntime-web; se descarga una
// vez y queda en Cache Storage. El worker se termina tras un rato sin uso para
// devolver la memoria.
import type { Pixels } from '../pixels';
import type { FromWorker, Provider, ToWorker } from './cutout.worker';
import { applyMask, normalizeMask, NoSubjectError, toModelInput } from './mask';
import { cutoutModelUrl, cutoutSimulated, CUTOUT_MODEL_NAME, DEFAULT_CUTOUT_MODEL_BYTES, MODEL_SIDE } from './model';

export type CutoutProgress =
  | { phase: 'downloading'; received: number; total: number }
  | { phase: 'loading' }
  | { phase: 'running' };

export interface CutoutResult {
  pixels: Pixels;
  model: string;
  provider: Provider | 'simulated';
  fromCache: boolean;
}

/** Tras este tiempo sin recortes se termina el worker. */
export const WORKER_IDLE_MS = 60_000;
/** Memoria (GB, `navigator.deviceMemory`) por debajo de la cual no se intenta. */
const MIN_MEMORY_GB = 2;

export type CutoutSupport = { ok: true } | { ok: false; reason: string };

/** ¿Puede este navegador quitar el fondo? Si no, dice por qué, en claro. */
export function cutoutSupport(
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): CutoutSupport {
  if (cutoutSimulated()) return { ok: true };
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    return {
      ok: false,
      reason:
        'Este navegador no puede quitar el fondo (le falta WebAssembly o los procesos en segundo plano). Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.',
    };
  }
  const memory = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;
  if (typeof memory === 'number' && memory < MIN_MEMORY_GB) {
    return {
      ok: false,
      reason: 'Este dispositivo tiene poca memoria para quitar el fondo en el navegador. Usa un ordenador.',
    };
  }
  return { ok: true };
}

/** Texto para quien pidió el recorte: qué pasó y qué hacer. */
export function describeCutoutError(error: unknown): string {
  const name = (error as Error | undefined)?.name;
  const message = (error as Error | undefined)?.message ?? '';
  if (error instanceof NoSubjectError || name === 'NoSubjectError') return message;
  if (name === 'ModelDownloadError') return message;
  if (name === 'RangeError' || /memory|alloc|out of/i.test(message)) {
    return 'El navegador se ha quedado sin memoria para quitar el fondo. Cierra otras pestañas, prueba con una foto más pequeña o usa un ordenador.';
  }
  if (/WebAssembly|wasm|session|backend|webgpu/i.test(message)) {
    return 'Este navegador no ha podido preparar el modelo para quitar el fondo (ni con la tarjeta gráfica ni con el procesador). Prueba con otro navegador o con un ordenador.';
  }
  return 'No se ha podido quitar el fondo en el navegador. Vuelve a intentarlo.';
}

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const pending = new Map<
  number,
  {
    ok: (m: Extract<FromWorker, { type: 'mask' }>) => void;
    ko: (e: Error) => void;
    onProgress?: (p: CutoutProgress) => void;
  }
>();

/** Termina el worker ya (si no hay nada en marcha) y suelta su memoria. */
export function releaseCutoutWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker || pending.size > 0) return;
  worker.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  const w = new Worker(new URL('./cutout.worker.ts', import.meta.url), { type: 'module', name: 'recorte-fotos' });
  w.onmessage = (event: MessageEvent<FromWorker>) => {
    const m = event.data;
    if (m.type === 'download') {
      pending.forEach((p) => p.onProgress?.({ phase: 'downloading', received: m.received, total: m.total }));
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'loading') p.onProgress?.({ phase: 'loading' });
    else if (m.type === 'running') p.onProgress?.({ phase: 'running' });
    else if (m.type === 'mask') {
      pending.delete(m.id);
      p.ok(m);
    } else {
      pending.delete(m.id);
      const error = new Error(m.message);
      if (m.name) error.name = m.name;
      p.ko(error);
    }
  };
  w.onerror = (event) => {
    const error = new Error(event.message || 'Error en el worker del recorte');
    pending.forEach((p) => p.ko(error));
    pending.clear();
    w.terminate();
    worker = null;
  };
  worker = w;
  return w;
}

/** Máscara simulada (solo pruebas de punta a punta): una elipse centrada. */
function simulatedPrediction(): Float32Array {
  const out = new Float32Array(MODEL_SIDE * MODEL_SIDE);
  const c = MODEL_SIDE / 2;
  for (let y = 0; y < MODEL_SIDE; y += 1) {
    for (let x = 0; x < MODEL_SIDE; x += 1) {
      const d = ((x - c) / (c * 0.8)) ** 2 + ((y - c) / (c * 0.7)) ** 2;
      out[y * MODEL_SIDE + x] = d <= 1 ? 1 : 0;
    }
  }
  return out;
}

function runInWorker(input: Float32Array, onProgress?: (p: CutoutProgress) => void) {
  return new Promise<Extract<FromWorker, { type: 'mask' }>>((ok, ko) => {
    const id = nextId++;
    pending.set(id, { ok, ko, onProgress });
    const message: ToWorker = { type: 'run', id, modelUrl: cutoutModelUrl(), input };
    getWorker().postMessage(message, [input.buffer]);
  }).finally(() => {
    if (pending.size === 0) idleTimer = setTimeout(releaseCutoutWorker, WORKER_IDLE_MS);
  });
}

/**
 * Foto → la misma foto con el fondo transparente. Lanza `NoSubjectError` si no
 * encuentra nada que recortar y `ModelDownloadError` si no puede bajar el modelo.
 */
export async function removeBackgroundInBrowser(
  image: Pixels,
  onProgress?: (p: CutoutProgress) => void,
): Promise<CutoutResult> {
  const support = cutoutSupport();
  if (!support.ok) throw new Error(support.reason);
  const input = toModelInput(image);
  if (cutoutSimulated()) {
    onProgress?.({ phase: 'downloading', received: DEFAULT_CUTOUT_MODEL_BYTES, total: DEFAULT_CUTOUT_MODEL_BYTES });
    onProgress?.({ phase: 'running' });
    const mask = normalizeMask(simulatedPrediction());
    return { pixels: applyMask(image, mask), model: CUTOUT_MODEL_NAME, provider: 'simulated', fromCache: true };
  }
  const result = await runInWorker(input, onProgress);
  const pixels = applyMask(image, normalizeMask(result.prediction));
  return { pixels, model: CUTOUT_MODEL_NAME, provider: result.provider, fromCache: result.fromCache };
}
