// Configuración del servicio de IA de texto a partir de las variables de
// entorno de la función. Aquí se decide, SIN tocar código:
//   * qué adaptador y qué modelo sirve cada tarea de texto;
//   * cuánto cuesta cada unidad de consumo (tabla de precios);
//   * si se acepta un proveedor que no procesa en la UE.
//
// Reglas:
//   * Un adaptador sin sus credenciales no se carga. La tarea que lo tenga
//     elegido falla con un error que dice qué falta (`unavailable`).
//   * El proveedor simulado NO existe para esta configuración: no se puede
//     elegir por variable de entorno ni se usa como sustituto. Solo lo crean
//     las pruebas.
//   * Criterio de datos por defecto: procesar en la UE. La API directa de
//     Anthropic no lo cumple y solo se carga con AI_ALLOW_NON_EU_PROCESSING=true.
//   * No se elige proveedor ni modelo por defecto: sin configuración, no hay IA.
//
// Los nombres de las variables están en `.env.example` y en docs/ia-texto.md.
import type { AiModelSpec, AiProvider } from '../contract.ts';
import { ANTHROPIC_PROVIDER_ID, createAnthropicProvider } from './anthropic.ts';
import { BEDROCK_PROVIDER_ID, createBedrockProvider, euResidencyProblem, type BedrockAuth } from './bedrock.ts';
import type { FetchLike } from './http.ts';
import { parseServiceAccountKey } from './google-auth.ts';
import { createMistralProvider, MISTRAL_PROVIDER_ID } from './mistral.ts';
import {
  createOpenAiProvider,
  normalizeOpenAiBaseUrl,
  OPENAI_PROVIDER_ID,
  openAiBaseUrlProblem,
  openAiEuProblem,
} from './openai.ts';
import { TEXT_UNITS } from './prompt.ts';
import { createVertexProvider, VERTEX_PROVIDER_ID, vertexEuProblem } from './vertex.ts';

export type Env = Record<string, string | undefined>;

/** Propósitos de las tareas de texto (`AiGenerateParams.purpose`). */
export const TEXT_PURPOSES = [
  'post.caption',
  'profile.proposal',
  'brand.check',
  'campaign.plan',
  'analytics.summary',
  'editor.copilot',
] as const;
export type TextPurpose = (typeof TEXT_PURPOSES)[number];

/** Variables con las que se elige adaptador y modelo de un propósito concreto. */
const PURPOSE_ENV: Record<TextPurpose, string> = {
  'post.caption': 'AI_TEXT_POST_CAPTION',
  'profile.proposal': 'AI_TEXT_PROFILE_PROPOSAL',
  'brand.check': 'AI_TEXT_BRAND_CHECK',
  'campaign.plan': 'AI_TEXT_CAMPAIGN_PLAN',
  // Analítica (Fase 5): interpretación de las cifras, siempre como hipótesis.
  'analytics.summary': 'AI_TEXT_ANALYTICS_SUMMARY',
  // Copiloto por voz del editor: convierte lo dictado en operaciones de capas.
  'editor.copilot': 'AI_TEXT_EDITOR_COPILOT',
};

export const TEXT_PROVIDER_IDS = [
  VERTEX_PROVIDER_ID,
  ANTHROPIC_PROVIDER_ID,
  MISTRAL_PROVIDER_ID,
  BEDROCK_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
] as const;

export interface AiTextConfig {
  providers: AiProvider[];
  models: AiModelSpec[];
  /** Adaptadores elegidos que no se han podido cargar, con el motivo. */
  unavailable: Record<string, string>;
  timeoutMs?: number;
  /**
   * Avisos de configuración para el registro del servidor (nunca para el
   * navegador). Solo nombres de variables, jamás valores.
   */
  problems: string[];
}

const value = (env: Env, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
};

/**
 * Tabla de precios: `{ "<adaptador>/<modelo>": { "<unidad>": micros por unidad } }`.
 * Un micro por token equivale a una unidad de moneda por millón de tokens.
 */
export function parsePrices(raw: string | undefined, problems: string[]): Record<string, Record<string, number>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('AI_PRICES no es JSON válido: ningún modelo tiene precio.');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('AI_PRICES debe ser un objeto { "adaptador/modelo": { unidad: precio } }.');
    return {};
  }
  const prices: Record<string, Record<string, number>> = {};
  for (const [key, units] of Object.entries(parsed)) {
    if (typeof units !== 'object' || units === null || Array.isArray(units)) {
      problems.push(`AI_PRICES: la entrada «${key}» no es un objeto de precios.`);
      continue;
    }
    const clean: Record<string, number> = {};
    for (const [unit, price] of Object.entries(units)) {
      if (typeof price === 'number' && Number.isFinite(price) && price >= 0) clean[unit] = price;
      else problems.push(`AI_PRICES: el precio de «${unit}» en «${key}» no es un número válido.`);
    }
    prices[key] = clean;
  }
  return prices;
}

