// Catálogo de lo que se puede configurar desde «Plataforma → Integraciones».
//
// Cada ajuste se llama igual que la variable de entorno que sustituye: las
// funciones leen primero lo guardado en la base de datos y, si no está, la
// variable (settings.ts). El mismo catálogo vive en la migración
// 20261120010000, ampliada en 20261123010000 con Google Drive y el copiloto
// y en 20261124010000 con Cloudflare R2 (y en 20261126010000 con OpenAI y en
// 20261208010000 con el trabajador de medios en Fly.io, y en 20261210010000
// con el token de su intermediario `worker-gateway`)
// (`private.integration_setting_keys`, que es la que manda: no
// se guarda nada fuera de él) y en la pantalla
// (src/features/platform/integrations/catalog.ts); una prueba comprueba que los
// tres coinciden.
//
// Sin dependencias de Deno ni de Node: lo usan las funciones y las pruebas.

export const INTEGRATION_IDS = [
  'meta',
  'comfyui',
  'ai_text',
  'ai_image',
  'stripe',
  'google_drive',
  'r2',
  'media_worker',
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export interface IntegrationSettingSpec {
  key: string;
  integration: IntegrationId;
  /** Secreto: se guarda cifrado (Vault) y nunca se devuelve al navegador. */
  secret: boolean;
  /** Comprueba el valor antes de guardarlo. Devuelve el problema, o null. */
  validate?: (value: string) => string | null;
}

const url =
  (allowLocalHttp = false) =>
  (value: string) => {
    try {
      const u = new URL(value);
      if (u.username || u.password) return 'La dirección no puede llevar usuario ni contraseña.';
      if (u.protocol === 'https:') return null;
      if (allowLocalHttp && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        return null;
      return 'La dirección debe empezar por https://.';
    } catch {
      return 'No es una dirección válida.';
    }
  };
const oneOf = (values: string[]) => (value: string) =>
  values.includes(value) ? null : `Valores admitidos: ${values.join(', ')}.`;
const pattern = (re: RegExp, message: string) => (value: string) => (re.test(value) ? null : message);
const json = (check?: (parsed: unknown) => string | null) => (value: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return 'No es JSON válido.';
  }
  return check ? check(parsed) : null;
};
const serviceAccount = json((parsed) => {
  const p = parsed as Record<string, unknown> | null;
  return p && typeof p === 'object' && typeof p.client_email === 'string' && typeof p.private_key === 'string'
    ? null
    : 'No es el JSON de una cuenta de servicio de Google (faltan client_email o private_key).';
});
const prices = json((parsed) =>
  parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? null
    : 'Debe ser un objeto { "adaptador/modelo": { "unidad": precio } }.',
);
const flag = oneOf(['true', 'false']);
const providerModel = pattern(/^[A-Za-z0-9._@/:-]{1,200}$/, 'Solo letras, números y . _ @ / : -');

export const TEXT_PROVIDER_CHOICES = [
  'anthropic-vertex',
  'anthropic-bedrock',
  'mistral',
  'openai',
  'anthropic',
] as const;
const textProvider = oneOf([...TEXT_PROVIDER_CHOICES]);

/** Prefijos de las variables de proveedor y modelo de cada tarea de texto (ai/text/config.ts). */
export const TEXT_TASK_PREFIXES = [
  'AI_TEXT_POST_CAPTION',
  'AI_TEXT_PROFILE_PROPOSAL',
  'AI_TEXT_BRAND_CHECK',
  'AI_TEXT_CAMPAIGN_PLAN',
  'AI_TEXT_ANALYTICS_SUMMARY',
  'AI_TEXT_EDITOR_COPILOT',
] as const;

/** Token de Fly: «FlyV1 fm2_…[,fm2_…]» de `fly tokens create` o del panel, o uno antiguo «fo1_…». */
export const FLY_TOKEN_PATTERN =
  /^(FlyV1 fm\d_[A-Za-z0-9_+/=-]{10,}(,fm\d_[A-Za-z0-9_+/=-]{10,})*|fo1_[A-Za-z0-9_-]{10,})$/;
/** Mismas formas que admite `private.media_worker_wake()` (van en la URL de la API). */
export const FLY_APP_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const FLY_MACHINE_PATTERN = /^[a-z0-9]{6,32}$/;
/** Token del trabajador para `worker-gateway`: «rrss_wgt_» y 32 bytes en base64url. */
export const WORKER_GATEWAY_TOKEN_PATTERN = /^rrss_wgt_[A-Za-z0-9_-]{43}$/;
/** Lo que se guarda de él: su huella SHA-256. */
export const WORKER_GATEWAY_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const INTEGRATION_SETTINGS: IntegrationSettingSpec[] = [
  // Meta
  {
    key: 'META_APP_ID',
    integration: 'meta',
    secret: false,
    validate: pattern(/^\d{5,30}$/, 'El App ID son solo cifras.'),
  },
  {
    key: 'META_APP_SECRET',
    integration: 'meta',
    secret: true,
    validate: pattern(/^[A-Za-z0-9]{16,128}$/, 'El App Secret son letras y cifras.'),
  },
  {
    key: 'META_LOGIN_CONFIG_ID',
    integration: 'meta',
    secret: false,
    validate: pattern(/^\d{5,30}$/, 'El config_id son solo cifras.'),
  },
  {
    key: 'META_GRAPH_API_VERSION',
    integration: 'meta',
    secret: false,
    validate: pattern(/^v\d+\.\d+$/, 'Tiene la forma v27.0.'),
  },
  { key: 'SOCIAL_APP_URL', integration: 'meta', secret: false, validate: url(true) },
  { key: 'SOCIAL_TOKEN_KEYS', integration: 'meta', secret: true },
  {
    key: 'SOCIAL_TOKEN_KEY_ID',
    integration: 'meta',
    secret: false,
    validate: pattern(/^[A-Za-z0-9_-]{1,32}$/, 'Identificador no válido.'),
  },
  // ComfyUI propio
  { key: 'COMFYUI_BASE_URL', integration: 'comfyui', secret: false, validate: url(true) },
  { key: 'COMFYUI_API_TOKEN', integration: 'comfyui', secret: true },
  {
    key: 'COMFYUI_DATA_REGION',
    integration: 'comfyui',
    secret: false,
    validate: oneOf(['eu', 'us', 'global', 'unknown']),
  },
  // IA de texto
  { key: 'AI_TEXT_PROVIDER', integration: 'ai_text', secret: false, validate: textProvider },
  { key: 'AI_TEXT_MODEL', integration: 'ai_text', secret: false, validate: providerModel },
  ...TEXT_TASK_PREFIXES.flatMap((prefix) => [
    { key: `${prefix}_PROVIDER`, integration: 'ai_text' as const, secret: false, validate: textProvider },
    { key: `${prefix}_MODEL`, integration: 'ai_text' as const, secret: false, validate: providerModel },
  ]),
  {
    key: 'AI_VERTEX_PROJECT_ID',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^[a-z][a-z0-9-]{4,29}$/, 'Identificador de proyecto de Google Cloud no válido.'),
  },
  {
    key: 'AI_VERTEX_LOCATION',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^[a-z0-9-]{2,30}$/, 'Región no válida (por ejemplo, europe-west1).'),
  },
  { key: 'AI_VERTEX_SERVICE_ACCOUNT_JSON', integration: 'ai_text', secret: true, validate: serviceAccount },
  { key: 'ANTHROPIC_API_KEY', integration: 'ai_text', secret: true },
  { key: 'MISTRAL_API_KEY', integration: 'ai_text', secret: true },
  { key: 'OPENAI_API_KEY', integration: 'ai_text', secret: true },
  { key: 'OPENAI_BASE_URL', integration: 'ai_text', secret: false, validate: url() },
  {
    key: 'OPENAI_ORGANIZATION',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^[A-Za-z0-9_-]{3,100}$/, 'Identificador de organización no válido (org-…).'),
  },
  {
    key: 'OPENAI_PROJECT',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^[A-Za-z0-9_-]{3,100}$/, 'Identificador de proyecto no válido (proj_…).'),
  },
  {
    key: 'AI_BEDROCK_REGION',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^[a-z]{2}-[a-z]+-\d$/, 'Región de AWS no válida (por ejemplo, eu-central-1).'),
  },
  { key: 'AI_BEDROCK_ACCESS_KEY_ID', integration: 'ai_text', secret: true },
  { key: 'AI_BEDROCK_SECRET_ACCESS_KEY', integration: 'ai_text', secret: true },
  { key: 'AI_BEDROCK_BEARER_TOKEN', integration: 'ai_text', secret: true },
  {
    key: 'AI_TRANSCRIPTION_MODEL',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^[a-z0-9][a-z0-9._-]{1,60}$/, 'Nombre de modelo no válido (por ejemplo, gpt-transcribe).'),
  },
  { key: 'AI_PRICES', integration: 'ai_text', secret: false, validate: prices },
  { key: 'AI_ALLOW_NON_EU_PROCESSING', integration: 'ai_text', secret: false, validate: flag },
  {
    key: 'AI_TIMEOUT_MS',
    integration: 'ai_text',
    secret: false,
    validate: pattern(/^\d{4,6}$/, 'Milisegundos, entre 1000 y 390000.'),
  },
  // IA de imagen
  { key: 'AI_MEDIA_IMAGE_MODEL', integration: 'ai_image', secret: false, validate: providerModel },
  { key: 'AI_MEDIA_ALLOW_NON_EU', integration: 'ai_image', secret: false, validate: flag },
  {
    key: 'GOOGLE_VERTEX_PROJECT_ID',
    integration: 'ai_image',
    secret: false,
    validate: pattern(/^[a-z][a-z0-9-]{4,29}$/, 'Identificador de proyecto de Google Cloud no válido.'),
  },
  {
    key: 'GOOGLE_VERTEX_LOCATION',
    integration: 'ai_image',
    secret: false,
    validate: pattern(/^[a-z0-9-]{2,30}$/, 'Región no válida (por ejemplo, eu).'),
  },
  { key: 'GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON', integration: 'ai_image', secret: true, validate: serviceAccount },
  { key: 'BFL_API_KEY', integration: 'ai_image', secret: true },
  {
    key: 'BFL_API_BASE_URL',
    integration: 'ai_image',
    secret: false,
    validate: oneOf(['https://api.eu.bfl.ai', 'https://api.us.bfl.ai', 'https://api.bfl.ai']),
  },
  { key: 'IDEOGRAM_API_KEY', integration: 'ai_image', secret: true },
  // Stripe
  {
    key: 'STRIPE_SECRET_KEY',
    integration: 'stripe',
    secret: true,
    validate: pattern(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, 'Empieza por sk_test_, sk_live_, rk_test_ o rk_live_.'),
  },
  {
    key: 'STRIPE_WEBHOOK_SECRET',
    integration: 'stripe',
    secret: true,
    validate: pattern(
      /^whsec_[A-Za-z0-9]{10,}(,\s*whsec_[A-Za-z0-9]{10,})*$/,
      'Empieza por whsec_ (varios, separados por comas, mientras se rota).',
    ),
  },
  { key: 'BILLING_APP_URL', integration: 'stripe', secret: false, validate: url(true) },
  // Google Drive (biblioteca): cliente OAuth «Aplicación web» del producto.
  {
    key: 'GOOGLE_DRIVE_CLIENT_ID',
    integration: 'google_drive',
    secret: false,
    validate: pattern(/^[A-Za-z0-9-]{5,100}\.apps\.googleusercontent\.com$/, 'Termina en .apps.googleusercontent.com.'),
  },
  { key: 'GOOGLE_DRIVE_CLIENT_SECRET', integration: 'google_drive', secret: true },
  { key: 'DRIVE_APP_URL', integration: 'google_drive', secret: false, validate: url(true) },
  // Cloudflare R2 (almacenamiento de medios, docs/almacenamiento-r2.md).
  {
    key: 'R2_ACCOUNT_ID',
    integration: 'r2',
    secret: false,
    validate: pattern(/^[0-9a-f]{32}$/, 'El Account ID son 32 caracteres hexadecimales.'),
  },
  {
    key: 'R2_ACCESS_KEY_ID',
    integration: 'r2',
    secret: true,
    validate: pattern(/^[A-Za-z0-9]{16,128}$/, 'El Access Key ID son letras y cifras.'),
  },
  {
    key: 'R2_SECRET_ACCESS_KEY',
    integration: 'r2',
    secret: true,
    validate: pattern(/^[A-Za-z0-9+/=]{16,256}$/, 'El Secret Access Key son letras y cifras.'),
  },
  {
    key: 'R2_BUCKET',
    integration: 'r2',
    secret: false,
    validate: pattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Minúsculas, cifras y guiones (3 a 63).'),
  },
  { key: 'R2_JURISDICTION', integration: 'r2', secret: false, validate: oneOf(['eu', 'default']) },
  { key: 'MEDIA_UPLOAD_BACKEND', integration: 'r2', secret: false, validate: oneOf(['r2', 'supabase']) },
  // Trabajador de medios en Fly.io (docs/alojamiento.md): la base de datos
  // arranca su máquina con la API de máquinas de Fly (20261208010000).
  {
    key: 'FLY_API_TOKEN',
    integration: 'media_worker',
    secret: true,
    validate: pattern(
      FLY_TOKEN_PATTERN,
      'Pega el token entero tal como lo da Fly: empieza por «FlyV1 fm2_» (o por «fo1_» si es uno antiguo).',
    ),
  },
  {
    key: 'FLY_APP',
    integration: 'media_worker',
    secret: false,
    validate: pattern(FLY_APP_PATTERN, 'El nombre de la app de Fly: minúsculas, cifras y guiones.'),
  },
  {
    key: 'FLY_MACHINE_ID',
    integration: 'media_worker',
    secret: false,
    validate: pattern(FLY_MACHINE_PATTERN, 'El ID de la máquina: minúsculas y cifras (por ejemplo, 148e21dc7d0189).'),
  },
  // Token del trabajador para `worker-gateway` (20261210010000): solo se
  // guarda su huella («sha256:…») y solo con «Generar token».
  {
    key: 'WORKER_GATEWAY_TOKEN',
    integration: 'media_worker',
    secret: true,
    validate: pattern(WORKER_GATEWAY_HASH_PATTERN, 'Solo se genera con «Generar token».'),
  },
];

export const INTEGRATION_SETTING_KEYS: ReadonlySet<string> = new Set(INTEGRATION_SETTINGS.map((s) => s.key));

export function settingSpec(key: string): IntegrationSettingSpec | undefined {
  return INTEGRATION_SETTINGS.find((s) => s.key === key);
}

/** Problema del valor de un ajuste antes de guardarlo (sin citar el valor), o null. */
export function validateSetting(key: string, value: string): string | null {
  const spec = settingSpec(key);
  if (!spec) return 'Ese ajuste no existe.';
  const trimmed = value.trim();
  if (!trimmed) return 'El valor está vacío.';
  if (trimmed.length > 20_000) return 'El valor es demasiado largo.';
  if (key !== 'AI_VERTEX_SERVICE_ACCOUNT_JSON' && key !== 'GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON' && key !== 'AI_PRICES') {
    if (/[\r\n]/.test(trimmed)) return 'El valor no puede tener saltos de línea.';
  }
  return spec.validate ? spec.validate(trimmed) : null;
}
