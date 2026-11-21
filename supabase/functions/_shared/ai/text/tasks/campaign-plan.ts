// Tarea: plan de campaña por instrucción («prepara la semana que viene»,
// «campaña de 3 semanas para el menú de otoño»).
//
// La IA PROPONE un plan explicado; no hace nada más. Lo que sale de aquí es
// solo datos: objetivo, razonamiento (observado / respaldado por datos /
// hipótesis) y una lista de piezas (red, formato, fecha, idea, pie de borrador
// y recursos sugeridos). Una persona lo revisa y, si lo acepta, un motor
// determinista crea las piezas como BORRADORES (src/features/campaigns/engine.ts
// y la función SQL accept_campaign_plan). Ni esta tarea ni el motor conocen
// otra acción que «crear borrador»: no hay forma de aprobar, programar ni
// publicar desde un plan.
//
// Defensa ante instrucciones maliciosas (en el perfil, en una fuente o en la
// propia instrucción):
//   * las instrucciones de la tarea son texto fijo del producto (mensaje de
//     sistema); todo lo que escribe el cliente viaja como material delimitado;
//   * la salida tiene un esquema cerrado (sin campos libres de «acciones» ni de
//     estado) y se valida entera;
//   * después, el producto descarta lo que no se pidió: piezas en redes o
//     formatos no elegidos, fuera de las fechas, recursos que no son de la
//     biblioteca enviada, y lo que exceda el máximo de piezas;
//   * sin datos de resultados, nada puede presentarse como «respaldado por
//     datos»: lo que el modelo ponga ahí pasa a hipótesis.
import { AiError, type AiOutputSchema, type AiService, type Json, type JsonSchema } from '../../contract.ts';
import {
  AiTaskInputError,
  brandProfileContext,
  DATA_RULE,
  requireText,
  runStructuredTask,
  type TaskActor,
  type TaskMeta,
} from './shared.ts';

export const CAMPAIGN_PLAN_PURPOSE = 'campaign.plan';
export const MAX_INSTRUCTION_CHARS = 2000;
/** Duración máxima de un plan: 9 semanas (una campaña de 2–4 semanas cabe con holgura). */
export const MAX_CAMPAIGN_DAYS = 63;
export const MAX_PIECES = 30;
export const MAX_TARGETS = 20;
export const MAX_ASSETS = 60;
export const MAX_ASSETS_PER_PIECE = 4;
export const MAX_SOURCES = 5;
export const MAX_SOURCES_CHARS = 60_000;
export const MAX_HASHTAGS = 30;

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASHTAG = /^[\p{L}\p{N}_]{1,100}$/u;

/** Texto fijo que acompaña a un plan sin datos de resultados (hoy, todos: la analítica es de la Fase 5). */
export const NO_DATA_NOTE =
  'Esta marca todavía no tiene datos de resultados en la plataforma: nada de este plan está respaldado por datos. Lo que no es observación es hipótesis.';

/** Un destino posible: red y formato del catálogo de la aplicación. Lo aporta quien llama. */
export interface CampaignTarget {
  network: string;
  format: string;
}

/** Recurso de la biblioteca que la IA puede sugerir (solo su descripción, nunca el archivo). */
export interface CampaignAssetRef {
  id: string;
  name: string;
  kind: string;
  tags?: string[];
  folder?: string;
}

export interface CampaignSource {
  title: string;
  text: string;
}

export interface CampaignPlanRequest {
  /** Perfil de marca activo (`brand_profiles.data`). */
  brandProfile: Json;
  /** Lo que pide la persona, con sus palabras. Es dato, no instrucciones. */
  instruction: string;
  /** Primer y último día del plan (AAAA-MM-DD, ambos incluidos). */
  startDate: string;
  endDate: string;
  targets: CampaignTarget[];
  assets?: CampaignAssetRef[];
  /** Fuentes de texto de la marca (ya extraído). Son dato. */
  sources?: CampaignSource[];
  /** Máximo de piezas (1–30). Por defecto, una cada dos días. */
  maxPieces?: number;
}

export interface CampaignPiece {
  network: string;
  format: string;
  /** AAAA-MM-DD, dentro del plan. */
  date: string;
  /** Idea de la pieza, para quien la prepare. */
  idea: string;
  /** Pie de borrador. */
  caption: string;
  /** Sin la almohadilla. */
  hashtags: string[];
  /** Recursos sugeridos de la biblioteca (de la marca). */
  assetIds: string[];
  /** Por qué esta pieza en este día y en esta red. */
  why: string;
}

export interface CampaignReasoning {
  /** Lo que se ve en el perfil, la instrucción, las fuentes y la biblioteca. */
  observed: string[];
  /** Lo que se apoya en datos de resultados (vacío si no hay datos). */
  dataBacked: string[];
  /** Suposiciones que conviene comprobar. */
  hypotheses: string[];
  /** Aviso sobre los datos (por ejemplo, que no hay). */
  dataNote: string;
}

