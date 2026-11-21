// Servicio de imagen y vídeo generativos: el único punto de entrada.
//
//   pedir → elegir modelo → estimar → RESERVAR cupo → lanzar en el proveedor
//     · síncrono:   guardar el resultado → registrar el coste real
//     · asíncrono:  encolar un trabajo `ai.media.poll`; lo cierra quien llegue
//                   antes, el sondeo (processJob) o el webhook (handleWebhook)
//
// Las mismas garantías que el servicio de texto (`../service.ts`): no se llama
// a ningún proveedor sin cupo reservado, y lo reservado acaba siempre en coste
// real (salió bien) o devuelto entero (falló o nunca terminó). El cupo lo
// impone la base de datos (`ai_reserve_generation`), no este código.
//
// Idempotencia: el estado de la generación es el árbitro. Cerrar dos veces la
// misma generación no apunta dos costes (`ai_complete_generation`), y un
// webhook repetido o un sondeo tardío encuentran la generación ya cerrada y no
// hacen nada.
import { AiError, AiProviderFailure, type Json, type RpcClient } from '../contract.ts';
import {
  editOutputSize,
  IMAGE_EDIT_OPERATIONS,
  MEDIA_JOB_KIND,
  mediaKindOf,
  MediaProviderFailure,
  MediaRequestError,
  type ClaimedJob,
  type MediaEditOrigin,
  type MediaEstimate,
  type MediaGenerateParams,
  type MediaGenerateResult,
  type MediaJobResult,
  type MediaModel,
  type MediaOutputRef,
  type MediaProvenance,
  type MediaProvider,
  type MediaReader,
  type MediaRequest,
  type MediaService,
  type MediaStartResult,
  type MediaStorage,
  type MediaUsage,
  type MediaWebhookResult,
  type ProviderJobRef,
  type StoredMedia,
  type WebhookRequest,
} from './contract.ts';
import { download, isRecord, type FetchLike } from './http.ts';
import {
  dataHandlingOf,
  priceMediaUsage,
  resolveEditModel,
  resolveMediaModel,
  type ModelSelection,
  type ProviderAvailability,
} from './models.ts';

export interface MediaServiceConfig {
  /** Funciones SQL con la clave de servicio. */
  rpc: RpcClient;
  /** Lecturas con la clave de servicio (generaciones y trabajos). */
  reader: MediaReader;
  /** Dónde se guardan los resultados. */
  storage: MediaStorage;
  /** Para descargar los resultados que el proveedor entrega como URL. */
  fetch: FetchLike;
  /** Adaptadores disponibles y los que faltan, con su motivo (ver config.ts). */
  providers: ProviderAvailability;
  /** Modelos del registro `ai_media_models`. */
  models: MediaModel[];
  selection?: ModelSelection;
  /**
   * Dirección pública que atiende los webhooks. Sin ella no se pide webhook y
   * los trabajos asíncronos se resuelven solo por sondeo.
   */
  webhookBaseUrl?: string;
  /** Tiempo máximo de la llamada que lanza la generación. Por defecto, 120 s. */
  startTimeoutMs?: number;
  /** Tiempo máximo de un trabajo asíncrono antes de darlo por perdido. Por defecto, 30 min. */
  asyncDeadlineSeconds?: number;
  /** Sondeos por cada vez que se reclama el trabajo, y su separación. Por defecto, 1. */
  pollsPerClaim?: number;
  pollIntervalMs?: number;
  /** Veces que el trabajo de sondeo puede volver a la cola (máximo de la cola: 20). Por defecto, 12. */
  maxPollAttempts?: number;
  /** Tamaño máximo de un resultado. Por defecto, 200 MB. */
  maxDownloadBytes?: number;
  /** Duración máxima de un vídeo, además de la que imponga el modelo. Por defecto, 30 s. */
  maxVideoSeconds?: number;
  now?: () => number;
}

const DEFAULTS = {
  startTimeoutMs: 120_000,
  asyncDeadlineSeconds: 1800,
  pollsPerClaim: 1,
  pollIntervalMs: 5000,
  maxPollAttempts: 12,
  maxDownloadBytes: 200 * 1024 * 1024,
  maxVideoSeconds: 30,
};
/** Margen entre el tiempo máximo y la caducidad de la reserva de cupo. */
const RESERVATION_MARGIN_SECONDS = 300;
const MAX_RESERVATION_SECONDS = 86_400;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;

