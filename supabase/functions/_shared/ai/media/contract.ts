// Contrato de IMAGEN y VÍDEO generativos, independiente del proveedor.
//
// Convive con el contrato de texto (`../contract.ts`), del que solo toma los
// tipos compartidos (errores, cliente de RPC, JSON). Igual que aquel, es
// TypeScript puro: sin SDK, sin Deno, y las pruebas lo ejecutan tal cual.
//
//   pedir → elegir modelo → estimar coste → RESERVAR cupo → lanzar
//        → (si es asíncrono) encolar y esperar: sondeo o webhook
//        → descargar el resultado al almacenamiento → registrar el coste real
//
// Un proveedor nuevo es un `MediaProvider` más y unas filas en
// `ai_media_models`; nada de lo que hay fuera de esta carpeta cambia.
import { AiProviderFailure, type Json } from '../contract.ts';

export type MediaKind = 'image' | 'video';

/** Proporción «ancho:alto»: `1:1`, `4:5`, `9:16`, `16:9`… */
export type AspectRatio = `${number}:${number}`;

/**
 * Una imagen de entrada (foto del cliente, logotipo, primer fotograma). Unos
 * proveedores la quieren como URL pública y otros como bytes: quien llama da
 * lo que tenga (lo normal, una URL firmada de nuestro Storage) y el adaptador
 * dice con claridad si le falta la otra forma.
 */
export interface MediaInput {
  mimeType: string;
  /** URL que el proveedor pueda descargar. Nunca una URL con credenciales permanentes. */
  url?: string;
  bytes?: Uint8Array;
  /** Tamaño en píxeles, si se conoce: afina la estimación de los modelos que cobran la entrada. */
  width?: number;
  height?: number;
}

export interface ImageRequest {
  kind: 'image';
  /** Lo que se pide. El material del cliente va en `references`, no mezclado aquí. */
  prompt: string;
  /** Imágenes de referencia o a editar. */
  references?: MediaInput[];
  aspectRatio: AspectRatio;
  /** Tamaño del resultado en píxeles. Cada adaptador lo ajusta a lo que su modelo admite. */
  size: { width: number; height: number };
}

export interface VideoRequest {
  kind: 'video';
  /** Imagen de la que parte el vídeo (primer fotograma). */
  startImage: MediaInput;
  prompt?: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
}

/**
 * Edición de una foto que ya existe: quitar el fondo, ampliar la resolución,
 * cambiar el fondo por otro descrito con palabras o mejorar luz y color. Lo
 * que se puede hacer sin IA (recortes, luz, color, nitidez, poner un fondo
 * liso) lo hace el navegador, no esto (docs/edicion-fotos.md).
 */
export const IMAGE_EDIT_OPERATIONS = ['remove_background', 'upscale', 'replace_background', 'enhance'] as const;
export type ImageEditOperation = (typeof IMAGE_EDIT_OPERATIONS)[number];

export interface ImageEditRequest {
  kind: 'image_edit';
  operation: ImageEditOperation;
  /** La foto original, con sus medidas. El original no se toca: el resultado es un archivo nuevo. */
  source: MediaInput & { width: number; height: number };
  /** Solo para ampliar: cuántas veces más grande (2 o 4). */
  scale?: 2 | 4;
  /** Solo para cambiar el fondo: cómo debe quedar (texto de la persona). */
  prompt?: string;
  /**
   * Máscara del sujeto, OPCIONAL (interfaz para el recorte en el navegador o
   * en el servidor): un PNG con las MISMAS medidas que la foto, donde lo
   * OPACO es el sujeto (el plato) y lo transparente, el fondo. Con ella, el
   * proveedor que sepa usarla cambia solo el fondo. Sin ella, la IA puede
   * retocar también el plato y la interfaz lo avisa.
   */
  subjectMask?: { mimeType: 'image/png'; bytes: Uint8Array };
}

export type MediaRequest = ImageRequest | VideoRequest | ImageEditRequest;

/** Tipo de medio que produce una petición: una edición de foto produce una imagen. */
export function mediaKindOf(request: MediaRequest): MediaKind {
  return request.kind === 'video' ? 'video' : 'image';
}