/** Plan tal como se guarda (`campaign_plans.plan`). Misma forma en src/features/campaigns/plan.ts. */
export interface CampaignPlan {
  objective: string;
  summary: string;
  reasoning: CampaignReasoning;
  pieces: CampaignPiece[];
}

export interface DiscardedPiece {
  /** Posición en la respuesta del modelo. */
  index: number;
  reason: string;
}

export interface CampaignPlanResult extends TaskMeta {
  /** Siempre `proposal`: nada se ha creado todavía. */
  status: 'proposal';
  plan: CampaignPlan;
  /** Piezas de la respuesta que el producto ha descartado y por qué. */
  discarded: DiscardedPiece[];
}

export const CAMPAIGN_PLAN_INSTRUCTIONS = [
  'Eres estratega de redes sociales. Preparas un plan de publicaciones para la marca descrita en el material «perfil de marca», a partir de lo que pide el material «instrucción».',
  'Tu respuesta es solo una PROPUESTA que revisará una persona: no apruebas, no programas y no publicas nada, y no puedes pedir que se haga.',
  'Cada pieza va en una de las redes y formatos de la lista «Destinos» y en una fecha entre las fechas indicadas, ambas incluidas. No pases del máximo de piezas.',
  'Reparte las piezas con sentido (no todas el mismo día) y explica en «why» por qué cada una va en esa red y en ese día.',
  'El pie («caption») es un borrador en el tono y el idioma de la marca, sin las etiquetas (van en «hashtags», sin #). No uses expresiones prohibidas ni temas vetados por la marca.',
  'No inventes datos (precios, fechas, promociones, direcciones) que no estén en el perfil, la instrucción o las fuentes.',
  'En «assetIds» sugiere, si encajan, identificadores del material «biblioteca»; solo esos identificadores, ninguno más. Si ninguno encaja, deja la lista vacía.',
  'Separa el razonamiento: en «observed», lo que ves en el material; en «dataBacked», solo conclusiones apoyadas en el material «datos de resultados» (si no llega ese material, deja la lista vacía); en «hypotheses», lo que supones y convendría comprobar.',
  DATA_RULE,
].join('\n');

const text = (maxLength: number): JsonSchema => ({ type: 'string', maxLength });
const textList = (maxItems: number, maxLength: number): JsonSchema => ({
  type: 'array',
  maxItems,
  items: { type: 'string', maxLength },
});

export const CAMPAIGN_PLAN_SCHEMA: AiOutputSchema = {
  name: 'campaign_plan',
  schema: {
    type: 'object',
    properties: {
      objective: { type: 'string', minLength: 1, maxLength: 600 },
      summary: text(1500),
      observed: textList(10, 400),
      dataBacked: textList(10, 400),
      hypotheses: textList(10, 400),
      pieces: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PIECES * 2,
        items: {
          type: 'object',
          properties: {
            network: text(32),
            format: text(32),
            date: text(10),
            idea: { type: 'string', minLength: 1, maxLength: 300 },
            caption: { type: 'string', minLength: 1, maxLength: 5000 },
            hashtags: textList(MAX_HASHTAGS, 100),
            assetIds: textList(10, 36),
            why: text(600),
          },
          required: ['network', 'format', 'date', 'idea', 'caption', 'hashtags', 'assetIds', 'why'],
          additionalProperties: false,
        },
      },
    },
    required: ['objective', 'summary', 'observed', 'dataBacked', 'hypotheses', 'pieces'],
    additionalProperties: false,
  } as JsonSchema,
};

// ── Validación de la petición ────────────────────────────────────────────

/** Día UTC de una fecha AAAA-MM-DD, o null si no es una fecha real. */
export function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  return time / 86_400_000;
}

function validTargets(targets: unknown): CampaignTarget[] {
  if (!Array.isArray(targets) || targets.length === 0) throw new AiTaskInputError('Elige al menos una red.');
  if (targets.length > MAX_TARGETS) throw new AiTaskInputError(`Como mucho ${MAX_TARGETS} destinos.`);
  const seen = new Set<string>();
  const out: CampaignTarget[] = [];
  for (const target of targets as unknown[]) {
    const { network, format } = (typeof target === 'object' && target !== null ? target : {}) as Record<
      string,
      unknown
    >;
    if (typeof network !== 'string' || !ID.test(network) || typeof format !== 'string' || !ID.test(format)) {
      throw new AiTaskInputError('Algún destino (red y formato) no es válido.');
    }
    const key = `${network}/${format}`;
    if (!seen.has(key)) out.push({ network, format });
    seen.add(key);
  }
  return out;
}

