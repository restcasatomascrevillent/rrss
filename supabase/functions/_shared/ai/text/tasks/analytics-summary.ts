// Tarea: interpretación de la analítica con IA (Fase 5, `analytics.summary`).
//
// La IA recibe SOLO las cifras ya medidas (los «datos» que redacta el analista
// sin IA, ../../../analytics/analyst.ts) y el perfil de marca como contexto, y
// devuelve interpretaciones. Todo lo que devuelve es HIPÓTESIS: no puede
// añadir cifras ni datos, y cada hipótesis tiene que apoyarse en datos que
// existen (por su identificador); la que no, se descarta. El resumen
// determinista sigue siendo la fuente de las cifras.
import type { AiOutputSchema, AiService, Json, JsonSchema } from '../../contract.ts';
import {
  AiTaskInputError,
  brandProfileContext,
  DATA_RULE,
  runStructuredTask,
  type TaskActor,
  type TaskMeta,
} from './shared.ts';

export const ANALYTICS_SUMMARY_PURPOSE = 'analytics.summary';
const MAX_FACTS = 60;
const MAX_HYPOTHESES = 5;

export interface AnalyticsFactInput {
  id: string;
  text: string;
}

export interface AnalyticsSummaryRequest {
  brandProfile: Json | null;
  /** Periodo, para el contexto («1–30 de noviembre de 2026»). */
  periodLabel: string;
  facts: AnalyticsFactInput[];
}

export interface AiHypothesis {
  id: string;
  kind: 'hypothesis';
  source: 'ai';
  text: string;
  basedOn: string[];
}

export interface AnalyticsSummaryResult extends TaskMeta {
  hypotheses: AiHypothesis[];
  /** Hipótesis descartadas por no apoyarse en ningún dato existente. */
  discarded: number;
}

export const ANALYTICS_SUMMARY_INSTRUCTIONS = [
  'Eres analista de redes sociales. Recibes en el material «datos medidos» una lista de cifras ya medidas de las cuentas de una marca, cada una con su identificador, y el perfil de la marca como contexto.',
  'Tu tarea es proponer como mucho 5 interpretaciones posibles (hipótesis) que ayuden a decidir qué publicar.',
  'Reglas:',
  '- No inventes cifras ni datos: usa solo los del material «datos medidos». No repitas los datos: interprétalos.',
  '- Cada hipótesis cita en «based_on» los identificadores de los datos en que se apoya (al menos uno).',
  '- Redacta cada hipótesis como posibilidad («podría», «parece»), nunca como causa demostrada, en español, en una o dos frases.',
  '- Si los datos no dan para ninguna interpretación útil (pocos datos, sin comparación), devuelve la lista vacía.',
  '- Ten en cuenta los avisos de los datos (estimaciones, días sin cifra, pocas publicaciones) y dilos si afectan.',
  DATA_RULE,
].join('\n');

const SCHEMA: AiOutputSchema = {
  name: 'analytics_summary',
  schema: {
    type: 'object',
    properties: {
      hypotheses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            based_on: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'based_on'],
          additionalProperties: false,
        } as JsonSchema,
      },
    },
    required: ['hypotheses'],
    additionalProperties: false,
  },
};

export async function summarizeAnalytics(
  service: AiService,
  actor: TaskActor,
  request: AnalyticsSummaryRequest,
): Promise<AnalyticsSummaryResult> {
  const facts = (request.facts ?? []).filter((f) => f && typeof f.id === 'string' && typeof f.text === 'string');
  if (!facts.length) throw new AiTaskInputError('No hay cifras medidas en ese periodo: no hay nada que interpretar.');
  if (facts.length > MAX_FACTS) throw new AiTaskInputError(`Demasiados datos (máximo ${MAX_FACTS}).`);
  const ids = new Set(facts.map((f) => f.id));

  const { data, meta } = await runStructuredTask(service, {
    actor,
    purpose: ANALYTICS_SUMMARY_PURPOSE,
    instructions: ANALYTICS_SUMMARY_INSTRUCTIONS,
    context: [
      ...(request.brandProfile ? [brandProfileContext(request.brandProfile)] : []),
      {
        label: 'datos medidos',
        content: JSON.stringify({
          periodo: request.periodLabel,
          datos: facts.map((f) => ({ id: f.id, dato: f.text })),
        }),
      },
    ],
    prompt: 'Propón las hipótesis a partir del material «datos medidos».',
    schema: SCHEMA,
    maxOutputTokens: 1500,
  });

  const raw = ((data as { hypotheses?: Array<{ text?: unknown; based_on?: unknown }> }).hypotheses ?? []).slice(0, 10);
  let discarded = 0;
  const hypotheses: AiHypothesis[] = [];
  for (const item of raw) {
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 500) : '';
    const basedOn = Array.isArray(item.based_on)
      ? item.based_on.filter((x): x is string => typeof x === 'string' && ids.has(x))
      : [];
    if (!text || !basedOn.length) {
      discarded += 1;
      continue;
    }
    if (hypotheses.length < MAX_HYPOTHESES) {
      hypotheses.push({
        id: `ai:${hypotheses.length + 1}`,
        kind: 'hypothesis',
        source: 'ai',
        text,
        basedOn: [...new Set(basedOn)],
      });
    }
  }
  return { ...meta, hypotheses, discarded };
}
