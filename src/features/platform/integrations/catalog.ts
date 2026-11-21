// Lo que se enseña en «Plataforma → Integraciones»: cada integración, sus
// apartados y sus campos, con el nombre de la variable de entorno que sustituye.
// El catálogo que manda es el de la base de datos (migraciones 20261120010000,
// 20261123010000, 20261124010000 y 20261208010000);
// el del servidor está en supabase/functions/_shared/integrations/catalog.ts y
// una prueba (tests/db/integraciones.test.ts) comprueba que los tres coinciden.
//
// Sin importaciones con «@/»: lo usan también las pruebas de base de datos.

export type IntegrationId =
  'meta' | 'comfyui' | 'ai_text' | 'ai_image' | 'stripe' | 'google_drive' | 'r2' | 'media_worker';

export interface UiField {
  key: string;
  label: string;
  /** Secreto: se escribe pero nunca se vuelve a ver. */
  secret: boolean;
  input?: 'text' | 'textarea' | 'select';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
}

export interface UiGroup {
  title: string;
  description?: string;
  fields: UiField[];
}

export interface UiIntegration {
  id: IntegrationId;
  title: string;
  description: string;
  /** Qué hace «Probar conexión» (para que se sepa que no gasta). */
  testDescription: string;
  groups: UiGroup[];
}

const TEXT_PROVIDERS = [
  { value: 'anthropic-vertex', label: 'Claude en Google Vertex AI (UE)' },
  { value: 'anthropic-bedrock', label: 'Claude en Amazon Bedrock (UE)' },
  { value: 'mistral', label: 'Mistral (UE)' },
  { value: 'openai', label: 'OpenAI (UE con eu.api.openai.com)' },
  { value: 'anthropic', label: 'Anthropic directo (fuera de la UE)' },
];
const YES_NO = [
  { value: 'false', label: 'No' },
  { value: 'true', label: 'Sí' },
];

const TEXT_TASKS: Array<{ prefix: string; label: string }> = [
  { prefix: 'AI_TEXT_POST_CAPTION', label: 'Textos de las piezas' },
  { prefix: 'AI_TEXT_PROFILE_PROPOSAL', label: 'Propuesta de perfil de marca' },
  { prefix: 'AI_TEXT_BRAND_CHECK', label: 'Verificador de marca' },
  { prefix: 'AI_TEXT_CAMPAIGN_PLAN', label: 'Plan de campaña' },
  { prefix: 'AI_TEXT_ANALYTICS_SUMMARY', label: 'Interpretación de la analítica' },
  { prefix: 'AI_TEXT_EDITOR_COPILOT', label: 'Copiloto por voz del editor' },
];

