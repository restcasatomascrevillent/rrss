// Montaje del servicio de medios para las funciones del servidor (`ai-media`,
// `ai-media-poll`, `ai-media-webhook`): adaptadores según la configuración,
// modelos del registro y, solo en pruebas locales, la imagen simulada.
//
// Sin Deno ni supabase-js: recibe sus dependencias y se prueba en Node.
import type { RpcClient } from '../contract.ts';
import {
  IMAGE_EDIT_OPERATIONS,
  type DataRegion,
  type ImageEditOperation,
  type MediaModel,
  type MediaReader,
  type MediaService,
  type MediaStorage,
  type TrainsOnInputs,
} from './contract.ts';
import { createMediaProviders, mediaSelectionFromEnv, mediaWebhookBaseUrl, type MediaEnv } from './config.ts';
import type { FetchLike } from './http.ts';
import { loadLocalTestMediaConfig } from './local-test.ts';
import {
  dataHandlingOf,
  mediaModelsFromRows,
  operationOf,
  regionOf,
  resolveEditModel,
  resolveMediaModel,
  type MediaModelRow,
  type ModelSelection,
} from './models.ts';
import { createMediaService, type MediaServiceConfig } from './service.ts';

/** Un modelo de imagen que la interfaz puede ofrecer. */
export interface ImageModelChoice {
  /** `proveedor:modelo`. */
  id: string;
  displayName: string;
  delivery: 'sync' | 'async';
  dataRegion: DataRegion;
  euProcessing: boolean;
  trainsOnInputs: TrainsOnInputs;
  untestedAdapter: boolean;
  /** El que se usa si no se elige ninguno. */
  default: boolean;
}

/** Una edición de foto que el servidor puede hacer, con el modelo que la hará. */
export interface EditChoice {
  operation: ImageEditOperation;
  /** `proveedor:modelo`. */
  model: string;
  delivery: 'sync' | 'async';
  dataRegion: DataRegion;
  euProcessing: boolean;
  trainsOnInputs: TrainsOnInputs;
  untestedAdapter: boolean;
  /** El modelo usa la máscara del sujeto para proteger el plato al cambiar el fondo. */
  usesSubjectMask: boolean;
}

export interface MediaRuntime {
  /** Modelos de imagen activos cuyo adaptador está configurado y que el criterio de datos permite. */
  imageChoices: ImageModelChoice[];
  /**
   * Ediciones de foto con IA disponibles (quitar el fondo, ampliar): solo las
   * que tienen un modelo activo con su adaptador configurado y permitido por
   * el criterio de datos. Sin proveedor, la lista está vacía y la interfaz no
   * las enseña.
   */
  editChoices: EditChoice[];
  /** Servicio con el modelo elegido fijado (o el de por defecto). */
  serviceFor(choice?: string): MediaService;
  /** Avisos de configuración para el registro del servidor (nombres de variables, nunca valores). */
  problems: string[];
}

export interface MediaRuntimeDeps {
  env: MediaEnv;
  fetch: FetchLike;
  rpc: RpcClient;
  reader: MediaReader;
  storage: MediaStorage;
  /** Filas de `ai_media_models` (con la clave de servicio). */
  modelRows: MediaModelRow[];
  /** Opciones del servicio que las pruebas ajustan (tiempos, reloj). */
  serviceOptions?: Partial<
    Pick<MediaServiceConfig, 'pollIntervalMs' | 'pollsPerClaim' | 'asyncDeadlineSeconds' | 'startTimeoutMs' | 'now'>
  >;
}

export const modelKey = (model: Pick<MediaModel, 'provider' | 'model'>) => `${model.provider}:${model.model}`;

/**
 * Lanza `LocalTestConfigError` si la imagen simulada se pide fuera de un
 * Supabase local: la función no debe arrancar así.
 */
export function createMediaRuntime(deps: MediaRuntimeDeps): MediaRuntime {
  const availability = createMediaProviders(deps.env, { fetch: deps.fetch });
  const models = mediaModelsFromRows(deps.modelRows);
  const problems = availability.unavailable
    .filter((u) => !u.id.startsWith('simulated'))
    .map((u) => `${u.id}: ${u.reason}`);

  const localTest = loadLocalTestMediaConfig(deps.env);
  if (localTest) {
    availability.providers.push(...localTest.providers);
    models.push(...localTest.models, ...localTest.editModels);
    problems.push(...localTest.problems);
  }

  const selection: ModelSelection = mediaSelectionFromEnv(deps.env);
  const providers = new Map(availability.providers.map((p) => [p.id, p]));
  const fixed = selection.preferred?.image;

  let defaultId: string | undefined;
  try {
    defaultId = modelKey(resolveMediaModel('image', models, availability, selection).model);
  } catch {
    defaultId = undefined;
  }

  const imageChoices: ImageModelChoice[] = models
    .filter(
      (m) =>
        m.kind === 'image' &&
        operationOf(m) === 'generate' &&
        m.active &&
        providers.get(m.provider)?.kinds.includes('image'),
    )
    .filter((m) => {
      // Criterio de datos: los que no procesan en la UE solo si se permiten o se fijan a propósito.
      const region = regionOf(m, providers.get(m.provider));
      return region === 'eu' || selection.allowNonEu === true || modelKey(m) === fixed;
    })
    .sort((a, b) => b.priority - a.priority)
    .map((m) => {
      const provider = providers.get(m.provider)!;
      const region = regionOf(m, provider);
      return {
        id: modelKey(m),
        displayName: m.displayName,
        delivery: typeof provider.poll === 'function' ? 'async' : 'sync',
        dataRegion: region,
        euProcessing: region === 'eu',
        trainsOnInputs: m.trainsOnInputs,
        untestedAdapter: !provider.testedAgainstRealService,
        default: modelKey(m) === defaultId,
      } satisfies ImageModelChoice;
    });

  const editChoices: EditChoice[] = [];
  for (const operation of IMAGE_EDIT_OPERATIONS) {
    try {
      const { model, provider } = resolveEditModel(operation, models, availability, selection);
      editChoices.push({
        operation,
        model: modelKey(model),
        delivery: typeof provider.poll === 'function' ? 'async' : 'sync',
        ...dataHandlingOf(model, provider),
        usesSubjectMask: provider.subjectMaskEdits?.includes(operation) ?? false,
      });
    } catch {
      // Sin modelo para esta edición: no se ofrece.
    }
  }

  const base: MediaServiceConfig = {
    rpc: deps.rpc,
    reader: deps.reader,
    storage: deps.storage,
    fetch: deps.fetch,
    providers: availability,
    models,
    webhookBaseUrl: mediaWebhookBaseUrl(deps.env),
    ...deps.serviceOptions,
  };

  return {
    imageChoices,
    editChoices,
    problems,
    serviceFor(choice) {
      // Solo se puede fijar un modelo de los que se ofrecen: así nadie salta el
      // criterio de datos eligiendo a mano uno de fuera de la UE.
      const chosen = choice && imageChoices.some((c) => c.id === choice) ? choice : undefined;
      return createMediaService({
        ...base,
        selection: chosen ? { ...selection, preferred: { ...selection.preferred, image: chosen } } : selection,
      });
    },
  };
}
