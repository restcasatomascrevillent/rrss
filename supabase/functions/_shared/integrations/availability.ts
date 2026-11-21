// ¿Qué integraciones están configuradas y listas en este entorno? Es lo que la
// interfaz pregunta para decidir qué enseña (src/features/platform/integrations/
// availability.ts). Solo booleanos: nunca un valor ni el nombre de lo que falta.
//
// Se calcula con la MISMA lógica con la que las funciones cargan cada servicio
// (los cargadores de config.ts de cada uno), sobre la configuración efectiva
// (base de datos y, si no, entorno). Que esté configurada no garantiza que la
// clave sea buena: eso lo dice «Probar conexión».
//
// Sin dependencias de Deno ni de Node: lo usan las funciones y las pruebas.
import type { MediaReader, MediaStorage } from '../ai/media/contract.ts';
import type { MediaModelRow } from '../ai/media/models.ts';
import { createMediaRuntime } from '../ai/media/runtime.ts';
import { loadAiTextConfig } from '../ai/text/config.ts';
import { transcriptionReady } from '../ai/transcription/config.ts';
import { loadLocalTestTextConfig } from '../ai/text/local-test.ts';
import { TEXT_UNITS } from '../ai/text/prompt.ts';
import { normalizeAppUrl } from '../billing/handlers.ts';
import { loadDriveConfig } from '../drive/config.ts';
import { loadSocialConfig } from '../social/config.ts';
import { loadMediaStorageConfig, mediaStorageReady } from '../storage/config.ts';
import type { Env } from './settings.ts';

export interface IntegrationAvailability {
  /** Publicar y medir en Instagram: hay claves de cifrado de los tokens. */
  publishing: boolean;
  /** Conectar por OAuth: además, la aplicación de Meta del producto. */
  socialOAuth: boolean;
  /** Conectar pegando un token de página (no necesita la aplicación del producto). */
  socialToken: boolean;
  aiText: boolean;
  aiImage: boolean;
  billing: boolean;
  /** Biblioteca con Google Drive: cliente OAuth, direcciones y claves de cifrado. */
  drive: boolean;
  /** Archivos de la biblioteca en Cloudflare R2: cuenta, clave y cubo. */
  mediaStorage: boolean;
  /** Subtítulos automáticos de los reels: OpenAI cargable (clave y criterio de la UE) con precio. */
  reelSubtitles: boolean;
}

export const NOTHING_AVAILABLE: IntegrationAvailability = {
  publishing: false,
  socialOAuth: false,
  socialToken: false,
  aiText: false,
  aiImage: false,
  billing: false,
  drive: false,
  mediaStorage: false,
  reelSubtitles: false,
};

const unused = () => {
  throw new Error('No se usa al calcular la disponibilidad');
};

function aiTextReady(env: Env): boolean {
  if (loadLocalTestTextConfig(env)) return true;
  const config = loadAiTextConfig(env);
  const loaded = new Set(config.providers.map((p) => p.id));
  return config.models.some((m) => {
    if (!loaded.has(m.provider)) return false;
    const needed: string[] = [TEXT_UNITS.input, TEXT_UNITS.output, TEXT_UNITS.cacheRead];
    if (m.provider !== 'mistral' && m.provider !== 'openai') needed.push(TEXT_UNITS.cacheWrite);
    return needed.every((unit) => m.microsPerUnit[unit] !== undefined);
  });
}

/** Lo mismo que necesita drive-media para conectar y servir imágenes. */
export function driveReady(config: ReturnType<typeof loadDriveConfig>): boolean {
  return config.client !== null && config.keyRing !== null && config.callbackUrl !== null && config.appUrl !== null;
}

/** Lanza solo si la configuración de una prueba local está mal puesta (la función tampoco arrancaría). */
export function computeAvailability(env: Env, imageModelRows: MediaModelRow[]): IntegrationAvailability {
  const social = loadSocialConfig(env, async () => {
    throw new Error('Sin red al calcular la disponibilidad');
  });
  const publishing = social.keyRing !== null;

  const runtime = createMediaRuntime({
    env,
    fetch: async () => unused(),
    rpc: async () => unused(),
    reader: { getGeneration: unused, getJob: unused } as unknown as MediaReader,
    storage: {} as MediaStorage,
    modelRows: imageModelRows,
  });

  const drive = loadDriveConfig(env, async () => unused());

  const webhook = (env.STRIPE_WEBHOOK_SECRET ?? '').split(',').some((s) => s.trim());
  return {
    publishing,
    socialOAuth: publishing && social.meta !== null && social.callbackUrl !== null && social.appUrl !== null,
    socialToken: publishing,
    aiText: aiTextReady(env),
    aiImage: runtime.imageChoices.length > 0,
    billing: Boolean(env.STRIPE_SECRET_KEY?.trim()) && webhook && normalizeAppUrl(env.BILLING_APP_URL) !== null,
    drive: driveReady(drive),
    mediaStorage: mediaStorageReady(loadMediaStorageConfig(env)),
    reelSubtitles: transcriptionReady(env),
  };
}
