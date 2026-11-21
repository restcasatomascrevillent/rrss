// Qué adaptadores se cargan, según la configuración del servidor.
//
// Las claves viven en las variables de entorno de las funciones del servidor
// (nunca en variables `VITE_`). Un adaptador sin su clave no se carga, y queda
// anotado con el nombre exacto de la variable que le falta para poder decirlo
// con claridad. Aquí no se elige proveedor: eso lo hacen el registro de
// modelos (qué está activo) y, si se quiere fijar uno, AI_MEDIA_*_MODEL.
import type { DataRegion, MediaProvider } from './contract.ts';
import { BFL_DEFAULT_BASE_URL, BFL_PROVIDER_ID, createBflImageProvider, isBflBaseUrl } from './bfl-image.ts';
import { COMFYUI_PROVIDER_ID, createComfyUiImageProvider, isComfyUiBaseUrl } from './comfyui-image.ts';
import { createFalVideoProvider, FAL_PROVIDER_ID } from './fal-video.ts';
import { createGoogleTokenSource, parseServiceAccount } from './google-auth.ts';
import { createHiggsfieldVideoProvider, HIGGSFIELD_PROVIDER_ID } from './higgsfield-video.ts';
import type { FetchLike } from './http.ts';
import { createIdeogramImageProvider, IDEOGRAM_PROVIDER_ID } from './ideogram-image.ts';
import { createOpenAiImageProvider, OPENAI_IMAGE_PROVIDER_ID } from './openai-image.ts';
import { openAiBaseUrlProblem } from '../text/openai.ts';
import type { ModelSelection, ProviderAvailability } from './models.ts';
import {
  createSimulatedImageProvider,
  createSimulatedVideoProvider,
  SIMULATED_IMAGE_PROVIDER_ID,
  SIMULATED_VIDEO_PROVIDER_ID,
} from './simulated.ts';
import { createVertexImageProvider, VERTEX_IMAGE_PROVIDER_ID } from './vertex-image.ts';
import { isLocalSupabaseUrl } from '../text/local-test.ts';

/** Variables de entorno, tal como las da `Deno.env.toObject()`. */
export type MediaEnv = Record<string, string | undefined>;

/** Nombres de todas las variables que lee este módulo (los mismos que en `.env.example`). */
export const MEDIA_ENV = {
  imageModel: 'AI_MEDIA_IMAGE_MODEL',
  videoModel: 'AI_MEDIA_VIDEO_MODEL',
  removeBackgroundModel: 'AI_MEDIA_REMOVE_BACKGROUND_MODEL',
  upscaleModel: 'AI_MEDIA_UPSCALE_MODEL',
  allowNonEu: 'AI_MEDIA_ALLOW_NON_EU',
  webhookBaseUrl: 'AI_MEDIA_WEBHOOK_BASE_URL',
  simulated: 'AI_MEDIA_SIMULATED',
  vertexProject: 'GOOGLE_VERTEX_PROJECT_ID',
  vertexLocation: 'GOOGLE_VERTEX_LOCATION',
  vertexServiceAccount: 'GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON',
  bflKey: 'BFL_API_KEY',
  bflBaseUrl: 'BFL_API_BASE_URL',
  ideogramKey: 'IDEOGRAM_API_KEY',
  openaiKey: 'OPENAI_API_KEY',
  openaiBaseUrl: 'OPENAI_BASE_URL',
  openaiOrganization: 'OPENAI_ORGANIZATION',
  openaiProject: 'OPENAI_PROJECT',
  higgsfieldKeyId: 'HIGGSFIELD_API_KEY_ID',
  higgsfieldKeySecret: 'HIGGSFIELD_API_KEY_SECRET',
  higgsfieldWebhookSecret: 'HIGGSFIELD_WEBHOOK_SECRET',
  falKey: 'FAL_KEY',
  comfyUiBaseUrl: 'COMFYUI_BASE_URL',
  comfyUiToken: 'COMFYUI_API_TOKEN',
  comfyUiDataRegion: 'COMFYUI_DATA_REGION',
} as const;

const value = (env: MediaEnv, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
};

const missing = (names: string[]) =>
  names.length === 1 ? `falta la variable ${names[0]}` : `faltan las variables ${names.join(' y ')}`;

/**
 * Carga los adaptadores que tienen su configuración completa y anota por qué
 * no se cargan los demás.
 */
