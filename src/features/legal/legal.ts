// Documentos legales de la plataforma: versiones vigentes, rutas y la lista de
// encargados del tratamiento. Son PLANTILLAS: los datos de la empresa van entre
// corchetes y un abogado debe revisarlas antes de usarlas con clientes. Esto no
// es asesoría legal.
//
// Al cambiar el texto de las condiciones o de la política de privacidad, sube
// su versión: queda constancia de qué versión aceptó cada persona
// (`legal_acceptances`) y la cuenta pide aceptar la nueva.

export const LEGAL_VERSIONS = {
  terms: '2026-11-19',
  privacy: '2026-11-20',
} as const;

export type LegalDocumentId = 'privacy' | 'terms' | 'legal-notice' | 'cookies';

export const LEGAL_DOCUMENTS: { id: LegalDocumentId; slug: string; title: string }[] = [
  { id: 'privacy', slug: 'privacidad', title: 'Política de privacidad' },
  { id: 'terms', slug: 'condiciones', title: 'Condiciones de uso' },
  { id: 'legal-notice', slug: 'aviso-legal', title: 'Aviso legal' },
  { id: 'cookies', slug: 'cookies', title: 'Política de cookies' },
];

export function legalPath(id: LegalDocumentId): string {
  return `/legal/${LEGAL_DOCUMENTS.find((d) => d.id === id)!.slug}`;
}

/** Hueco que hay que rellenar con un dato real de la empresa. */
export const PLACEHOLDERS = {
  company: '[RAZÓN SOCIAL]',
  taxId: '[CIF]',
  address: '[DIRECCIÓN]',
  registry: '[DATOS DE INSCRIPCIÓN EN EL REGISTRO MERCANTIL]',
  privacyEmail: '[CORREO DE PRIVACIDAD]',
  contactEmail: '[CORREO DE CONTACTO]',
  dpo: '[DELEGADO DE PROTECCIÓN DE DATOS, SI SE NOMBRA]',
  domain: '[DOMINIO]',
  jurisdiction: '[JUZGADOS COMPETENTES]',
} as const;

export type ProcessorStatus = 'in_use' | 'optional' | 'off' | 'pending';

export const PROCESSOR_STATUS_LABEL: Record<ProcessorStatus, string> = {
  in_use: 'En uso',
  optional: 'Solo si se activa',
  off: 'Apagado por defecto',
  pending: 'Pendiente de elegir',
};

export interface Processor {
  name: string;
  purpose: string;
  /** Dónde se tratan los datos, según lo comprobado en la documentación del proveedor. */
  region: string;
  /** Transferencia fuera del Espacio Económico Europeo y su garantía (a confirmar con el contrato). */
  transfer: string;
  status: ProcessorStatus;
}

/**
 * Encargados del tratamiento según lo que usa el producto hoy (docs/rgpd.md).
 * Las regiones salen de docs/ia-texto.md y docs/ia-medios.md; lo que no está
 * comprobado lo dice. Al añadir un proveedor, añádelo aquí y en docs/rgpd.md.
 */