function validAssets(assets: unknown): CampaignAssetRef[] {
  if (assets === undefined || assets === null) return [];
  if (!Array.isArray(assets)) throw new AiTaskInputError('La lista de recursos no es válida.');
  if (assets.length > MAX_ASSETS) throw new AiTaskInputError(`Como mucho ${MAX_ASSETS} recursos de la biblioteca.`);
  return (assets as unknown[]).map((asset) => {
    const a = (typeof asset === 'object' && asset !== null ? asset : {}) as Record<string, unknown>;
    if (typeof a.id !== 'string' || !UUID.test(a.id)) throw new AiTaskInputError('Algún recurso no es válido.');
    const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : [];
    return {
      id: a.id.toLowerCase(),
      name: typeof a.name === 'string' ? a.name.slice(0, 200) : '',
      kind: typeof a.kind === 'string' ? a.kind.slice(0, 20) : '',
      tags: tags.map((t) => t.slice(0, 60)),
      folder: typeof a.folder === 'string' ? a.folder.slice(0, 200) : '',
    };
  });
}

function validSources(sources: unknown): CampaignSource[] {
  if (sources === undefined || sources === null) return [];
  if (!Array.isArray(sources)) throw new AiTaskInputError('Las fuentes no son válidas.');
  if (sources.length > MAX_SOURCES) throw new AiTaskInputError(`Como mucho ${MAX_SOURCES} fuentes.`);
  const out = (sources as unknown[]).map((source, i) => {
    const s = (typeof source === 'object' && source !== null ? source : {}) as Record<string, unknown>;
    return {
      title: requireText(s.title, `el título de la fuente ${i + 1}`, 200),
      text: requireText(s.text, `el texto de la fuente ${i + 1}`, MAX_SOURCES_CHARS),
    };
  });
  const total = out.reduce((sum, source) => sum + source.text.length, 0);
  if (total > MAX_SOURCES_CHARS) {
    throw new AiTaskInputError(`Las fuentes superan entre todas el máximo de ${MAX_SOURCES_CHARS} caracteres.`);
  }
  return out;
}

/** Máximo de piezas por defecto: una cada dos días, entre 1 y 30. */
export function defaultMaxPieces(days: number): number {
  return Math.max(1, Math.min(MAX_PIECES, Math.ceil(days / 2)));
}

// ── Saneado de la respuesta ──────────────────────────────────────────────

