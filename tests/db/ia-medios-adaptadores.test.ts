// Adaptadores de imagen y vídeo, con respuestas HTTP SIMULADAS.
//
// Ninguna de estas pruebas llama a un proveedor: `fetch` es un doble que
// devuelve lo que la documentación oficial de cada API dice que devuelve. Sirven
// para comprobar que cada adaptador construye bien la petición y entiende las
// respuestas (éxito, error, límite de uso, tiempo agotado, webhook), no que el
// servicio real se comporte así: eso queda sin probar.
//
// No usan la base de datos; están en esta carpeta porque es la que se ejecuta
// en Node (el proyecto «unit» corre en jsdom).
import { createHash, createHmac, createVerify, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MediaProviderFailure,
  type ImageRequest,
  type MediaModel,
  type MediaProvider,
  type VideoRequest,
} from '../../supabase/functions/_shared/ai/media/contract.ts';
import { createBflImageProvider } from '../../supabase/functions/_shared/ai/media/bfl-image.ts';
import {
  createMediaProviders,
  MEDIA_ENV,
  mediaSelectionFromEnv,
  mediaWebhookBaseUrl,
} from '../../supabase/functions/_shared/ai/media/config.ts';
import { createFalVideoProvider } from '../../supabase/functions/_shared/ai/media/fal-video.ts';
import { createGoogleTokenSource, parseServiceAccount } from '../../supabase/functions/_shared/ai/media/google-auth.ts';
import { createHiggsfieldVideoProvider } from '../../supabase/functions/_shared/ai/media/higgsfield-video.ts';
import { download, type FetchLike } from '../../supabase/functions/_shared/ai/media/http.ts';
import { createIdeogramImageProvider } from '../../supabase/functions/_shared/ai/media/ideogram-image.ts';
import { megapixels, priceMediaUsage, resolveMediaModel } from '../../supabase/functions/_shared/ai/media/models.ts';
import { simulatedPng } from '../../supabase/functions/_shared/ai/media/simulated.ts';
import { createVertexImageProvider, vertexHost } from '../../supabase/functions/_shared/ai/media/vertex-image.ts';

// ───────────────────────────── Doble de `fetch` ─────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply =
  { status?: number; json?: unknown; headers?: Record<string, string>; bytes?: Uint8Array } | 'hang' | 'network';

/** `fetch` de mentira: responde lo que diga `route` y apunta cada llamada. */
function fakeFetch(route: (call: Call, index: number) => Reply): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url, method: init.method ?? 'GET', headers, body };
    calls.push(call);
    const reply = route(call, calls.length);
    if (reply === 'network') throw new TypeError('fetch failed: https://secreto.test/?clave=123');
    if (reply === 'hang') {
      // No responde nunca; solo termina si se cancela la petición.
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(reply.bytes ?? JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  };
  return { fetch, calls };
}

const model = (extra: Partial<MediaModel>): MediaModel => ({
  provider: 'x',
  model: 'm',
  kind: 'image',
  displayName: 'Modelo',
  billingUnit: 'image',
  priceMicros: 1000,
  priceDetails: {},
  priceVerified: true,
  dataRegion: 'unknown',
  trainsOnInputs: 'unknown',
  delivery: 'sync',
  settings: {},
  priority: 0,
  active: true,
  ...extra,
});

const IMAGE: ImageRequest = {
  kind: 'image',
  prompt: 'Mesa de otoño',
  aspectRatio: '4:5',
  size: { width: 1080, height: 1350 },
};
const VIDEO: VideoRequest = {
  kind: 'video',
  startImage: { mimeType: 'image/jpeg', url: 'https://almacen.test/firmada/foto.jpg?token=abc' },
  prompt: 'Travelling lento',
  durationSeconds: 5,
  aspectRatio: '9:16',
};

const signal = () => new AbortController().signal;
const start = (provider: MediaProvider, request: ImageRequest | VideoRequest, m: MediaModel, webhookUrl?: string) =>
  provider.start({ request, model: m, idempotencyKey: 'gen-1', webhookUrl, signal: signal() });

async function failure(promise: Promise<unknown>): Promise<MediaProviderFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaProviderFailure) return error;
    throw error;
  }
  throw new Error('Se esperaba un fallo del adaptador');
}

const PNG = simulatedPng('respuesta');
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

// ───────────────────────────── Vertex AI (imagen) ─────────────────────────────