export const UI_INTEGRATIONS: UiIntegration[] = [
  {
    id: 'meta',
    title: 'Meta (Instagram)',
    description:
      'La aplicación de Meta del producto, con la que las marcas conectan su cuenta de Instagram por OAuth, y las claves con las que se cifran los tokens de las cuentas.',
    testDescription: 'Pregunta a Meta si reconoce la aplicación (sin publicar nada) y comprueba las claves de cifrado.',
    groups: [
      {
        title: 'Aplicación de Meta',
        fields: [
          { key: 'META_APP_ID', label: 'App ID', secret: false, placeholder: '1234567890123456' },
          { key: 'META_APP_SECRET', label: 'App Secret', secret: true },
          {
            key: 'META_LOGIN_CONFIG_ID',
            label: 'config_id de Facebook Login for Business',
            secret: false,
            help: 'La configuración de inicio de sesión que fija los permisos. Recomendado.',
          },
          {
            key: 'META_GRAPH_API_VERSION',
            label: 'Versión de la Graph API',
            secret: false,
            placeholder: 'v27.0',
            help: 'Si no se pone, v27.0.',
          },
          {
            key: 'SOCIAL_APP_URL',
            label: 'Dirección de la aplicación',
            secret: false,
            placeholder: 'https://…',
            help: 'A dónde vuelve la persona tras conectar su cuenta. Sin ella no sale el botón «Conectar con Meta».',
          },
        ],
      },
      {
        title: 'Cifrado de los tokens',
        description:
          'Los tokens de las cuentas se guardan cifrados con estas claves. Se generan aquí y no se ven nunca; una clave con la que hay tokens guardados no se puede quitar.',
        fields: [
          { key: 'SOCIAL_TOKEN_KEYS', label: 'Claves de cifrado', secret: true },
          { key: 'SOCIAL_TOKEN_KEY_ID', label: 'Clave con la que se cifra lo nuevo', secret: false },
        ],
      },
    ],
  },
  {
    id: 'comfyui',
    title: 'ComfyUI propio',
    description:
      'Generar imágenes con modelos abiertos en un ComfyUI propio (por ejemplo, el cuaderno de Colab con su túnel).',
    testDescription: 'Pide a ComfyUI su estado (/system_stats): no genera ninguna imagen.',
    groups: [
      {
        title: 'Servidor',
        fields: [
          {
            key: 'COMFYUI_BASE_URL',
            label: 'Dirección (URL base)',
            secret: false,
            placeholder: 'https://…',
            help: 'https; http solo en la propia máquina.',
          },
          {
            key: 'COMFYUI_API_TOKEN',
            label: 'Token de acceso',
            secret: true,
            help: 'El que pide el proxy o el túnel delante de ComfyUI (Authorization: Bearer).',
          },
          {
            key: 'COMFYUI_DATA_REGION',
            label: 'Región de los datos',
            secret: false,
            input: 'select',
            options: [
              { value: 'eu', label: 'Unión Europea' },
              { value: 'us', label: 'Estados Unidos' },
              { value: 'global', label: 'Global' },
              { value: 'unknown', label: 'No se sabe (se trata como fuera de la UE)' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'ai_text',
    title: 'IA de texto',
    description:
      'Qué proveedor y qué modelo redacta cada tarea, las credenciales de cada proveedor y la tabla de precios. Sin precio completo, el modelo no genera.',
    testDescription:
      'Por cada proveedor elegido: lista los modelos (Anthropic, Mistral, OpenAI, Bedrock) o pide un token de acceso (Vertex). No genera texto ni gasta cupo.',
    groups: [
      {
        title: 'Proveedor y modelo',
        description: 'El de todas las tareas, salvo las que tengan uno propio más abajo.',
        fields: [
          { key: 'AI_TEXT_PROVIDER', label: 'Proveedor', secret: false, input: 'select', options: TEXT_PROVIDERS },
          { key: 'AI_TEXT_MODEL', label: 'Modelo', secret: false },
        ],
      },
      {
        title: 'Por tarea (opcional)',
        fields: TEXT_TASKS.flatMap((t) => [
          {
            key: `${t.prefix}_PROVIDER`,
            label: `${t.label} · proveedor`,
            secret: false,
            input: 'select' as const,
            options: TEXT_PROVIDERS,
          },
          { key: `${t.prefix}_MODEL`, label: `${t.label} · modelo`, secret: false },
        ]),
      },
      {
        title: 'Google Vertex AI',
        fields: [
          { key: 'AI_VERTEX_PROJECT_ID', label: 'Proyecto', secret: false },
          { key: 'AI_VERTEX_LOCATION', label: 'Región', secret: false, placeholder: 'europe-west1' },
          {
            key: 'AI_VERTEX_SERVICE_ACCOUNT_JSON',
            label: 'Cuenta de servicio (JSON)',
            secret: true,
            input: 'textarea',
          },
        ],
      },
      {
        title: 'Anthropic y Mistral',
        fields: [
          {
            key: 'ANTHROPIC_API_KEY',
            label: 'Clave de Anthropic',
            secret: true,
            help: 'La API directa no procesa en la UE: solo se usa si se admite expresamente.',
          },
          { key: 'MISTRAL_API_KEY', label: 'Clave de Mistral', secret: true },
        ],
      },
      {
        title: 'OpenAI',
        description:
          'Para procesar en la UE: proyecto creado con región Europa, su clave y la dirección https://eu.api.openai.com.',
        fields: [
          { key: 'OPENAI_API_KEY', label: 'Clave de OpenAI', secret: true },
          {
            key: 'OPENAI_BASE_URL',
            label: 'Dirección de la API',
            secret: false,
            placeholder: 'https://eu.api.openai.com',
            help: 'Sin ella se usa api.openai.com, que no garantiza la UE y exige admitirlo expresamente.',
          },
          { key: 'OPENAI_ORGANIZATION', label: 'Organización (opcional)', secret: false, placeholder: 'org-…' },
          { key: 'OPENAI_PROJECT', label: 'Proyecto (opcional)', secret: false, placeholder: 'proj_…' },
          {
            key: 'AI_TRANSCRIPTION_MODEL',
            label: 'Modelo de transcripción (subtítulos de los reels)',
            secret: false,
            placeholder: 'gpt-transcribe',
            help: 'Opcional. Sin él, gpt-transcribe. Precio en la tabla de precios: "openai/<modelo>": { "audio_seconds": micros }.',
          },
        ],
      },
      {
        title: 'Amazon Bedrock',
        fields: [
          { key: 'AI_BEDROCK_REGION', label: 'Región', secret: false, placeholder: 'eu-central-1' },
          { key: 'AI_BEDROCK_ACCESS_KEY_ID', label: 'Access key ID', secret: true },
          { key: 'AI_BEDROCK_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true },
          {
            key: 'AI_BEDROCK_BEARER_TOKEN',
            label: 'Clave de API de Bedrock (en lugar de las dos anteriores)',
            secret: true,
          },
        ],
      },
      {
        title: 'Precios y criterio de datos',
        fields: [
          {
            key: 'AI_PRICES',
            label: 'Tabla de precios (JSON)',
            secret: false,
            input: 'textarea',
            help: '{ "proveedor/modelo": { "input_tokens": micros, "output_tokens": …, "cache_read_input_tokens": …, "cache_write_input_tokens": … } }',
          },
          {
            key: 'AI_ALLOW_NON_EU_PROCESSING',
            label: 'Admitir proveedores que no procesan en la UE',
            secret: false,
            input: 'select',
            options: YES_NO,
          },
          { key: 'AI_TIMEOUT_MS', label: 'Tiempo máximo por llamada (ms)', secret: false, placeholder: '60000' },
        ],
      },
    ],
  },
  {
    id: 'ai_image',
    title: 'IA de imagen',
    description:
      'Las credenciales de cada proveedor de imagen y, si se quiere, el modelo fijo. Qué modelos se ofrecen lo decide el registro de modelos; ComfyUI tiene su propio apartado.',
    testDescription:
      'Pide un token a Google (Vertex) o el saldo a Black Forest Labs. Ideogram no tiene una llamada gratuita. No genera imágenes.',
    groups: [
      {
        title: 'Modelo',
        fields: [
          {
            key: 'AI_MEDIA_IMAGE_MODEL',
            label: 'Modelo fijo (proveedor:modelo)',
            secret: false,
            help: 'Si no se pone, el de más prioridad del registro de modelos.',
          },
          {
            key: 'AI_MEDIA_ALLOW_NON_EU',
            label: 'Admitir modelos que no procesan en la UE',
            secret: false,
            input: 'select',
            options: YES_NO,
          },
        ],
      },
      {
        title: 'Google Vertex AI (Gemini)',
        fields: [
          { key: 'GOOGLE_VERTEX_PROJECT_ID', label: 'Proyecto', secret: false },
          { key: 'GOOGLE_VERTEX_LOCATION', label: 'Región', secret: false, placeholder: 'eu' },
          {
            key: 'GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON',
            label: 'Cuenta de servicio (JSON)',
            secret: true,
            input: 'textarea',
          },
        ],
      },
      {
        title: 'Black Forest Labs (FLUX.2) e Ideogram',
        fields: [
          { key: 'BFL_API_KEY', label: 'Clave de Black Forest Labs', secret: true },
          {
            key: 'BFL_API_BASE_URL',
            label: 'Servidor de Black Forest Labs',
            secret: false,
            input: 'select',
            options: [
              { value: 'https://api.eu.bfl.ai', label: 'UE (api.eu.bfl.ai)' },
              { value: 'https://api.us.bfl.ai', label: 'EE. UU. (api.us.bfl.ai)' },
              { value: 'https://api.bfl.ai', label: 'Global (api.bfl.ai)' },
            ],
          },
          { key: 'IDEOGRAM_API_KEY', label: 'Clave de Ideogram', secret: true },
        ],
      },
    ],
  },
  {
    id: 'stripe',
    title: 'Stripe',
    description: 'Cobrar los planes: la clave secreta de la cuenta y el secreto del punto de conexión de los avisos.',
    testDescription: 'Lee los datos de la cuenta (/v1/account): no crea clientes ni cobros.',
    groups: [
      {
        title: 'Cuenta',
        fields: [
          { key: 'STRIPE_SECRET_KEY', label: 'Clave secreta', secret: true, placeholder: 'sk_test_… o sk_live_…' },
          {
            key: 'STRIPE_WEBHOOK_SECRET',
            label: 'Secreto del webhook',
            secret: true,
            placeholder: 'whsec_…',
            help: 'Del punto de conexión …/functions/v1/billing-webhook.',
          },
          {
            key: 'BILLING_APP_URL',
            label: 'Dirección de la aplicación',
            secret: false,
            placeholder: 'https://…',
            help: 'A dónde vuelve la persona tras pagar.',
          },
        ],
      },
    ],
  },
  {
    id: 'google_drive',
    title: 'Google Drive',
    description:
      'El cliente OAuth de Google del producto, con el que cada organización conecta su Drive (solo lectura) para usar sus fotos en la biblioteca sin copiarlas. Los tokens se cifran con las mismas claves que los de Meta.',
    testDescription:
      'Comprueba que la configuración está completa. Google no tiene una llamada gratuita para validar el cliente: se comprueba al conectar Google Drive.',
    groups: [
      {
        title: 'Cliente OAuth («Aplicación web»)',
        description:
          'En Google Cloud, con la API de Google Drive activada y como dirección de vuelta autorizada …/functions/v1/drive-media/callback.',
        fields: [
          {
            key: 'GOOGLE_DRIVE_CLIENT_ID',
            label: 'ID de cliente',
            secret: false,
            placeholder: '…apps.googleusercontent.com',
          },
          { key: 'GOOGLE_DRIVE_CLIENT_SECRET', label: 'Secreto del cliente', secret: true },
          {
            key: 'DRIVE_APP_URL',
            label: 'Dirección de la aplicación',
            secret: false,
            placeholder: 'https://…',
            help: 'A dónde vuelve la persona tras conectar Drive. Si no se pone, la de Meta (SOCIAL_APP_URL).',
          },
        ],
      },
    ],
  },
  {
    id: 'r2',
    title: 'Cloudflare R2 (almacenamiento)',
    description:
      'Fotos, vídeos y exportaciones en un cubo de Cloudflare R2 en la UE, en lugar de Supabase Storage: sin coste de salida y sin el límite de espacio del plan de Supabase. Lo ya subido sigue en Supabase y se sigue viendo.',
    testDescription:
      'Pregunta a R2 si el cubo existe y si la clave puede usarlo (HeadBucket). No sube ni descarga nada.',
    groups: [
      {
        title: 'Cuenta y cubo',
        description:
          'El cubo, con jurisdicción UE y sin acceso público, y su regla CORS: docs/almacenamiento-r2.md, «Lo que hace el dueño en Cloudflare».',
        fields: [
          {
            key: 'R2_ACCOUNT_ID',
            label: 'Account ID',
            secret: false,
            placeholder: '32 caracteres hexadecimales',
          },
          { key: 'R2_BUCKET', label: 'Cubo', secret: false, placeholder: 'rrss-media-staging' },
          {
            key: 'R2_JURISDICTION',
            label: 'Jurisdicción del cubo',
            secret: false,
            input: 'select',
            options: [
              { value: 'eu', label: 'Unión Europea (recomendado)' },
              { value: 'default', label: 'Sin jurisdicción (fuera de la garantía UE)' },
            ],
            help: 'La que se eligió al crear el cubo: no se puede cambiar después. Sin poner, eu.',
          },
        ],
      },
      {
        title: 'Token de API de R2',
        description: '«Object Read & Write» limitado a ese cubo.',
        fields: [
          { key: 'R2_ACCESS_KEY_ID', label: 'Access Key ID', secret: true },
          { key: 'R2_SECRET_ACCESS_KEY', label: 'Secret Access Key', secret: true },
        ],
      },
      {
        title: 'Subidas nuevas',
        fields: [
          {
            key: 'MEDIA_UPLOAD_BACKEND',
            label: 'Dónde se guardan',
            secret: false,
            input: 'select',
            options: [
              { value: 'r2', label: 'Cloudflare R2' },
              { value: 'supabase', label: 'Supabase Storage (respaldo)' },
            ],
            help: 'Sin poner, en R2 si está configurado. Cambiarlo no mueve lo ya subido.',
          },
        ],
      },
    ],
  },
  {
    id: 'media_worker',
    title: 'Trabajador de medios (Fly.io)',
    description:
      'La máquina de Fly.io que monta los reels, hace los recortes, extrae el texto de los documentos y genera los informes en PDF. Está parada y la base de datos la arranca cuando hay trabajo en la cola; al vaciarla se vuelve a parar sola.',
    testDescription:
      'Pregunta a la API de máquinas de Fly por esa máquina (GET): dice si existe, en qué estado está y si el token sirve. No la arranca.',
    groups: [
      {
        title: 'App y máquina',
        description:
          'En el panel de Fly, la app del trabajador → «Machines»: el nombre de la app y el ID de su máquina (docs/alojamiento.md).',
        fields: [
          { key: 'FLY_APP', label: 'App', secret: false, placeholder: 'rrss-worker' },
          {
            key: 'FLY_MACHINE_ID',
            label: 'ID de la máquina',
            secret: false,
            placeholder: '148e21dc7d0189',
            help: 'Si se destruye y se vuelve a crear la máquina, cambia: pon el nuevo.',
          },
        ],
      },
      {
        title: 'Token de Fly',
        description:
          'Un token de despliegue de esa app (panel de Fly → la app → «Tokens»), no uno de la organización: solo sirve para esa app.',
        fields: [
          {
            key: 'FLY_API_TOKEN',
            label: 'Token',
            secret: true,
            placeholder: 'FlyV1 fm2_…',
            help: 'Se guarda cifrado. Cuando caduque, crea otro y pégalo aquí.',
          },
        ],
      },
      {
        title: 'Acceso del trabajador a Supabase',
        description:
          'El trabajador no lleva la clave de servicio: habla con la función worker-gateway con un token propio que solo sirve para eso. Genera el token y pégalo en Fly (la app → «Secrets») como WORKER_GATEWAY_TOKEN, junto a SUPABASE_URL.',
        fields: [{ key: 'WORKER_GATEWAY_TOKEN', label: 'Token del trabajador', secret: true }],
      },
    ],
  },
];