/** Medidas del resultado de una edición: quitar el fondo conserva las de la foto; ampliar las multiplica. */
export function editOutputSize(request: ImageEditRequest): { width: number; height: number } {
  const factor = request.operation === 'upscale' ? (request.scale ?? 2) : 1;
  return { width: request.source.width * factor, height: request.source.height * factor };
}

/** Unidad en la que cobra un modelo. Coincide con `ai_media_models.billing_unit`. */
export type BillingUnit = 'image' | 'megapixel' | 'second';
export type DataRegion = 'eu' | 'us' | 'global' | 'unknown';
export type TrainsOnInputs = 'no' | 'yes' | 'unknown';

/**
 * Consumo de un medio, en las unidades con las que se cobra:
 * `images`, `megapixels`, `input_megapixels`, `seconds`.
 */
export type MediaUsage = Record<string, number>;

/** Un modelo del registro (`ai_media_models`), ya leído. */
export interface MediaModel {
  provider: string;
  model: string;
  kind: MediaKind;
  displayName: string;
  billingUnit: BillingUnit;
  /** Millonésimas por unidad de cobro. */
  priceMicros: number;
  priceDetails: { first_unit_micros?: number; input_megapixel_micros?: number };
  priceVerified: boolean;
  dataRegion: DataRegion;
  trainsOnInputs: TrainsOnInputs;
  delivery: 'sync' | 'async';
  /**
   * Qué hace el modelo: generar (por defecto) o una edición de foto. Un modelo
   * de edición nunca se elige para generar, ni al revés.
   */
  operation?: 'generate' | ImageEditOperation;
  /** Ajustes del modelo para su adaptador (nombres de campos, límites…). */
  settings: { [key: string]: Json | undefined };
  priority: number;
  active: boolean;
}

/** Resultado tal como lo entrega el proveedor: los bytes o una URL (temporal) de descarga. */
export interface MediaOutputRef {
  mimeType: string;
  url?: string;
  bytes?: Uint8Array;
}

/** Trabajo en curso en el proveedor. Se guarda en la cola: solo datos serializables, sin secretos. */
export interface ProviderJobRef {
  /** Identificador del trabajo en el proveedor. */
  id: string;
  /** URL de sondeo que devolvió el proveedor, si la da. */
  statusUrl?: string;
  /** URL del resultado, si es distinta de la de sondeo. */
  resultUrl?: string;
  cancelUrl?: string;
}

export type MediaOutcome =
  | { status: 'pending' }
  | {
      status: 'completed';
      outputs: MediaOutputRef[];
      /** Consumo real, si el proveedor lo informa; si no, se cobra lo estimado. */
      usage?: MediaUsage;
    }
  | { status: 'failed'; code: string; message: string; retryable?: boolean };

export type MediaStartResult =
  | { status: 'completed'; outputs: MediaOutputRef[]; usage?: MediaUsage; providerRequestId?: string }
  | { status: 'pending'; job: ProviderJobRef };

export interface MediaStartRequest {
  request: MediaRequest;
  model: MediaModel;
  /** Clave para que repetir el envío tras un fallo de red no cree otro trabajo. */
  idempotencyKey: string;
  /** Adónde debe avisar el proveedor al terminar, si admite webhooks. */
  webhookUrl?: string;
  signal: AbortSignal;
}

export interface WebhookRequest {
  /** Cabeceras con el nombre en minúsculas. */
  headers: Record<string, string>;
  /** Cuerpo sin interpretar: las firmas se calculan sobre estos bytes. */
  rawBody: string;
}

export interface WebhookEvent {
  /** Identificador del trabajo en el proveedor al que se refiere el aviso. */
  providerJobId: string;
  outcome: MediaOutcome;
}