describe('Vertex AI · imagen (HTTP simulado)', () => {
  const vertexModel = model({ provider: 'google-vertex', model: 'gemini-nano-banana-2.1' });
  const ok = {
    json: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'Aquí está.' }, { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290, totalTokenCount: 1300 },
      responseId: 'resp-123',
    },
  };
  const create = (route: Parameters<typeof fakeFetch>[0], extra: { location?: string; timeoutMs?: number } = {}) => {
    const http = fakeFetch(route);
    const provider = createVertexImageProvider({
      projectId: 'mi-proyecto',
      getAccessToken: async () => 'token-de-prueba',
      fetch: http.fetch,
      ...extra,
    });
    return { provider, calls: http.calls };
  };

  it('pide la imagen a la multirregión UE y devuelve los bytes', async () => {
    const { provider, calls } = create(() => ok);
    expect(provider.dataRegion).toBe('eu');
    expect(provider.testedAgainstRealService).toBe(false);

    const result = await start(
      provider,
      { ...IMAGE, references: [{ mimeType: 'image/jpeg', bytes: Uint8Array.of(1, 2, 3) }] },
      vertexModel,
    );
    expect(result).toMatchObject({ status: 'completed', usage: { images: 1 }, providerRequestId: 'resp-123' });
    if (result.status !== 'completed') throw new Error('síncrono');
    expect(result.outputs).toEqual([{ mimeType: 'image/png', bytes: PNG }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://aiplatform.eu.rep.googleapis.com/v1/projects/mi-proyecto/locations/eu/publishers/google/models/gemini-nano-banana-2.1:generateContent',
      method: 'POST',
      headers: { authorization: 'Bearer token-de-prueba', 'content-type': 'application/json' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AQID' } }, { text: 'Mesa de otoño' }],
          },
        ],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:5' } },
      },
    });
  });

  it('cada ubicación usa su host, y fuera de la UE lo declara', () => {
    expect(vertexHost('eu')).toBe('https://aiplatform.eu.rep.googleapis.com');
    expect(vertexHost('global')).toBe('https://aiplatform.googleapis.com');
    expect(vertexHost('europe-west4')).toBe('https://europe-west4-aiplatform.googleapis.com');
    expect(create(() => ok, { location: 'europe-southwest1' }).provider.dataRegion).toBe('eu');
    expect(create(() => ok, { location: 'global' }).provider.dataRegion).toBe('global');
    expect(create(() => ok, { location: 'us-central1' }).provider.dataRegion).toBe('us');
  });

  it('el tamaño de imagen solo se envía si el registro lo trae para ese modelo', async () => {
    const { provider, calls } = create(() => ok);
    await start(provider, IMAGE, { ...vertexModel, settings: { image_size: '2K' } });
    expect(calls[0]!.body).toMatchObject({
      generationConfig: { imageConfig: { aspectRatio: '4:5', imageSize: '2K' } },
    });
  });

  it('límite de uso (429): fallo reintentable con la espera indicada', async () => {
    const { provider } = create(() => ({
      status: 429,
      headers: { 'retry-after': '12' },
      json: {
        error: { code: 429, message: 'Quota exceeded for aiplatform.googleapis.com', status: 'RESOURCE_EXHAUSTED' },
      },
    }));
    const error = await failure(start(provider, IMAGE, vertexModel));
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSeconds: 12 });
    expect(error.message).toMatch(/Quota exceeded/);
  });

  it('credenciales rechazadas, error del servidor y petición inválida', async () => {
    expect(await failure(start(create(() => ({ status: 403, json: {} })).provider, IMAGE, vertexModel))).toMatchObject({
      code: 'auth',
      retryable: false,
    });
    expect(await failure(start(create(() => ({ status: 503, json: {} })).provider, IMAGE, vertexModel))).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    expect(await failure(start(create(() => ({ status: 400, json: {} })).provider, IMAGE, vertexModel))).toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
  });

  it('bloqueo por contenido y respuesta sin imagen', async () => {
    const blocked = create(() => ({
      json: { candidates: [{ finishReason: 'FINISH_REASON_IMAGE_PROHIBITED_CONTENT' }] },
    }));
    expect((await failure(start(blocked.provider, IMAGE, vertexModel))).code).toBe('moderated');
    const empty = create(() => ({
      json: { candidates: [{ content: { parts: [{ text: 'No puedo.' }] }, finishReason: 'FINISH_REASON_NO_IMAGE' }] },
    }));
    const error = await failure(start(empty.provider, IMAGE, vertexModel));
    expect(error.code).toBe('bad_response');
    expect(error.message).toMatch(/NO_IMAGE/);
  });

  it('tiempo agotado y fallo de red: reintentables y sin filtrar la dirección', async () => {
    const slow = create(() => 'hang', { timeoutMs: 30 });
    expect(await failure(start(slow.provider, IMAGE, vertexModel))).toMatchObject({ code: 'timeout', retryable: true });
    const down = create(() => 'network');
    const error = await failure(start(down.provider, IMAGE, vertexModel));
    expect(error).toMatchObject({ code: 'network', retryable: true });
    expect(error.message).not.toMatch(/secreto|clave/);
  });
});