function bedrockAuth(env: Env): BedrockAuth | null {
  const accessKeyId = value(env, 'AI_BEDROCK_ACCESS_KEY_ID');
  const secretAccessKey = value(env, 'AI_BEDROCK_SECRET_ACCESS_KEY');
  if (accessKeyId && secretAccessKey) {
    return {
      kind: 'sigv4',
      credentials: { accessKeyId, secretAccessKey, sessionToken: value(env, 'AI_BEDROCK_SESSION_TOKEN') },
    };
  }
  const token = value(env, 'AI_BEDROCK_BEARER_TOKEN');
  return token ? { kind: 'bearer', token } : null;
}

export function loadAiTextConfig(env: Env, options: { fetch?: FetchLike } = {}): AiTextConfig {
  const problems: string[] = [];
  const unavailable: Record<string, string> = {};
  const providers: AiProvider[] = [];
  const allowNonEu = value(env, 'AI_ALLOW_NON_EU_PROCESSING') === 'true';

  // 1. Qué adaptador y qué modelo pide cada propósito.
  const routes: { purpose: TextPurpose; provider: string; model: string }[] = [];
  for (const purpose of TEXT_PURPOSES) {
    const prefix = PURPOSE_ENV[purpose];
    const provider = value(env, `${prefix}_PROVIDER`) ?? value(env, 'AI_TEXT_PROVIDER');
    const model = value(env, `${prefix}_MODEL`) ?? value(env, 'AI_TEXT_MODEL');
    if (!provider && !model) continue;
    if (!provider || !model) {
      problems.push(
        `La tarea «${purpose}» necesita adaptador y modelo: define ${prefix}_PROVIDER y ${prefix}_MODEL (o AI_TEXT_PROVIDER y AI_TEXT_MODEL).`,
      );
      continue;
    }
    routes.push({ purpose, provider, model });
  }

  // 2. Adaptadores: solo los que alguna tarea ha elegido y tienen credenciales.
  const wanted = new Set(routes.map((route) => route.provider));
  for (const id of wanted) {
    if (id === ANTHROPIC_PROVIDER_ID) {
      const apiKey = value(env, 'ANTHROPIC_API_KEY');
      if (!allowNonEu) {
        unavailable[id] =
          'El adaptador «anthropic» (API directa) no procesa los datos en la UE. Usa «anthropic-vertex», «anthropic-bedrock», «mistral» o «openai» (endpoint UE), o acepta expresamente ese tratamiento con AI_ALLOW_NON_EU_PROCESSING=true.';
      } else if (!apiKey) {
        unavailable[id] = 'Falta la clave del adaptador «anthropic» (variable ANTHROPIC_API_KEY).';
      } else {
        providers.push(createAnthropicProvider({ apiKey, fetch: options.fetch }));
      }
    } else if (id === BEDROCK_PROVIDER_ID) {
      const region = value(env, 'AI_BEDROCK_REGION');
      const auth = bedrockAuth(env);
      const residency = region
        ? routes
            .filter((route) => route.provider === id)
            .map((route) => euResidencyProblem(region, route.model))
            .find((problem) => problem !== null)
        : undefined;
      if (!region || !auth) {
        unavailable[id] =
          'Faltan datos del adaptador «anthropic-bedrock»: AI_BEDROCK_REGION y las credenciales (AI_BEDROCK_ACCESS_KEY_ID con AI_BEDROCK_SECRET_ACCESS_KEY, o AI_BEDROCK_BEARER_TOKEN).';
      } else if (residency && !allowNonEu) {
        unavailable[id] =
          `El adaptador «anthropic-bedrock» no se carga: ${residency}. Usa una región y un modelo de la UE, o acepta expresamente ese tratamiento con AI_ALLOW_NON_EU_PROCESSING=true.`;
      } else {
        providers.push(createBedrockProvider({ region, auth, fetch: options.fetch, allowOutsideEu: allowNonEu }));
      }
    } else if (id === VERTEX_PROVIDER_ID) {
      const projectId = value(env, 'AI_VERTEX_PROJECT_ID');
      const location = value(env, 'AI_VERTEX_LOCATION');
      const rawKey = value(env, 'AI_VERTEX_SERVICE_ACCOUNT_JSON');
      const serviceAccount = rawKey ? parseServiceAccountKey(rawKey) : null;
      const residency = location ? vertexEuProblem(location) : null;
      if (!projectId || !location || !rawKey) {
        unavailable[id] =
          'Faltan datos del adaptador «anthropic-vertex»: AI_VERTEX_PROJECT_ID, AI_VERTEX_LOCATION y AI_VERTEX_SERVICE_ACCOUNT_JSON.';
      } else if (!serviceAccount) {
        unavailable[id] =
          'AI_VERTEX_SERVICE_ACCOUNT_JSON no es el JSON de una cuenta de servicio (faltan client_email o private_key).';
      } else if (residency && !allowNonEu) {
        unavailable[id] =
          `El adaptador «anthropic-vertex» no se carga: ${residency}. O acepta expresamente ese tratamiento con AI_ALLOW_NON_EU_PROCESSING=true.`;
      } else {
        providers.push(
          createVertexProvider({ projectId, location, serviceAccount, fetch: options.fetch, allowOutsideEu: allowNonEu }),
        );
      }
    } else if (id === MISTRAL_PROVIDER_ID) {
      const apiKey = value(env, 'MISTRAL_API_KEY');
      if (!apiKey) unavailable[id] = 'Falta la clave del adaptador «mistral» (variable MISTRAL_API_KEY).';
      else providers.push(createMistralProvider({ apiKey, fetch: options.fetch }));
    } else if (id === OPENAI_PROVIDER_ID) {
      const apiKey = value(env, 'OPENAI_API_KEY');
      const rawBase = value(env, 'OPENAI_BASE_URL');
      const baseProblem = rawBase ? openAiBaseUrlProblem(rawBase) : null;
      const baseUrl = normalizeOpenAiBaseUrl(rawBase);
      const residency = baseProblem ? null : openAiEuProblem(baseUrl);
      if (!apiKey) {
        unavailable[id] = 'Falta la clave del adaptador «openai» (variable OPENAI_API_KEY).';
      } else if (baseProblem) {
        unavailable[id] = baseProblem;
      } else if (residency && !allowNonEu) {
        unavailable[id] =
          `El adaptador «openai» no se carga: ${residency}. Crea un proyecto con residencia en Europa y pon OPENAI_BASE_URL=https://eu.api.openai.com, o acepta expresamente ese tratamiento con AI_ALLOW_NON_EU_PROCESSING=true.`;
      } else {
        providers.push(
          createOpenAiProvider({
            apiKey,
            baseUrl,
            organization: value(env, 'OPENAI_ORGANIZATION'),
            project: value(env, 'OPENAI_PROJECT'),
            fetch: options.fetch,
          }),
        );
      }
    } else {
      unavailable[id] =
        `El adaptador «${id}» no existe. Los de texto son: ${TEXT_PROVIDER_IDS.join(', ')}.`;
    }
  }
  for (const [id, reason] of Object.entries(unavailable)) problems.push(`Adaptador «${id}» no disponible. ${reason}`);

  // 3. Modelos con su precio. Sin precio completo el servicio no genera.
  const prices = parsePrices(value(env, 'AI_PRICES'), problems);
  const models: AiModelSpec[] = routes.map((route) => {
    const key = `${route.provider}/${route.model}`;
    const microsPerUnit = prices[key] ?? {};
    const needed: string[] = [TEXT_UNITS.input, TEXT_UNITS.output, TEXT_UNITS.cacheRead];
    if (route.provider !== MISTRAL_PROVIDER_ID && route.provider !== OPENAI_PROVIDER_ID) needed.push(TEXT_UNITS.cacheWrite);
    const missing = needed.filter((unit) => microsPerUnit[unit] === undefined);
    if (missing.length > 0 && !(route.provider in unavailable)) {
      problems.push(`AI_PRICES: a «${key}» le falta el precio de ${missing.join(', ')}.`);
    }
    return { provider: route.provider, model: route.model, task: 'text', microsPerUnit, purposes: [route.purpose] };
  });

  // 4. Tiempo máximo de la llamada al proveedor (opcional).
  let timeoutMs: number | undefined;
  const rawTimeout = value(env, 'AI_TIMEOUT_MS');
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (Number.isInteger(parsed) && parsed >= 1000 && parsed <= 390_000) timeoutMs = parsed;
    else problems.push('AI_TIMEOUT_MS debe ser un entero entre 1000 y 390000 (milisegundos).');
  }

  return { providers, models, unavailable, timeoutMs, problems };
}