/** Adaptador de un proveedor de imagen o vídeo. Es lo único que conoce su API. */
export interface MediaProvider {
  readonly id: string;
  readonly kinds: readonly MediaKind[];
  /** Ediciones de foto que sabe hacer (quitar el fondo, ampliar). Sin el campo, ninguna. */
  readonly edits?: readonly ImageEditOperation[];
  /** Ediciones en las que usa la máscara del sujeto (`ImageEditRequest.subjectMask`) para proteger el plato. */
  readonly subjectMaskEdits?: readonly ImageEditOperation[];
  /**
   * `false` mientras el adaptador solo se haya probado con respuestas HTTP
   * simuladas. Viaja con cada resultado para que nadie lo dé por contrastado.
   */
  readonly testedAgainstRealService: boolean;
  /**
   * Región a la que apunta de verdad el adaptador, cuando depende de cómo se
   * ha configurado (un mismo modelo puede servirse desde la UE o desde fuera).
   * Si está, manda sobre lo que diga el registro de modelos.
   */
  readonly dataRegion?: DataRegion;
  /**
   * Cota superior del consumo de una petición, sin llamar al proveedor. Con
   * ella y el precio del modelo se reserva el cupo antes de gastar nada.
   */
  estimateUsage(request: MediaRequest, model: MediaModel): MediaUsage;
  /** Lanza la generación: devuelve el resultado (síncrono) o el trabajo en curso (asíncrono). */
  start(request: MediaStartRequest): Promise<MediaStartResult>;
  /** Consulta un trabajo asíncrono. */
  poll?(job: ProviderJobRef, model: MediaModel, signal: AbortSignal): Promise<MediaOutcome>;
  /** Pide al proveedor que abandone un trabajo. Nunca lanza: es un «si se puede». */
  cancel?(job: ProviderJobRef, signal: AbortSignal): Promise<void>;
  /**
   * Comprueba la firma de un webhook y lo interpreta. Lanza
   * `MediaProviderFailure('invalid_webhook')` si no es auténtico.
   */
  parseWebhook?(request: WebhookRequest): Promise<WebhookEvent>;
}

/**
 * Fallo que un adaptador lanza a propósito. Su mensaje se guarda en el
 * registro de generaciones: no debe contener claves, cabeceras ni URL firmadas.
 *
 * Códigos: `rate_limited`, `timeout`, `network`, `auth`, `insufficient_credits`,
 * `invalid_request`, `moderated`, `provider_error`, `provider_unavailable`,
 * `bad_response`, `invalid_webhook`, `canceled`, `never_finished`.
 */
export class MediaProviderFailure extends AiProviderFailure {
  /** Segundos que el proveedor pide esperar antes de reintentar (límite de uso). */
  readonly retryAfterSeconds?: number;

