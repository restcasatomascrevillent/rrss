// Adaptador de ComfyUI propio (FLUX.2 Klein 4B) con respuestas HTTP simuladas.
// NO se ha probado contra un ComfyUI real: esto comprueba que se habla la API
// documentada tal como se ha entendido, no que el servidor responda así.
import { describe, expect, it } from 'vitest';
import {
  buildFlux2KleinGraph,
  comfySize,
  COMFYUI_FLUX2_KLEIN_DEFAULTS,
  createComfyUiImageProvider,
  isComfyUiBaseUrl,
} from '../../supabase/functions/_shared/ai/media/comfyui-image.ts';
import { createMediaProviders } from '../../supabase/functions/_shared/ai/media/config.ts';
import type { ImageRequest, MediaModel } from '../../supabase/functions/_shared/ai/media/contract.ts';
import { simulatedPng } from '../../supabase/functions/_shared/ai/media/simulated.ts';

const BASE = 'https://comfy.ejemplo.test';

const model: MediaModel = {
  provider: 'comfyui',
  model: 'flux-2-klein-4b',
  kind: 'image',
  displayName: 'FLUX.2 Klein 4B',
  billingUnit: 'image',
  priceMicros: 0,
  priceDetails: {},
  priceVerified: true,
  dataRegion: 'unknown',
  trainsOnInputs: 'no',
  delivery: 'async',
  settings: { steps: 4, max_pixels: 1_572_864 },
  priority: 0,
  active: true,
};

