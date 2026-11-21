// Configuración de la transcripción (subtítulos automáticos de los reels).
//
// Usa la MISMA clave de OpenAI de «Plataforma → Integraciones → IA de texto»
// (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`)
// y el mismo criterio de datos: sin el endpoint de la UE
// (https://eu.api.openai.com) no se carga, salvo AI_ALLOW_NON_EU_PROCESSING=true.
//
//   AI_TRANSCRIPTION_MODEL   modelo (por defecto, `gpt-transcribe`)
//   AI_PRICES                "openai/<modelo>": { "audio_seconds": micros }
//
// Precio por defecto (millonésimas de la moneda de cuenta por segundo de
// sonido), consultado el 21/11/2026 en https://developers.openai.com/api/docs/pricing,
// con un 10 % más por el procesamiento regional (UE), que OpenAI cobra a los
// modelos publicados desde el 05/03/2026: la página no dice si alcanza a estos,
// así que se cuenta como cota. Se puede cambiar sin tocar código con AI_PRICES.
import type { AiModelSpec, AiProvider } from '../contract.ts';
import { isLocalSupabaseUrl, LOCAL_TEST_FLAG, LocalTestConfigError } from '../text/local-test.ts';
import { normalizeOpenAiBaseUrl, OPENAI_PROVIDER_ID, openAiBaseUrlProblem, openAiEuProblem } from '../text/openai.ts';
import { parsePrices, type Env } from '../text/config.ts';
import {
  createOpenAiTranscriptionProvider,
  TRANSCRIPTION_DEFAULT_MODEL,
  TRANSCRIPTION_UNIT,
  type TranscriptionFetch,
} from './openai.ts';
import { createSimulatedTranscriptionProvider, SIMULATED_TRANSCRIPTION_MODEL } from './simulated.ts';

export const TRANSCRIPTION_PURPOSE = 'reel.subtitles';

/** Precio por defecto, en micros por segundo: (precio por minuto × 1,10) / 60 × 10⁶. */
export const DEFAULT_TRANSCRIPTION_PRICES: Record<string, number> = {
  'gpt-transcribe': 82.5, // 0,0045 $/min
  'whisper-1': 110, // 0,006 $/min (obsoleto, se apaga el 26/02/2027)
  'gpt-4o-transcribe': 110, // 0,006 $/min (obsoleto)
  'gpt-4o-mini-transcribe': 55, // 0,003 $/min (obsoleto)
};

/** Precio inventado para la prueba local (no es el de ningún proveedor). */
export const LOCAL_TEST_TRANSCRIPTION_PRICE = 100;

export interface TranscriptionConfig {
  providers: AiProvider[];
  models: AiModelSpec[];
  unavailable: Record<string, string>;
  problems: string[];
}

const value = (env: Env, key: string) => {
  const v = env[key]?.trim();
  return v ? v : undefined;
};

export function loadTranscriptionConfig(env: Env, options: { fetch?: TranscriptionFetch } = {}): TranscriptionConfig {
  const problems: string[] = [];

  // Prueba de extremo a extremo en local: proveedor simulado, con la misma guarda que el texto.
  const flag = value(env, LOCAL_TEST_FLAG);
  if (flag) {
    if (flag !== 'true') throw new LocalTestConfigError(`${LOCAL_TEST_FLAG} solo admite el valor «true».`);
    if (!isLocalSupabaseUrl(env.SUPABASE_URL)) {
      throw new LocalTestConfigError(`${LOCAL_TEST_FLAG}=true solo se admite contra un Supabase local.`);
    }
    return {
      providers: [createSimulatedTranscriptionProvider()],
      models: [
        {
          provider: 'simulated',
          model: SIMULATED_TRANSCRIPTION_MODEL,
          task: 'transcription',
          microsPerUnit: { [TRANSCRIPTION_UNIT]: LOCAL_TEST_TRANSCRIPTION_PRICE },
          purposes: [TRANSCRIPTION_PURPOSE],
        },
      ],
      unavailable: {},
      problems: [`${LOCAL_TEST_FLAG}=true: transcripción SIMULADA para pruebas locales.`],
    };
  }

  const model = value(env, 'AI_TRANSCRIPTION_MODEL') ?? TRANSCRIPTION_DEFAULT_MODEL;
  const prices = parsePrices(value(env, 'AI_PRICES'), problems);
  const rate = prices[`${OPENAI_PROVIDER_ID}/${model}`]?.[TRANSCRIPTION_UNIT] ?? DEFAULT_TRANSCRIPTION_PRICES[model];
  const models: AiModelSpec[] = [];
  const unavailable: Record<string, string> = {};
  const providers: AiProvider[] = [];

  const apiKey = value(env, 'OPENAI_API_KEY');
  const rawBase = value(env, 'OPENAI_BASE_URL');
  const baseProblem = rawBase ? openAiBaseUrlProblem(rawBase) : null;
  const baseUrl = normalizeOpenAiBaseUrl(rawBase);
  const residency = baseProblem ? null : openAiEuProblem(baseUrl);
  const allowNonEu = value(env, 'AI_ALLOW_NON_EU_PROCESSING') === 'true';
  if (!apiKey) {
    unavailable[OPENAI_PROVIDER_ID] = 'Falta la clave de OpenAI (OPENAI_API_KEY).';
  } else if (baseProblem) {
    unavailable[OPENAI_PROVIDER_ID] = baseProblem;
  } else if (residency && !allowNonEu) {
    unavailable[OPENAI_PROVIDER_ID] =
      `La transcripción con OpenAI no se carga: ${residency}. Pon OPENAI_BASE_URL=https://eu.api.openai.com o acepta ese tratamiento con AI_ALLOW_NON_EU_PROCESSING=true.`;
  } else {
    providers.push(
      createOpenAiTranscriptionProvider({
        apiKey,
        baseUrl,
        organization: value(env, 'OPENAI_ORGANIZATION'),
        project: value(env, 'OPENAI_PROJECT'),
        fetch: options.fetch,
      }),
    );
  }
  if (rate === undefined) {
    problems.push(`El modelo de transcripción «${model}» no tiene precio: añádelo en AI_PRICES (audio_seconds).`);
  } else {
    models.push({
      provider: OPENAI_PROVIDER_ID,
      model,
      task: 'transcription',
      microsPerUnit: { [TRANSCRIPTION_UNIT]: rate },
      purposes: [TRANSCRIPTION_PURPOSE],
    });
  }
  for (const [id, reason] of Object.entries(unavailable))
    problems.push(`Transcripción («${id}») no disponible. ${reason}`);
  return { providers, models, unavailable, problems };
}

/** ¿Se pueden pedir subtítulos automáticos en este entorno? (Solo booleano, para la interfaz.) */
export function transcriptionReady(env: Env): boolean {
  const config = loadTranscriptionConfig(env);
  const loaded = new Set(config.providers.map((p) => p.id));
  return config.models.some((m) => loaded.has(m.provider));
}

/** Precio por segundo del modelo que se usará, o null si no hay. */
export function transcriptionPrice(config: TranscriptionConfig): number | null {
  const loaded = new Set(config.providers.map((p) => p.id));
  const spec = config.models.find((m) => loaded.has(m.provider));
  return spec?.microsPerUnit[TRANSCRIPTION_UNIT] ?? null;
}