export function normalizeHashtags(raw: string[]): string[] {
  const out: string[] = [];
  for (const tag of raw) {
    const clean = tag.trim().replace(/\s+/g, '').replace(/^#+/, '');
    if (HASHTAG.test(clean) && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, MAX_HASHTAGS);
}

const cleanList = (items: string[]) => items.map((item) => item.trim()).filter(Boolean);

interface RawPlan {
  objective: string;
  summary: string;
  observed: string[];
  dataBacked: string[];
  hypotheses: string[];
  pieces: Omit<CampaignPiece, never>[];
}

export interface SanitizeContext {
  startDate: string;
  endDate: string;
  targets: CampaignTarget[];
  assetIds: string[];
  maxPieces: number;
  /** ¿Se enviaron datos de resultados? Hoy nunca. */
  hasPerformanceData: boolean;
}

/**
 * Deja en el plan solo lo que se pidió. Determinista: la misma respuesta da
 * siempre el mismo plan. No añade nada que no dijera el modelo.
 */
export function sanitizePlan(raw: RawPlan, ctx: SanitizeContext): { plan: CampaignPlan; discarded: DiscardedPiece[] } {
  const start = dayNumber(ctx.startDate)!;
  const end = dayNumber(ctx.endDate)!;
  const targets = new Set(ctx.targets.map((t) => `${t.network}/${t.format}`));
  const assets = new Set(ctx.assetIds.map((id) => id.toLowerCase()));
  const discarded: DiscardedPiece[] = [];
  const kept: CampaignPiece[] = [];

  raw.pieces.forEach((piece, index) => {
    const day = dayNumber(piece.date);
    if (!targets.has(`${piece.network}/${piece.format}`)) {
      discarded.push({ index, reason: 'Red o formato que no se ha pedido.' });
    } else if (day === null || day < start || day > end) {
      discarded.push({ index, reason: 'Fecha fuera del plan.' });
    } else if (!piece.idea.trim() || !piece.caption.trim()) {
      discarded.push({ index, reason: 'Pieza sin idea o sin texto.' });
    } else {
      const assetIds = [...new Set(piece.assetIds.map((id) => id.trim().toLowerCase()))]
        .filter((id) => assets.has(id))
        .slice(0, MAX_ASSETS_PER_PIECE);
      kept.push({
        network: piece.network,
        format: piece.format,
        date: piece.date,
        idea: piece.idea.trim(),
        caption: piece.caption.trim(),
        hashtags: normalizeHashtags(piece.hashtags),
        assetIds,
        why: piece.why.trim(),
      });
    }
  });

  // Por fecha (orden estable); lo que pase del máximo se descarta, avisando.
  const ordered = kept
    .map((piece, order) => ({ piece, order }))
    .sort((a, b) => (a.piece.date === b.piece.date ? a.order - b.order : a.piece.date < b.piece.date ? -1 : 1))
    .map(({ piece }) => piece);
  const pieces = ordered.slice(0, ctx.maxPieces);
  if (ordered.length > pieces.length) {
    discarded.push({
      index: -1,
      reason: `Sobran ${ordered.length - pieces.length} piezas sobre el máximo de ${ctx.maxPieces}.`,
    });
  }

  const observed = cleanList(raw.observed);
  const dataBacked = cleanList(raw.dataBacked);
  const hypotheses = cleanList(raw.hypotheses);
  return {
    plan: {
      objective: raw.objective.trim(),
      summary: raw.summary.trim(),
      reasoning: ctx.hasPerformanceData
        ? { observed, dataBacked, hypotheses, dataNote: '' }
        : // Sin datos, nada está respaldado por datos: lo que el modelo puso ahí es una hipótesis más.
          { observed, dataBacked: [], hypotheses: [...hypotheses, ...dataBacked], dataNote: NO_DATA_NOTE },
      pieces,
    },
    discarded,
  };
}

// ── Tarea ────────────────────────────────────────────────────────────────

function buildPrompt(startDate: string, endDate: string, targets: CampaignTarget[], maxPieces: number): string {
  // Todo lo de aquí está validado (fechas reales, identificadores con formato
  // fijo, número entero): ningún texto libre del cliente entra en el prompt.
  return [
    `Fechas: del ${startDate} al ${endDate}, ambos incluidos.`,
    'Destinos (red/formato):',
    ...targets.map((t) => `- Destino: ${t.network}/${t.format}`),
    `Máximo de piezas: ${maxPieces}.`,
    '',
    'Prepara el plan que pide el material «instrucción».',
  ].join('\n');
}

export async function planCampaign(
  service: AiService,
  actor: TaskActor,
  request: CampaignPlanRequest,
): Promise<CampaignPlanResult> {
  const instruction = requireText(request.instruction, 'la instrucción', MAX_INSTRUCTION_CHARS);
  const start = dayNumber(request.startDate);
  const end = dayNumber(request.endDate);
  if (start === null || end === null) throw new AiTaskInputError('Las fechas del plan no son válidas (AAAA-MM-DD).');
  if (end < start) throw new AiTaskInputError('La fecha final es anterior a la inicial.');
  const days = end - start + 1;
  if (days > MAX_CAMPAIGN_DAYS) throw new AiTaskInputError(`Un plan dura como mucho ${MAX_CAMPAIGN_DAYS} días.`);
  const targets = validTargets(request.targets);
  const assets = validAssets(request.assets);
  const sources = validSources(request.sources);
  const maxPieces = request.maxPieces ?? defaultMaxPieces(days);
  if (!Number.isInteger(maxPieces) || maxPieces < 1 || maxPieces > MAX_PIECES) {
    throw new AiTaskInputError(`El máximo de piezas debe estar entre 1 y ${MAX_PIECES}.`);
  }

  const context = [
    brandProfileContext(request.brandProfile),
    // Lo que escribe el cliente (instrucción, fuentes, nombres de archivos) viaja como material.
    { label: 'instrucción', content: instruction },
    { label: 'biblioteca', content: JSON.stringify(assets) },
    ...sources.map((source) => ({ label: `fuente: ${source.title}`, content: source.text })),
  ];

  const { data, meta } = await runStructuredTask(service, {
    actor,
    purpose: CAMPAIGN_PLAN_PURPOSE,
    instructions: CAMPAIGN_PLAN_INSTRUCTIONS,
    context,
    prompt: buildPrompt(request.startDate, request.endDate, targets, maxPieces),
    schema: CAMPAIGN_PLAN_SCHEMA,
    maxOutputTokens: Math.min(16_000, 1500 + maxPieces * 700),
  });

  const { plan, discarded } = sanitizePlan(data as unknown as RawPlan, {
    startDate: request.startDate,
    endDate: request.endDate,
    targets,
    assetIds: assets.map((a) => a.id),
    maxPieces,
    hasPerformanceData: false,
  });
  if (plan.pieces.length === 0) {
    throw new AiError(
      'invalid_output',
      'La IA no ha propuesto ninguna pieza válida para esas fechas y redes. Vuelve a probar o cambia la instrucción.',
      { generationId: meta.generationId },
    );
  }
  return { ...meta, status: 'proposal', plan, discarded };
}
