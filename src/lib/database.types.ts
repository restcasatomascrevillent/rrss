// Tipos de la base de datos, escritos a mano a partir de supabase/migrations.
// Cuando exista el proyecto de Supabase se sustituirán por los generados
// (`supabase gen types typescript`); hasta entonces este archivo es el contrato.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type OrgKind = 'business' | 'agency';
export type OrgRole = 'owner' | 'admin' | 'member';
export type BrandRole = 'manager' | 'editor' | 'reviewer' | 'client' | 'viewer';
export type BrandStatus = 'onboarding' | 'active' | 'archived';
export type ProfileStatus = 'active' | 'archived';
export type SourceKind = 'pdf' | 'document' | 'website' | 'json' | 'text' | 'image';
export type SourceStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type AssetKind = 'image' | 'video' | 'logo' | 'document' | 'audio' | 'template';
export type AssetOrigin = 'upload' | 'generated' | 'import';

export type ProfileRow = {
  user_id: string;
  email: string;
  full_name: string;
  locale: string;
  created_at: string;
  updated_at: string;
};

export type OrganizationRow = {
  id: string;
  name: string;
  kind: OrgKind;
  settings: Json;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationMemberRow = {
  organization_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
};

export type BrandRow = {
  id: string;
  organization_id: string;
  name: string;
  sector: string;
  website: string;
  timezone: string;
  default_locale: string;
  status: BrandStatus;
  /** Cómo se redacta con IA en la marca (migración 20261118230000). */
  ai_mode: BrandAiMode;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BrandMemberRow = {
  brand_id: string;
  organization_id: string;
  user_id: string;
  role: BrandRole;
  created_at: string;
};

export type BrandProfileRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  version: number;
  status: ProfileStatus;
  schema_version: number;
  data: Json;
  provenance: Json;
  change_note: string;
  created_by: string | null;
  created_at: string;
};

export type KnowledgeSourceRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  kind: SourceKind;
  title: string;
  storage_path: string | null;
  url: string | null;
  mime_type: string | null;
  bytes: number | null;
  status: SourceStatus;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MediaAssetRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  kind: AssetKind;
  origin: AssetOrigin;
  storage_path: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  sha256: string | null;
  folder: string;
  tags: string[];
  rights: Json;
  /** De dónde sale el recurso (p. ej. una exportación del editor). Se fija al crear; vacío si se subió a mano. */
  provenance: Json;
  /**
   * Dónde vive el archivo: en Storage o en Google Drive (migración 20261122010000).
   * Los de Drive tienen una ruta virtual `<org>/<marca>/drive/<id>` y solo los da
   * de alta el servidor. Opcionales aquí para no obligar a las pruebas antiguas.
   */
  source?: AssetSource;
  drive_connection_id?: string | null;
  drive_file_id?: string | null;
  /**
   * En qué almacén está el archivo de un recurso de Storage: Supabase Storage o
   * Cloudflare R2 (migración 20261124010000). Lo fija el servidor.
   */
  storage_backend?: StorageBackend;
  /**
   * Miniatura ligera (WebP de unos 400 px) en el mismo almacén que el original
   * (migración 20261209010000). Null si no se generó. Solo para mostrar en
   * cuadrículas: editar, exportar y publicar usan siempre el original.
   */
  thumb_path?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AssetSource = 'storage' | 'google_drive';

export type StorageBackend = 'supabase' | 'r2';

export type InvitationRow = {
  id: string;
  organization_id: string;
  email: string;
  org_role: OrgRole;
  brand_id: string | null;
  brand_role: BrandRole | null;
  token_hash: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type AuditLogRow = {
  id: number;
  organization_id: string;
  brand_id: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  data: Json;
  created_at: string;
};

export type AdminOrganizationRow = {
  id: string;
  name: string;
  kind: OrgKind;
  created_at: string;
  members: number;
  brands: number;
  assets: number;
  storage_bytes: number;
};

export type InvitationPreview = {
  organization_name: string;
  email: string;
  org_role: OrgRole;
  brand_name: string | null;
  brand_role: BrandRole | null;
  usable: boolean;
};

/** Archivos de Storage pendientes de borrar tras eliminar su recurso (los anota un disparador). */
export type StorageCleanupRow = {
  id: number;
  organization_id: string;
  brand_id: string;
  storage_path: string;
  storage_backend?: StorageBackend;
  created_at: string;
};

// ───────────── Fase 2 · Contenidos y versiones del documento ─────────────
// Migración 20261117100000_content_items_versions. El cliente crea la pieza y
// cambia su título, red y formato; el estado, las versiones y el archivado solo
// cambian por función. `data` es el documento por capas
// (src/features/content/document), validado en el cliente.

export type ContentStatus = 'idea' | 'draft' | 'in_review' | 'approved';

export type ContentItemRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  title: string;
  network: string;
  format: string;
  status: ContentStatus;
  /** Número de la última versión guardada; 0 = todavía sin documento. */
  current_version: number;
  archived_at: string | null;
  /** Lleva contenido generado con IA (su versión vigente). Ver el bloque de RGPD. */
  ai_generated?: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ContentVersionRow = {
  id: string;
  content_id: string;
  brand_id: string;
  organization_id: string;
  version: number;
  schema_version: number;
  data: Json;
  change_note: string;
  /** Si es una restauración, de qué versión se copió. */
  restored_from: number | null;
  /** El documento lleva contenido generado con IA. Ver el bloque de RGPD. */
  ai_generated?: boolean;
  created_by: string | null;
  created_at: string;
};

type ContentTables = {
  content_items: Table<
    ContentItemRow,
    { brand_id: string; organization_id: string; title: string; network: string; format: string },
    { title?: string; network?: string; format?: string }
  >;
  content_versions: Table<ContentVersionRow>;
};

type ContentFunctions = {
  // Quien edita la marca. Con p_expected_version fallan (CT001) si otra persona guardó antes.
  save_content_version: {
    Args: {
      p_content_id: string;
      p_data: Json;
      p_schema_version: number;
      p_change_note?: string;
      p_expected_version?: number | null;
    };
    Returns: ContentVersionRow;
  };
  restore_content_version: {
    Args: { p_content_id: string; p_version: number; p_change_note?: string; p_expected_version?: number | null };
    Returns: ContentVersionRow;
  };
  // Quien edita o aprueba, según el cambio. Aprobar exige p_expected_version.
  set_content_status: {
    Args: { p_content_id: string; p_status: ContentStatus; p_expected_version?: number | null };
    Returns: ContentItemRow;
  };
  archive_content_item: { Args: { p_content_id: string; p_archived?: boolean }; Returns: ContentItemRow };
};

type ContentEnums = {
  content_status: ContentStatus;
};

// ───────────────────── fin del bloque de contenidos ─────────────────────

// ───────────── Fase 2 · IA (generaciones, consumo, cupos) y cola de trabajos ─────────────
// Migraciones 20261116110000_ai_usage_quotas y 20261116111000_jobs. El cliente
// solo lee estas tablas; las funciones de servidor exigen la clave de servicio.
// Los importes van en millonésimas («micros») de la moneda de cuenta.

export type AiTask = 'text' | 'vision' | 'image' | 'video' | 'transcription' | 'embedding';
export type AiGenerationStatus = 'reserved' | 'succeeded' | 'failed' | 'expired';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type QuotaMetric = 'ai_cost_micros';

export type UsageQuotaRow = {
  organization_id: string;
  metric: QuotaMetric;
  period: 'month';
  limit_value: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AiGenerationRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  requested_by: string | null;
  task: AiTask;
  purpose: string;
  provider: string;
  model: string;
  status: AiGenerationStatus;
  period_start: string;
  reserved_micros: number;
  reserved_until: string;
  cost_micros: number | null;
  usage: Json;
  output: Json | null;
  latency_ms: number | null;
  provider_request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
};

export type AiUsageRow = {
  id: number;
  organization_id: string;
  brand_id: string | null;
  generation_id: string;
  period_start: string;
  entry: 'reserve' | 'settle' | 'release';
  reserved_delta_micros: number;
  cost_delta_micros: number;
  created_at: string;
};

export type JobRow = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  kind: string;
  payload: Json;
  status: JobStatus;
  priority: number;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_by: string | null;
  locked_until: string | null;
  result: Json | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type AiCostByOrganizationRow = {
  organization_id: string;
  organization_name: string | null;
  generations: number;
  cost_micros: number;
};

type Phase2Tables = {
  usage_quotas: Table<UsageQuotaRow>;
  ai_generations: Table<AiGenerationRow>;
  ai_usage: Table<AiUsageRow>;
  jobs: Table<JobRow>;
};

type Phase2Functions = {
  // Superadministradores.
  admin_set_ai_quota: { Args: { p_organization_id: string; p_monthly_limit_micros: number }; Returns: UsageQuotaRow };
  // Administradores de la organización (y superadministradores, para todas).
  ai_cost_by_organization: { Args: { p_from: string; p_to: string }; Returns: AiCostByOrganizationRow[] };
  // Solo con la clave de servicio.
  ai_reserve_generation: {
    Args: {
      p_user_id: string;
      p_brand_id: string;
      p_task: AiTask;
      p_purpose: string;
      p_provider: string;
      p_model: string;
      p_reserve_micros: number;
      p_ttl_seconds?: number;
    };
    Returns: AiGenerationRow;
  };
  ai_complete_generation: {
    Args: {
      p_generation_id: string;
      p_cost_micros: number;
      p_usage?: Json;
      p_output?: Json | null;
      p_latency_ms?: number | null;
      p_provider_request_id?: string | null;
    };
    Returns: AiGenerationRow;
  };
  ai_fail_generation: {
    Args: { p_generation_id: string; p_error_code: string; p_error_message?: string; p_latency_ms?: number | null };
    Returns: AiGenerationRow;
  };
  enqueue_job: {
    Args: {
      p_organization_id: string;
      p_kind: string;
      p_payload: Json;
      p_idempotency_key: string;
      p_brand_id?: string | null;
      p_priority?: number;
      p_max_attempts?: number;
      p_run_after?: string | null;
      p_created_by?: string | null;
    };
    Returns: JobRow;
  };
  claim_jobs: {
    Args: { p_worker: string; p_kinds?: string[] | null; p_limit?: number; p_lease_seconds?: number };
    Returns: JobRow[];
  };
  complete_job: { Args: { p_job_id: string; p_worker: string; p_result?: Json | null }; Returns: JobRow };
  fail_job: { Args: { p_job_id: string; p_worker: string; p_error: string; p_retry?: boolean }; Returns: JobRow };
  cancel_job: { Args: { p_job_id: string }; Returns: JobRow };
  release_job: { Args: { p_job_id: string; p_worker: string }; Returns: JobRow };
  extend_job_lease: { Args: { p_job_id: string; p_worker: string; p_lease_seconds?: number }; Returns: JobRow };
};

type Phase2Enums = {
  ai_task: AiTask;
  ai_generation_status: AiGenerationStatus;
  job_status: JobStatus;
};

// ───────────────────────────── fin del bloque de la Fase 2 ─────────────────────────────

// ───────────── Fase 2 · IA de medios: registro de modelos de imagen y vídeo ─────────────
// Migración 20261117110000_ai_media_models. Catálogo de la plataforma: lo lee
// cualquier usuario con sesión y solo lo escribe un superadministrador.
// `price_micros` va en millonésimas de `price_currency` por unidad de cobro.

export type AiMediaTask = Extract<AiTask, 'image' | 'video'>;
export type AiMediaBillingUnit = 'image' | 'megapixel' | 'second';
export type AiMediaDataRegion = 'eu' | 'us' | 'global' | 'unknown';
export type AiMediaTrainsOnInputs = 'no' | 'yes' | 'unknown';
export type AiMediaOperation = 'generate' | 'remove_background' | 'upscale' | 'replace_background' | 'enhance';

export type AiMediaModelRow = {
  id: string;
  provider: string;
  model: string;
  task: AiMediaTask;
  /** Qué hace: generar o una edición de foto (migración 20261128010000). */
  operation: AiMediaOperation;
  display_name: string;
  billing_unit: AiMediaBillingUnit;
  price_micros: number;
  price_details: Json;
  price_currency: string;
  price_checked_on: string;
  price_source: string;
  /** Un modelo con el precio sin verificar no se puede activar. */
  price_verified: boolean;
  data_region: AiMediaDataRegion;
  trains_on_inputs: AiMediaTrainsOnInputs;
  delivery: 'sync' | 'async';
  settings: Json;
  priority: number;
  active: boolean;
  notes: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type AiMediaModelUpdate = Partial<
  Pick<
    AiMediaModelRow,
    | 'model'
    | 'display_name'
    | 'billing_unit'
    | 'price_micros'
    | 'price_details'
    | 'price_currency'
    | 'price_checked_on'
    | 'price_source'
    | 'price_verified'
    | 'data_region'
    | 'trains_on_inputs'
    | 'delivery'
    | 'settings'
    | 'priority'
    | 'active'
    | 'notes'
    | 'operation'
  >
>;

type AiMediaModelInsert = Pick<
  AiMediaModelRow,
  | 'provider'
  | 'model'
  | 'task'
  | 'display_name'
  | 'billing_unit'
  | 'price_micros'
  | 'price_checked_on'
  | 'price_source'
  | 'data_region'
  | 'trains_on_inputs'
  | 'delivery'
> &
  Omit<AiMediaModelUpdate, 'model'>;

type Phase2MediaTables = {
  ai_media_models: Table<AiMediaModelRow, AiMediaModelInsert, AiMediaModelUpdate>;
};

// ─────────────────────── fin del bloque de IA de medios (Fase 2) ───────────────────────

// ──────────── Fase 2 · Imágenes generadas con IA: procedencia en la biblioteca ────────────
// Migración 20261118210000_ai_media_images. La procedencia va en
// `media_assets.provenance` (columna de la exportación, 20261118120000) con
// `type: 'ai_generation'`; ese tipo solo lo puede escribir el servidor.

export type MediaAssetAiProvenance = {
  type: 'ai_generation';
  generation_id: string;
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  prompt?: string | null;
  data_region?: AiMediaDataRegion;
  trains_on_inputs?: AiMediaTrainsOnInputs;
  untested_adapter?: boolean;
};

/** Lo que la generación deja en `ai_generations.output` (servicio de medios). */
export type AiMediaGenerationOutput = {
  assets?: { kind: string; path: string; mime_type: string; bytes: number; asset_id?: string }[];
  error?: string;
};

// ──────────────── fin del bloque de imágenes generadas con IA (Fase 2) ────────────────

// ───────────── Fase 3 · Trabajos de medios encargados desde la aplicación ─────────────
// Migración 20261118220000_media_jobs_library. Quien edita una marca encarga un
// reel o un recorte con `request_media_job` (sin clave de servicio); el estado
// se lee de `jobs` (RLS: quien ve la marca). Al completarse, el resultado se da
// de alta en `media_assets` con su procedencia (columna común `provenance`,
// `type` = 'media_job'), y `jobs.result.assets` lo apunta.

export type MediaJobKind = 'media.reel.template' | 'media.image.process';

type MediaJobFunctions = {
  request_media_job: {
    Args: { p_brand_id: string; p_kind: MediaJobKind; p_input: Json; p_idempotency_key: string };
    Returns: JobRow;
  };
};

// ─────────────────── fin del bloque de trabajos de medios (Fase 3) ───────────────────

// ───────────── Modo agencia · Encargos ─────────────
// Migración 20261118230000_content_requests. El cliente solo lee estas tablas;
// todo cambio pasa por las funciones (pedir, comentar, tomar, entregar…).

/** api: el servicio de IA de la plataforma · agency: se pide a la agencia. */
export type BrandAiMode = 'api' | 'agency';

export type ContentRequestStatus =
  'requested' | 'in_progress' | 'delivered' | 'changes_requested' | 'accepted' | 'cancelled';

export type ContentRequestRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  title: string;
  /** Lo escribe el cliente: dato, nunca instrucciones. */
  brief: string;
  network: string;
  format: string;
  media_kind: 'image' | 'video' | null;
  reference_asset_ids: string[];
  desired_date: string | null;
  status: ContentRequestStatus;
  content_id: string | null;
  delivered_version: number | null;
  requested_by: string | null;
  claimed_by: string | null;
  claim_token: string | null;
  claimed_until: string | null;
  delivered_by: string | null;
  delivered_at: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ContentRequestCommentRow = {
  id: string;
  request_id: string;
  brand_id: string;
  organization_id: string;
  kind: 'comment' | 'status';
  status: ContentRequestStatus | null;
  body: string;
  author_id: string | null;
  created_at: string;
};

type RequestTables = {
  content_requests: Table<ContentRequestRow>;
  content_request_comments: Table<ContentRequestCommentRow>;
};

type RequestFunctions = {
  create_content_request: {
    Args: {
      p_brand_id: string;
      p_title: string;
      p_brief: string;
      p_network: string;
      p_format: string;
      p_media_kind?: 'image' | 'video' | null;
      p_reference_asset_ids?: string[];
      p_desired_date?: string | null;
      p_content_id?: string | null;
    };
    Returns: ContentRequestRow;
  };
  comment_content_request: { Args: { p_request_id: string; p_body: string }; Returns: ContentRequestCommentRow };
  pending_content_requests: { Args: Record<string, never>; Returns: ContentRequestRow[] };
  take_content_request: {
    Args: { p_request_id: string; p_claim_token?: string | null; p_lease_minutes?: number };
    Returns: ContentRequestRow;
  };
  release_content_request: {
    Args: { p_request_id: string; p_claim_token?: string | null };
    Returns: ContentRequestRow;
  };
  deliver_content_request: {
    Args: {
      p_request_id: string;
      p_data: Json;
      p_schema_version: number;
      p_claim_token?: string | null;
      p_title?: string | null;
      p_change_note?: string | null;
    };
    Returns: ContentRequestRow;
  };
  request_content_request_changes: { Args: { p_request_id: string; p_message: string }; Returns: ContentRequestRow };
  accept_content_request: { Args: { p_request_id: string }; Returns: ContentRequestRow };
  cancel_content_request: { Args: { p_request_id: string; p_reason?: string }; Returns: ContentRequestRow };
};

type RequestEnums = {
  content_request_status: ContentRequestStatus;
};

// ─────────────────────── fin del bloque de encargos ───────────────────────

// ───────────── Pulido de la Fase 2 (migraciones 2026111911…) ─────────────
// Cancelar un trabajo de medios desde la aplicación (20261119111000).

// Avisos de encargos dentro de la aplicación (20261119113000): los escribe la
// base de datos; cada persona lee los suyos y los marca como leídos por RPC.
export type RequestNotificationKind = 'request_created' | 'request_delivered';

export type RequestNotificationRow = {
  id: string;
  user_id: string;
  request_id: string;
  brand_id: string;
  organization_id: string;
  kind: RequestNotificationKind;
  created_at: string;
  read_at: string | null;
};

// Recursos provisionales (20261119112000): logotipos subidos desde el perfil y
// aún sin guardar. El plazo lo pone la base de datos; el cliente solo lo pide al subir.
type PolishTables = {
  request_notifications: Table<RequestNotificationRow>;
  media_assets: Table<
    // Opcional en la fila para no cambiar `MediaAssetRow` (lo usan muchas pantallas).
    { provisional_until?: string | null },
    { provisional_until?: string | null },
    Record<never, never>
  >;
};

type PolishFunctions = {
  /** Cancela un reel o un recorte en cola o en curso de una marca que se edita. */
  cancel_media_job: { Args: { p_job_id: string }; Returns: JobRow };
  /** Marca como leídos los avisos propios de una marca (o de un encargo). Devuelve cuántos. */
  mark_request_notifications_read: { Args: { p_brand_id: string; p_request_id?: string | null }; Returns: number };
};

// ─────────────────────── fin del bloque de pulido ───────────────────────

// ───────── Texto de las fuentes y tipografías de la marca (20261119210000 y 20261119211000) ─────────

/** Columnas de la extracción de texto de una fuente (sin el texto, que pesa). */
export type SourceExtractionColumns = {
  extracted_chars: number | null;
  /** Detalle: páginas del PDF, páginas web leídas u omitidas y por qué, si se recortó… */
  extraction: Json | null;
  extracted_at: string | null;
  extraction_job_id: string | null;
};

/** Fuente tal como se lista: sin el texto extraído. */
export type KnowledgeSourceListRow = KnowledgeSourceRow & SourceExtractionColumns;

/** El texto extraído de una fuente: solo se pide al revisarlo o al proponer el perfil. */
export type KnowledgeSourceTextRow = Pick<KnowledgeSourceRow, 'id' | 'title' | 'kind'> & {
  extracted_text: string | null;
  extracted_chars: number | null;
};

export type FontFormat = 'woff2' | 'woff' | 'ttf' | 'otf';
export type FontStyle = 'normal' | 'italic';

export type BrandFontRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  family: string;
  weight: number;
  style: FontStyle;
  format: FontFormat;
  storage_path: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  license_confirmed: boolean;
  license_note: string | null;
  created_by: string | null;
  created_at: string;
};

/** Tipografía que usarán los reels de la marca (vacío: la de reserva del trabajador). */
export type ReelFontInfo = Pick<BrandFontRow, 'family' | 'weight' | 'style' | 'format'> & { font_id: string };

type SourceFontTables = {
  brand_fonts: Table<
    BrandFontRow,
    {
      brand_id: string;
      organization_id: string;
      family: string;
      weight?: number;
      style?: FontStyle;
      format: FontFormat;
      storage_path: string;
      file_name: string;
      mime_type: string;
      bytes: number;
      license_confirmed: boolean;
      license_note?: string | null;
    }
  >;
};

type SourceFontFunctions = {
  request_source_extraction: { Args: { p_source_id: string }; Returns: KnowledgeSourceRow & SourceExtractionColumns };
  brand_reel_font_info: { Args: { p_brand_id: string }; Returns: ReelFontInfo[] };
};

// ───────── fin del bloque de texto de las fuentes y tipografías ─────────
// ───────────── Publicación (Fase 3) ─────────────
// Migraciones 20261119010000 a 20261119040000. El cliente solo lee estas
// tablas; todo cambio pasa por funciones. Los tokens de las cuentas no están
// aquí (viven cifrados en el esquema `private`, sin acceso desde el cliente).

export type SocialNetwork = 'instagram' | 'facebook';
export type SocialAccountStatus = 'active' | 'needs_reauth' | 'disconnected';

export type SocialAccountRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  network: SocialNetwork;
  provider: string;
  external_id: string;
  username: string;
  display_name: string;
  page_id: string | null;
  status: SocialAccountStatus;
  scopes: string[];
  token_expires_at: string | null;
  token_checked_at: string | null;
  quota_usage: number | null;
  quota_total: number | null;
  quota_checked_at: string | null;
  last_error: string | null;
  connected_by: string | null;
  connected_at: string;
  disconnected_at: string | null;
  /** Por OAuth o pegando un token (20261120010000). */
  connection_method: SocialConnectionMethod;
  created_at: string;
  updated_at: string;
};

export type PublicationStatus = 'planned' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export type PublicationHoldReason =
  | 'not_approved'
  | 'content_changed'
  | 'content_archived'
  | 'no_account'
  | 'account_disconnected'
  | 'account_needs_reauth'
  | 'no_media'
  | 'invalid_media'
  | 'unsupported_format';

export type ScheduledPublicationRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  content_id: string;
  content_version: number | null;
  social_account_id: string | null;
  network: string;
  format: string;
  scheduled_at: string;
  media_asset_ids: string[];
  status: PublicationStatus;
  hold_reason: PublicationHoldReason | null;
  generation: number;
  attempt_count: number;
  last_error_code: string | null;
  last_error: string | null;
  container_id: string | null;
  container_created_at: string | null;
  /** Identificador que dio la red: solo existe si está publicada. */
  external_id: string | null;
  external_url: string | null;
  published_at: string | null;
  locked_by: string | null;
  locked_until: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicationAttemptOutcome =
  'started' | 'waiting' | 'deferred' | 'published' | 'recovered' | 'retrying' | 'failed' | 'not_ready';

export type PublicationAttemptRow = {
  id: string;
  publication_id: string;
  brand_id: string;
  organization_id: string;
  attempt_no: number;
  job_id: string | null;
  worker: string | null;
  outcome: PublicationAttemptOutcome;
  container_id: string | null;
  external_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

export type ContentCommentKind = 'comment' | 'approved' | 'unapproved' | 'changes_requested';

export type ContentCommentRow = {
  id: string;
  content_id: string;
  brand_id: string;
  organization_id: string;
  version: number | null;
  kind: ContentCommentKind;
  body: string;
  author_id: string | null;
  created_at: string;
};

type PublicationTables = {
  social_accounts: Table<SocialAccountRow>;
  scheduled_publications: Table<ScheduledPublicationRow>;
  publication_attempts: Table<PublicationAttemptRow>;
  content_comments: Table<ContentCommentRow>;
};

// ───────────── Importar publicaciones y plantillas de diseño (20261201010000) ─────────────

export type SocialImportStatus = 'running' | 'paused' | 'completed';
export type SocialImportPhase = 'listing' | 'copying' | 'done';

export type SocialImportRunRow = {
  id: string;
  social_account_id: string;
  brand_id: string;
  organization_id: string;
  status: SocialImportStatus;
  phase: SocialImportPhase;
  copy_images: boolean;
  after_cursor: string | null;
  pages: number;
  items_seen: number;
  items_new: number;
  copied: number;
  copy_failed: number;
  retry_after: string | null;
  lease_until: string | null;
  last_error: string | null;
  started_by: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type SocialImportedMediaRow = {
  id: string;
  social_account_id: string;
  brand_id: string;
  organization_id: string;
  network: 'instagram';
  external_id: string;
  caption: string | null;
  media_type: string;
  media_product_type: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  published_at: string | null;
  children: Json;
  copy_status: 'none' | 'pending' | 'copied' | 'failed' | 'skipped';
  copy_error: string | null;
  asset_ids: string[];
  copied_at: string | null;
  first_imported_at: string;
  last_seen_at: string;
};

export type BrandDesignTemplateRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  template_key: string;
  name: string;
  network: string;
  format: string;
  document: Json;
  analysis: Json;
  source: 'instagram_import' | 'manual';
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ImportTables = {
  social_import_runs: Table<SocialImportRunRow>;
  social_imported_media: Table<SocialImportedMediaRow>;
  brand_design_templates: Table<BrandDesignTemplateRow>;
};

type ImportFunctions = {
  delete_design_template: { Args: { p_template_id: string }; Returns: undefined };
};

type PublicationFunctions = {
  social_oauth_begin: { Args: { p_brand_id: string; p_network: SocialNetwork }; Returns: string };
  disconnect_social_account: { Args: { p_account_id: string }; Returns: SocialAccountRow };
  save_publication: {
    Args: {
      p_publication_id: string | null;
      p_content_id: string;
      p_scheduled_at: string;
      p_social_account_id?: string | null;
      p_media_asset_ids?: string[];
      p_content_version?: number | null;
    };
    Returns: ScheduledPublicationRow;
  };
  reschedule_publication: {
    Args: { p_publication_id: string; p_scheduled_at: string };
    Returns: ScheduledPublicationRow;
  };
  cancel_publication: { Args: { p_publication_id: string }; Returns: ScheduledPublicationRow };
  retry_publication: { Args: { p_publication_id: string }; Returns: ScheduledPublicationRow };
  publish_publication_now: {
    Args: {
      p_content_id: string;
      p_social_account_id: string | null;
      p_media_asset_ids: string[];
      p_content_version: number | null;
      p_publication_id?: string | null;
    };
    Returns: ScheduledPublicationRow;
  };
  publication_publish_kick: { Args: { p_publication_id: string }; Returns: string };
  comment_content_item: {
    Args: { p_content_id: string; p_body: string; p_version?: number | null };
    Returns: ContentCommentRow;
  };
  request_content_changes: { Args: { p_content_id: string; p_message: string }; Returns: ContentItemRow };
  approve_content_items: {
    Args: { p_items: Json };
    Returns: { content_id: string; ok: boolean; message: string | null }[];
  };
};

type PublicationEnums = {
  publication_status: PublicationStatus;
};

// ─────────────────────── fin del bloque de publicación ───────────────────────

// ───────────── Fase 6 · Planes, suscripciones y facturación ─────────────
// Migración 20261119310000_plans_subscriptions. Importes en micros de la moneda
// de cuenta de la plataforma (la misma que los costes de IA).

export type BillingInterval = 'month' | 'year';
export type SubscriptionStatus =
  'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
export type SubscriptionSource = 'default' | 'manual' | 'stripe';
export type PlanFeature = 'ai_text' | 'ai_image' | 'ai_video' | 'reels' | 'publishing';

export type PlanRow = {
  id: string;
  code: string;
  name: string;
  description: string;
  price_micros: number;
  billing_interval: BillingInterval;
  max_brands: number | null;
  max_members: number | null;
  max_storage_bytes: number | null;
  ai_monthly_micros: number;
  features: PlanFeature[];
  is_public: boolean;
  is_default: boolean;
  active: boolean;
  stripe_price_id: string | null;
  sort_order: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Lo que un superadministrador puede escribir de un plan (`code` solo al crearlo). */
export type PlanUpdate = Partial<
  Pick<
    PlanRow,
    | 'name'
    | 'description'
    | 'price_micros'
    | 'billing_interval'
    | 'max_brands'
    | 'max_members'
    | 'max_storage_bytes'
    | 'ai_monthly_micros'
    | 'features'
    | 'is_public'
    | 'active'
    | 'stripe_price_id'
    | 'sort_order'
  >
>;
export type PlanInsert = PlanUpdate & { code: string; name: string };

export type SubscriptionRow = {
  organization_id: string;
  plan_id: string | null;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  custom_price_micros: number | null;
  note: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingEventRow = {
  id: string;
  type: string;
  organization_id: string | null;
  outcome: 'received' | 'applied' | 'ignored';
  detail: string;
  received_at: string;
};

/** `organization_plan_usage()`: plan efectivo, suscripción y uso frente a límites. */
export type OrganizationPlanUsage = {
  plan: Pick<
    PlanRow,
    | 'code'
    | 'name'
    | 'description'
    | 'price_micros'
    | 'billing_interval'
    | 'max_brands'
    | 'max_members'
    | 'max_storage_bytes'
    | 'ai_monthly_micros'
    | 'features'
  >;
  subscription: {
    source: SubscriptionSource;
    status: SubscriptionStatus;
    assigned_plan_code: string | null;
    custom_price_micros: number | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    has_billing_account: boolean;
  };
  usage: {
    brands: number;
    members: number;
    pending_invitations: number;
    storage_bytes: number;
    ai_committed_micros: number;
  };
  ai_limit_micros: number;
  ai_limit_overridden: boolean;
  period_start: string;
};

export type BillingOverviewRow = {
  organization_id: string;
  organization_name: string;
  kind: OrgKind;
  plan_code: string;
  plan_name: string;
  assigned_plan_code: string | null;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  custom_price_micros: number | null;
  monthly_revenue_micros: number;
  ai_cost_micros: number;
  margin_micros: number;
  ai_limit_micros: number;
  ai_limit_overridden: boolean;
  brands: number;
  members: number;
  storage_bytes: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

type BillingTables = {
  plans: Table<PlanRow, PlanInsert, PlanUpdate>;
  subscriptions: Table<SubscriptionRow>;
  billing_events: Table<BillingEventRow>;
};

type BillingFunctions = {
  // Propietarios y administradores de la organización (y superadministradores).
  organization_plan_usage: { Args: { p_organization_id: string }; Returns: OrganizationPlanUsage };
  // Superadministradores.
  admin_billing_overview: { Args: { p_period_start: string }; Returns: BillingOverviewRow[] };
  admin_set_organization_plan: {
    Args: {
      p_organization_id: string;
      p_plan_id: string | null;
      p_custom_price_micros?: number | null;
      p_note?: string;
    };
    Returns: SubscriptionRow;
  };
  admin_set_default_plan: { Args: { p_plan_id: string }; Returns: PlanRow };
  admin_clear_ai_quota: { Args: { p_organization_id: string }; Returns: undefined };
};

type BillingEnums = {
  billing_interval: BillingInterval;
  subscription_status: SubscriptionStatus;
  subscription_source: SubscriptionSource;
};

// ─────────────────────── fin del bloque de planes ───────────────────────

// ───────────── Fase 4 · Campañas ─────────────
// Migración 20261119510000_campaigns. El cliente solo lee estas tablas; todo
// cambio pasa por las funciones (crear con IA, pedir a la agencia, entregar,
// aceptar, descartar). El plan tiene la forma de src/features/campaigns/plan.ts.

export type CampaignStatus = 'requested' | 'proposed' | 'accepted' | 'discarded';
export type CampaignOrigin = 'ai' | 'agency';
export type CampaignPlanSource = 'ai' | 'agency' | 'edit';

export type CampaignRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  title: string;
  /** Lo escribe una persona: dato, nunca instrucciones. */
  instruction: string;
  networks: string[];
  starts_on: string;
  ends_on: string;
  origin: CampaignOrigin;
  status: CampaignStatus;
  current_plan_version: number;
  accepted_plan_version: number | null;
  created_by: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CampaignPlanRow = {
  id: string;
  campaign_id: string;
  brand_id: string;
  organization_id: string;
  version: number;
  data: Json;
  source: CampaignPlanSource;
  generation_id: string | null;
  created_by: string | null;
  created_at: string;
};

export type CampaignContentRow = {
  campaign_id: string;
  content_id: string;
  brand_id: string;
  organization_id: string;
  plan_version: number;
  piece_index: number;
  created_at: string;
};

/** Encargo con lo que añade la migración de campañas (tipo «plan»). */
export type CampaignRequestRow = ContentRequestRow & {
  kind: 'piece' | 'plan';
  campaign_id: string | null;
  delivered_plan_version: number | null;
};

type CampaignTables = {
  campaigns: Table<CampaignRow>;
  campaign_plans: Table<CampaignPlanRow>;
  campaign_contents: Table<CampaignContentRow>;
};

type CampaignFunctions = {
  create_campaign: {
    Args: {
      p_brand_id: string;
      p_title: string;
      p_instruction: string;
      p_networks: string[];
      p_starts_on: string;
      p_ends_on: string;
      p_plan: Json;
      p_generation_id: string;
    };
    Returns: CampaignRow;
  };
  request_campaign_plan: {
    Args: {
      p_brand_id: string;
      p_title: string;
      p_instruction: string;
      p_networks: string[];
      p_starts_on: string;
      p_ends_on: string;
    };
    Returns: CampaignRow;
  };
  deliver_campaign_plan: {
    Args: { p_request_id: string; p_plan: Json; p_claim_token?: string | null; p_note?: string | null };
    Returns: CampaignRequestRow;
  };
  accept_campaign_plan: {
    Args: { p_campaign_id: string; p_expected_version: number; p_plan: Json; p_drafts: Json };
    Returns: CampaignRow;
  };
  discard_campaign: { Args: { p_campaign_id: string; p_reason?: string }; Returns: CampaignRow };
};

type CampaignEnums = {
  campaign_status: CampaignStatus;
};

// ─────────────────────── fin del bloque de campañas ───────────────────────

// ───────────── RGPD · Aceptaciones, acceso, portabilidad y supresión ─────────────
// Migraciones 20261119410000_rgpd_derechos y 20261119411000_contenido_generado_ia.
// Borrar (cuenta u organización) no tiene RPC para el cliente: lo hacen las
// Edge Functions `delete-account` y `delete-organization` con la clave de servicio.
// `content_items.ai_generated` y `content_versions.ai_generated` los calcula la
// base de datos al guardar cada versión (opcionales en los tipos de arriba para
// no romper las filas escritas a mano en las pruebas).

export type LegalDocument = 'terms' | 'privacy';

export type LegalAcceptanceRow = {
  id: number;
  user_id: string;
  document: LegalDocument;
  version: string;
  accepted_at: string;
  source: 'signup' | 'app';
};

export type AccountDeletionCheck = {
  /** Organizaciones donde es la única propietaria y hay más miembros: bloquean el borrado. */
  blocking: { organization_id: string; name: string; members: number }[];
  /** Organizaciones donde es el único miembro: se borran con la cuenta. */
  deleted_with_account: { organization_id: string; name: string }[];
};

type RgpdTables = {
  legal_acceptances: Table<LegalAcceptanceRow>;
};

type RgpdFunctions = {
  accept_legal_documents: {
    Args: { p_terms_version: string; p_privacy_version: string };
    Returns: LegalAcceptanceRow[];
  };
  /** JSON con los datos personales de quien llama (formato `rrss.personal-data`). */
  export_my_data: { Args: Record<string, never>; Returns: Json };
  /** Solo propietarios. JSON `rrss.organization-export` con la lista de archivos (rutas). */
  export_organization_data: { Args: { p_organization_id: string }; Returns: Json };
  my_account_deletion_check: { Args: Record<string, never>; Returns: AccountDeletionCheck };
};

// ─────────────────────────── fin del bloque de RGPD ───────────────────────────

// ─────────────────────── Analítica (Fase 5) ───────────────────────
// Migraciones 20261119610000 a 20261119630000. Cifras capturadas por el
// servidor (`social-insights`); el navegador solo las lee.

export type AnalyticsMetricScope = 'account' | 'media';
export type AnalyticsMetricStatus = 'captured' | 'not_captured' | 'retired';

export type AnalyticsMetricDefinitionRow = {
  id: string;
  network: 'instagram' | 'facebook';
  scope: AnalyticsMetricScope;
  api_name: string | null;
  api_source: 'insights' | 'field' | null;
  label: string;
  description: string;
  unit: 'count' | 'milliseconds';
  aggregation: 'daily' | 'snapshot' | 'lifetime';
  media_types: string[];
  estimated: boolean;
  in_development: boolean;
  status: AnalyticsMetricStatus;
  status_note: string;
  delay_hours: number;
  source_url: string;
  verified_on: string;
  sort: number;
};

export type AccountMetricDailyRow = {
  id: string;
  social_account_id: string;
  brand_id: string;
  organization_id: string;
  metric_id: string;
  metric_date: string;
  /** numeric de Postgres: llega como número o como texto según el cliente. */
  value: number | string;
  first_captured_at: string;
  captured_at: string;
  capture_count: number;
  provisional: boolean;
};

export type MediaMetricDailyRow = {
  id: string;
  social_account_id: string;
  brand_id: string;
  organization_id: string;
  publication_id: string | null;
  external_media_id: string;
  media_product_type: 'FEED' | 'REELS';
  published_at: string | null;
  metric_id: string;
  metric_date: string;
  value: number | string;
  first_captured_at: string;
  captured_at: string;
  capture_count: number;
  provisional: boolean;
};

export type AnalyticsCaptureRunRow = {
  id: string;
  social_account_id: string;
  brand_id: string;
  organization_id: string;
  job_id: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  window_from: string | null;
  window_to: string | null;
  api_calls: number;
  account_rows: number;
  media_rows: number;
  unavailable: Array<{ metric_id: string; reason: string; message: string }>;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string;
};

export type AnalyticsReportStatus = 'queued' | 'rendering' | 'ready' | 'failed';

export type AnalyticsReportRow = {
  id: string;
  brand_id: string;
  organization_id: string;
  /** Primer día del mes (AAAA-MM-01). */
  period_start: string;
  status: AnalyticsReportStatus;
  source: 'schedule' | 'manual';
  revision: number;
  data_job_id: string | null;
  render_job_id: string | null;
  media_asset_id: string | null;
  summary: Json;
  error: string | null;
  requested_by: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AnalyticsMediaSummaryRow = {
  publication_id: string | null;
  content_id: string | null;
  title: string;
  format: string;
  network: string;
  media_product_type: 'FEED' | 'REELS';
  external_media_id: string;
  external_url: string | null;
  published_at: string;
  last_captured_at: string;
  provisional: boolean;
  metrics: Record<string, number | string>;
};

// ── Biblioteca con Google Drive (migración 20261122010000) ──────────────────
// Conexiones de Drive de la organización. El token de refresco no está aquí:
// vive cifrado en el esquema `private`, sin acceso desde el cliente.

export type DriveConnectionStatus = 'active' | 'needs_reauth' | 'disconnected';

export type DriveConnectionRow = {
  id: string;
  organization_id: string;
  provider: 'google_drive';
  account_email: string;
  display_name: string;
  status: DriveConnectionStatus;
  scopes: string[];
  last_error: string | null;
  connected_by: string | null;
  connected_at: string;
  disconnected_at: string | null;
  created_at: string;
  updated_at: string;
};

type DriveTables = {
  drive_connections: Table<DriveConnectionRow>;
};

type DriveFunctions = {
  drive_oauth_begin: { Args: { p_organization_id: string }; Returns: string };
  disconnect_drive: { Args: { p_connection_id: string }; Returns: DriveConnectionRow };
  drive_connection_for_brand: {
    Args: { p_brand_id: string; p_connection_id?: string | null };
    Returns: { id: string; organization_id: string; account_email: string; user_id: string };
  };
};

type AnalyticsTables = {
  analytics_metric_definitions: Table<AnalyticsMetricDefinitionRow>;
  account_metrics_daily: Table<AccountMetricDailyRow>;
  media_metrics_daily: Table<MediaMetricDailyRow>;
  analytics_capture_runs: Table<AnalyticsCaptureRunRow>;
  analytics_reports: Table<AnalyticsReportRow>;
};

type AnalyticsFunctions = {
  analytics_media_summary: {
    Args: { p_brand_id: string; p_from: string; p_to: string };
    Returns: AnalyticsMediaSummaryRow[];
  };
  request_analytics_report: { Args: { p_brand_id: string; p_period_start: string }; Returns: AnalyticsReportRow };
};

// ─────────────────────── fin del bloque de analítica ───────────────────────

// ───────────── Plataforma → Integraciones (20261120010000) ─────────────
// Solo superadministradores. Los secretos nunca llegan: `value` es null y
// `hint` es una pista («…a1b2» o el correo de la cuenta de servicio).

export type SocialConnectionMethod = 'oauth' | 'token';

export type IntegrationSettingRow = {
  setting_key: string;
  integration: string;
  is_secret: boolean;
  value: string | null;
  hint: string | null;
  updated_at: string;
  updated_by_email: string | null;
};

export type IntegrationTestRow = {
  integration: string;
  ok: boolean;
  message: string;
  tested_at: string;
  tested_by_email: string | null;
};

export type IntegrationAuditRow = {
  id: number;
  created_at: string;
  action: 'set' | 'delete' | 'test';
  integration: string;
  setting_key: string | null;
  actor_email: string | null;
  data: Json;
};

type IntegrationFunctions = {
  admin_integration_settings: { Args: Record<string, never>; Returns: IntegrationSettingRow[] };
  admin_integration_tests: { Args: Record<string, never>; Returns: IntegrationTestRow[] };
  admin_integration_audit: { Args: { p_limit?: number }; Returns: IntegrationAuditRow[] };
  admin_set_integration_setting: { Args: { p_key: string; p_value: string }; Returns: undefined };
  admin_delete_integration_setting: { Args: { p_key: string }; Returns: boolean };
};
// ───────────────────── fin del bloque de integraciones ─────────────────────

type Table<Row, Insert = never, Update = never> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<ProfileRow, never, { full_name?: string; locale?: string }>;
      platform_admins: Table<{ user_id: string; created_at: string }>;
      organizations: Table<OrganizationRow, never, { name?: string; kind?: OrgKind; settings?: Json }>;
      organization_members: Table<OrganizationMemberRow>;
      brands: Table<
        BrandRow,
        {
          organization_id: string;
          name: string;
          sector?: string;
          website?: string;
          timezone?: string;
          default_locale?: string;
          status?: BrandStatus;
        },
        {
          name?: string;
          sector?: string;
          website?: string;
          timezone?: string;
          default_locale?: string;
          status?: BrandStatus;
          ai_mode?: BrandAiMode;
        }
      >;
      brand_members: Table<
        BrandMemberRow,
        { brand_id: string; organization_id: string; user_id: string; role: BrandRole },
        { role?: BrandRole }
      >;
      brand_profiles: Table<BrandProfileRow>;
      brand_knowledge_sources: Table<
        KnowledgeSourceRow & SourceExtractionColumns & { extracted_text: string | null },
        {
          brand_id: string;
          organization_id: string;
          kind: SourceKind;
          title: string;
          storage_path?: string | null;
          url?: string | null;
          mime_type?: string | null;
          bytes?: number | null;
        }
      >;
      media_assets: Table<
        MediaAssetRow,
        {
          brand_id: string;
          organization_id: string;
          kind: AssetKind;
          storage_path: string;
          file_name: string;
          mime_type: string;
          bytes: number;
          width?: number | null;
          height?: number | null;
          duration_ms?: number | null;
          sha256?: string | null;
          folder?: string;
          tags?: string[];
          rights?: Json;
          provenance?: Json;
          thumb_path?: string | null;
        },
        { kind?: AssetKind; file_name?: string; folder?: string; tags?: string[]; rights?: Json }
      >;
      storage_cleanup_queue: Table<StorageCleanupRow>;
      invitations: Table<InvitationRow>;
      audit_logs: Table<AuditLogRow>;
    } & Phase2Tables &
      ContentTables &
      Phase2MediaTables &
      RequestTables &
      PolishTables &
      SourceFontTables &
      PublicationTables &
      ImportTables &
      BillingTables &
      CampaignTables &
      RgpdTables &
      AnalyticsTables &
      DriveTables;
    Views: Record<never, never>;
    Functions: {
      create_organization: { Args: { p_name: string; p_kind?: OrgKind }; Returns: OrganizationRow };
      set_member_role: { Args: { p_organization_id: string; p_user_id: string; p_role: OrgRole }; Returns: undefined };
      remove_member: { Args: { p_organization_id: string; p_user_id: string }; Returns: undefined };
      create_invitation: {
        Args: {
          p_organization_id: string;
          p_email: string;
          p_org_role?: OrgRole;
          p_brand_id?: string | null;
          p_brand_role?: BrandRole | null;
        };
        Returns: { invitation_id: string; token: string }[];
      };
      revoke_invitation: { Args: { p_invitation_id: string }; Returns: undefined };
      get_invitation: { Args: { p_token: string }; Returns: InvitationPreview[] };
      accept_invitation: { Args: { p_token: string }; Returns: string };
      save_brand_profile: {
        Args: { p_brand_id: string; p_data: Json; p_provenance?: Json; p_change_note?: string };
        Returns: BrandProfileRow;
      };
      asset_facets: { Args: { p_brand_id: string }; Returns: { tags: string[]; folders: string[] }[] };
      admin_list_organizations: { Args: Record<string, never>; Returns: AdminOrganizationRow[] };
    } & Phase2Functions &
      ContentFunctions &
      MediaJobFunctions &
      RequestFunctions &
      PolishFunctions &
      SourceFontFunctions &
      PublicationFunctions &
      BillingFunctions &
      CampaignFunctions &
      RgpdFunctions &
      AnalyticsFunctions &
      IntegrationFunctions &
      DriveFunctions &
      ImportFunctions;
    Enums: {
      org_kind: OrgKind;
      org_role: OrgRole;
      brand_role: BrandRole;
      brand_status: BrandStatus;
      profile_status: ProfileStatus;
      source_kind: SourceKind;
      source_status: SourceStatus;
      asset_kind: AssetKind;
      asset_origin: AssetOrigin;
    } & Phase2Enums &
      ContentEnums &
      RequestEnums &
      PublicationEnums &
      BillingEnums &
      CampaignEnums;
    CompositeTypes: Record<never, never>;
  };
};
