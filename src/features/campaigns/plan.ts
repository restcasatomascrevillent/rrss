import { z } from 'zod';
import { isKnownTarget } from '../content/networks';

// Forma del plan de campaña (`campaign_plans.data`). Es la misma que devuelve
// la tarea `campaign.plan` (supabase/functions/_shared/ai/text/tasks/campaign-plan.ts),
// la que entrega la agencia y la que valida la base de datos
// (private.campaign_plan_problem). Forma CERRADA: un campo no previsto
// («approve», «publish», «status»…) invalida el plan entero. Puro: sin red.

export const MAX_PLAN_PIECES = 30;
export const MAX_PLAN_DAYS = 63;
export const MAX_INSTRUCTION_CHARS = 2000;
export const MAX_CAMPAIGN_NETWORKS = 8;
export const MAX_PIECE_ASSETS = 4;

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Igual que en el documento de la pieza (postCopySchema): letras, números y guion bajo. */
const HASHTAG = /^[\p{L}\p{N}_]+$/u;

const shortList = (maxItems: number) => z.array(z.string().max(400)).max(maxItems);

export const campaignPieceSchema = z
  .object({
    network: z.string().regex(ID, 'Red no válida'),
    format: z.string().regex(ID, 'Formato no válido'),
    date: z.string().regex(DATE, 'Fecha no válida (AAAA-MM-DD)'),
    idea: z.string().trim().min(1, 'Falta la idea').max(300),
    caption: z.string().trim().min(1, 'Falta el texto').max(5000),
    hashtags: z
      .array(z.string().trim().max(100).regex(HASHTAG, 'Una etiqueta va sin # y solo con letras, números y guion bajo'))
      .max(30),
    assetIds: z.array(z.string().uuid('Recurso no válido')).max(MAX_PIECE_ASSETS),
    why: z.string().trim().max(600),
  })
  .strict();

export const campaignPlanSchema = z
  .object({
    objective: z.string().trim().min(1, 'Falta el objetivo').max(600),
    summary: z.string().trim().max(1500),
    reasoning: z
      .object({
        observed: shortList(10),
        dataBacked: shortList(10),
        hypotheses: shortList(20),
        dataNote: z.string().max(600),
      })
      .strict(),
    pieces: z.array(campaignPieceSchema).min(1, 'El plan no tiene piezas').max(MAX_PLAN_PIECES),
  })
  .strict();

export type CampaignPiece = z.infer<typeof campaignPieceSchema>;
export type CampaignPlan = z.infer<typeof campaignPlanSchema>;

export interface PlanIssue {
  /** «pieces.2.date», «objective»… Vacío si es el plan entero. */
  path: string;
  message: string;
}

/** Lo que la campaña fija: redes y fechas (AAAA-MM-DD, ambas incluidas). */
export interface CampaignFrame {
  networks: readonly string[];
  starts_on: string;
  ends_on: string;
}

/**
 * Comprueba un plan contra el esquema y contra su campaña: redes de la
 * campaña, formatos del catálogo y fechas dentro del plan. Devuelve el plan
 * normalizado o los problemas.
 */
export function validatePlan(
  input: unknown,
  frame: CampaignFrame,
): { ok: true; plan: CampaignPlan } | { ok: false; issues: PlanIssue[] } {
  const parsed = campaignPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }
  const issues: PlanIssue[] = [];
  parsed.data.pieces.forEach((piece, index) => {
    if (!frame.networks.includes(piece.network)) {
      issues.push({ path: `pieces.${index}.network`, message: 'Esa red no es de la campaña' });
    } else if (!isKnownTarget(piece.network, piece.format)) {
      issues.push({ path: `pieces.${index}.format`, message: 'Ese formato no existe en esa red' });
    }
    if (!isRealDate(piece.date) || piece.date < frame.starts_on || piece.date > frame.ends_on) {
      issues.push({ path: `pieces.${index}.date`, message: 'La fecha cae fuera de la campaña' });
    }
  });
  return issues.length ? { ok: false, issues } : { ok: true, plan: parsed.data };
}

export function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Días entre dos fechas AAAA-MM-DD, ambas incluidas. */
export function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Fecha AAAA-MM-DD (local) de un `Date`. */
export function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** «La semana que viene»: del lunes siguiente al domingo, en la hora local. */
export function nextWeek(today: Date): { start: string; end: string } {
  const day = today.getDay(); // 0 = domingo
  const toMonday = (8 - day) % 7 || 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + toMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: isoDay(monday), end: isoDay(sunday) };
}

/** Fecha AAAA-MM-DD para personas: «lun 23/11». */
export function shortDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(date);
}
