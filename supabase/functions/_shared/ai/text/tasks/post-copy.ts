// Tarea: texto de una publicación, con N variantes, para una red concreta.
//
// Entra el perfil de marca (entero, en caché) y un encargo breve. Los límites
// de la red llegan como DATO: aquí no hay ninguna red escrita. Las variantes
// se devuelven tal cual las escribió el modelo, con su longitud medida y la
// señal de si caben en la red: no se recortan ni se «arreglan» solas.
import type { AiOutputSchema, AiService, Json } from '../../contract.ts';
import {
  AiTaskInputError,
  brandProfileContext,
  DATA_RULE,
  requireText,
  runStructuredTask,
  type TaskActor,
  type TaskMeta,
} from './shared.ts';

export const POST_COPY_PURPOSE = 'post.caption';
export const MAX_VARIANTS = 5;
const MAX_BRIEF_CHARS = 2000;

/** Lo que la red admite. Lo aporta quien llama (el conector o el verificador de formatos). */
export interface NetworkLimits {
  /** Identificador de la red tal como lo usa el producto (`instagram`, `linkedin`…). */
  id: string;
  /** Nombre para enseñar al modelo. */
  name: string;
  /** Máximo de caracteres del texto completo, etiquetas incluidas. */
  maxChars: number;
  /** Máximo de etiquetas (#). Sin indicar, no se limita. */
  maxHashtags?: number;
  /** Otras condiciones de la red, en lenguaje natural («sin enlaces en el texto»…). */
  notes?: string[];
}

export interface PostCopyRequest {
  /** Perfil de marca activo (`brand_profiles.data`). */
  brandProfile: Json;
  /** Encargo breve: de qué va la publicación. */
  brief: string;
  network: NetworkLimits;
  /** Cuántas variantes se piden (1 a 5). */
  variants: number;
}

export interface PostCopyVariant {
  text: string;
  hashtags: string[];
  /** Texto completo tal como se publicaría: el texto y, debajo, las etiquetas. */
  caption: string;
  /** Caracteres del texto completo, en unidades UTF-16 (un emoji puede contar 2): la cuenta común del producto, ver src/features/content/textUnits.ts. */
  characters: number;
  /** ¿Cabe en la red? (caracteres y número de etiquetas). */
  withinLimits: boolean;
}

export interface PostCopyResult extends TaskMeta {
  network: string;
  requestedVariants: number;
  variants: PostCopyVariant[];
}

export const POST_COPY_INSTRUCTIONS = [
  'Eres redactor de redes sociales. Escribes el texto de una publicación para la marca descrita en el material «perfil de marca».',
  'Respeta su tono, su personalidad, sus mensajes clave y su idioma principal. No uses las expresiones que la marca prohíbe ni toques los temas que tiene vetados.',
  'No inventes datos (precios, fechas, promociones, direcciones) que no estén en el perfil o en el encargo.',
  'El encargo indica la red, sus límites y cuántas variantes se piden. Cada variante debe ser una propuesta distinta (otro enfoque u otro arranque), no la misma frase retocada, y debe caber en los límites indicados contando las etiquetas.',
  'Devuelve las etiquetas (#) en su lista, no dentro del texto. Si no conviene ninguna, deja la lista vacía.',
  DATA_RULE,
].join('\n');

export const POST_COPY_SCHEMA: AiOutputSchema = {
  name: 'post_copy',
  schema: {
    type: 'object',
    properties: {
      variants: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_VARIANTS,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1 },
            hashtags: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'hashtags'],
          additionalProperties: false,
        },
      },
    },
    required: ['variants'],
    additionalProperties: false,
  },
};

