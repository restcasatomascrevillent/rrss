// Tarea: proponer un perfil de marca a partir de las fuentes subidas.
//
// Recibe el TEXTO ya extraído de las fuentes (esta tarea no lee PDF ni webs) y
// devuelve una PROPUESTA con la misma forma que el perfil de marca
// (src/features/brand/profile.ts). No guarda nada: una persona la revisa y,
// si la acepta, la guarda con `save_brand_profile()`, que es quien versiona y
// comprueba el permiso. Aquí no hay ninguna llamada que escriba el perfil.
import type { AiOutputSchema, AiService, Json, JsonSchema } from '../../contract.ts';
import {
  AiTaskInputError,
  DATA_RULE,
  requireText,
  runStructuredTask,
  stableStringify,
  type TaskActor,
  type TaskMeta,
} from './shared.ts';

export const PROFILE_PROPOSAL_PURPOSE = 'profile.proposal';
export const MAX_SOURCES = 20;
/** Tope del texto total de las fuentes. Por encima no se recorta en silencio: se rechaza. */
export const MAX_SOURCES_CHARS = 400_000;

export interface ProfileSource {
  /** Nombre con el que la persona reconoce la fuente («Manual de marca 2026.pdf»). */
  title: string;
  /** Texto ya extraído. */
  text: string;
}

export interface ProfileProposalRequest {
  sources: ProfileSource[];
  /** Perfil actual, si lo hay: la propuesta lo completa en vez de empezar de cero. */
  currentProfile?: Json;
}

export interface ProfileProposalResult extends TaskMeta {
  /** Siempre `proposal`: nada se ha aplicado. */
  status: 'proposal';
  /** Secciones del perfil propuestas (misma forma que `brand_profiles.data`). */
  proposal: { [section: string]: Json };
  /** Dudas, contradicciones entre fuentes y datos que no constan, para quien revisa. */
  notes: { section: string; note: string }[];
  sources: string[];
}

export const PROFILE_PROPOSAL_INSTRUCTIONS = [
  'Eres analista de marca. A partir de las fuentes que aporta el cliente (manual de marca, web, documentos), propones su perfil de marca.',
  'Rellena cada campo SOLO con lo que digan las fuentes. Si un dato no consta, deja el campo vacío (texto vacío o lista vacía): no lo inventes ni lo deduzcas de lo que suele ser habitual en el sector.',
  'Si hay un perfil actual, consérvalo salvo que las fuentes lo contradigan o lo amplíen.',
  'Escribe en el idioma principal de la marca. Sé concreto y breve: frases que una persona pueda revisar de un vistazo.',
  'En «voice.forbiddenPhrases» y «restrictions» recoge únicamente prohibiciones que las fuentes formulen de forma expresa.',
  'Los colores van en formato #RRGGBB y solo si la fuente da el valor exacto.',
  'En «notes» anota, por sección, lo que quien revise debe saber: contradicciones entre fuentes, datos dudosos y huecos importantes.',
  'Tu respuesta es una propuesta que revisará una persona antes de usarse.',
  DATA_RULE,
].join('\n');

const text: JsonSchema = { type: 'string' };
const list: JsonSchema = { type: 'array', items: { type: 'string' } };
const object = (properties: { [name: string]: JsonSchema }): JsonSchema => ({
  type: 'object',
  properties: properties as { [name: string]: Json },
  // Todo obligatorio: lo que no conste va vacío. Así el esquema no tiene
  // campos opcionales, que los proveedores limitan en modo estricto.
  required: Object.keys(properties),
  additionalProperties: false,
});
const listOf = (properties: { [name: string]: JsonSchema }): JsonSchema => ({ type: 'array', items: object(properties) });

export const PROFILE_PROPOSAL_SCHEMA: AiOutputSchema = {
  name: 'brand_profile_proposal',
  schema: object({
    business: object({
      description: text,
      products: listOf({ name: text, description: text }),
      locations: list,
      valueProps: list,
    }),
    audience: object({ segments: listOf({ name: text, description: text }) }),
    goals: list,
    voice: object({
      tone: list,
      personality: text,
      values: list,
      keyMessages: list,
      allowedPhrases: list,
      forbiddenPhrases: list,
    }),
    visual: object({
      colors: listOf({ name: text, hex: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, role: text }),
      fonts: listOf({ family: text, usage: text }),
      styleNotes: text,
    }),
    channels: listOf({ platform: text, handle: text, url: text }),
    languages: object({ primary: text, others: list }),
    restrictions: object({ legal: list, advertising: list }),
    notes: listOf({ section: text, note: text }),
  }),
};

export async function proposeBrandProfile(
  service: AiService,
  actor: TaskActor,
  request: ProfileProposalRequest,
): Promise<ProfileProposalResult> {
  if (!Array.isArray(request.sources) || request.sources.length === 0) {
    throw new AiTaskInputError('Hace falta al menos una fuente con texto para proponer el perfil.');
  }
  if (request.sources.length > MAX_SOURCES) {
    throw new AiTaskInputError(`Se pueden analizar como máximo ${MAX_SOURCES} fuentes a la vez.`);
  }
  const sources = request.sources.map((source, i) => ({
    title: requireText(source?.title, `el título de la fuente ${i + 1}`, 200),
    text: requireText(source?.text, `el texto de la fuente ${i + 1}`, MAX_SOURCES_CHARS),
  }));
  const total = sources.reduce((sum, source) => sum + source.text.length, 0);
  if (total > MAX_SOURCES_CHARS) {
    throw new AiTaskInputError(
      `Las fuentes suman demasiado texto (${total} caracteres; el máximo es ${MAX_SOURCES_CHARS}). Analízalas por partes.`,
    );
  }

  const context = sources.map((source) => ({ label: `fuente: ${source.title}`, content: source.text }));
  const current = request.currentProfile;
  if (current !== undefined && current !== null) {
    if (typeof current !== 'object' || Array.isArray(current)) {
      throw new AiTaskInputError('El perfil actual no tiene el formato esperado.');
    }
    context.push({ label: 'perfil actual', content: stableStringify(current) });
  }

  const { data, meta } = await runStructuredTask(service, {
    actor,
    purpose: PROFILE_PROPOSAL_PURPOSE,
    instructions: PROFILE_PROPOSAL_INSTRUCTIONS,
    context,
    prompt: `Propón el perfil de marca a partir de ${sources.length === 1 ? 'la fuente aportada' : `las ${sources.length} fuentes aportadas`}.`,
    schema: PROFILE_PROPOSAL_SCHEMA,
    maxOutputTokens: 8000,
  });

  const { notes, ...proposal } = data as { notes: { section: string; note: string }[]; [section: string]: Json };
  return {
    ...meta,
    status: 'proposal',
    proposal,
    notes: notes.filter((entry) => entry.note.trim() !== ''),
    sources: sources.map((source) => source.title),
  };
}