export const PROCESSORS: Processor[] = [
  {
    name: 'Supabase (Supabase Inc.)',
    purpose: 'Base de datos, cuentas e inicio de sesión, archivos de la biblioteca y funciones del servidor.',
    region: 'Unión Europea (región del proyecto). [CONFIRMAR LA REGIÓN DEL PROYECTO DE PRODUCCIÓN]',
    transfer:
      'Empresa con sede en EE. UU.: posibles accesos de soporte desde fuera del EEE. [CONFIRMAR EL CONTRATO DE ENCARGO (DPA) Y SUS CLÁUSULAS CONTRACTUALES TIPO]',
    status: 'in_use',
  },
  {
    name: 'Vercel (Vercel Inc.)',
    purpose: 'Publicación de la aplicación web y registros técnicos de acceso (dirección IP, navegador).',
    region: 'Red global de distribución; la aplicación no guarda datos de cuentas en Vercel.',
    transfer: 'Empresa con sede en EE. UU. [CONFIRMAR EL DPA DE VERCEL Y LA GARANTÍA DE LA TRANSFERENCIA]',
    status: 'in_use',
  },
  {
    name: '[PROVEEDOR DE CORREO]',
    purpose: 'Envío de los correos de confirmación de cuenta, recuperación de contraseña e invitaciones.',
    region: '[REGIÓN]',
    transfer: '[GARANTÍA]',
    status: 'pending',
  },
  {
    name: 'Google Cloud · Vertex AI',
    purpose: 'IA de texto (modelos Claude) e imagen, solo si la organización usa la IA.',
    region: 'Multirregión de la UE («eu»). El adaptador rechaza otras ubicaciones.',
    transfer: 'Sin transferencia prevista. Google no entrena con los datos del cliente sin permiso.',
    status: 'optional',
  },
  {
    name: 'Amazon Web Services · Bedrock',
    purpose: 'IA de texto (modelos Claude), alternativa a Vertex AI.',
    region: 'Regiones «eu-…» de AWS. El adaptador rechaza las demás.',
    transfer: 'Sin transferencia prevista. [CONFIRMAR EL PERFIL DE INFERENCIA DE LA UE]',
    status: 'optional',
  },
  {
    name: 'Mistral AI',
    purpose: 'IA de texto, alternativa europea.',
    region: 'Empresa europea; dónde procesa no consta en la documentación consultada. [CONFIRMAR]',
    transfer: '[CONFIRMAR]',
    status: 'optional',
  },
  {
    name: 'OpenAI',
    purpose: 'IA de texto (incluido el copiloto por voz), alternativa.',
    region:
      'Residencia en la UE con un proyecto de región Europa y el endpoint eu.api.openai.com. Sin él, procesa fuera de la UE.',
    transfer:
      'Sin transferencia prevista con el endpoint de la UE; el esquema de salida estructurada no entra en la residencia. [CONFIRMAR CONTRATO Y ELEGIBILIDAD]',
    status: 'optional',
  },
  {
    name: 'Black Forest Labs (FLUX)',
    purpose: 'IA de imagen.',
    region: 'Dirección de la UE (api.eu.bfl.ai).',
    transfer: 'Puede entrenar con las entradas salvo contrato enterprise. [CONFIRMAR ANTES DE ACTIVARLO]',
    status: 'optional',
  },
  {
    name: 'Servidor de imagen propio (ComfyUI)',
    purpose: 'IA de imagen con modelos abiertos.',
    region: 'La del servidor que se configure. [INDICAR DÓNDE ESTÁ]',
    transfer: 'Depende de dónde se aloje. Nadie entrena con lo enviado.',
    status: 'optional',
  },
  {
    name: 'Anthropic (API directa)',
    purpose: 'IA de texto.',
    region: 'EE. UU. o global: la API directa no procesa en la UE.',
    transfer: 'Transferencia internacional: solo con la aceptación expresa de la organización.',
    status: 'off',
  },
  {
    name: 'Ideogram',
    purpose: 'IA de imagen.',
    region: 'No documentada.',
    transfer: 'Transferencia probable: solo con la aceptación expresa de la organización.',
    status: 'off',
  },
  {
    name: 'Higgsfield y fal.ai',
    purpose: 'Vídeo generado con IA.',
    region: 'Sin región de la UE documentada.',
    transfer: 'Apagado por defecto: ninguno tiene región de la UE verificada.',
    status: 'off',
  },
  {
    name: 'Cloudflare R2 (Cloudflare, Inc.)',
    purpose: 'Almacenamiento privado de fotos, vídeos y exportaciones de la biblioteca, si la plataforma lo activa (si no, se usa Supabase).',
    region: 'Unión Europea (jurisdicción UE del cubo, que no se puede cambiar después). El cubo es privado y se accede con enlaces que caducan.',
    transfer:
      'Empresa con sede en EE. UU. que actúa como encargada del tratamiento. [CONFIRMAR EL DPA DE CLOUDFLARE Y SU ADHESIÓN AL EU-U.S. DATA PRIVACY FRAMEWORK]',
    status: 'optional',
  },
  {
    name: 'Google Drive (Google LLC)',
    purpose:
      'Biblioteca con fotos de Drive: la organización conecta su cuenta de Google con permiso de solo lectura y las imágenes se piden a Drive cada vez que se ven. El token de acceso se guarda cifrado.',
    region: 'La de la cuenta de Google de la organización.',
    transfer: 'Empresa con sede en EE. UU. [CONFIRMAR EL DPA DE GOOGLE]',
    status: 'optional',
  },
  {
    name: 'Dictado por voz del navegador (Google en Chrome, Microsoft en Edge)',
    purpose:
      'Copiloto por voz del editor: al pulsar «Dictar», el navegador envía el audio a los servidores de su fabricante (Google en Chrome, Microsoft en Edge) para pasarlo a texto. Nosotros solo recibimos el texto.',
    region: 'La decide el navegador de la persona; no se puede pedir región de la UE.',
    transfer:
      'Posible transferencia a EE. UU. por el proveedor del navegador, que no contratamos nosotros. [CONFIRMAR CON EL ABOGADO CÓMO INFORMARLO]',
    status: 'optional',
  },
  {
    name: '[ALOJAMIENTO DEL TRABAJADOR DE MEDIOS]',
    purpose: 'Montaje de reels y recortes de fotos de la biblioteca.',
    region: '[REGIÓN]',
    transfer: '[GARANTÍA]',
    status: 'pending',
  },
];