/** Lo que se guarda en la cola para poder cerrar la generación más tarde. Sin secretos. */
interface JobPayload {
  generation_id: string;
  provider: string;
  model: string;
  kind: 'image' | 'video';
  job: ProviderJobRef;
  reserve_micros: number;
  estimated_usage: MediaUsage;
  started_at: number;
  deadline_at: number;
  /** Para la procedencia del recurso: para qué se pidió, el encargo y quién lo pidió. */
  purpose?: string;
  prompt?: string;
  user_id?: string;
  /** Si es una edición de foto: de qué recurso sale (procedencia del resultado). */
  edit?: MediaEditOrigin;
}

function parseEdit(value: unknown): MediaEditOrigin | undefined {
  if (!isRecord(value)) return undefined;
  const { operation, sourceAssetId, sourceName, scale } = value;
  if (typeof operation !== 'string' || !(IMAGE_EDIT_OPERATIONS as readonly string[]).includes(operation)) {
    return undefined;
  }
  if (typeof sourceAssetId !== 'string') return undefined;
  return {
    operation: operation as MediaEditOrigin['operation'],
    sourceAssetId,
    ...(typeof sourceName === 'string' ? { sourceName } : {}),
    ...(typeof scale === 'number' ? { scale } : {}),
  };
}

function parsePayload(value: unknown): JobPayload | null {
  if (!isRecord(value) || !isRecord(value.job) || !isRecord(value.estimated_usage)) return null;
  const { generation_id, provider, model, kind, job, reserve_micros, estimated_usage, started_at, deadline_at } = value;
  if (typeof generation_id !== 'string' || typeof provider !== 'string' || typeof model !== 'string') return null;
  if (kind !== 'image' && kind !== 'video') return null;
  if (typeof job.id !== 'string' || typeof reserve_micros !== 'number') return null;
  if (typeof started_at !== 'number' || typeof deadline_at !== 'number') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const usage: MediaUsage = {};
  for (const [unit, amount] of Object.entries(estimated_usage)) if (typeof amount === 'number') usage[unit] = amount;
  return {
    generation_id,
    provider,
    model,
    kind,
    job: { id: job.id, statusUrl: text(job.statusUrl), resultUrl: text(job.resultUrl), cancelUrl: text(job.cancelUrl) },
    reserve_micros,
    estimated_usage: usage,
    started_at,
    deadline_at,
    purpose: text(value.purpose),
    prompt: text(value.prompt),
    user_id: text(value.user_id),
    edit: parseEdit(value.edit),
  };
}

function parseDetails(details: string | null | undefined): Json | undefined {
  if (!details) return undefined;
  try {
    return JSON.parse(details) as Json;
  } catch {
    return undefined;
  }
}

function field(row: unknown, name: string): string | null {
  if (isRecord(row) && typeof row[name] === 'string') return row[name];
  return null;
}

