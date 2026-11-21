// Lógica de la Edge Function `ai-transcribe` (subtítulos automáticos de los
// reels), sin nada de Deno: recibe sus dependencias y devuelve una `Response`.
// Las pruebas la ejecutan en Node con la base de datos real y el proveedor
// simulado (tests/db/ia-transcripcion.test.ts).
//
//   POST application/json      { action: "options", brandId }
//        → { available, microsPerSecond }   (para enseñar el coste antes)
//   POST multipart/form-data   brandId, meta = { chunks: [{ seconds }], language? },
//                              chunk-0, chunk-1, … (WAV)
//        → { segments: [{ index, text }], generationId }
//
// El navegador ya ha cortado el sonido del tramo usado de cada clip en trozos
// de voz; aquí se transcribe cada trozo (un trozo = un subtítulo). El permiso
// («editar la marca»), el plan (`ai_text`) y el cupo de IA de la organización
// los impone la base de datos al reservar (`ai_reserve_generation`), antes de
// llamar a OpenAI; el coste queda en `ai_generations` (tarea `transcription`).
//
// En marcas en modo agencia se admite (decisión provisional, como el copiloto
// por voz): transcribir no redacta, copia lo que se dice en el clip.
import { AiError, type AiErrorCode, type AiService } from '../_shared/ai/contract.ts';
import { TRANSCRIPTION_PURPOSE } from '../_shared/ai/transcription/config.ts';

export const MAX_CHUNKS = 40;
export const MAX_CHUNK_SECONDS = 15;
export const MAX_TOTAL_SECONDS = 120;
export const MAX_TOTAL_BYTES = 6_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AiTranscribeDeps {
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  /** ¿Ve el usuario la marca? (con su identidad: RLS). */
  brandVisible(accessToken: string, brandId: string): Promise<boolean>;
  service: AiService;
  /** Precio por segundo del modelo configurado, o null si no hay transcripción en este entorno. */
  microsPerSecond: number | null;
  log?: (event: string, data: Record<string, unknown>) => void;
  allowedOrigin?: string;
}

const STATUS: Record<AiErrorCode, number> = {
  quota_exhausted: 402,
  quota_missing: 402,
  forbidden: 403,
  not_configured: 503,
  provider_failed: 502,
  provider_timeout: 504,
  invalid_output: 502,
  refused: 422,
  internal: 500,
};