function validNetwork(network: NetworkLimits): NetworkLimits {
  if (typeof network !== 'object' || network === null) throw new AiTaskInputError('Falta la red de destino.');
  const id = requireText(network.id, 'el identificador de la red', 40);
  const name = requireText(network.name, 'el nombre de la red', 80);
  if (!Number.isInteger(network.maxChars) || network.maxChars < 1 || network.maxChars > 100_000) {
    throw new AiTaskInputError('El límite de caracteres de la red no es válido.');
  }
  if (network.maxHashtags !== undefined && (!Number.isInteger(network.maxHashtags) || network.maxHashtags < 0)) {
    throw new AiTaskInputError('El límite de etiquetas de la red no es válido.');
  }
  const notes = (network.notes ?? []).map((note, i) => requireText(note, `la condición ${i + 1} de la red`, 300));
  if (notes.length > 10) throw new AiTaskInputError('La red trae demasiadas condiciones (máximo 10).');
  return { id, name, maxChars: network.maxChars, maxHashtags: network.maxHashtags, notes };
}

function normalizeHashtag(raw: string): string {
  const tag = raw.trim().replace(/\s+/g, '').replace(/^#+/, '');
  return tag ? `#${tag}` : '';
}

/** Mide una variante contra los límites de la red, sin cambiar su texto. */
export function measureVariant(text: string, hashtags: string[], network: NetworkLimits): PostCopyVariant {
  const tags = hashtags.map(normalizeHashtag).filter((tag) => tag !== '');
  const body = text.trim();
  const caption = tags.length > 0 ? `${body}\n\n${tags.join(' ')}` : body;
  // UTF-16, como el editor y el verificador (src/features/content/textUnits.ts).
  const characters = caption.length;
  const withinLimits =
    characters <= network.maxChars && (network.maxHashtags === undefined || tags.length <= network.maxHashtags);
  return { text: body, hashtags: tags, caption, characters, withinLimits };
}

function buildPrompt(brief: string, network: NetworkLimits, variants: number): string {
  const lines = [
    `Red: ${network.name}.`,
    `Límite: ${network.maxChars} caracteres en total, contando las etiquetas.`,
    network.maxHashtags === undefined ? null : `Etiquetas (#): como máximo ${network.maxHashtags}.`,
    ...(network.notes ?? []).map((note) => `Condición de la red: ${note}`),
    `Variantes: ${variants}.`,
  ].filter((line): line is string => line !== null);
  return `${lines.join('\n')}\n\nEscribe el texto de la publicación que se describe en el material «encargo».`;
}

export async function generatePostCopy(
  service: AiService,
  actor: TaskActor,
  request: PostCopyRequest,
): Promise<PostCopyResult> {
  const brief = requireText(request.brief, 'el encargo', MAX_BRIEF_CHARS);
  const network = validNetwork(request.network);
  if (!Number.isInteger(request.variants) || request.variants < 1 || request.variants > MAX_VARIANTS) {
    throw new AiTaskInputError(`El número de variantes debe estar entre 1 y ${MAX_VARIANTS}.`);
  }

  // Salida: cada variante puede ocupar hasta el límite de la red. Se reserva
  // con holgura (2 caracteres por token) y margen para el razonamiento del modelo.
  const maxOutputTokens = Math.min(16_000, 1024 + request.variants * Math.ceil(Math.min(network.maxChars, 6000) / 2));

  const { data, meta } = await runStructuredTask(service, {
    actor,
    purpose: POST_COPY_PURPOSE,
    instructions: POST_COPY_INSTRUCTIONS,
    // El encargo lo escribe una persona del cliente: viaja como material, no como instrucción.
    context: [brandProfileContext(request.brandProfile), { label: 'encargo', content: brief }],
    prompt: buildPrompt(brief, network, request.variants),
    schema: POST_COPY_SCHEMA,
    maxOutputTokens,
  });

  const raw = (data as { variants: { text: string; hashtags: string[] }[] }).variants;
  return {
    ...meta,
    network: network.id,
    requestedVariants: request.variants,
    // Si el modelo escribe de más, sobran; si escribe de menos, se ve en `requestedVariants`.
    variants: raw.slice(0, request.variants).map((variant) => measureVariant(variant.text, variant.hashtags, network)),
  };
}