const jobKey = (generationId: string) => `ai-media:${generationId}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tipos de foto que se pueden editar con IA. */
const EDITABLE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Tope por defecto de la foto de entrada (36 MP) y del lado del resultado al ampliar. */
const DEFAULT_MAX_INPUT_PIXELS = 36_000_000;
const DEFAULT_MAX_OUTPUT_SIDE = 4096;
/** Tope de la máscara del sujeto (PNG). */
const MAX_MASK_BYTES = 1_000_000;

function numberSetting(model: MediaModel, name: string): number | undefined {
  const value = model.settings[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function validate(request: MediaRequest, model: MediaModel, maxVideoSeconds: number): void {
  if (request.kind === 'image_edit') {
    const { source } = request;
    if (!EDITABLE_MIME_TYPES.includes(source.mimeType)) {
      throw new MediaRequestError('Solo se pueden editar fotos JPEG, PNG o WebP.');
    }
    const valid = (n: number) => Number.isInteger(n) && n >= 16 && n <= 20_000;
    if (!valid(source.width) || !valid(source.height)) {
      throw new MediaRequestError('No se conocen las medidas de la foto: vuelve a subirla a la biblioteca.');
    }
    const maxInput = numberSetting(model, 'max_input_pixels') ?? DEFAULT_MAX_INPUT_PIXELS;
    if (source.width * source.height > maxInput) {
      throw new MediaRequestError(
        `La foto es demasiado grande para editarla con IA (más de ${Math.floor(maxInput / 1_000_000)} megapíxeles).`,
      );
    }
    if (request.operation === 'upscale') {
      if (request.scale !== 2 && request.scale !== 4) throw new MediaRequestError('Se puede ampliar ×2 o ×4.');
      const maxSide = numberSetting(model, 'max_output_side') ?? DEFAULT_MAX_OUTPUT_SIDE;
      const out = editOutputSize(request);
      if (Math.max(out.width, out.height) > maxSide) {
        throw new MediaRequestError(
          `Ampliada ×${request.scale} pasaría de ${maxSide} px por lado: la foto ya tiene resolución suficiente` +
            (request.scale === 4 ? ' (prueba ×2).' : '.'),
        );
      }
    } else if (request.scale !== undefined) {
      throw new MediaRequestError('Esta edición no admite factor de ampliación.');
    }
    if (request.operation === 'replace_background') {
      const text = request.prompt?.trim() ?? '';
      if (text === '') throw new MediaRequestError('Describe el fondo que quieres.');
      if (text.length > 500) throw new MediaRequestError('La descripción del fondo es demasiado larga (máximo 500 caracteres).');
    } else if (request.prompt !== undefined) {
      throw new MediaRequestError('Esta edición no admite descripción.');
    }
    if (request.subjectMask && request.subjectMask.bytes.byteLength > MAX_MASK_BYTES) {
      throw new MediaRequestError('La máscara del sujeto es demasiado grande.');
    }
    return;
  }
  if (!/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(request.aspectRatio)) {
    throw new MediaRequestError('La proporción debe tener la forma «ancho:alto», por ejemplo 4:5.');
  }
  if (request.kind === 'image') {
    if (request.prompt.trim() === '') throw new MediaRequestError('Falta la descripción de la imagen.');
    const { width, height } = request.size;
    const valid = (n: number) => Number.isInteger(n) && n >= 64 && n <= 8192;
    if (!valid(width) || !valid(height)) {
      throw new MediaRequestError('El tamaño de la imagen debe estar entre 64 y 8192 píxeles por lado.');
    }
    return;
  }
  if (!request.startImage.url && !request.startImage.bytes) {
    throw new MediaRequestError('Falta la imagen de la que parte el vídeo.');
  }
  const setting = (name: string) => {
    const value = model.settings[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const min = setting('min_seconds') ?? 1;
  const max = Math.min(setting('max_seconds') ?? maxVideoSeconds, maxVideoSeconds);
  if (!Number.isInteger(request.durationSeconds) || request.durationSeconds < min || request.durationSeconds > max) {
    throw new MediaRequestError(`La duración del vídeo debe estar entre ${min} y ${max} segundos enteros.`);
  }
}

export function createMediaService(config: MediaServiceConfig): MediaService {
  const options = {
    startTimeoutMs: config.startTimeoutMs ?? DEFAULTS.startTimeoutMs,
    asyncDeadlineSeconds: config.asyncDeadlineSeconds ?? DEFAULTS.asyncDeadlineSeconds,
    pollsPerClaim: Math.max(1, config.pollsPerClaim ?? DEFAULTS.pollsPerClaim),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    maxPollAttempts: Math.min(20, Math.max(1, config.maxPollAttempts ?? DEFAULTS.maxPollAttempts)),
    maxDownloadBytes: config.maxDownloadBytes ?? DEFAULTS.maxDownloadBytes,
    maxVideoSeconds: config.maxVideoSeconds ?? DEFAULTS.maxVideoSeconds,
  };
  const now = config.now ?? Date.now;
  const providers = new Map(config.providers.providers.map((provider) => [provider.id, provider]));

  /** Llama a una función SQL; un fallo de red se trata igual que un error devuelto. */
  async function rpc(fn: string, args: Record<string, unknown>): Promise<Awaited<ReturnType<RpcClient>>> {
    try {
      return await config.rpc(fn, args);
    } catch {
      return { data: null, error: { message: 'Sin conexión con la base de datos' } };
    }
  }

  function plan(request: MediaRequest) {
    const { model, provider } =
      request.kind === 'image_edit'
        ? resolveEditModel(request.operation, config.models, config.providers, config.selection)
        : resolveMediaModel(request.kind, config.models, config.providers, config.selection);
    validate(request, model, options.maxVideoSeconds);
    const usage = provider.estimateUsage(request, model);
    const priced = priceMediaUsage(model, usage);
    if (priced.unpriced.length > 0) {
      // Sin precio no se puede reservar ni cobrar: mejor no generar.
      throw new AiError('not_configured', 'El modelo configurado no tiene precio completo para esta petición.', {
        details: { model: model.model, unpriced: priced.unpriced },
      });
    }
    return { model, provider, usage, costMicros: Math.max(1, priced.micros) };
  }

  /** Guarda en el almacenamiento lo que entregó el proveedor (bytes o URL de descarga). */
  async function store(
    target: {
      organizationId: string;
      brandId: string;
      generationId: string;
      kind: 'image' | 'video';
      provenance?: MediaProvenance;
    },
    provider: MediaProvider,
    outputs: MediaOutputRef[],
  ): Promise<StoredMedia[]> {
    if (outputs.length === 0) {
      throw new MediaProviderFailure('bad_response', 'El proveedor dio la generación por terminada sin ningún archivo');
    }
    const assets: StoredMedia[] = [];
    for (const [index, output] of outputs.entries()) {
      let bytes = output.bytes;
      let mimeType = output.mimeType;
      if (!bytes) {
        if (!output.url) throw new MediaProviderFailure('bad_response', 'El proveedor no ha entregado el archivo');
        const file = await download(output.url, {
          fetch: config.fetch,
          provider: provider.id,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes: options.maxDownloadBytes,
        });
        bytes = file.bytes;
        mimeType = mimeType || file.contentType?.split(';')[0]?.trim() || 'application/octet-stream';
      }
      const { path, assetId } = await config.storage.put({
        organizationId: target.organizationId,
        brandId: target.brandId,
        generationId: target.generationId,
        kind: target.kind,
        provenance: target.provenance,
        index,
        mimeType,
        bytes,
      });
      assets.push({ kind: target.kind, path, mimeType, bytes: bytes.byteLength, ...(assetId ? { assetId } : {}) });
    }
    return assets;
  }

  /**
   * Cierra una generación que el proveedor terminó bien: guarda los archivos y
   * cambia la reserva por el coste real. Si el proveedor no informa del
   * consumo, o informa de algo sin precio, se cobra lo reservado.
   */
  async function settle(context: {
    generationId: string;
    organizationId: string;
    brandId: string;
    kind: 'image' | 'video';
    provider: MediaProvider;
    model: MediaModel | undefined;
    reserveMicros: number;
    estimatedUsage: MediaUsage;
    usage: MediaUsage | undefined;
    outputs: MediaOutputRef[];
    startedAt: number;
    providerRequestId: string | undefined;
    /** Para qué se pidió, el encargo, quién lo pidió y, si es una edición, de qué foto (procedencia del recurso). */
    origin?: { purpose?: string; prompt?: string; requestedBy?: string; edit?: MediaEditOrigin };
  }): Promise<{ assets: StoredMedia[]; usage: MediaUsage; costMicros: number }> {
    const provenance: MediaProvenance = {
      provider: context.provider.id,
      model: context.model?.model ?? '',
      ...context.origin,
      dataRegion: context.provider.dataRegion ?? context.model?.dataRegion ?? 'unknown',
      trainsOnInputs: context.model?.trainsOnInputs ?? 'unknown',
      untestedAdapter: !context.provider.testedAgainstRealService,
    };
    const assets = await store({ ...context, provenance }, context.provider, context.outputs);

    const usage = context.usage ?? context.estimatedUsage;
    let costMicros = context.reserveMicros;
    if (context.model) {
      const priced = priceMediaUsage(context.model, usage);
      costMicros = priced.unpriced.length > 0 ? Math.max(priced.micros, context.reserveMicros) : priced.micros;
    }

    const completion = await rpc('ai_complete_generation', {
      p_generation_id: context.generationId,
      p_cost_micros: costMicros,
      p_usage: usage,
      p_output: {
        assets: assets.map((a) => ({
          kind: a.kind,
          path: a.path,
          mime_type: a.mimeType,
          bytes: a.bytes,
          ...(a.assetId ? { asset_id: a.assetId } : {}),
        })),
        data_region: context.provider.dataRegion ?? context.model?.dataRegion ?? 'unknown',
        trains_on_inputs: context.model?.trainsOnInputs ?? 'unknown',
        untested_adapter: !context.provider.testedAgainstRealService,
      },
      p_latency_ms: Math.max(0, now() - context.startedAt),
      p_provider_request_id: context.providerRequestId,
    });
    if (completion.error) {
      // El gasto ya está hecho pero no se ha podido anotar: no se da por
      // cerrado. La reserva sigue contando y el siguiente intento lo repite.
      throw new AiError('internal', 'No se ha podido registrar el resultado de la IA. Inténtalo de nuevo.', {
        generationId: context.generationId,
        retryable: true,
      });
    }
    return { assets, usage, costMicros };
  }

  async function failGeneration(generationId: string, code: string, message: string, startedAt: number) {
    await rpc('ai_fail_generation', {
      p_generation_id: generationId,
      p_error_code: code,
      p_error_message: message,
      p_latency_ms: Math.max(0, now() - startedAt),
    });
  }

  function estimate(request: MediaRequest): MediaEstimate {
    const { model, provider, usage, costMicros } = plan(request);
    return {
      provider: provider.id,
      model: model.model,
      usage,
      costMicros,
      dataHandling: dataHandlingOf(model, provider),
    };
  }

  async function generate(params: MediaGenerateParams): Promise<MediaGenerateResult> {
    const { request } = params;
    const kind = mediaKindOf(request);
    const prompt = request.prompt;
    let edit: MediaEditOrigin | undefined;
    if (request.kind === 'image_edit') {
      // Para estimar basta con las medidas; para editar hace falta la foto.
      if (!request.source.url && !request.source.bytes)
        throw new MediaRequestError('Falta la foto que hay que editar.');
      if (!params.edit?.sourceAssetId) throw new MediaRequestError('Falta la foto de la biblioteca que se edita.');
      edit = {
        operation: request.operation,
        sourceAssetId: params.edit.sourceAssetId,
        ...(params.edit.sourceName ? { sourceName: params.edit.sourceName.slice(0, 120) } : {}),
        ...(request.scale ? { scale: request.scale } : {}),
      };
    }
    const { model, provider, usage: estimatedUsage, costMicros: reserveMicros } = plan(request);
    const asynchronous = typeof provider.poll === 'function';
    const ttlSeconds = asynchronous
      ? Math.min(MAX_RESERVATION_SECONDS, options.asyncDeadlineSeconds + RESERVATION_MARGIN_SECONDS)
      : Math.ceil(options.startTimeoutMs / 1000) + 60;

    // 1. Reservar cupo. Si no hay, aquí se acaba: no se llama a nadie.
    const reservation = await rpc('ai_reserve_generation', {
      p_user_id: params.userId,
      p_brand_id: params.brandId,
      p_task: kind,
      p_purpose: params.purpose,
      p_provider: provider.id,
      p_model: model.model,
      p_reserve_micros: reserveMicros,
      p_ttl_seconds: ttlSeconds,
    });
    if (reservation.error) {
      const { code, message, details } = reservation.error;
      if (code === 'AI001') throw new AiError('quota_exhausted', message, { details: parseDetails(details) });
      if (code === 'AI002') throw new AiError('quota_missing', message);
      // Planes (Fase 6): la tarea no está en el plan, o no queda espacio para el resultado.
      if (code === 'PL002') throw new AiError('quota_missing', message);
      if (code === 'PL001') throw new AiError('quota_exhausted', message);
      if (code === '42501') throw new AiError('forbidden', message);
      throw new AiError('internal', 'No se ha podido reservar el cupo de IA. Inténtalo de nuevo.', { retryable: true });
    }
    const generationId = field(reservation.data, 'id');
    const organizationId = field(reservation.data, 'organization_id');
    if (!generationId || !organizationId) {
      throw new AiError('internal', 'No se ha podido reservar el cupo de IA. Inténtalo de nuevo.');
    }

    const base = {
      generationId,
      provider: provider.id,
      model: model.model,
      estimatedCostMicros: reserveMicros,
      ...dataHandlingOf(model, provider),
    };

    // 2. Lanzar en el proveedor, con tiempo máximo.
    const startedAt = now();
    const controller = new AbortController();
    let started: MediaStartResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MediaProviderFailure('timeout', 'El proveedor no respondió a tiempo', { retryable: true }));
        }, options.startTimeoutMs);
      });
      const webhookUrl =
        config.webhookBaseUrl && provider.parseWebhook
          ? `${config.webhookBaseUrl}?provider=${encodeURIComponent(provider.id)}&generation=${generationId}`
          : undefined;
      const call = provider.start({
        request,
        model,
        idempotencyKey: generationId,
        webhookUrl,
        signal: controller.signal,
      });
      // Si gana el tiempo máximo, el fallo tardío del proveedor ya no interesa.
      call.catch(() => undefined);
      started = await Promise.race([call, timeout]);
    } catch (error) {
      // Falló: se devuelve la reserva. Solo se guarda el mensaje de los fallos
      // que el adaptador lanza a propósito; de los demás, nada que pueda llevar
      // un secreto. Si ni siquiera esto se puede anotar, la reserva caduca sola.
      const known = error instanceof AiProviderFailure ? error : null;
      await failGeneration(
        generationId,
        known?.code ?? 'unexpected',
        known?.message ?? 'Error inesperado del adaptador',
        startedAt,
      );
      const details: Json = {
        provider_code: known?.code ?? 'unexpected',
        retry_after_seconds: known instanceof MediaProviderFailure ? (known.retryAfterSeconds ?? null) : null,
      };
      if (known?.code === 'timeout') {
        throw new AiError('provider_timeout', 'La IA ha tardado demasiado en responder. No se ha consumido cupo.', {
          generationId,
          retryable: true,
          details,
        });
      }
      throw new AiError('provider_failed', 'La IA no ha podido completar la petición. No se ha consumido cupo.', {
        generationId,
        retryable: known?.retryable ?? false,
        details,
      });
    } finally {
      clearTimeout(timer);
    }

    // 3a. Síncrono: guardar y registrar el coste real.
    if (started.status === 'completed') {
      try {
        const settled = await settle({
          generationId,
          organizationId,
          brandId: params.brandId,
          kind,
          provider,
          model,
          reserveMicros,
          estimatedUsage,
          usage: started.usage,
          outputs: started.outputs,
          startedAt,
          providerRequestId: started.providerRequestId,
          origin: { purpose: params.purpose, prompt, requestedBy: params.userId, edit },
        });
        return { ...base, status: 'completed', ...settled };
      } catch (error) {
        if (error instanceof AiError) throw error;
        // El proveedor ya generó (y cobró), pero el archivo no se ha podido
        // guardar. El gasto es real: se apunta, sin resultado que entregar.
        await rpc('ai_complete_generation', {
          p_generation_id: generationId,
          p_cost_micros: reserveMicros,
          p_usage: started.usage ?? estimatedUsage,
          p_output: { assets: [], error: 'storage_failed' },
          p_latency_ms: Math.max(0, now() - startedAt),
          p_provider_request_id: started.providerRequestId,
        });
        throw new AiError('internal', 'La IA generó el resultado, pero no se ha podido guardar.', {
          generationId,
          retryable: true,
        });
      }
    }

    // 3b. Asíncrono: el resultado lo recogerá el sondeo o el webhook.
    const payload: JobPayload = {
      generation_id: generationId,
      provider: provider.id,
      model: model.model,
      kind,
      job: started.job,
      reserve_micros: reserveMicros,
      estimated_usage: estimatedUsage,
      started_at: startedAt,
      deadline_at: startedAt + options.asyncDeadlineSeconds * 1000,
      purpose: params.purpose,
      prompt,
      user_id: params.userId,
      ...(edit ? { edit } : {}),
    };
    const queued = await rpc('enqueue_job', {
      p_organization_id: organizationId,
      p_kind: MEDIA_JOB_KIND,
      p_payload: payload,
      p_idempotency_key: jobKey(generationId),
      p_brand_id: params.brandId,
      p_max_attempts: options.maxPollAttempts,
      p_run_after: new Date(now() + options.pollIntervalMs).toISOString(),
      p_created_by: params.userId,
    });
    const jobId = field(queued.data, 'id');
    if (queued.error || !jobId) {
      // Sin trabajo en la cola nadie recogería el resultado: se abandona.
      await provider.cancel?.(started.job, new AbortController().signal).catch(() => undefined);
      await failGeneration(generationId, 'enqueue_failed', 'No se pudo encolar el seguimiento del trabajo', startedAt);
      throw new AiError('internal', 'No se ha podido poner en marcha la generación. Inténtalo de nuevo.', {
        generationId,
        retryable: true,
      });
    }
    return { ...base, status: 'pending', jobId };
  }

  async function processJob(job: ClaimedJob, worker: string): Promise<MediaJobResult> {
    const payload = job.kind === MEDIA_JOB_KIND ? parsePayload(job.payload) : null;
    if (!payload) {
      await rpc('fail_job', {
        p_job_id: job.id,
        p_worker: worker,
        p_error: 'Trabajo de medios mal formado',
        p_retry: false,
      });
      return { status: 'failed', generationId: '', code: 'bad_job' };
    }
    const generationId = payload.generation_id;
    const provider = providers.get(payload.provider);
    const model = config.models.find((m) => m.provider === payload.provider && m.model === payload.model);
    const finishJob = (result: Json) => rpc('complete_job', { p_job_id: job.id, p_worker: worker, p_result: result });
    const failJob = (error: string, retry: boolean) =>
      rpc('fail_job', { p_job_id: job.id, p_worker: worker, p_error: error, p_retry: retry });

    /** Da el trabajo por perdido: se avisa al proveedor y se devuelve la reserva. */
    const giveUp = async (code: string, message: string): Promise<MediaJobResult> => {
      if (provider?.cancel) {
        await provider.cancel(payload.job, new AbortController().signal).catch(() => undefined);
      }
      await failGeneration(generationId, code, message, payload.started_at);
      return { status: 'failed', generationId, code };
    };

    /** Devuelve el trabajo a la cola (con espera creciente). Si ya no quedan intentos, se da por perdido. */
    const requeue = async (reason: string): Promise<MediaJobResult> => {
      const result = await failJob(reason, true);
      if (field(result.data, 'status') === 'failed') {
        return giveUp('never_finished', 'El proveedor no terminó el trabajo tras todos los intentos de consulta');
      }
      return { status: 'pending', generationId };
    };

    const generation = await config.reader.getGeneration(generationId).catch(() => undefined);
    if (generation === undefined) {
      // No se pudo leer: se reintenta más tarde sin tocar nada.
      return requeue('No se ha podido leer la generación');
    }
    if (!generation || generation.status !== 'reserved') {
      await finishJob({ status: 'already_closed' });
      return { status: 'already_closed', generationId };
    }

    if (!provider?.poll) {
      return requeue(`El adaptador «${payload.provider}» no está disponible para consultar el trabajo`);
    }

    for (let attempt = 1; attempt <= options.pollsPerClaim; attempt += 1) {
      let outcome;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
        try {
          outcome = await provider.poll(payload.job, model ?? fallbackModel(payload), controller.signal);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        // Un fallo al consultar (límite de uso, red, caída) no dice nada del
        // trabajo: puede seguir en marcha. Se vuelve a consultar más tarde.
        const known = error instanceof AiProviderFailure ? error : null;
        return requeue(known ? `No se pudo consultar el trabajo: ${known.message}` : 'No se pudo consultar el trabajo');
      }

      if (outcome.status === 'completed') {
        try {
          const settled = await settle({
            generationId,
            organizationId: generation.organization_id,
            brandId: generation.brand_id,
            kind: payload.kind,
            provider,
            model,
            reserveMicros: payload.reserve_micros,
            estimatedUsage: payload.estimated_usage,
            usage: outcome.usage,
            outputs: outcome.outputs,
            startedAt: payload.started_at,
            providerRequestId: payload.job.id,
            origin: {
              purpose: payload.purpose,
              prompt: payload.prompt,
              requestedBy: payload.user_id,
              edit: payload.edit,
            },
          });
          await finishJob({ status: 'completed', cost_micros: settled.costMicros });
          return { status: 'completed', generationId, assets: settled.assets, costMicros: settled.costMicros };
        } catch (error) {
          // El resultado existe pero no se ha podido guardar o anotar: se
          // reintenta (el proveedor conserva el archivo un tiempo).
          const known = error instanceof AiProviderFailure ? error : null;
          return requeue(
            known ? `No se pudo guardar el resultado: ${known.message}` : 'No se pudo guardar el resultado',
          );
        }
      }

      if (outcome.status === 'failed') {
        await failGeneration(generationId, outcome.code, outcome.message, payload.started_at);
        await failJob(outcome.message, false);
        return { status: 'failed', generationId, code: outcome.code };
      }

      if (now() >= payload.deadline_at) {
        // Trabajo que nunca termina: no se espera para siempre.
        const result = await giveUp('never_finished', 'El proveedor no terminó el trabajo en el tiempo máximo');
        await failJob('El proveedor no terminó el trabajo en el tiempo máximo', false);
        return result;
      }
      if (attempt < options.pollsPerClaim) await sleep(options.pollIntervalMs);
    }
    return requeue('El proveedor todavía no ha terminado');
  }

  /** Modelo mínimo para consultar un trabajo cuyo modelo ya no está en el registro. */
  function fallbackModel(payload: JobPayload): MediaModel {
    return {
      provider: payload.provider,
      model: payload.model,
      kind: payload.kind,
      displayName: payload.model,
      billingUnit: payload.kind === 'video' ? 'second' : 'image',
      priceMicros: 0,
      priceDetails: {},
      priceVerified: false,
      dataRegion: 'unknown',
      trainsOnInputs: 'unknown',
      delivery: 'async',
      settings: {},
      priority: 0,
      active: false,
    };
  }

  async function handleWebhook(
    providerId: string,
    generationId: string,
    request: WebhookRequest,
  ): Promise<MediaWebhookResult> {
    const provider = providers.get(providerId);
    if (!provider?.parseWebhook) {
      const missing = config.providers.unavailable.find((u) => u.id === providerId);
      throw new AiError(
        'not_configured',
        missing
          ? `No se puede atender el webhook de «${providerId}»: ${missing.reason}.`
          : `El proveedor «${providerId}» no admite webhooks.`,
      );
    }
    // Primero la firma: de un aviso sin autenticar no se cree nada.
    const event = await provider.parseWebhook(request);

    const generation = await config.reader.getGeneration(generationId);
    if (!generation || generation.provider !== providerId) {
      throw new MediaProviderFailure(
        'invalid_webhook',
        'El aviso no corresponde a ninguna generación de este proveedor',
      );
    }
    if (generation.status !== 'reserved') return { status: 'duplicate', generationId };

    const job = await config.reader.getJob(generation.organization_id, jobKey(generationId));
    const payload = job ? parsePayload(job.payload) : null;
    if (!payload || payload.job.id !== event.providerJobId) {
      throw new MediaProviderFailure('invalid_webhook', 'El aviso no corresponde al trabajo de esta generación');
    }

    if (event.outcome.status === 'pending') return { status: 'ignored', generationId };

    if (event.outcome.status === 'failed') {
      await failGeneration(generationId, event.outcome.code, event.outcome.message, payload.started_at);
      return { status: 'failed', generationId };
    }

    // Si guardar falla, el error sube: el proveedor reintentará el aviso y el
    // trabajo de sondeo sigue en la cola como red de seguridad.
    await settle({
      generationId,
      organizationId: generation.organization_id,
      brandId: generation.brand_id,
      kind: payload.kind,
      provider,
      model: config.models.find((m) => m.provider === payload.provider && m.model === payload.model),
      reserveMicros: payload.reserve_micros,
      estimatedUsage: payload.estimated_usage,
      usage: event.outcome.usage,
      outputs: event.outcome.outputs,
      startedAt: payload.started_at,
      providerRequestId: payload.job.id,
      origin: { purpose: payload.purpose, prompt: payload.prompt, requestedBy: payload.user_id, edit: payload.edit },
    });
    return { status: 'completed', generationId };
  }

  return { estimate, generate, processJob, handleWebhook };
}