export function createMediaProviders(env: MediaEnv, options: { fetch: FetchLike }): ProviderAvailability {
  const providers: MediaProvider[] = [];
  const unavailable: { id: string; reason: string }[] = [];
  const { fetch } = options;

  /** Carga un adaptador si no le falta ninguna variable; si su configuración es inválida, lo dice. */
  const load = (id: string, required: string[], create: () => MediaProvider) => {
    const absent = required.filter((name) => !value(env, name));
    if (absent.length > 0) {
      unavailable.push({ id, reason: missing(absent) });
      return;
    }
    try {
      providers.push(create());
    } catch (error) {
      unavailable.push({ id, reason: error instanceof Error ? error.message : 'configuración no válida' });
    }
  };

  // Imagen · Google (Gemini) por Vertex AI. Por defecto, multirregión UE.
  load(VERTEX_IMAGE_PROVIDER_ID, [MEDIA_ENV.vertexProject, MEDIA_ENV.vertexServiceAccount], () => {
    const account = parseServiceAccount(value(env, MEDIA_ENV.vertexServiceAccount));
    if (!account) throw new Error(`${MEDIA_ENV.vertexServiceAccount} no es el JSON de una cuenta de servicio`);
    return createVertexImageProvider({
      projectId: value(env, MEDIA_ENV.vertexProject)!,
      location: value(env, MEDIA_ENV.vertexLocation) ?? 'eu',
      getAccessToken: createGoogleTokenSource(account, { fetch }),
      fetch,
    });
  });

  // Imagen · Black Forest Labs (FLUX.2). Por defecto, host de la UE.
  load(BFL_PROVIDER_ID, [MEDIA_ENV.bflKey], () => {
    const baseUrl = value(env, MEDIA_ENV.bflBaseUrl) ?? BFL_DEFAULT_BASE_URL;
    if (!isBflBaseUrl(baseUrl)) {
      throw new Error(
        `${MEDIA_ENV.bflBaseUrl} debe ser https://api.eu.bfl.ai, https://api.us.bfl.ai o https://api.bfl.ai`,
      );
    }
    return createBflImageProvider({ apiKey: value(env, MEDIA_ENV.bflKey)!, baseUrl, fetch });
  });

  // Imagen · Ideogram.
  load(IDEOGRAM_PROVIDER_ID, [MEDIA_ENV.ideogramKey], () =>
    createIdeogramImageProvider({ apiKey: value(env, MEDIA_ENV.ideogramKey)!, fetch }),
  );

  // Imagen · OpenAI (GPT Image). La misma clave y dirección que el texto.
  load(OPENAI_IMAGE_PROVIDER_ID, [MEDIA_ENV.openaiKey], () => {
    const baseUrl = value(env, MEDIA_ENV.openaiBaseUrl);
    const problem = baseUrl ? openAiBaseUrlProblem(baseUrl) : null;
    if (problem) throw new Error(problem);
    return createOpenAiImageProvider({
      apiKey: value(env, MEDIA_ENV.openaiKey)!,
      baseUrl,
      organization: value(env, MEDIA_ENV.openaiOrganization),
      project: value(env, MEDIA_ENV.openaiProject),
      fetch,
    });
  });

  // Vídeo · Higgsfield. Sin HIGGSFIELD_WEBHOOK_SECRET funciona, pero solo por sondeo.
  load(HIGGSFIELD_PROVIDER_ID, [MEDIA_ENV.higgsfieldKeyId, MEDIA_ENV.higgsfieldKeySecret], () =>
    createHiggsfieldVideoProvider({
      keyId: value(env, MEDIA_ENV.higgsfieldKeyId)!,
      keySecret: value(env, MEDIA_ENV.higgsfieldKeySecret)!,
      webhookSecret: value(env, MEDIA_ENV.higgsfieldWebhookSecret),
      fetch,
    }),
  );

  // Vídeo · fal.ai.
  load(FAL_PROVIDER_ID, [MEDIA_ENV.falKey], () =>
    createFalVideoProvider({ apiKey: value(env, MEDIA_ENV.falKey)!, fetch }),
  );

  // Imagen · ComfyUI propio (modelos abiertos). Región: la que se declare.
  load(COMFYUI_PROVIDER_ID, [MEDIA_ENV.comfyUiBaseUrl], () => {
    const baseUrl = value(env, MEDIA_ENV.comfyUiBaseUrl)!;
    if (!isComfyUiBaseUrl(baseUrl)) {
      throw new Error(
        `${MEDIA_ENV.comfyUiBaseUrl} debe ser https (o http solo en localhost), sin usuario ni contraseña`,
      );
    }
    const region = value(env, MEDIA_ENV.comfyUiDataRegion) ?? 'unknown';
    if (!['eu', 'us', 'global', 'unknown'].includes(region)) {
      throw new Error(`${MEDIA_ENV.comfyUiDataRegion} debe ser eu, us, global o unknown`);
    }
    return createComfyUiImageProvider({
      baseUrl,
      token: value(env, MEDIA_ENV.comfyUiToken),
      dataRegion: region as DataRegion,
      fetch,
    });
  });

  // Simulados: solo si se piden a propósito Y contra un Supabase local. Nunca
  // en un entorno con clientes.
  const simulated = value(env, MEDIA_ENV.simulated) === 'true';
  if (simulated && isLocalSupabaseUrl(env.SUPABASE_URL)) {
    providers.push(createSimulatedImageProvider(), createSimulatedVideoProvider());
  } else {
    const reason = simulated
      ? `${MEDIA_ENV.simulated}=true solo se admite con un Supabase local (SUPABASE_URL http://127.0.0.1, localhost o kong)`
      : `solo se carga con ${MEDIA_ENV.simulated}=true y un Supabase local (pruebas)`;
    unavailable.push({ id: SIMULATED_IMAGE_PROVIDER_ID, reason }, { id: SIMULATED_VIDEO_PROVIDER_ID, reason });
  }

  return { providers, unavailable };
}

/** Qué modelo se fija para cada tipo y si se admiten los que no procesan en la UE. */
export function mediaSelectionFromEnv(env: MediaEnv): ModelSelection {
  const removeBackground = value(env, MEDIA_ENV.removeBackgroundModel);
  const upscale = value(env, MEDIA_ENV.upscaleModel);
  return {
    preferred: { image: value(env, MEDIA_ENV.imageModel), video: value(env, MEDIA_ENV.videoModel) },
    allowNonEu: value(env, MEDIA_ENV.allowNonEu) === 'true',
    // Solo si se fija alguno: quien no edita fotos ve la misma configuración que antes.
    ...(removeBackground || upscale ? { preferredEdits: { remove_background: removeBackground, upscale } } : {}),
  };
}

export function mediaWebhookBaseUrl(env: MediaEnv): string | undefined {
  const url = value(env, MEDIA_ENV.webhookBaseUrl);
  return url && /^https:\/\//.test(url) ? url : undefined;
}
