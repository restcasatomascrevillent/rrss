/// <reference lib="webworker" />
// Worker del recorte en el navegador: onnxruntime-web con IS-Net. Se crea al
// primer uso (desde engine.ts), así ni el runtime ni el modelo entran en el
// paquete inicial ni congelan la interfaz.
//
// Proveedor: WebGPU si el navegador lo tiene y, si no, o si falla o devuelve una
// máscara vacía, WASM en CPU. Hilos solo con aislamiento cross-origin; la
// aplicación no lo activa a propósito (docs/edicion-fotos.md, §7): un hilo.
import * as ort from 'onnxruntime-web/webgpu';
import { loadModelBytes } from './download';
import { CUTOUT_MODEL_CACHE, DEFAULT_CUTOUT_MODEL_BYTES, MODEL_SIDE } from './model';

export type Provider = 'webgpu' | 'wasm';

export type ToWorker = { type: 'run'; id: number; modelUrl: string; input: Float32Array };
export type FromWorker =
  | { type: 'download'; received: number; total: number }
  | { type: 'loading'; id: number }
  | { type: 'running'; id: number }
  | { type: 'mask'; id: number; prediction: Float32Array; provider: Provider; fromCache: boolean; ms: number }
  | { type: 'error'; id: number; message: string; name?: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

let session: Promise<{ s: ort.InferenceSession; provider: Provider; fromCache: boolean }> | null = null;
let sessionUrl = '';
let noWebgpu = false;

async function hasWebgpu(): Promise<boolean> {
  if (noWebgpu) return false;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function loadSession(modelUrl: string) {
  if (session && sessionUrl !== modelUrl) session = null;
  if (!session) {
    sessionUrl = modelUrl;
    session = (async () => {
      ort.env.wasm.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      let last = 0;
      const model = await loadModelBytes({
        url: modelUrl,
        expectedBytes: DEFAULT_CUTOUT_MODEL_BYTES,
        openCache: () => caches.open(CUTOUT_MODEL_CACHE),
        onProgress: (received, total) => {
          if (received - last < 512 * 1024 && received < total) return;
          last = received;
          send({ type: 'download', received, total });
        },
      });
      const options = { graphOptimizationLevel: 'all' as const };
      if (await hasWebgpu()) {
        try {
          const s = await ort.InferenceSession.create(model.bytes, { ...options, executionProviders: ['webgpu'] });
          return { s, provider: 'webgpu' as const, fromCache: model.fromCache };
        } catch (error) {
          console.warn('[recorte] WebGPU no disponible, se usa WASM', error);
          noWebgpu = true;
        }
      }
      const s = await ort.InferenceSession.create(model.bytes, { ...options, executionProviders: ['wasm'] });
      return { s, provider: 'wasm' as const, fromCache: model.fromCache };
    })();
    session.catch(() => {
      session = null; // se reintenta en la próxima petición
    });
  }
  return session;
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type !== 'run') return;
  queue = queue.then(async () => {
    try {
      for (let attempt = 0; ; attempt += 1) {
        send({ type: 'loading', id: message.id });
        const { s, provider, fromCache } = await loadSession(message.modelUrl);
        send({ type: 'running', id: message.id });
        const started = performance.now();
        try {
          const outputs = await s.run({
            [s.inputNames[0]!]: new ort.Tensor('float32', message.input, [1, 3, MODEL_SIDE, MODEL_SIDE]),
          });
          const tensor = outputs[s.outputNames[0]!]!;
          const data = (tensor.location === 'gpu-buffer' ? await tensor.getData() : tensor.data) as Float32Array;
          const prediction = new Float32Array(data);
          let max = -Infinity;
          for (let i = 0; i < prediction.length; i += 997) if (prediction[i]! > max) max = prediction[i]!;
          // Controladores de GPU raros: NaN o mapa plano → se repite en CPU.
          if (provider === 'webgpu' && !(max > 0)) throw new Error('Máscara vacía en WebGPU');
          send(
            { type: 'mask', id: message.id, prediction, provider, fromCache, ms: performance.now() - started },
            [prediction.buffer],
          );
          return;
        } catch (error) {
          if (provider !== 'webgpu' || attempt > 0) throw error;
          console.warn('[recorte] fallo en WebGPU, se repite en WASM', error);
          noWebgpu = true;
          session = null;
        }
      }
    } catch (error) {
      send({
        type: 'error',
        id: message.id,
        message: (error as Error)?.message || String(error),
        name: (error as Error)?.name,
      });
    }
  });
};
