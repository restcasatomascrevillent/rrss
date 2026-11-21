// Registro de modelos (`ai_media_models`): lectura, elección y precio.
//
// Aquí no hay ningún modelo ni ningún precio escrito: todo sale de la tabla.
import { AiError, type Json } from '../contract.ts';
import type {
  BillingUnit,
  DataRegion,
  ImageEditOperation,
  MediaDataHandling,
  MediaKind,
  MediaModel,
  MediaProvider,
  MediaUsage,
  TrainsOnInputs,
} from './contract.ts';

/** Fila de `ai_media_models` tal como la entrega la API (los bigint, como número o texto). */
export interface MediaModelRow {
  provider: string;
  model: string;
  task: string;
  display_name: string;
  billing_unit: string;
  price_micros: number | string;
  price_details: unknown;
  price_verified: boolean;
  data_region: string;
  trains_on_inputs: string;
  delivery: string;
  settings: unknown;
  priority: number;
  active: boolean;
  /** `generate` (por defecto) o una edición de foto (migración 20261128010000). */
  operation?: string | null;
}

const EDIT_OPERATIONS: readonly string[] = ['remove_background', 'upscale', 'replace_background', 'enhance'];

/** Qué hace un modelo: sin el campo, generar (así eran todos antes de la edición de fotos). */
export function operationOf(model: Pick<MediaModel, 'operation'>): 'generate' | ImageEditOperation {
  return model.operation ?? 'generate';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalMicros(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Convierte las filas del registro. Las que no se entienden se descartan: un modelo dudoso no se usa. */
export function mediaModelsFromRows(rows: MediaModelRow[]): MediaModel[] {
  const models: MediaModel[] = [];
  for (const row of rows) {
    const price = Number(row.price_micros);
    if (row.task !== 'image' && row.task !== 'video') continue;
    if (!['image', 'megapixel', 'second'].includes(row.billing_unit)) continue;
    if (!Number.isFinite(price) || price < 0) continue;
    const details = record(row.price_details);
    const operation = row.operation ?? 'generate';
    if (operation !== 'generate' && (row.task !== 'image' || !EDIT_OPERATIONS.includes(operation))) continue;
    models.push({
      provider: row.provider,
      model: row.model,
      kind: row.task,
      displayName: row.display_name,
      billingUnit: row.billing_unit as BillingUnit,
      priceMicros: price,
      priceDetails: {
        first_unit_micros: optionalMicros(details.first_unit_micros),
        input_megapixel_micros: optionalMicros(details.input_megapixel_micros),
      },
      priceVerified: row.price_verified === true,
      dataRegion: (['eu', 'us', 'global'].includes(row.data_region) ? row.data_region : 'unknown') as DataRegion,
      trainsOnInputs: (['no', 'yes'].includes(row.trains_on_inputs)
        ? row.trains_on_inputs
        : 'unknown') as TrainsOnInputs,
      delivery: row.delivery === 'async' ? 'async' : 'sync',
      operation: operation as 'generate' | ImageEditOperation,
      settings: record(row.settings) as { [key: string]: Json | undefined },
      priority: Number.isFinite(row.priority) ? row.priority : 0,
      active: row.active === true,
    });
  }
  return models;
}

/** Nombre de la unidad de consumo que corresponde a cada unidad de cobro. */
const USAGE_KEY: Record<BillingUnit, string> = { image: 'images', megapixel: 'megapixels', second: 'seconds' };

/**
 * Coste de un consumo con la tarifa del modelo, redondeado siempre hacia
 * arriba. `unpriced` lista lo que falta o no tiene precio: sin precio completo
 * no se reserva ni se cobra.
 */
export function priceMediaUsage(model: MediaModel, usage: MediaUsage): { micros: number; unpriced: string[] } {
  const unpriced: string[] = [];
  const unitKey = USAGE_KEY[model.billingUnit];
  const units = usage[unitKey];
  let total = 0;

  if (units === undefined || !Number.isFinite(units) || units < 0) {
    unpriced.push(unitKey);
  } else if (units > 0) {
    const first = model.priceDetails.first_unit_micros;
    total += first === undefined ? units * model.priceMicros : first + Math.max(0, units - 1) * model.priceMicros;
  }

  const inputMegapixels = usage.input_megapixels;
  if (inputMegapixels !== undefined) {
    if (!Number.isFinite(inputMegapixels) || inputMegapixels < 0) unpriced.push('input_megapixels');
    else total += inputMegapixels * (model.priceDetails.input_megapixel_micros ?? 0);
  }
  return { micros: Math.ceil(total), unpriced };
}

/** Región efectiva: la que declara el adaptador según su configuración o, si no, la del registro. */
export function regionOf(model: MediaModel, provider: MediaProvider | undefined): DataRegion {
  return provider?.dataRegion ?? model.dataRegion;
}

export function dataHandlingOf(model: MediaModel, provider: MediaProvider): MediaDataHandling {
  const dataRegion = regionOf(model, provider);
  return {
    dataRegion,
    euProcessing: dataRegion === 'eu',
    trainsOnInputs: model.trainsOnInputs,
    untestedAdapter: !provider.testedAgainstRealService,
  };
}

export interface ModelSelection {
  /** Modelo fijado por configuración para cada tipo: `proveedor:modelo`. */
  preferred?: Partial<Record<MediaKind, string>>;
  /**
   * Por defecto solo se eligen solos los modelos que procesan en la UE. Los
   * demás siguen disponibles, pero hay que fijarlos a propósito (`preferred`)
   * o permitirlos aquí.
   */
  allowNonEu?: boolean;
  /** Modelo fijado para cada edición de foto: `proveedor:modelo`. */
  preferredEdits?: Partial<Record<ImageEditOperation, string>>;
}

export interface ProviderAvailability {
  providers: MediaProvider[];
  /** Adaptadores que existen pero no se pueden usar, con el motivo (falta tal variable). */
  unavailable: { id: string; reason: string }[];
}

const KIND_LABEL: Record<MediaKind, string> = { image: 'imagen', video: 'vídeo' };

/**
 * Elige el modelo para un tipo de medio. Si no hay ninguno utilizable lanza
 * `AiError('not_configured')` diciendo exactamente qué falta.
 */
export function resolveMediaModel(
  kind: MediaKind,
  models: MediaModel[],
  availability: ProviderAvailability,
  selection: ModelSelection = {},
): { model: MediaModel; provider: MediaProvider } {
  const providers = new Map(availability.providers.map((p) => [p.id, p]));
  const usable = (model: MediaModel): MediaProvider | undefined => {
    const provider = providers.get(model.provider);
    return provider?.kinds.includes(kind) ? provider : undefined;
  };
  const whyNot = (providerId: string): string => {
    const missing = availability.unavailable.find((u) => u.id === providerId);
    return missing ? missing.reason : `no hay ningún adaptador «${providerId}» para ${KIND_LABEL[kind]}`;
  };

  const preferred = selection.preferred?.[kind];
  if (preferred) {
    const separator = preferred.indexOf(':');
    const providerId = separator > 0 ? preferred.slice(0, separator) : preferred;
    const modelName = separator > 0 ? preferred.slice(separator + 1) : '';
    const model = models.find(
      (m) => m.kind === kind && operationOf(m) === 'generate' && m.provider === providerId && m.model === modelName,
    );
    if (!model) {
      throw new AiError(
        'not_configured',
        `El modelo de ${KIND_LABEL[kind]} configurado («${preferred}») no está en el registro de modelos.`,
      );
    }
    if (!model.active) {
      throw new AiError(
        'not_configured',
        `El modelo de ${KIND_LABEL[kind]} configurado («${preferred}») está desactivado en el registro de modelos.`,
      );
    }
    const provider = usable(model);
    if (!provider) {
      throw new AiError(
        'not_configured',
        `El modelo de ${KIND_LABEL[kind]} configurado («${preferred}») no se puede usar: ${whyNot(providerId)}.`,
      );
    }
    return { model, provider };
  }

  const active = models
    .filter((m) => m.kind === kind && operationOf(m) === 'generate' && m.active)
    .sort((a, b) => b.priority - a.priority);
  if (active.length === 0) {
    throw new AiError(
      'not_configured',
      `No hay ningún modelo de ${KIND_LABEL[kind]} activo en el registro de modelos.`,
    );
  }
  const allowed = selection.allowNonEu ? active : active.filter((m) => regionOf(m, providers.get(m.provider)) === 'eu');
  if (allowed.length === 0) {
    throw new AiError(
      'not_configured',
      `Hay modelos de ${KIND_LABEL[kind]} activos, pero ninguno procesa los datos en la UE. ` +
        'Para usar uno hay que fijarlo a propósito en la configuración del servidor.',
    );
  }
  for (const model of allowed) {
    const provider = usable(model);
    if (provider) return { model, provider };
  }
  const reasons = [...new Set(allowed.map((m) => whyNot(m.provider)))].join('; ');
  throw new AiError('not_configured', `Ningún proveedor de ${KIND_LABEL[kind]} está disponible: ${reasons}.`);
}

export const EDIT_LABEL: Record<ImageEditOperation, string> = {
  remove_background: 'quitar el fondo',
  upscale: 'ampliar la resolución',
  replace_background: 'cambiar el fondo',
  enhance: 'mejorar la luz y el color',
};

/**
 * Elige el modelo de una edición de foto (quitar el fondo, ampliar). Mismas
 * reglas que `resolveMediaModel`: lo fijado manda; si no, el activo de más
 * prioridad que procese en la UE (salvo que se permitan los demás) y cuyo
 * adaptador sepa hacer esa edición. Sin ninguno, `AiError('not_configured')`.
 */
export function resolveEditModel(
  operation: ImageEditOperation,
  models: MediaModel[],
  availability: ProviderAvailability,
  selection: ModelSelection = {},
): { model: MediaModel; provider: MediaProvider } {
  const label = EDIT_LABEL[operation];
  const providers = new Map(availability.providers.map((p) => [p.id, p]));
  const usable = (model: MediaModel): MediaProvider | undefined => {
    const provider = providers.get(model.provider);
    return provider?.edits?.includes(operation) ? provider : undefined;
  };
  const whyNot = (providerId: string): string => {
    const missing = availability.unavailable.find((u) => u.id === providerId);
    return missing ? missing.reason : `el adaptador «${providerId}» no sabe ${label}`;
  };
  const candidates = models.filter((m) => m.kind === 'image' && operationOf(m) === operation);

  const preferred = selection.preferredEdits?.[operation];
  if (preferred) {
    const separator = preferred.indexOf(':');
    const providerId = separator > 0 ? preferred.slice(0, separator) : preferred;
    const modelName = separator > 0 ? preferred.slice(separator + 1) : '';
    const model = candidates.find((m) => m.provider === providerId && m.model === modelName);
    if (!model || !model.active) {
      throw new AiError(
        'not_configured',
        `El modelo para ${label} configurado («${preferred}») no está activo en el registro de modelos.`,
      );
    }
    const provider = usable(model);
    if (!provider) {
      throw new AiError(
        'not_configured',
        `El modelo para ${label} configurado («${preferred}») no se puede usar: ${whyNot(providerId)}.`,
      );
    }
    return { model, provider };
  }

  const active = candidates.filter((m) => m.active).sort((a, b) => b.priority - a.priority);
  if (active.length === 0) {
    throw new AiError('not_configured', `No hay ningún modelo para ${label} activo en el registro de modelos.`);
  }
  const allowed = selection.allowNonEu ? active : active.filter((m) => regionOf(m, providers.get(m.provider)) === 'eu');
  if (allowed.length === 0) {
    throw new AiError(
      'not_configured',
      `Hay modelos para ${label} activos, pero ninguno procesa los datos en la UE. ` +
        'Para usar uno hay que fijarlo a propósito en la configuración del servidor.',
    );
  }
  for (const model of allowed) {
    const provider = usable(model);
    if (provider) return { model, provider };
  }
  const reasons = [...new Set(allowed.map((m) => whyNot(m.provider)))].join('; ');
  throw new AiError('not_configured', `Ningún proveedor para ${label} está disponible: ${reasons}.`);
}

// ─────────────────────────── Geometría ───────────────────────────

/** Megapíxeles de una imagen, redondeados hacia arriba (así cobran los modelos por megapíxel). */
export function megapixels(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return Number.NaN;
  return Math.max(1, Math.ceil((width * height) / 1_000_000));
}
