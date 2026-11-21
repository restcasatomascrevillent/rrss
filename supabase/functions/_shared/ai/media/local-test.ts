// Imagen simulada para la prueba de extremo a extremo en LOCAL, y la guarda
// que impide usarla en cualquier otro sitio. Es la misma guarda que la del
// texto (`../text/local-test.ts`) y la misma variable:
//   1. AI_E2E_SIMULATED_PROVIDER=true, explícita;
//   2. SUPABASE_URL de un Supabase local: http y host 127.0.0.1, localhost o
//      `kong` (el nombre del stack de la CLI dentro de Docker).
// Si la variable está y el Supabase no es local, la función no arranca. Si no
// está, este módulo no hace nada.
//
// Da dos modelos que no existen en `ai_media_models` (viven solo en memoria):
// uno síncrono y otro asíncrono (sin estado, para probar el sondeo). Su precio
// es inventado, para que el cupo y la estimación se vean con cifras distintas
// de cero. No es el precio de nadie.
import type { ImageEditOperation, MediaModel, MediaProvider } from './contract.ts';
import {
  createSimulatedAsyncImageProvider,
  createSimulatedImageEditProvider,
  createSimulatedImageProvider,
  SIMULATED_IMAGE_ASYNC_PROVIDER_ID,
  SIMULATED_IMAGE_EDIT_PROVIDER_ID,
  SIMULATED_IMAGE_PROVIDER_ID,
} from './simulated.ts';
import { isLocalSupabaseUrl, LOCAL_TEST_FLAG, LocalTestConfigError } from '../text/local-test.ts';

export const LOCAL_TEST_IMAGE_MODEL = 'simulado-e2e';
export const LOCAL_TEST_IMAGE_ASYNC_MODEL = 'simulado-e2e-asincrono';
/** Precio inventado por imagen (micros): 0,02 unidades de cuenta. */
export const LOCAL_TEST_IMAGE_PRICE_MICROS = 20_000;
/** Ediciones de foto simuladas (quitar el fondo, ampliar), también solo en memoria. */
export const LOCAL_TEST_EDIT_MODELS: Record<ImageEditOperation, string> = {
  remove_background: 'simulado-e2e-quitar-fondo',
  upscale: 'simulado-e2e-ampliar',
  replace_background: 'simulado-e2e-cambiar-fondo',
  enhance: 'simulado-e2e-mejorar',
};
/** Precio inventado por edición (micros): 0,01 unidades de cuenta. */
export const LOCAL_TEST_EDIT_PRICE_MICROS = 10_000;

export interface LocalTestMediaConfig {
  providers: MediaProvider[];
  /** Modelos de generar imágenes. */
  models: MediaModel[];
  /** Modelos de edición de fotos (quitar el fondo, ampliar). */
  editModels: MediaModel[];
  problems: string[];
}

function simulatedModel(provider: string, model: string, displayName: string, delivery: 'sync' | 'async'): MediaModel {
  return {
    provider,
    model,
    kind: 'image',
    displayName,
    billingUnit: 'image',
    priceMicros: LOCAL_TEST_IMAGE_PRICE_MICROS,
    priceDetails: {},
    priceVerified: true,
    // Se marca UE para que se pueda elegir sin AI_MEDIA_ALLOW_NON_EU: no sale de la máquina.
    dataRegion: 'eu',
    trainsOnInputs: 'no',
    delivery,
    settings: {},
    priority: delivery === 'sync' ? 100 : 99,
    active: true,
  };
}

/**
 * Proveedores y modelos simulados de imagen, o `null` si la variable no está.
 * Lanza `LocalTestConfigError` si está pero el Supabase no es local.
 */
export function loadLocalTestMediaConfig(env: Record<string, string | undefined>): LocalTestMediaConfig | null {
  const flag = env[LOCAL_TEST_FLAG]?.trim();
  if (!flag) return null;
  if (flag !== 'true') {
    throw new LocalTestConfigError(`${LOCAL_TEST_FLAG} solo admite el valor «true»; para no usarla, quítala.`);
  }
  if (!isLocalSupabaseUrl(env.SUPABASE_URL)) {
    throw new LocalTestConfigError(
      `${LOCAL_TEST_FLAG}=true solo se admite en pruebas locales: SUPABASE_URL debe ser http://127.0.0.1, http://localhost o http://kong (stack local de la CLI). Esta función no arranca; quita la variable.`,
    );
  }
  return {
    providers: [
      createSimulatedImageProvider(),
      createSimulatedAsyncImageProvider(),
      createSimulatedImageEditProvider(),
    ],
    models: [
      simulatedModel(SIMULATED_IMAGE_PROVIDER_ID, LOCAL_TEST_IMAGE_MODEL, 'Imagen simulada (pruebas locales)', 'sync'),
      simulatedModel(
        SIMULATED_IMAGE_ASYNC_PROVIDER_ID,
        LOCAL_TEST_IMAGE_ASYNC_MODEL,
        'Imagen simulada asíncrona (pruebas locales)',
        'async',
      ),
    ],
    editModels: (Object.entries(LOCAL_TEST_EDIT_MODELS) as [ImageEditOperation, string][]).map(
      ([operation, model]): MediaModel => ({
        ...simulatedModel(SIMULATED_IMAGE_EDIT_PROVIDER_ID, model, `Edición simulada: ${operation}`, 'sync'),
        operation,
        priceMicros: LOCAL_TEST_EDIT_PRICE_MICROS,
      }),
    ),
    problems: [`${LOCAL_TEST_FLAG}=true: imagen SIMULADA para pruebas locales. Nunca en un entorno con clientes.`],
  };
}