  constructor(code: string, message: string, options: { retryable?: boolean; retryAfterSeconds?: number } = {}) {
    super(code, message, options);
    this.name = 'MediaProviderFailure';
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * La petición no se puede atender tal como viene (duración fuera de rango,
 * tamaño imposible…). Se detecta antes de reservar cupo. `message` está en
 * español y se puede enseñar a una persona.
 */
export class MediaRequestError extends Error {
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'MediaRequestError';
  }
}

/** Un medio ya guardado en nuestro almacenamiento. */
export interface StoredMedia {
  kind: MediaKind;
  path: string;
  mimeType: string;
  bytes: number;
  /** Recurso de la biblioteca (`media_assets.id`), si el almacenamiento lo crea. */
  assetId?: string;
}

/**
 * De dónde sale un medio generado: viaja hasta el almacenamiento para que el
 * recurso de la biblioteca diga que lo hizo una IA, cuál y con qué encargo.
 * Sin secretos ni URL firmadas.
 */
export interface MediaProvenance {
  provider: string;
  model: string;
  /** Para qué se pidió (`post.visual`…). */
  purpose?: string;
  /** El encargo tal como lo escribió la persona. */
  prompt?: string;
  /** Usuario en cuyo nombre se generó. */
  requestedBy?: string;
  dataRegion: DataRegion;
  trainsOnInputs: TrainsOnInputs;
  untestedAdapter: boolean;
  /** Si es una edición de una foto: cuál, de qué recurso sale y con qué factor. */
  edit?: MediaEditOrigin;
}

/** Edición de una foto de la biblioteca: el resultado apunta a su original. */
export interface MediaEditOrigin {
  operation: ImageEditOperation;
  /** `media_assets.id` de la foto original (que no se modifica). */
  sourceAssetId: string;
  /** Nombre del original, para el nombre legible del resultado. */
  sourceName?: string;
  scale?: number;
}

/**
 * Almacenamiento donde se dejan los resultados. Se inyecta: este módulo no
 * escribe en Storage. La implementación real debe usar la ruta
 * `<organización>/<marca>/…` (docs/02-modelo-de-datos.md, §2) y ser
 * idempotente: la misma generación e índice van siempre a la misma ruta, de
 * modo que guardar dos veces (sondeo y webhook a la vez) no duplica nada.
 */
export interface MediaStorage {
  put(object: {
    organizationId: string;
    brandId: string;
    generationId: string;
    kind: MediaKind;
    /** Posición del medio dentro de la generación. */
    index: number;
    mimeType: string;
    bytes: Uint8Array;
    /** Procedencia, para el recurso de la biblioteca. */
    provenance?: MediaProvenance;
  }): Promise<{ path: string; assetId?: string }>;
}

/** Lo que el servicio necesita leer de la base de datos (con la clave de servicio). */
export interface MediaReader {
  /** Generación por su identificador, o `null`. */
  getGeneration(
    id: string,
  ): Promise<{ id: string; organization_id: string; brand_id: string; provider: string; status: string } | null>;
  /** Trabajo de la cola con esa clave de idempotencia en la organización, o `null`. */
  getJob(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; status: string; payload: unknown } | null>;
}

export interface MediaGenerateParams {
  /** Usuario en cuyo nombre se genera (ya autenticado por quien llama). */
  userId: string;
  brandId: string;
  /** Para qué se pide: `post.visual`, `reel.clip`… Queda en el registro. */
  purpose: string;
  request: MediaRequest;
  /** Solo en ediciones: la foto de la biblioteca de la que sale el resultado. */
  edit?: Omit<MediaEditOrigin, 'operation' | 'scale'>;
}

/** Lo que se sabe del tratamiento de datos del modelo usado: viaja con cada resultado. */
export interface MediaDataHandling {
  dataRegion: DataRegion;
  /** `true` solo si el registro dice que el modelo procesa en la UE. */
  euProcessing: boolean;
  trainsOnInputs: TrainsOnInputs;
  /** El adaptador no se ha probado todavía contra el servicio real. */
  untestedAdapter: boolean;
}

interface MediaResultBase extends MediaDataHandling {
  generationId: string;
  provider: string;
  model: string;
  /** Lo que se estimó (y reservó) antes de generar. */
  estimatedCostMicros: number;
}

export type MediaGenerateResult =
  | (MediaResultBase & { status: 'completed'; assets: StoredMedia[]; usage: MediaUsage; costMicros: number })
  | (MediaResultBase & { status: 'pending'; jobId: string });

/** Trabajo de la cola (`jobs`) tal como lo entrega `claim_jobs`. */
export interface ClaimedJob {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

export type MediaJobResult =
  | { status: 'completed'; generationId: string; assets: StoredMedia[]; costMicros: number }
  | { status: 'failed'; generationId: string; code: string }
  /** Sigue en curso: el trabajo ha vuelto a la cola. */
  | { status: 'pending'; generationId: string }
  /** No había nada que hacer: la generación ya estaba cerrada (por el webhook, por ejemplo). */
  | { status: 'already_closed'; generationId: string };

export type MediaWebhookResult =
  | { status: 'completed'; generationId: string }
  | { status: 'failed'; generationId: string }
  /** Aviso repetido o de un trabajo que ya se cerró: se acepta sin hacer nada. */
  | { status: 'duplicate'; generationId: string }
  /** El proveedor avisa de un estado intermedio. */
  | { status: 'ignored'; generationId: string };

export interface MediaEstimate {
  provider: string;
  model: string;
  usage: MediaUsage;
  /** Cota superior del coste, en millonésimas. */
  costMicros: number;
  dataHandling: MediaDataHandling;
}

export interface MediaService {
  /** Coste máximo de una petición, sin generar ni reservar nada. */
  estimate(request: MediaRequest): MediaEstimate;
  /** Reserva cupo y genera. Si el proveedor es asíncrono, deja el trabajo en la cola. */
  generate(params: MediaGenerateParams): Promise<MediaGenerateResult>;
  /** Avanza un trabajo `ai.media.poll` ya reclamado de la cola por `worker`. */
  processJob(job: ClaimedJob, worker: string): Promise<MediaJobResult>;
  /** Atiende el webhook de un proveedor. Repetirlo no tiene efecto. */
  handleWebhook(providerId: string, generationId: string, request: WebhookRequest): Promise<MediaWebhookResult>;
}

/** Tipo de trabajo que este módulo deja en la cola. */
export const MEDIA_JOB_KIND = 'ai.media.poll';
