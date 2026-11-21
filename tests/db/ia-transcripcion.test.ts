// Subtítulos automáticos de los reels: la función `ai-transcribe` (handler.ts)
// con la base de datos real, el servicio de IA de siempre y la transcripción
// simulada; y el adaptador de OpenAI contra un HTTP simulado (sin clave real).
// Cupo, permiso y plan los impone `ai_reserve_generation`, como en el texto.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiModelSpec, RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import { createAiService } from '../../supabase/functions/_shared/ai/service.ts';
import {
  DEFAULT_TRANSCRIPTION_PRICES,
  loadTranscriptionConfig,
  transcriptionPrice,
  transcriptionReady,
  TRANSCRIPTION_PURPOSE,
} from '../../supabase/functions/_shared/ai/transcription/config.ts';
import {
  createOpenAiTranscriptionProvider,
  TRANSCRIPTION_UNIT,
} from '../../supabase/functions/_shared/ai/transcription/openai.ts';
import {
  createSimulatedTranscriptionProvider,
  SIMULATED_TRANSCRIPTION_MODEL,
} from '../../supabase/functions/_shared/ai/transcription/simulated.ts';
import { createAiTranscribeHandler } from '../../supabase/functions/ai-transcribe/handler.ts';
import {
  as,
  createBrand,
  createDb,
  createOrg,
  createUser,
  join,
  serviceRpc,
  setAiQuota,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

const PRICE = 100; // micros por segundo (inventado)
const MODELS: AiModelSpec[] = [
  {
    provider: 'simulated',
    model: SIMULATED_TRANSCRIPTION_MODEL,
    task: 'transcription',
    microsPerUnit: { [TRANSCRIPTION_UNIT]: PRICE },
    purposes: [TRANSCRIPTION_PURPOSE],
  },
];

let db: Db;
let root: TestUser;
let n = 0;
const sessions = new Map<string, TestUser>();

const rpc: RpcClient = async (fn, args) => {
  try {
    return { data: await serviceRpc(db, fn, args), error: null };
  } catch (error) {
    const { code, message, detail } = error as { code?: string; message: string; detail?: string };
    return { data: null, error: { code, message, details: detail ?? null } };
  }
};

/** WAV de 16 kHz, mono, 16 bits, en silencio. */
function wav(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 16000);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return new Uint8Array(buffer);
}

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@plataforma.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
});

afterAll(async () => {
  await db?.close();
});