/** ¿Es un WAV (RIFF … WAVE)? */
export function isWav(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const tag = (from: number) => String.fromCharCode(data[from]!, data[from + 1]!, data[from + 2]!, data[from + 3]!);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

export function createAiTranscribeHandler(deps: AiTranscribeDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
  const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    json(status, { error: { code, message, retryable: false, ...extra } });

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    const header = request.headers.get('authorization') ?? '';
    const accessToken = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    if (!accessToken) return fail(401, 'unauthenticated', 'Inicia sesión para usar los subtítulos automáticos.');
    let user: { userId: string } | null;
    try {
      user = await deps.authenticate(accessToken);
    } catch {
      return fail(500, 'internal', 'No se ha podido comprobar la sesión. Inténtalo de nuevo.', { retryable: true });
    }
    if (!user) return fail(401, 'unauthenticated', 'La sesión ha caducado. Vuelve a iniciar sesión.');

    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > MAX_TOTAL_BYTES + 100_000) return fail(413, 'too_large', 'Hay demasiado sonido en una sola petición.');
    const type = request.headers.get('content-type') ?? '';

    // ── Precio, para enseñarlo antes ──
    if (type.startsWith('application/json')) {
      let body: { action?: unknown; brandId?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return fail(400, 'invalid_request', 'La petición no es JSON válido.');
      }
      if (body.action !== 'options') return fail(400, 'invalid_request', 'Acción no admitida.');
      if (typeof body.brandId !== 'string' || !UUID.test(body.brandId)) {
        return fail(400, 'invalid_request', 'Indica la marca (brandId).');
      }
      let visible = false;
      try {
        visible = await deps.brandVisible(accessToken, body.brandId);
      } catch {
        return fail(500, 'internal', 'No se ha podido leer la marca. Inténtalo de nuevo.', { retryable: true });
      }
      if (!visible) return fail(404, 'brand_not_found', 'No existe esa marca o no tienes acceso a ella.');
      return json(200, { available: deps.microsPerSecond !== null, microsPerSecond: deps.microsPerSecond });
    }

    // ── Transcribir ──
    if (!type.startsWith('multipart/form-data')) {
      return fail(415, 'invalid_request', 'Manda el sonido como multipart/form-data.');
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, 'invalid_request', 'No se ha podido leer el sonido enviado.');
    }
    const brandId = form.get('brandId');
    if (typeof brandId !== 'string' || !UUID.test(brandId)) {
      return fail(400, 'invalid_request', 'Indica la marca (brandId).');
    }
    let meta: { chunks?: Array<{ seconds?: unknown }>; language?: unknown };
    try {
      meta = JSON.parse(String(form.get('meta') ?? '')) as typeof meta;
    } catch {
      return fail(400, 'invalid_request', 'Faltan los datos de los trozos (meta).');
    }
    const declared = Array.isArray(meta.chunks) ? meta.chunks : [];
    if (declared.length === 0 || declared.length > MAX_CHUNKS) {
      return fail(400, 'invalid_request', `Manda entre 1 y ${MAX_CHUNKS} trozos de sonido.`);
    }
    const language = typeof meta.language === 'string' && /^[a-z]{2}$/.test(meta.language) ? meta.language : undefined;
    const chunks: Array<{ data: Uint8Array; mimeType: string; seconds: number }> = [];
    let total = 0;
    let bytes = 0;
    for (const [index, entry] of declared.entries()) {
      const seconds = typeof entry?.seconds === 'number' ? entry.seconds : NaN;
      if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > MAX_CHUNK_SECONDS) {
        return fail(400, 'invalid_request', `El trozo ${index + 1} debe durar entre 0,2 y ${MAX_CHUNK_SECONDS} s.`);
      }
      const file = form.get(`chunk-${index}`);
      if (!(file instanceof Blob)) return fail(400, 'invalid_request', `Falta el trozo ${index + 1}.`);
      const data = new Uint8Array(await file.arrayBuffer());
      if (!isWav(data)) return fail(400, 'invalid_request', `El trozo ${index + 1} no es un WAV.`);
      total += seconds;
      bytes += data.length;
      chunks.push({ data, mimeType: 'audio/wav', seconds });
    }
    if (total > MAX_TOTAL_SECONDS) {
      return fail(400, 'invalid_request', `Como mucho ${MAX_TOTAL_SECONDS} s de sonido por petición.`);
    }
    if (bytes > MAX_TOTAL_BYTES) return fail(413, 'too_large', 'Hay demasiado sonido en una sola petición.');

    try {
      if (!(await deps.brandVisible(accessToken, brandId))) {
        return fail(404, 'brand_not_found', 'No existe esa marca o no tienes acceso a ella.');
      }
      const result = await deps.service.generate({
        userId: user.userId,
        brandId,
        task: 'transcription',
        purpose: TRANSCRIPTION_PURPOSE,
        input: { prompt: 'Transcribe literalmente lo que se dice.', audio: { chunks, language } },
      });
      const segments = Array.isArray(result.output.segments) ? result.output.segments : [];
      return json(200, { segments, generationId: result.generationId });
    } catch (error) {
      if (error instanceof AiError) {
        deps.log?.('ai_error', { brandId, code: error.code, generationId: error.generationId });
        const message =
          error.code === 'not_configured'
            ? 'Los subtítulos automáticos no están disponibles. Avisa a quien administra la plataforma.'
            : error.message;
        return json(STATUS[error.code], {
          error: { code: error.code, message, retryable: error.retryable, generationId: error.generationId },
        });
      }
      deps.log?.('unexpected_error', { brandId });
      return fail(500, 'internal', 'Algo ha fallado al transcribir. Inténtalo de nuevo.', { retryable: true });
    }
  };
}
