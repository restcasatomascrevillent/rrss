// Tarea: comprobación de marca con IA.
//
// Juzga lo que no se puede comprobar con reglas: si el TONO encaja con la
// marca y si el texto toca, POR SIGNIFICADO, un tema o una expresión que la
// marca tiene vetados (aunque no use las mismas palabras). Las reglas
// literales (longitud, expresiones exactas, formato) no son cosa de esta
// tarea: se comprueban sin IA en el verificador.
//
// El modelo evalúa cada criterio con una rúbrica y puede responder «dudoso».
// El veredicto global NO lo decide el modelo: se calcula aquí, y cualquier duda
// manda la pieza a revisión humana. Esta tarea nunca aprueba nada: «aprobado»
// es un estado que solo escribe una persona.
import type { AiOutputSchema, AiService, Json, JsonSchema } from '../../contract.ts';
import {
  brandProfileContext,
  DATA_RULE,
  requireText,
  runStructuredTask,
  type TaskActor,
  type TaskMeta,
} from './shared.ts';

export const BRAND_CHECK_PURPOSE = 'brand.check';
const MAX_TEXT_CHARS = 20_000;

export const BRAND_CHECK_CRITERIA = ['tone', 'banned_topics'] as const;
export type BrandCheckCriterion = (typeof BRAND_CHECK_CRITERIA)[number];

/** `uncertain` = «dudoso: que lo revise una persona». */
export type CriterionVerdict = 'pass' | 'fail' | 'uncertain';
/** `review` = no se puede dar por bueno ni por malo sin una persona. */
export type BrandCheckVerdict = 'pass' | 'fail' | 'review';

export interface CriterionResult {
  criterion: BrandCheckCriterion;
  verdict: CriterionVerdict;
  /** Motivo, en una o dos frases. */
  explanation: string;
  /** Fragmentos literales del texto en los que se apoya. */
  evidence: string[];
}

export interface BrandCheckRequest {
  /** Perfil de marca activo (`brand_profiles.data`). */
  brandProfile: Json;
  /** Texto que se comprueba. */
  text: string;
}

export interface BrandCheckResult extends TaskMeta {
  verdict: BrandCheckVerdict;
  /** `true` cuando el veredicto es `review`: la IA no se pronuncia y decide una persona. */
  needsHumanReview: boolean;
  criteria: CriterionResult[];
}

export const BRAND_CHECK_INSTRUCTIONS = [
  'Eres revisor de marca. Compruebas si un texto para redes sociales respeta la marca descrita en el material «perfil de marca». No reescribes el texto ni opinas sobre su calidad: solo evalúas los dos criterios de esta rúbrica.',
  '',
  'Criterio «tone» (tono y voz). Compara el texto con «voice» del perfil (tono, personalidad, valores, mensajes clave).',
  '- pass: el texto suena a la marca; cualquier desviación es de matiz.',
  '- fail: hay un choque claro y señalable con el tono o la personalidad descritos (por ejemplo, tuteo donde la marca trata de usted, humor donde pide sobriedad, agresividad comercial donde pide cercanía).',
  '- uncertain: el perfil no describe el tono lo bastante como para juzgar, o el texto está en el límite.',
  '',
  'Criterio «banned_topics» (temas y expresiones vetados). Compara el texto con «voice.forbiddenPhrases» y «restrictions» del perfil. Juzga por SIGNIFICADO: cuenta como incumplimiento decir lo vetado con otras palabras, insinuarlo o hacer la promesa o la comparación que la marca prohíbe.',
  '- pass: el texto no toca nada de lo vetado.',
  '- fail: el texto dice, promete o insinúa con claridad algo vetado. Indica qué veto es.',
  '- uncertain: el texto roza un veto y personas razonables podrían no estar de acuerdo, o el veto del perfil es ambiguo.',
  '',
  'Reglas comunes:',
  '- Si dudas, responde uncertain: lo revisará una persona. No fuerces un pass ni un fail.',
  '- Si el perfil no tiene nada que comparar para un criterio, responde uncertain en «tone» y pass en «banned_topics», y dilo en la explicación.',
  '- «explanation»: una o dos frases con el motivo, sin desarrollar el razonamiento paso a paso.',
  '- «evidence»: fragmentos copiados literalmente del texto evaluado que justifican el veredicto; lista vacía si es pass.',
  DATA_RULE,
].join('\n');

const criterionSchema: JsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    explanation: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'explanation', 'evidence'],
  additionalProperties: false,
};

export const BRAND_CHECK_SCHEMA: AiOutputSchema = {
  name: 'brand_check',
  schema: {
    type: 'object',
    properties: { tone: criterionSchema, banned_topics: criterionSchema },
    required: ['tone', 'banned_topics'],
    additionalProperties: false,
  },
};

/** Veredicto global: un incumplimiento claro pesa más que una duda, y una duda más que un visto bueno. */
export function overallVerdict(criteria: CriterionResult[]): BrandCheckVerdict {
  if (criteria.some((item) => item.verdict === 'fail')) return 'fail';
  if (criteria.some((item) => item.verdict === 'uncertain')) return 'review';
  return 'pass';
}

export async function checkBrandCompliance(
  service: AiService,
  actor: TaskActor,
  request: BrandCheckRequest,
): Promise<BrandCheckResult> {
  const text = requireText(request.text, 'el texto que se comprueba', MAX_TEXT_CHARS);

  const { data, meta } = await runStructuredTask(service, {
    actor,
    purpose: BRAND_CHECK_PURPOSE,
    instructions: BRAND_CHECK_INSTRUCTIONS,
    context: [brandProfileContext(request.brandProfile), { label: 'texto evaluado', content: text }],
    prompt: 'Evalúa el material «texto evaluado» con la rúbrica.',
    schema: BRAND_CHECK_SCHEMA,
    maxOutputTokens: 2000,
  });

  const answer = data as Record<BrandCheckCriterion, Omit<CriterionResult, 'criterion'>>;
  const criteria = BRAND_CHECK_CRITERIA.map((criterion): CriterionResult => {
    const { verdict, explanation, evidence } = answer[criterion];
    // La evidencia debe salir del texto: lo que no esté en él se descarta, y un
    // «fail» que se queda sin evidencia pasa a duda (no se acusa sin prueba).
    const quoted = evidence.map((fragment) => fragment.trim()).filter((fragment) => fragment && text.includes(fragment));
    const unsupported = verdict === 'fail' && quoted.length === 0;
    return { criterion, verdict: unsupported ? 'uncertain' : verdict, explanation: explanation.trim(), evidence: quoted };
  });

  const verdict = overallVerdict(criteria);
  return { ...meta, verdict, needsHumanReview: verdict === 'review', criteria };
}