async function setup(options: { quota?: number | null; price?: number | null } = {}) {
  n += 1;
  const owner = await createUser(db, `duena${n}@transcribe${n}.test`);
  const lector = await createUser(db, `lector${n}@transcribe${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  await join(db, owner, lector, org, 'member', brand, 'viewer');
  if (options.quota !== null) await setAiQuota(db, root, org, options.quota ?? 1_000_000);
  const provider = createSimulatedTranscriptionProvider();
  const handler = createAiTranscribeHandler({
    service: createAiService({ rpc, providers: [provider], models: MODELS }),
    microsPerSecond: options.price === undefined ? PRICE : options.price,
    authenticate: async (token) => (sessions.get(token) ? { userId: sessions.get(token)!.id } : null),
    brandVisible: async (token, brandId) =>
      (await as(db, sessions.get(token)!, `select id from public.brands where id = $1`, [brandId])).length > 0,
  });
  const login = (user: TestUser) => {
    const token = `sesion-${user.id}`;
    sessions.set(token, user);
    return token;
  };
  const send = async (token: string, chunks: Array<{ seconds: number; data?: Uint8Array }>, brandId = brand) => {
    const form = new FormData();
    form.append('brandId', brandId);
    form.append('meta', JSON.stringify({ chunks: chunks.map((c) => ({ seconds: c.seconds })), language: 'es' }));
    chunks.forEach((c, i) => form.append(`chunk-${i}`, new Blob([c.data ?? wav(c.seconds)], { type: 'audio/wav' })));
    const response = await handler(
      new Request('https://funciones.test/ai-transcribe', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      }),
    );
    return { status: response.status, body: (await response.json()) as Row };
  };
  const options_ = async (token: string, brandId = brand) => {
    const response = await handler(
      new Request('https://funciones.test/ai-transcribe', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'options', brandId }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Row };
  };
  return {
    owner,
    lector,
    org,
    brand,
    provider,
    send,
    options: options_,
    token: login(owner),
    lectorToken: login(lector),
  };
}

const generations = (org: string) =>
  db.query<Row>(`select * from public.ai_generations where organization_id = $1 order by created_at`, [org]);

describe('ai-transcribe', () => {
  it('transcribe cada trozo, registra el coste por segundos y lo descuenta del cupo de la organización', async () => {
    const t = await setup();
    const result = await t.send(t.token, [{ seconds: 2.4 }, { seconds: 1.2 }]);
    expect(result.status).toBe(200);
    expect(result.body.segments).toEqual([
      { index: 0, text: '[simulado] Frase 1 de 2 (2.4 s)' },
      { index: 1, text: '[simulado] Frase 2 de 2 (1.2 s)' },
    ]);
    const [generation] = await generations(t.org);
    // 3 + 2 segundos (cada trozo redondeado por arriba) × 100 micros.
    expect(generation).toMatchObject({
      task: 'transcription',
      purpose: 'reel.subtitles',
      provider: 'simulated',
      status: 'succeeded',
      cost_micros: 500,
      usage: { audio_seconds: 5 },
    });
    // El sonido no se guarda en el registro.
    expect(JSON.stringify(generation)).not.toContain('RIFF');
  });

  it('enseña el precio antes a quien ve la marca; a quien no la ve, nada', async () => {
    const t = await setup();
    expect(await t.options(t.token)).toEqual({ status: 200, body: { available: true, microsPerSecond: PRICE } });
    const other = await setup();
    expect((await other.options(other.token, t.brand)).status).toBe(404);
    const off = await setup({ price: null });
    expect((await off.options(off.token)).body).toEqual({ available: false, microsPerSecond: null });
  });

  it('sin cupo, sin permiso de edición o con una marca ajena, no llama a nadie', async () => {
    const poor = await setup({ quota: 300 });
    expect(await poor.send(poor.token, [{ seconds: 4 }])).toMatchObject({
      status: 402,
      body: { error: { code: 'quota_exhausted' } },
    });
    expect(poor.provider.calls).toHaveLength(0);
    const t = await setup();
    expect((await t.send(t.lectorToken, [{ seconds: 1 }])).status).toBe(403);
    const other = await setup();
    expect((await other.send(other.token, [{ seconds: 1 }], t.brand)).status).toBe(404);
    expect(t.provider.calls).toHaveLength(0);
    expect(other.provider.calls).toHaveLength(0);
  });

  it('rechaza lo que no es un WAV, trozos de más y demasiado sonido', async () => {
    const t = await setup();
    const bad = await t.send(t.token, [{ seconds: 1, data: new TextEncoder().encode('no soy un wav') }]);
    expect(bad).toMatchObject({ status: 400, body: { error: { message: 'El trozo 1 no es un WAV.' } } });
    expect((await t.send(t.token, [{ seconds: 20 }])).status).toBe(400);
    expect(
      (
        await t.send(
          t.token,
          Array.from({ length: 41 }, () => ({ seconds: 0.5 })),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await t.send(
          t.token,
          Array.from({ length: 9 }, () => ({ seconds: 14 })),
        )
      ).status,
    ).toBe(400);
    expect(t.provider.calls).toHaveLength(0);
  });
});

describe('configuración y adaptador de OpenAI (HTTP simulado)', () => {
  it('sin clave, o sin el endpoint de la UE, no hay subtítulos; con ellos, gpt-transcribe con su precio', () => {
    expect(transcriptionReady({})).toBe(false);
    expect(transcriptionReady({ OPENAI_API_KEY: 'sk-x' })).toBe(false);
    expect(transcriptionReady({ OPENAI_API_KEY: 'sk-x', AI_ALLOW_NON_EU_PROCESSING: 'true' })).toBe(true);
    const config = loadTranscriptionConfig({ OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'https://eu.api.openai.com' });
    expect(config.models[0]).toMatchObject({ provider: 'openai', model: 'gpt-transcribe', task: 'transcription' });
    expect(transcriptionPrice(config)).toBe(DEFAULT_TRANSCRIPTION_PRICES['gpt-transcribe']);
    // Otro modelo y otro precio, sin tocar código.
    const custom = loadTranscriptionConfig({
      OPENAI_API_KEY: 'sk-x',
      OPENAI_BASE_URL: 'https://eu.api.openai.com',
      AI_TRANSCRIPTION_MODEL: 'whisper-1',
      AI_PRICES: JSON.stringify({ 'openai/whisper-1': { audio_seconds: 120 } }),
    });
    expect(transcriptionPrice(custom)).toBe(120);
    // Un modelo sin precio conocido no se ofrece.
    expect(
      transcriptionReady({
        OPENAI_API_KEY: 'sk-x',
        AI_ALLOW_NON_EU_PROCESSING: 'true',
        AI_TRANSCRIPTION_MODEL: 'otro',
      }),
    ).toBe(false);
  });

  it('manda cada trozo a /v1/audio/transcriptions y cobra por la duración que diga OpenAI', async () => {
    const seen: Array<{ url: string; model: string; languages: string | null; auth: string }> = [];
    const provider = createOpenAiTranscriptionProvider({
      apiKey: 'sk-secreta',
      baseUrl: 'https://eu.api.openai.com/v1',
      fetch: async (url, init) => {
        seen.push({
          url,
          model: String(init.body.get('model')),
          languages: init.body.get('languages[]') as string | null,
          auth: init.headers.authorization!,
        });
        return new Response(
          JSON.stringify({ text: ` Frase ${seen.length} `, usage: { type: 'duration', seconds: 1.4 } }),
          {
            status: 200,
            headers: { 'x-request-id': 'req_1' },
          },
        );
      },
    });
    const result = await provider.generate({
      task: 'transcription',
      model: 'gpt-transcribe',
      input: {
        prompt: '',
        audio: {
          chunks: [
            { data: wav(1.3), mimeType: 'audio/wav', seconds: 1.3 },
            { data: wav(1), mimeType: 'audio/wav', seconds: 1 },
          ],
          language: 'es',
        },
      },
      signal: new AbortController().signal,
    });
    expect(seen.map((s) => [s.url, s.model, s.languages])).toEqual([
      ['https://eu.api.openai.com/v1/audio/transcriptions', 'gpt-transcribe', 'es'],
      ['https://eu.api.openai.com/v1/audio/transcriptions', 'gpt-transcribe', 'es'],
    ]);
    expect(seen[0]!.auth).toBe('Bearer sk-secreta');
    expect(result).toEqual({
      output: {
        segments: [
          { index: 0, text: 'Frase 1' },
          { index: 1, text: 'Frase 2' },
        ],
      },
      usage: { audio_seconds: 4 },
      providerRequestId: 'req_1',
    });

    // Un error de OpenAI no deja ver la clave.
    const failing = createOpenAiTranscriptionProvider({
      apiKey: 'sk-secreta',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'clave sk-secreta no válida' } }), { status: 401 }),
    });
    await expect(
      failing.generate({
        task: 'transcription',
        model: 'gpt-transcribe',
        input: { prompt: '', audio: { chunks: [{ data: wav(1), mimeType: 'audio/wav', seconds: 1 }] } },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/\[oculto\]/);
  });
});