const request: ImageRequest = {
  kind: 'image',
  prompt: 'Editorial food photograph of tapas',
  aspectRatio: '4:5',
  size: { width: 896, height: 1152 },
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeComfy(routes: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = init.body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    const call = { method: init.method ?? 'GET', url: input, headers, body };
    calls.push(call);
    return routes(call) ?? new Response('no encontrado', { status: 404 });
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signal = new AbortController().signal;

describe('adaptador ComfyUI', () => {
  it('solo admite https, o http en la propia máquina, y sin credenciales en la dirección', () => {
    expect(isComfyUiBaseUrl('https://abc.trycloudflare.com')).toBe(true);
    expect(isComfyUiBaseUrl('http://127.0.0.1:8188')).toBe(true);
    expect(isComfyUiBaseUrl('http://localhost:8188')).toBe(true);
    expect(isComfyUiBaseUrl('http://comfy.ejemplo.test')).toBe(false);
    expect(isComfyUiBaseUrl('https://usuario:clave@comfy.ejemplo.test')).toBe(false);
    expect(isComfyUiBaseUrl('ftp://comfy')).toBe(false);
  });

  it('ajusta el tamaño a múltiplos de 16 y al tope de píxeles, conservando la proporción', () => {
    expect(comfySize(896, 1152, 1_572_864)).toEqual({ width: 896, height: 1152 });
    const big = comfySize(2048, 2048, 1_048_576);
    expect(big).toEqual({ width: 1024, height: 1024 });
    const odd = comfySize(1000, 1250, 2_000_000);
    expect(odd.width % 16).toBe(0);
    expect(odd.height % 16).toBe(0);
  });

  it('el grafo es el del cuaderno de Colab, con el encargo, el tamaño y la semilla', () => {
    const graph = buildFlux2KleinGraph({
      prompt: 'hola',
      width: 896,
      height: 1152,
      seed: 7,
      filenamePrefix: 'rrss/x',
      references: [],
      settings: {},
    });
    expect(graph['70']!.inputs.unet_name).toBe(COMFYUI_FLUX2_KLEIN_DEFAULTS.unet_name);
    expect(graph['71']!.inputs).toMatchObject({ clip_name: 'qwen_3_4b_fp8_mixed.safetensors', type: 'flux2' });
    expect(graph['72']!.inputs.vae_name).toBe('flux2-vae.safetensors');
    expect(graph['74']!.inputs.text).toBe('hola');
    expect(graph['62']!.inputs).toEqual({ steps: 4, width: 896, height: 1152 });
    expect(graph['66']!.inputs).toEqual({ width: 896, height: 1152, batch_size: 1 });
    expect(graph['73']!.inputs.noise_seed).toBe(7);
    expect(graph['63']!.inputs.positive).toEqual(['74', 0]);
    expect(graph['9']!.class_type).toBe('SaveImage');
  });

  it('las referencias se suben y entran en la condición con ReferenceLatent', () => {
    const graph = buildFlux2KleinGraph({
      prompt: 'p',
      width: 512,
      height: 512,
      seed: 1,
      filenamePrefix: 'x',
      references: ['a.png', 'b.png'],
      settings: {},
    });
    expect(graph['100']!.inputs.image).toBe('a.png');
    expect(graph['110']!.inputs.image).toBe('b.png');
    expect(graph['63']!.inputs.positive).toEqual(['113', 0]);
    expect(graph['63']!.inputs.negative).toEqual(['114', 0]);
  });

  it('lanza el trabajo con el token, sondea el historial y descarga la imagen', async () => {
    const png = simulatedPng('comfy');
    let finished = false;
    const { calls, fetch } = fakeComfy((call) => {
      if (call.url === `${BASE}/upload/image`) return json({ name: 'rrss-ref.png', subfolder: '', type: 'input' });
      if (call.url === 'https://firmada.test/ref') return new Response(png);
      if (call.url === `${BASE}/prompt`) return json({ prompt_id: 'p-1', number: 3, node_errors: {} });
      if (call.url === `${BASE}/history/p-1`) {
        return json(
          finished
            ? {
                'p-1': {
                  status: { status_str: 'success', completed: true },
                  outputs: { '9': { images: [{ filename: 'rrss_0001.png', subfolder: 'rrss', type: 'output' }] } },
                },
              }
            : {},
        );
      }
      if (call.url.startsWith(`${BASE}/view?`)) return new Response(png, { headers: { 'content-type': 'image/png' } });
      return undefined;
    });
    const provider = createComfyUiImageProvider({ baseUrl: `${BASE}/`, token: 'secreto', dataRegion: 'eu', fetch });
    expect(provider.dataRegion).toBe('eu');
    expect(provider.testedAgainstRealService).toBe(false);
    expect(provider.estimateUsage(request, model)).toEqual({ images: 1 });

    const started = await provider.start({
      request: { ...request, references: [{ mimeType: 'image/png', url: 'https://firmada.test/ref' }] },
      model,
      idempotencyKey: '11111111-2222-3333-4444-555555555555',
      signal,
    });
    expect(started).toEqual({ status: 'pending', job: { id: 'p-1' } });
    const submit = calls.find((c) => c.url === `${BASE}/prompt`)!;
    expect(submit.headers.authorization).toBe('Bearer secreto');
    const graph = (submit.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    expect(graph['74']!.inputs.text).toBe(request.prompt);
    expect(graph['100']!.inputs.image).toBe('rrss-ref.png');
    // La descarga de la referencia (URL firmada de nuestro Storage) no lleva el token de ComfyUI.
    expect(calls.find((c) => c.url === 'https://firmada.test/ref')!.headers.authorization).toBeUndefined();

    expect(await provider.poll!({ id: 'p-1' }, model, signal)).toEqual({ status: 'pending' });
    finished = true;
    const done = await provider.poll!({ id: 'p-1' }, model, signal);
    expect(done).toMatchObject({ status: 'completed', usage: { images: 1 } });
    if (done.status !== 'completed') throw new Error('debía terminar');
    expect(done.outputs[0]!.bytes).toEqual(png);
    const view = calls.find((c) => c.url.startsWith(`${BASE}/view?`))!;
    expect(new URL(view.url).searchParams.get('subfolder')).toBe('rrss');
    expect(view.headers.authorization).toBe('Bearer secreto');
  });

  it('un flujo rechazado (faltan nodos o modelos) o un error del servidor son fallos claros', async () => {
    const { fetch } = fakeComfy((call) => {
      if (call.url === `${BASE}/prompt`) return json({ error: { message: 'x' }, node_errors: { '70': {} } }, 400);
      if (call.url === `${BASE}/history/p-2`) return json({ 'p-2': { status: { status_str: 'error' }, outputs: {} } });
      return undefined;
    });
    const provider = createComfyUiImageProvider({ baseUrl: BASE, fetch });
    expect(provider.dataRegion).toBe('unknown');
    await expect(provider.start({ request, model, idempotencyKey: 'k', signal })).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringMatching(/faltan nodos o archivos de modelo/),
    });
    expect(await provider.poll!({ id: 'p-2' }, model, signal)).toMatchObject({
      status: 'failed',
      code: 'provider_error',
    });
  });

  it('cancelar quita el trabajo de la cola, y solo interrumpe si es el que está en marcha', async () => {
    let running = false;
    const { calls, fetch } = fakeComfy((call) => {
      if (call.url === `${BASE}/queue` && call.method === 'GET') {
        return json({ queue_running: running ? [[1, 'p-3', {}]] : [[1, 'de-otro', {}]], queue_pending: [] });
      }
      if (call.method === 'POST') return json({});
      return undefined;
    });
    const provider = createComfyUiImageProvider({ baseUrl: BASE, fetch });
    await provider.cancel!({ id: 'p-3' }, signal);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([
      [`${BASE}/queue`, { delete: ['p-3'] }],
    ]);
    calls.length = 0;
    running = true;
    await provider.cancel!({ id: 'p-3' }, signal);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`${BASE}/interrupt`]);
  });

  it('se carga con COMFYUI_BASE_URL; la región la declara COMFYUI_DATA_REGION', () => {
    const fetch = async () => new Response(null);
    const loaded = createMediaProviders(
      { COMFYUI_BASE_URL: 'https://gpu.ejemplo.test', COMFYUI_API_TOKEN: 't', COMFYUI_DATA_REGION: 'eu' },
      { fetch },
    );
    expect(loaded.providers.map((p) => [p.id, p.dataRegion])).toEqual([['comfyui', 'eu']]);
    const invalid = createMediaProviders(
      { COMFYUI_BASE_URL: 'http://gpu.ejemplo.test', COMFYUI_DATA_REGION: 'luna' },
      { fetch },
    );
    expect(invalid.providers).toEqual([]);
    expect(invalid.unavailable.find((u) => u.id === 'comfyui')?.reason).toMatch(/COMFYUI_BASE_URL debe ser https/);
  });
});