describe('Google · token de cuenta de servicio (HTTP simulado)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = parseServiceAccount(
    JSON.stringify({
      type: 'service_account',
      client_email: 'rrss@mi-proyecto.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  )!;

  it('firma el JWT, lo canjea y reutiliza el token hasta que caduca', async () => {
    let clock = 1_800_000_000_000;
    const http = fakeFetch((_call, i) => ({
      json: { access_token: `token-${i}`, expires_in: 3600, token_type: 'Bearer' },
    }));
    const getToken = createGoogleTokenSource(account, { fetch: http.fetch, now: () => clock });

    expect(await getToken()).toBe('token-1');
    expect(await getToken()).toBe('token-1');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    const form = new URLSearchParams(http.calls[0]!.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(claims!)).toEqual({
      iss: 'rrss@mi-proyecto.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    // La firma es válida con la clave pública de la cuenta.
    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);

    clock += 3_590_000; // a punto de caducar: se pide otro
    expect(await getToken()).toBe('token-2');
  });

  it('una clave que no lo es se rechaza sin citarla', async () => {
    expect(parseServiceAccount('{"client_email": "a@b"}')).toBeNull();
    expect(parseServiceAccount('no es json')).toBeNull();
    const bad = parseServiceAccount(
      JSON.stringify({
        client_email: 'a@b',
        private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      }),
    )!;
    const error = await failure(createGoogleTokenSource(bad, { fetch: fakeFetch(() => ({})).fetch })());
    expect(error.code).toBe('auth');
    expect(error.message).not.toMatch(/AAAA/);
  });
});

// ───────────────────────────── Black Forest Labs (imagen) ─────────────────────────────

describe('Black Forest Labs · FLUX.2 (HTTP simulado)', () => {
  const fluxModel = model({
    provider: 'bfl',
    model: 'flux-2-pro',
    billingUnit: 'megapixel',
    priceMicros: 15_000,
    priceDetails: { first_unit_micros: 30_000, input_megapixel_micros: 15_000 },
    delivery: 'async',
  });
  const POLLING = 'https://api.eu.bfl.ai/v1/get_result?id=tarea-1';
  const create = (route: Parameters<typeof fakeFetch>[0], baseUrl?: string) => {
    const http = fakeFetch(route);
    return { provider: createBflImageProvider({ apiKey: 'clave-bfl', fetch: http.fetch, baseUrl }), calls: http.calls };
  };

  it('lanza en el host de la UE, con las referencias como URL, y devuelve el trabajo', async () => {
    const { provider, calls } = create(() => ({
      json: { id: 'tarea-1', polling_url: POLLING, cost: 4.5, input_mp: 1, output_mp: 1.46 },
    }));
    expect(provider.dataRegion).toBe('eu');
    const request: ImageRequest = {
      ...IMAGE,
      references: [
        { mimeType: 'image/jpeg', url: 'https://almacen.test/a.jpg' },
        { mimeType: 'image/png', url: 'https://almacen.test/logo.png' },
      ],
    };
    expect(await start(provider, request, fluxModel)).toEqual({
      status: 'pending',
      job: { id: 'tarea-1', statusUrl: POLLING },
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.eu.bfl.ai/v1/flux-2-pro',
      method: 'POST',
      headers: { 'x-key': 'clave-bfl' },
      body: {
        prompt: 'Mesa de otoño',
        width: 1080,
        height: 1350,
        output_format: 'jpeg',
        input_image: 'https://almacen.test/a.jpg',
        input_image_2: 'https://almacen.test/logo.png',
      },
    });
  });

  it('estima megapíxeles de salida y de referencia por arriba', () => {
    const { provider } = create(() => ({}));
    expect(provider.estimateUsage(IMAGE, fluxModel)).toEqual({ megapixels: 2 });
    const withRefs: ImageRequest = {
      ...IMAGE,
      references: [
        { mimeType: 'image/jpeg', url: 'https://a.test/1.jpg', width: 1200, height: 1500 }, // 1,8 MP → 2
        { mimeType: 'image/jpeg', url: 'https://a.test/2.jpg' }, // tamaño desconocido → el máximo, 4
      ],
    };
    const usage = provider.estimateUsage(withRefs, fluxModel);
    expect(usage).toEqual({ megapixels: 2, input_megapixels: 6 });
    // 30 000 (primer MP) + 15 000 (segundo) + 6 × 15 000 de referencias.
    expect(priceMediaUsage(fluxModel, usage)).toEqual({ micros: 135_000, unpriced: [] });
  });

  it('sondea con la dirección devuelta: en curso, listo, moderado y error', async () => {
    const job = { id: 'tarea-1', statusUrl: POLLING };
    const poll = (json: unknown) => {
      const { provider, calls } = create(() => ({ json }));
      return provider.poll!(job, fluxModel, signal()).then((outcome) => ({ outcome, call: calls[0]! }));
    };
    const pending = await poll({ id: 'tarea-1', status: 'Pending' });
    expect(pending.outcome).toEqual({ status: 'pending' });
    expect(pending.call).toMatchObject({ url: POLLING, method: 'GET', headers: { 'x-key': 'clave-bfl' } });
    expect((await poll({ status: 'Generating', progress: 0.4 })).outcome).toEqual({ status: 'pending' });

    expect(
      (await poll({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/firmada.jpg' } })).outcome,
    ).toEqual({
      status: 'completed',
      outputs: [{ url: 'https://delivery.bfl.ai/firmada.jpg', mimeType: '' }],
    });
    expect((await poll({ status: 'Content Moderated' })).outcome).toMatchObject({
      status: 'failed',
      code: 'moderated',
    });
    expect((await poll({ status: 'Error' })).outcome).toMatchObject({ status: 'failed', code: 'provider_error' });
    expect((await poll({ status: 'Task not found' })).outcome).toMatchObject({
      status: 'failed',
      code: 'provider_error',
    });
  });

  it('no envía la clave a una dirección de consulta que no sea de BFL', async () => {
    const { provider, calls } = create(() => ({
      json: { id: 'tarea-1', polling_url: 'https://otro.test/get_result?id=1' },
    }));
    expect((await failure(start(provider, IMAGE, fluxModel))).code).toBe('bad_response');
    const outcome = await provider.poll!({ id: 'x', statusUrl: 'https://otro.test/robar' }, fluxModel, signal());
    expect(outcome).toMatchObject({ status: 'failed', code: 'bad_response' });
    expect(calls).toHaveLength(1); // solo el envío; ningún sondeo
  });

  it('sin saldo (402), límite de uso (429) y validación (422)', async () => {
    expect((await failure(start(create(() => ({ status: 402, json: {} })).provider, IMAGE, fluxModel))).code).toBe(
      'insufficient_credits',
    );
    expect(await failure(start(create(() => ({ status: 429, json: {} })).provider, IMAGE, fluxModel))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    const invalid = create(() => ({
      status: 422,
      json: { detail: [{ loc: ['body', 'width'], msg: 'too small', type: 'value_error' }] },
    }));
    expect((await failure(start(invalid.provider, IMAGE, fluxModel))).code).toBe('invalid_request');
    // Un límite de uso al sondear se lanza: quien sondea decide reintentar.
    const limited = create(() => ({ status: 429, json: {} }));
    expect((await failure(limited.provider.poll!({ id: 't', statusUrl: POLLING }, fluxModel, signal()))).code).toBe(
      'rate_limited',
    );
  });

  it('solo admite los hosts documentados y referencias por URL', async () => {
    expect(() => create(() => ({}), 'https://api.bfl.example')).toThrow(/no es uno de los documentados/);
    expect(create(() => ({}), 'https://api.bfl.ai').provider.dataRegion).toBe('global');
    const { provider, calls } = create(() => ({}));
    const error = await failure(
      start(provider, { ...IMAGE, references: [{ mimeType: 'image/png', bytes: PNG }] }, fluxModel),
    );
    expect(error.code).toBe('invalid_request');
    expect(calls).toEqual([]);
  });
});

// ───────────────────────────── Ideogram (imagen) ─────────────────────────────

describe('Ideogram 3.0 (HTTP simulado)', () => {
  const ideogramModel = model({ provider: 'ideogram', model: 'ideogram-v3', settings: { rendering_speed: 'TURBO' } });
  const create = (route: Parameters<typeof fakeFetch>[0]) => {
    const http = fakeFetch(route);
    return {
      provider: createIdeogramImageProvider({ apiKey: 'clave-ideogram', fetch: http.fetch }),
      calls: http.calls,
    };
  };

  it('envía un formulario y devuelve el enlace de la imagen', async () => {
    const { provider, calls } = create(() => ({
      json: {
        created: '2026-11-17T10:00:00Z',
        data: [
          {
            url: 'https://ideogram.ai/api/images/ephemeral/x.png',
            is_image_safe: true,
            seed: 1,
            resolution: '896x1120',
            prompt: 'Mesa de otoño',
          },
        ],
      },
    }));
    const result = await start(
      provider,
      { ...IMAGE, references: [{ mimeType: 'image/png', bytes: PNG }] },
      ideogramModel,
    );
    expect(result).toEqual({
      status: 'completed',
      outputs: [{ url: 'https://ideogram.ai/api/images/ephemeral/x.png', mimeType: '' }],
      usage: { images: 1 },
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.ideogram.ai/v1/ideogram-v3/generate',
      method: 'POST',
      headers: { 'api-key': 'clave-ideogram' },
    });
    const form = calls[0]!.body as FormData;
    expect(form.get('prompt')).toBe('Mesa de otoño');
    expect(form.get('aspect_ratio')).toBe('4x5');
    expect(form.get('rendering_speed')).toBe('TURBO');
    expect(form.get('num_images')).toBe('1');
    expect((form.get('style_reference_images') as Blob).size).toBe(PNG.byteLength);
  });

  it('texto rechazado (422), imagen retenida y límite de uso (429)', async () => {
    expect(
      (
        await failure(
          start(
            create(() => ({ status: 422, json: { error: 'Prompt failed safety check' } })).provider,
            IMAGE,
            ideogramModel,
          ),
        )
      ).code,
    ).toBe('moderated');
    const unsafe = create(() => ({ json: { data: [{ url: null, is_image_safe: false }] } }));
    expect((await failure(start(unsafe.provider, IMAGE, ideogramModel))).code).toBe('moderated');
    expect(
      await failure(start(create(() => ({ status: 429, json: {} })).provider, IMAGE, ideogramModel)),
    ).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect((await failure(start(create(() => ({ status: 401, json: {} })).provider, IMAGE, ideogramModel))).code).toBe(
      'auth',
    );
  });
});

// ───────────────────────────── Higgsfield (vídeo) ─────────────────────────────

describe('Higgsfield · vídeo (HTTP simulado)', () => {
  const klingModel = model({
    provider: 'higgsfield',
    model: 'kling-video/v3.0/std/image-to-video',
    kind: 'video',
    billingUnit: 'second',
    delivery: 'async',
    settings: { fields: { image: 'image_url', prompt: 'prompt', duration: 'duration' }, static: { sound: 'off' } },
  });
  const STATUS = 'https://api.higgsfield.ai/requests/req-1/status';
  const CANCEL = 'https://api.higgsfield.ai/requests/req-1/cancel';
  const SECRET_BYTES = Buffer.from('secreto-de-webhooks-de-prueba');
  const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
  const NOW = 1_800_000_000_000;
  const create = (
    route: Parameters<typeof fakeFetch>[0],
    extra: { webhookSecret?: string; timeoutMs?: number } = {},
  ) => {
    const http = fakeFetch(route);
    const provider = createHiggsfieldVideoProvider({
      keyId: 'id-clave',
      keySecret: 'secreto-clave',
      fetch: http.fetch,
      now: () => NOW,
      ...extra,
    });
    return { provider, calls: http.calls };
  };
  const queued = { json: { status: 'queued', request_id: 'req-1', status_url: STATUS, cancel_url: CANCEL } };

  it('lanza el vídeo con la clave, la idempotencia y el webhook; devuelve el trabajo', async () => {
    const { provider, calls } = create(() => queued, { webhookSecret: SECRET });
    const webhook = 'https://funciones.test/ai-media-webhook?provider=higgsfield&generation=gen-1';
    expect(await start(provider, VIDEO, klingModel, webhook)).toEqual({
      status: 'pending',
      job: { id: 'req-1', statusUrl: STATUS, cancelUrl: CANCEL },
    });
    expect(provider.estimateUsage(VIDEO, klingModel)).toEqual({ seconds: 5 });
    expect(calls[0]).toMatchObject({
      url: `https://api.higgsfield.ai/kling-video/v3.0/std/image-to-video?hf_webhook=${encodeURIComponent(webhook)}`,
      method: 'POST',
      headers: {
        authorization: 'Key id-clave:secreto-clave',
        'content-type': 'application/json',
        'idempotency-key': 'gen-1',
      },
      // Este modelo no tiene campo de proporción: no se envía.
      body: { image_url: VIDEO.startImage.url, prompt: 'Travelling lento', duration: 5, sound: 'off' },
    });
  });

  it('sin secreto de webhooks no pide webhook (no podría comprobar la firma)', async () => {
    const { provider, calls } = create(() => queued);
    expect(provider.parseWebhook).toBeUndefined();
    await start(provider, VIDEO, klingModel, 'https://funciones.test/ai-media-webhook');
    expect(calls[0]!.url).toBe('https://api.higgsfield.ai/kling-video/v3.0/std/image-to-video');
  });

  it('los campos de la petición salen de los ajustes del modelo', async () => {
    const { provider, calls } = create(() => queued);
    const other = {
      ...klingModel,
      model: 'otro/modelo',
      settings: { fields: { image: 'start_image', duration: 'seconds', aspect_ratio: 'aspect_ratio' } },
    };
    await start(provider, VIDEO, other);
    expect(calls[0]!.body).toEqual({ start_image: VIDEO.startImage.url, seconds: 5, aspect_ratio: '9:16' });
  });

  it('sondea el estado: en cola, en curso, terminado, fallido, moderado y cancelado', async () => {
    const job = { id: 'req-1', statusUrl: STATUS, cancelUrl: CANCEL };
    const poll = async (json: unknown) => {
      const { provider, calls } = create(() => ({ json }));
      return { outcome: await provider.poll!(job, klingModel, signal()), call: calls[0]! };
    };
    const first = await poll({ status: 'queued', request_id: 'req-1' });
    expect(first.outcome).toEqual({ status: 'pending' });
    expect(first.call).toMatchObject({
      url: STATUS,
      method: 'GET',
      headers: { authorization: 'Key id-clave:secreto-clave' },
    });
    expect((await poll({ status: 'in_progress' })).outcome).toEqual({ status: 'pending' });
    expect(
      (await poll({ status: 'completed', request_id: 'req-1', video: { url: 'https://cdn.higgsfield.ai/out.mp4' } }))
        .outcome,
    ).toEqual({
      status: 'completed',
      outputs: [{ url: 'https://cdn.higgsfield.ai/out.mp4', mimeType: '' }],
    });
    expect((await poll({ status: 'failed', error: 'Generation failed' })).outcome).toEqual({
      status: 'failed',
      code: 'provider_error',
      message: 'Higgsfield no ha podido generar el vídeo: Generation failed',
    });
    expect((await poll({ status: 'nsfw' })).outcome).toMatchObject({ status: 'failed', code: 'moderated' });
    expect((await poll({ status: 'canceled' })).outcome).toMatchObject({ status: 'failed', code: 'canceled' });
    expect((await poll({ status: 'completed' })).outcome).toMatchObject({ status: 'failed', code: 'bad_response' });
  });

  it('no envía la clave a una dirección de estado que no sea de Higgsfield', async () => {
    const { provider, calls } = create(() => ({ json: { status: 'queued' } }));
    await provider.poll!({ id: 'req-1', statusUrl: 'https://otro.test/requests/req-1/status' }, klingModel, signal());
    expect(calls[0]!.url).toBe(STATUS);
  });

  it('cola llena (429 con Retry-After), sin saldo (403), modelo bloqueado (423) y caída (503)', async () => {
    const full = create(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      json: {
        detail: {
          code: 'account_queue_full',
          message: 'Queue is full',
          retryable: true,
          limit: 40,
          retry_after_seconds: 30,
        },
      },
    }));
    expect(await failure(start(full.provider, VIDEO, klingModel))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 30,
    });
    expect(
      await failure(
        start(create(() => ({ status: 403, json: { detail: 'Insufficient balance' } })).provider, VIDEO, klingModel),
      ),
    ).toMatchObject({
      code: 'insufficient_credits',
      retryable: false,
    });
    expect(await failure(start(create(() => ({ status: 423, json: {} })).provider, VIDEO, klingModel))).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    expect(await failure(start(create(() => ({ status: 503, json: {} })).provider, VIDEO, klingModel))).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    expect(
      (
        await failure(
          start(create(() => ({ status: 401, json: { detail: 'Invalid credentials' } })).provider, VIDEO, klingModel),
        )
      ).code,
    ).toBe('auth');
  });

  it('tiempo agotado al lanzar y al sondear', async () => {
    const slow = create(() => 'hang', { timeoutMs: 30 });
    expect(await failure(start(slow.provider, VIDEO, klingModel))).toMatchObject({ code: 'timeout', retryable: true });
    expect((await failure(slow.provider.poll!({ id: 'req-1', statusUrl: STATUS }, klingModel, signal()))).code).toBe(
      'timeout',
    );
  });

  it('cancela sin lanzar aunque el proveedor diga que ya no se puede', async () => {
    const { provider, calls } = create(() => ({ status: 400, json: { detail: 'Already started' } }));
    await expect(provider.cancel!({ id: 'req-1', cancelUrl: CANCEL }, signal())).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: CANCEL, method: 'POST' });
  });

  it('necesita la imagen inicial como URL', async () => {
    const { provider, calls } = create(() => queued);
    const noUrl: VideoRequest = { ...VIDEO, startImage: { mimeType: 'image/png', bytes: PNG } };
    expect((await failure(start(provider, noUrl, klingModel))).code).toBe('invalid_request');
    expect(calls).toEqual([]);
  });

  describe('webhook (Standard Webhooks)', () => {
    const body = JSON.stringify({
      request_id: 'req-1',
      status: 'completed',
      error: null,
      expires_at: '2026-11-24T10:00:00Z',
      payload: { video: { url: 'https://cdn.higgsfield.ai/out.mp4', content_type: 'video/mp4' } },
    });
    const timestamp = String(NOW / 1000);
    const signFor = (raw: string, id = 'msg_1', ts = timestamp, key = SECRET_BYTES) =>
      `v1,${createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64')}`;
    const headers = (signature: string, ts = timestamp) => ({
      'webhook-id': 'msg_1',
      'webhook-timestamp': ts,
      'webhook-signature': signature,
    });
    const { provider } = create(() => ({}), { webhookSecret: SECRET });

    it('con firma válida entrega el resultado; repetido da lo mismo', async () => {
      const webhook = { headers: headers(signFor(body)), rawBody: body };
      const event = await provider.parseWebhook!(webhook);
      expect(event).toEqual({
        providerJobId: 'req-1',
        outcome: {
          status: 'completed',
          outputs: [{ url: 'https://cdn.higgsfield.ai/out.mp4', mimeType: 'video/mp4' }],
        },
      });
      expect(await provider.parseWebhook!(webhook)).toEqual(event);
      // Durante una rotación llegan dos firmas: basta con que valga una.
      const rotated = {
        headers: headers(`v1,${Buffer.from('otra').toString('base64')} ${signFor(body)}`),
        rawBody: body,
      };
      expect((await provider.parseWebhook!(rotated)).providerJobId).toBe('req-1');
    });

    it('avisos de fallo y de contenido rechazado', async () => {
      const failed = JSON.stringify({
        request_id: 'req-1',
        status: 'failed',
        error: 'Generation failed',
        payload: null,
      });
      expect(
        (await provider.parseWebhook!({ headers: headers(signFor(failed)), rawBody: failed })).outcome,
      ).toMatchObject({
        status: 'failed',
        code: 'provider_error',
      });
      const nsfw = JSON.stringify({ request_id: 'req-1', status: 'nsfw', error: null, payload: null });
      expect((await provider.parseWebhook!({ headers: headers(signFor(nsfw)), rawBody: nsfw })).outcome).toMatchObject({
        status: 'failed',
        code: 'moderated',
      });
    });

    it('rechaza firma incorrecta, cuerpo alterado, marca de tiempo vieja y cabeceras ausentes', async () => {
      const bad = (webhook: { headers: Record<string, string>; rawBody: string }) =>
        failure(provider.parseWebhook!(webhook));
      expect(
        (await bad({ headers: headers(signFor(body, 'msg_1', timestamp, Buffer.from('otro-secreto'))), rawBody: body }))
          .code,
      ).toBe('invalid_webhook');
      expect((await bad({ headers: headers(signFor(body)), rawBody: body.replace('out.mp4', 'malo.mp4') })).code).toBe(
        'invalid_webhook',
      );
      const old = String(NOW / 1000 - 301);
      expect((await bad({ headers: headers(signFor(body, 'msg_1', old), old), rawBody: body })).code).toBe(
        'invalid_webhook',
      );
      expect((await bad({ headers: {}, rawBody: body })).code).toBe('invalid_webhook');
      expect((await bad({ headers: headers('v1,no-es-base64-%%%'), rawBody: body })).code).toBe('invalid_webhook');
    });
  });
});

// ───────────────────────────── fal.ai (vídeo) ─────────────────────────────

describe('fal.ai · vídeo (HTTP simulado)', () => {
  const falModel = model({
    provider: 'fal',
    model: 'fal-ai/modelo-de-prueba/image-to-video',
    kind: 'video',
    billingUnit: 'second',
    delivery: 'async',
  });
  const BASE = 'https://queue.fal.run/fal-ai/modelo-de-prueba/requests/req-9';
  const job = { id: 'req-9', statusUrl: `${BASE}/status`, resultUrl: BASE, cancelUrl: `${BASE}/cancel` };
  const NOW = 1_800_000_000_000;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x }] };
  const create = (route: Parameters<typeof fakeFetch>[0], timeoutMs?: number) => {
    const http = fakeFetch(route);
    return {
      provider: createFalVideoProvider({ apiKey: 'clave-fal', fetch: http.fetch, now: () => NOW, timeoutMs }),
      calls: http.calls,
    };
  };

  it('envía a la cola con el webhook y guarda las direcciones devueltas', async () => {
    const { provider, calls } = create(() => ({
      json: {
        request_id: 'req-9',
        status_url: job.statusUrl,
        response_url: job.resultUrl,
        cancel_url: job.cancelUrl,
        queue_position: 0,
      },
    }));
    const webhook = 'https://funciones.test/ai-media-webhook?provider=fal&generation=gen-1';
    expect(await start(provider, VIDEO, falModel, webhook)).toEqual({ status: 'pending', job });
    expect(calls[0]).toMatchObject({
      url: `https://queue.fal.run/fal-ai/modelo-de-prueba/image-to-video?fal_webhook=${encodeURIComponent(webhook)}`,
      method: 'POST',
      headers: { authorization: 'Key clave-fal', 'content-type': 'application/json' },
      body: { image_url: VIDEO.startImage.url, prompt: 'Travelling lento', duration: 5, aspect_ratio: '9:16' },
    });
  });

  it('los nombres de los campos y el formato de la duración salen de los ajustes del modelo', async () => {
    const { provider, calls } = create(() => ({
      json: { request_id: 'req-9', status_url: job.statusUrl, response_url: job.resultUrl },
    }));
    const custom = {
      ...falModel,
      settings: {
        fields: { image: 'start_image_url', prompt: 'prompt', duration: 'duration' },
        duration_as_string: true,
        static: { resolution: '720p' },
      },
    };
    await start(provider, VIDEO, custom);
    expect(calls[0]!.body).toEqual({
      resolution: '720p',
      start_image_url: VIDEO.startImage.url,
      prompt: 'Travelling lento',
      duration: '5',
    });
  });

  it('sondea: en cola, en curso, terminado (pide el resultado) y terminado con error', async () => {
    const queue = create(() => ({ json: { status: 'IN_QUEUE', queue_position: 3 } }));
    expect(await queue.provider.poll!(job, falModel, signal())).toEqual({ status: 'pending' });
    expect(queue.calls[0]).toMatchObject({
      url: job.statusUrl,
      method: 'GET',
      headers: { authorization: 'Key clave-fal' },
    });
    expect(await create(() => ({ json: { status: 'IN_PROGRESS' } })).provider.poll!(job, falModel, signal())).toEqual({
      status: 'pending',
    });

    const done = create((call) =>
      call.url.endsWith('/status')
        ? { json: { status: 'COMPLETED', metrics: { inference_time: 41.2 } } }
        : { json: { video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' } } },
    );
    expect(await done.provider.poll!(job, falModel, signal())).toEqual({
      status: 'completed',
      outputs: [{ url: 'https://v3.fal.media/files/out.mp4', mimeType: 'video/mp4' }],
    });
    expect(done.calls.map((c) => c.url)).toEqual([job.statusUrl, job.resultUrl]);

    const error = create(() => ({
      json: { status: 'COMPLETED', error: 'Invalid status code: 422', error_type: 'validation_error' },
    }));
    expect(await error.provider.poll!(job, falModel, signal())).toMatchObject({
      status: 'failed',
      code: 'provider_error',
    });
    expect(error.calls).toHaveLength(1);

    // Un modelo que entrega el resultado en otro sitio lo dice en sus ajustes.
    const elsewhere = create((call) =>
      call.url.endsWith('/status')
        ? { json: { status: 'COMPLETED' } }
        : { json: { output: { file: 'https://v3.fal.media/files/x.mp4' } } },
    );
    expect(
      await elsewhere.provider.poll!(job, { ...falModel, settings: { output_path: 'output.file' } }, signal()),
    ).toMatchObject({
      status: 'completed',
      outputs: [{ url: 'https://v3.fal.media/files/x.mp4' }],
    });
  });

  it('límite de uso, credenciales, tiempo agotado y direcciones que no son de fal', async () => {
    expect(await failure(start(create(() => ({ status: 429, json: {} })).provider, VIDEO, falModel))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect((await failure(start(create(() => ({ status: 401, json: {} })).provider, VIDEO, falModel))).code).toBe(
      'auth',
    );
    expect((await failure(start(create(() => 'hang', 30).provider, VIDEO, falModel))).code).toBe('timeout');
    expect(
      (await failure(create(() => ({ status: 429, json: {} })).provider.poll!(job, falModel, signal()))).code,
    ).toBe('rate_limited');

    const foreign = create(() => ({
      json: { request_id: 'r', status_url: 'https://otro.test/s', response_url: 'https://otro.test/r' },
    }));
    expect((await failure(start(foreign.provider, VIDEO, falModel))).code).toBe('bad_response');
    const { provider, calls } = create(() => ({}));
    expect(
      await provider.poll!(
        { id: 'r', statusUrl: 'https://otro.test/s', resultUrl: 'https://otro.test/r' },
        falModel,
        signal(),
      ),
    ).toMatchObject({ status: 'failed' });
    await provider.cancel!({ id: 'r', cancelUrl: 'https://otro.test/c' }, signal());
    expect(calls).toEqual([]);
  });

  it('cancela con PUT', async () => {
    const { provider, calls } = create(() => ({ json: { status: 'CANCELLATION_REQUESTED' }, status: 202 }));
    await provider.cancel!(job, signal());
    expect(calls[0]).toMatchObject({ url: job.cancelUrl, method: 'PUT' });
  });

  describe('webhook (firma ED25519)', () => {
    const body = JSON.stringify({
      request_id: 'req-9',
      gateway_request_id: 'req-9',
      status: 'OK',
      payload: { video: { url: 'https://v3.fal.media/files/out.mp4', content_type: 'video/mp4' } },
    });
    const timestamp = String(NOW / 1000);
    const signed = (raw: string, ts = timestamp, key = privateKey) => {
      const hash = createHash('sha256').update(raw).digest('hex');
      const message = Buffer.from(['req-9', 'usuario-1', ts, hash].join('\n'));
      return {
        headers: {
          'x-fal-webhook-request-id': 'req-9',
          'x-fal-webhook-user-id': 'usuario-1',
          'x-fal-webhook-timestamp': ts,
          'x-fal-webhook-signature': nodeSign(null, message, key).toString('hex'),
        },
        rawBody: raw,
      };
    };

    it('comprueba la firma con las claves públicas publicadas (y las guarda)', async () => {
      const { provider, calls } = create(() => ({ json: jwks }));
      const event = await provider.parseWebhook!(signed(body));
      expect(event).toEqual({
        providerJobId: 'req-9',
        outcome: {
          status: 'completed',
          outputs: [{ url: 'https://v3.fal.media/files/out.mp4', mimeType: 'video/mp4' }],
        },
      });
      // Repetido: mismo resultado, sin volver a pedir las claves.
      expect(await provider.parseWebhook!(signed(body))).toEqual(event);
      expect(calls.map((c) => c.url)).toEqual(['https://rest.fal.ai/.well-known/jwks.json']);
    });

    it('aviso de error, y aviso sin resultado legible (lo recogerá el sondeo)', async () => {
      const { provider } = create(() => ({ json: jwks }));
      const failed = JSON.stringify({
        request_id: 'req-9',
        status: 'ERROR',
        error: 'Invalid status code: 422',
        payload: { detail: [] },
      });
      expect((await provider.parseWebhook!(signed(failed))).outcome).toMatchObject({
        status: 'failed',
        code: 'provider_error',
      });
      const noPayload = JSON.stringify({
        request_id: 'req-9',
        status: 'OK',
        payload: null,
        payload_error: 'Response payload is not JSON serializable',
      });
      expect((await provider.parseWebhook!(signed(noPayload))).outcome).toEqual({ status: 'pending' });
      const otherShape = JSON.stringify({
        request_id: 'req-9',
        status: 'OK',
        payload: { output: { file: 'https://x.test/a.mp4' } },
      });
      expect((await provider.parseWebhook!(signed(otherShape))).outcome).toEqual({ status: 'pending' });
    });

    it('rechaza firma de otra clave, cuerpo alterado, marca de tiempo vieja y cabeceras ausentes', async () => {
      const { provider } = create(() => ({ json: jwks }));
      const bad = (webhook: { headers: Record<string, string>; rawBody: string }) =>
        failure(provider.parseWebhook!(webhook));
      const other = generateKeyPairSync('ed25519').privateKey;
      expect((await bad(signed(body, timestamp, other))).code).toBe('invalid_webhook');
      expect((await bad({ ...signed(body), rawBody: body.replace('out.mp4', 'malo.mp4') })).code).toBe(
        'invalid_webhook',
      );
      expect((await bad(signed(body, String(NOW / 1000 + 301)))).code).toBe('invalid_webhook');
      expect((await bad({ headers: {}, rawBody: body })).code).toBe('invalid_webhook');
      expect(
        (await bad({ ...signed(body), headers: { ...signed(body).headers, 'x-fal-webhook-signature': 'zz' } })).code,
      ).toBe('invalid_webhook');
    });
  });
});

// ───────────────────────────── Configuración ─────────────────────────────

describe('configuración del servidor', () => {
  const fetch = fakeFetch(() => ({})).fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = JSON.stringify({
    client_email: 'rrss@p.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });

  it('sin ninguna clave no hay ningún adaptador, y cada uno dice qué variable le falta', () => {
    const { providers, unavailable } = createMediaProviders({}, { fetch });
    expect(providers).toEqual([]);
    expect(Object.fromEntries(unavailable.map((u) => [u.id, u.reason]))).toEqual({
      'google-vertex': 'faltan las variables GOOGLE_VERTEX_PROJECT_ID y GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON',
      bfl: 'falta la variable BFL_API_KEY',
      ideogram: 'falta la variable IDEOGRAM_API_KEY',
      openai: 'falta la variable OPENAI_API_KEY',
      higgsfield: 'faltan las variables HIGGSFIELD_API_KEY_ID y HIGGSFIELD_API_KEY_SECRET',
      fal: 'falta la variable FAL_KEY',
      comfyui: 'falta la variable COMFYUI_BASE_URL',
      'simulated-image': 'solo se carga con AI_MEDIA_SIMULATED=true y un Supabase local (pruebas)',
      'simulated-video': 'solo se carga con AI_MEDIA_SIMULATED=true y un Supabase local (pruebas)',
    });
  });

  it('carga solo los adaptadores configurados; Vertex y BFL, en la UE por defecto', () => {
    const { providers, unavailable } = createMediaProviders(
      {
        GOOGLE_VERTEX_PROJECT_ID: 'mi-proyecto',
        GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON: serviceAccount,
        BFL_API_KEY: 'k',
        HIGGSFIELD_API_KEY_ID: 'id',
        HIGGSFIELD_API_KEY_SECRET: '   ', // en blanco = sin configurar
        FAL_KEY: 'k',
      },
      { fetch },
    );
    expect(providers.map((p) => [p.id, p.dataRegion ?? null])).toEqual([
      ['google-vertex', 'eu'],
      ['bfl', 'eu'],
      ['fal', null],
    ]);
    expect(providers.every((p) => p.testedAgainstRealService === false)).toBe(true);
    expect(unavailable.find((u) => u.id === 'higgsfield')?.reason).toBe('falta la variable HIGGSFIELD_API_KEY_SECRET');
  });

  it('una configuración inválida deja el adaptador fuera y lo explica', () => {
    const { providers, unavailable } = createMediaProviders(
      {
        GOOGLE_VERTEX_PROJECT_ID: 'p',
        GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON: '{"no": "es"}',
        BFL_API_KEY: 'k',
        BFL_API_BASE_URL: 'https://api.bfl.example',
      },
      { fetch },
    );
    expect(providers).toEqual([]);
    const reasons = Object.fromEntries(unavailable.map((u) => [u.id, u.reason]));
    expect(reasons['google-vertex']).toMatch(
      /GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON no es el JSON de una cuenta de servicio/,
    );
    expect(reasons.bfl).toMatch(/BFL_API_BASE_URL debe ser/);
  });

  it('los simulados solo se cargan si se piden a propósito y contra un Supabase local', () => {
    const local = { AI_MEDIA_SIMULATED: 'true', SUPABASE_URL: 'http://127.0.0.1:55321' };
    expect(createMediaProviders(local, { fetch }).providers.map((p) => p.id)).toEqual([
      'simulated-image',
      'simulated-video',
    ]);
    for (const url of [undefined, 'https://abcdefgh.supabase.co', 'http://ejemplo.test', 'https://127.0.0.1:55321']) {
      const result = createMediaProviders({ AI_MEDIA_SIMULATED: 'true', SUPABASE_URL: url }, { fetch });
      expect(result.providers).toEqual([]);
      expect(result.unavailable.find((u) => u.id === 'simulated-image')?.reason).toMatch(/solo se admite con un Supabase local/);
    }
  });

  it('lee qué modelo se fija, si se admite salir de la UE y la dirección de los webhooks', () => {
    expect(mediaSelectionFromEnv({})).toEqual({ preferred: { image: undefined, video: undefined }, allowNonEu: false });
    expect(
      mediaSelectionFromEnv({
        AI_MEDIA_VIDEO_MODEL: 'higgsfield:kling-video/v3.0/std/image-to-video',
        AI_MEDIA_ALLOW_NON_EU: 'true',
      }),
    ).toEqual({
      preferred: { image: undefined, video: 'higgsfield:kling-video/v3.0/std/image-to-video' },
      allowNonEu: true,
    });
    expect(mediaWebhookBaseUrl({ AI_MEDIA_WEBHOOK_BASE_URL: 'https://x.functions.supabase.co/ai-media-webhook' })).toBe(
      'https://x.functions.supabase.co/ai-media-webhook',
    );
    expect(mediaWebhookBaseUrl({ AI_MEDIA_WEBHOOK_BASE_URL: 'http://inseguro.test' })).toBeUndefined();
    expect(Object.values(MEDIA_ENV).every((name) => /^[A-Z][A-Z0-9_]+$/.test(name))).toBe(true);
  });

  it('un modelo fijado cuyo proveedor no tiene clave dice qué falta; la región efectiva es la del adaptador', () => {
    const availability = createMediaProviders({ BFL_API_KEY: 'k', BFL_API_BASE_URL: 'https://api.bfl.ai' }, { fetch });
    const models = [
      model({ provider: 'higgsfield', model: 'kling', kind: 'video', billingUnit: 'second' }),
      model({ provider: 'bfl', model: 'flux-2-pro', dataRegion: 'eu' }),
    ];
    expect(() =>
      resolveMediaModel('video', models, availability, { preferred: { video: 'higgsfield:kling' } }),
    ).toThrow(/faltan las variables HIGGSFIELD_API_KEY_ID y HIGGSFIELD_API_KEY_SECRET/);
    // El registro dice UE, pero el adaptador apunta al host global: no cuenta como UE.
    expect(() => resolveMediaModel('image', models, availability)).toThrow(/ninguno procesa los datos en la UE/);
    expect(resolveMediaModel('image', models, availability, { allowNonEu: true }).model.model).toBe('flux-2-pro');
  });
});

// ───────────────────────────── Piezas comunes ─────────────────────────────

describe('precio y descarga', () => {
  it('megapíxeles hacia arriba; precio por unidad, primera unidad y referencias', () => {
    expect(megapixels(1024, 1024)).toBe(2); // 1,05 MP
    expect(megapixels(1000, 1000)).toBe(1);
    expect(megapixels(0, 100)).toBeNaN();

    const perSecond = model({ kind: 'video', billingUnit: 'second', priceMicros: 112_000 });
    expect(priceMediaUsage(perSecond, { seconds: 5 })).toEqual({ micros: 560_000, unpriced: [] });
    expect(priceMediaUsage(perSecond, { seconds: 0 })).toEqual({ micros: 0, unpriced: [] });
    // Falta la unidad de cobro, o es imposible: sin precio no se cobra a ojo.
    expect(priceMediaUsage(perSecond, { images: 1 }).unpriced).toEqual(['seconds']);
    expect(priceMediaUsage(perSecond, { seconds: Number.NaN }).unpriced).toEqual(['seconds']);
    expect(priceMediaUsage(model({ priceMicros: 33_600 }), { images: 1 })).toEqual({ micros: 33_600, unpriced: [] });
    expect(priceMediaUsage(model({ priceMicros: 0.5 }), { images: 3 })).toEqual({ micros: 2, unpriced: [] }); // 1,5 → 2
  });

  it('la descarga exige https, respeta el tamaño máximo y no filtra la dirección', async () => {
    const options = { provider: 'Prueba', timeoutMs: 1000, maxBytes: 10 };
    const ok = fakeFetch(() => ({ bytes: Uint8Array.of(1, 2, 3), headers: { 'content-type': 'video/mp4' } }));
    expect(await download('https://cdn.test/a.mp4?firma=abc', { ...options, fetch: ok.fetch })).toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      contentType: 'video/mp4',
    });
    const big = fakeFetch(() => ({ bytes: new Uint8Array(11) }));
    expect((await failure(download('https://cdn.test/a.mp4', { ...options, fetch: big.fetch }))).code).toBe(
      'too_large',
    );
    expect((await failure(download('http://cdn.test/a.mp4', { ...options, fetch: ok.fetch }))).code).toBe(
      'bad_response',
    );
    const gone = fakeFetch(() => ({ status: 403 }));
    const error = await failure(download('https://cdn.test/a.mp4?firma=abc', { ...options, fetch: gone.fetch }));
    expect(error.code).toBe('download_failed');
    expect(error.message).not.toMatch(/firma|cdn\.test/);
  });
});
