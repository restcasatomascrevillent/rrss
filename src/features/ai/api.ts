// Cliente de la Edge Function `ai-generate` (contrato en docs/ia-texto.md, §5)
// y lecturas de consumo y cupo de IA (docs/02-modelo-de-datos.md, §9).
//
// Las mutaciones se exponen SIN `mutate`: solo `mutateAsync`. Los callbacks de
// `mutate` se pierden si el componente se desmonta o se vuelve a pintar a media
// petición (ya pasó en este proyecto); con la promesa, quien llama decide.
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { AiCostByOrganizationRow, AiUsageRow, UsageQuotaRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

// ── Tipos del contrato ────────────────────────────────────────────────────

export type AiAction = 'post.caption' | 'brand.check' | 'profile.proposal' | 'analytics.summary' | 'editor.copilot';

/** Interpretación de la analítica (Fase 5): solo hipótesis, cada una con los datos en que se apoya. */
export interface AnalyticsSummaryResult {
  action: 'analytics.summary';
  generationId: string;
  hypotheses: { id: string; kind: 'hypothesis'; source: 'ai'; text: string; basedOn: string[] }[];
  /** Propuestas de la IA descartadas por no apoyarse en ningún dato medido. */
  discarded: number;
}

/** Límites de la red tal como los espera la tarea `post.caption`. */
export interface AiNetworkLimits {
  id: string;
  name: string;
  maxChars: number;
  maxHashtags?: number;
  notes?: string[];
}

export interface PostCaptionInput {
  brief: string;
  network: AiNetworkLimits;
  /** De 1 a 5. */
  variants: number;
}

export interface PostCaptionVariant {
  text: string;
  /** Con la almohadilla delante. */
  hashtags: string[];
  /** Texto y, debajo, las etiquetas: lo que se publicaría. */
  caption: string;
  /** Caracteres (puntos de código) del texto completo, medidos en el servidor. */
  characters: number;
  withinLimits: boolean;
}

export interface PostCaptionResult {
  action: 'post.caption';
  generationId: string;
  network: string;
  requestedVariants: number;
  variants: PostCaptionVariant[];
}

export type BrandCheckCriterion = 'tone' | 'banned_topics';
export type CriterionVerdict = 'pass' | 'fail' | 'uncertain';
export type BrandCheckVerdict = 'pass' | 'fail' | 'review';

export interface BrandCheckCriterionResult {
  criterion: BrandCheckCriterion;
  verdict: CriterionVerdict;
  explanation: string;
  /** Fragmentos literales del texto. */
  evidence: string[];
}

export interface BrandCheckResult {
  action: 'brand.check';
  generationId: string;
  verdict: BrandCheckVerdict;
  needsHumanReview: boolean;
  criteria: BrandCheckCriterionResult[];
}

export interface ProfileSourceText {
  title: string;
  text: string;
}

export interface ProfileProposalResult {
  action: 'profile.proposal';
  generationId: string;
  status: 'proposal';
  /** Secciones con la forma de `brand_profiles.data` (sin competidores, referencias ni logotipos). */
  proposal: Record<string, unknown>;
  notes: { section: string; note: string }[];
  sources: string[];
}

// ── Errores ───────────────────────────────────────────────────────────────

/** Códigos del contrato y dos propios del cliente (`network`, `client_timeout`). */
export type AiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'quota_exhausted'
  | 'quota_missing'
  | 'forbidden'
  | 'brand_not_found'
  | 'brand_profile_missing'
  | 'agency_mode'
  | 'refused'
  | 'provider_failed'
  | 'invalid_output'
  | 'not_configured'
  | 'provider_timeout'
  | 'too_large'
  | 'internal'
  | 'network'
  | 'client_timeout';

const KNOWN_CODES = new Set<string>([
  'invalid_request',
  'unauthenticated',
  'quota_exhausted',
  'quota_missing',
  'forbidden',
  'brand_not_found',
  'brand_profile_missing',
  'agency_mode',
  'refused',
  'provider_failed',
  'invalid_output',
  'not_configured',
  'provider_timeout',
  'too_large',
  'internal',
]);

const MESSAGES: Record<AiErrorCode, string> = {
  quota_exhausted:
    'El cupo de IA de este mes está agotado. Se renueva el día 1 del mes que viene; si hace falta antes, quien administra la organización puede pedir a la plataforma que lo amplíe.',
  quota_missing:
    'Esta organización todavía no tiene cupo de IA asignado. Quien administra la organización debe pedírselo a la plataforma.',
  not_configured:
    'La IA no está disponible en este momento: falta configurarla en la plataforma. Avisa a quien la administra.',
  refused:
    'El modelo se ha negado a responder a esta petición. Cambia el planteamiento (sin datos personales ni temas delicados) y vuelve a probar.',
  provider_failed: 'El servicio de IA ha fallado y no se ha descontado nada del cupo. Vuelve a probar en un momento.',
  invalid_output:
    'La IA ha devuelto una respuesta que no se puede usar. Vuelve a probar; si se repite, cambia la petición.',
  provider_timeout: 'El servicio de IA ha tardado demasiado en responder. Vuelve a probar en un momento.',
  client_timeout: 'La IA no ha respondido a tiempo. Vuelve a probar en un momento.',
  forbidden: 'No tienes permiso para usar la IA en esta marca: hace falta poder crear contenido en ella.',
  brand_not_found: 'No existe esa marca o no tienes acceso a ella.',
  brand_profile_missing: 'Esta marca todavía no tiene perfil. Complétalo antes de usar la IA.',
  agency_mode:
    'Esta marca redacta por encargo a la agencia, no con el servicio de IA. Pide la pieza desde «Encargos» o, si gestionas la marca, cambia el modo en su página.',
  unauthenticated: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  invalid_request: 'La petición a la IA no es válida. Revisa lo que has escrito.',
  too_large: 'El texto es demasiado largo para enviarlo a la IA.',
  network: 'No hay conexión con el servidor. Comprueba tu red.',
  internal: 'Algo ha fallado al usar la IA. Inténtalo de nuevo.',
};

/** Mensaje para personas de cada código. */
export function aiErrorMessage(code: AiErrorCode): string {
  return MESSAGES[code];
}

export class AiRequestError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly generationId: string | undefined;

  constructor(
    code: AiErrorCode,
    message: string,
    extra: { retryable?: boolean; status?: number | null; generationId?: string } = {},
  ) {
    super(message);
    this.name = 'AiRequestError';
    this.code = code;
    this.retryable = extra.retryable ?? false;
    this.status = extra.status ?? null;
    this.generationId = extra.generationId;
  }
}

/** ¿Es un error de cupo (agotado o sin asignar)? Las pantallas lo explican aparte. */
export function isQuotaError(error: unknown): error is AiRequestError {
  return error instanceof AiRequestError && (error.code === 'quota_exhausted' || error.code === 'quota_missing');
}

/**
 * Error de `functions.invoke` → `AiRequestError` con el mensaje en español.
 * Para `invalid_request` se usa el mensaje del servidor, que dice qué falta
 * («El número de variantes debe estar entre 1 y 5»); para los demás, el
 * propio, que no depende de cómo redacte el servidor.
 */
export async function toAiError(error: unknown): Promise<AiRequestError> {
  if (error instanceof AiRequestError) return error;
  const name = typeof error === 'object' && error !== null ? (error as { name?: string }).name : undefined;
  const context = typeof error === 'object' && error !== null ? (error as { context?: unknown }).context : undefined;

  if (name === 'FunctionsHttpError' && context instanceof Response) {
    let body: unknown = null;
    try {
      body = await context.clone().json();
    } catch {
      body = null;
    }
    const payload = (
      body as { error?: { code?: unknown; message?: unknown; retryable?: unknown; generationId?: unknown } } | null
    )?.error;
    const raw = typeof payload?.code === 'string' ? payload.code : '';
    const code: AiErrorCode = KNOWN_CODES.has(raw)
      ? (raw as AiErrorCode)
      : context.status === 401
        ? 'unauthenticated'
        : 'internal';
    const serverMessage = typeof payload?.message === 'string' ? payload.message.trim() : '';
    const message = code === 'invalid_request' && serverMessage ? serverMessage : MESSAGES[code];
    return new AiRequestError(code, message, {
      retryable: payload?.retryable === true,
      status: context.status,
      generationId: typeof payload?.generationId === 'string' ? payload.generationId : undefined,
    });
  }
  if (name === 'FunctionsFetchError') {
    const cause = context as { name?: string } | undefined;
    if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError') {
      return new AiRequestError('client_timeout', MESSAGES.client_timeout, { retryable: true });
    }
    return new AiRequestError('network', MESSAGES.network, { retryable: true });
  }
  return new AiRequestError('internal', MESSAGES.internal, { retryable: true });
}

// ── Llamada ───────────────────────────────────────────────────────────────

/** Margen sobre el tiempo máximo del servidor (60 s por defecto). */
const CLIENT_TIMEOUT_MS = 90_000;

async function invokeAiGenerate<T extends { action: AiAction }>(
  action: AiAction,
  brandId: string,
  input: unknown,
): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke('ai-generate', {
      body: { action, brandId, input },
      timeout: CLIENT_TIMEOUT_MS,
    });
  } catch (error) {
    throw await toAiError(error);
  }
  if (result.error) throw await toAiError(result.error);
  const data = result.data as T | null;
  if (!data || typeof data !== 'object' || data.action !== action) {
    throw new AiRequestError('internal', MESSAGES.internal, { retryable: true });
  }
  return data;
}

export function generatePostCaption(brandId: string, input: PostCaptionInput): Promise<PostCaptionResult> {
  return invokeAiGenerate<PostCaptionResult>('post.caption', brandId, input);
}

export function checkBrandWithAi(brandId: string, text: string): Promise<BrandCheckResult> {
  return invokeAiGenerate<BrandCheckResult>('brand.check', brandId, { text });
}

export function proposeProfile(brandId: string, sources: ProfileSourceText[]): Promise<ProfileProposalResult> {
  return invokeAiGenerate<ProfileProposalResult>('profile.proposal', brandId, { sources });
}

/** Interpreta las cifras medidas de un periodo (AAAA-MM-DD, `to` excluido). Solo devuelve hipótesis. */
export function summarizeAnalytics(
  brandId: string,
  period: { from: string; to: string },
): Promise<AnalyticsSummaryResult> {
  return invokeAiGenerate<AnalyticsSummaryResult>('analytics.summary', brandId, period);
}

/**
 * Copiloto por voz (`editor.copilot`): lo dictado + el estado del documento →
 * operaciones de editor. La respuesta NO se usa tal cual: la valida
 * `parseCopilotResponse` (src/features/content/copilot/operations.ts) y las
 * aplica `applyCopilotOperations`, que valida el documento resultante.
 */
export function requestEditorCopilot(brandId: string, input: unknown): Promise<{ action: 'editor.copilot' }> {
  return invokeAiGenerate<{ action: 'editor.copilot' }>('editor.copilot', brandId, input);
}

/** Mutación sin `mutate`: solo `mutateAsync`. */
export type AsyncMutation<TData, TVariables> = Omit<UseMutationResult<TData, AiRequestError, TVariables>, 'mutate'>;

/** Quita `mutate` del resultado de `useMutation`. */
function withoutMutate<T extends { mutate: unknown }>(mutation: T): Omit<T, 'mutate'> {
  const copy: Partial<T> = { ...mutation };
  delete copy.mutate;
  return copy as Omit<T, 'mutate'>;
}

export const aiKeys = {
  org: (orgId: string) => ['ai', orgId] as const,
  quota: (orgId: string) => ['ai', orgId, 'quota'] as const,
  ledger: (orgId: string, periodStart: string) => ['ai', orgId, 'ledger', periodStart] as const,
  monthly: (orgId: string, from: string) => ['ai', orgId, 'monthly', from] as const,
  platformCost: (from: string) => ['platform', 'ai-cost', from] as const,
};

export function useGeneratePostCaption(brandId: string): AsyncMutation<PostCaptionResult, PostCaptionInput> {
  return withoutMutate(
    useMutation<PostCaptionResult, AiRequestError, PostCaptionInput>({
      mutationFn: (input) => generatePostCaption(brandId, input),
    }),
  );
}

export function useBrandCheckAi(brandId: string): AsyncMutation<BrandCheckResult, string> {
  return withoutMutate(
    useMutation<BrandCheckResult, AiRequestError, string>({ mutationFn: (text) => checkBrandWithAi(brandId, text) }),
  );
}

export function useProfileProposal(brandId: string): AsyncMutation<ProfileProposalResult, ProfileSourceText[]> {
  return withoutMutate(
    useMutation<ProfileProposalResult, AiRequestError, ProfileSourceText[]>({
      mutationFn: (sources) => proposeProfile(brandId, sources),
    }),
  );
}

// ── Consumo y cupo ────────────────────────────────────────────────────────

/** Primer día del mes (UTC) en `YYYY-MM-DD`: el periodo de los cupos. */
export function periodStartOf(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** Los `count` últimos meses, del más reciente al más antiguo (`YYYY-MM-DD`). */
export function lastPeriods(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 10),
  );
}

function nextPeriod(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Cupo mensual de la organización, o `null` si no tiene. Lo leen sus administradores (RLS). */
/**
 * Cupo mensual de IA vigente de una organización: el que haya sobrescrito la
 * plataforma (`usage_quotas`) o, si no hay, el de su plan (Fase 6). `null` si
 * ninguno de los dos da cupo.
 */
export interface AiQuota {
  limit_value: number;
  source: 'override' | 'plan';
  /** Nombre del plan, si el cupo sale de él. */
  plan_name: string | null;
}

export function useAiQuota(orgId: string, enabled = true) {
  return useQuery({
    queryKey: aiKeys.quota(orgId),
    enabled,
    queryFn: async (): Promise<AiQuota | null> => {
      const override = unwrap(
        await supabase
          .from('usage_quotas')
          .select('*')
          .eq('organization_id', orgId)
          .eq('metric', 'ai_cost_micros')
          .maybeSingle(),
      ) as UsageQuotaRow | null;
      if (override) return { limit_value: Number(override.limit_value), source: 'override', plan_name: null };
      const plan = unwrap(await supabase.rpc('organization_plan_usage', { p_organization_id: orgId }));
      return plan.ai_limit_micros > 0
        ? { limit_value: Number(plan.ai_limit_micros), source: 'plan', plan_name: plan.plan.name }
        : null;
    },
  });
}

/** Máximo de apuntes del libro que se leen para un mes (de mil en mil). */
export const LEDGER_MAX_ROWS = 20_000;
const LEDGER_PAGE = 1000;

export interface BrandCost {
  brandId: string | null;
  generations: number;
  costMicros: number;
}

export interface MonthLedger {
  periodStart: string;
  /** Coste real apuntado (settle). */
  consumedMicros: number;
  /** Reservas de generaciones en curso (aún sin cerrar). */
  reservedMicros: number;
  generations: number;
  byBrand: BrandCost[];
  /** `true` si el mes tiene más apuntes de los que se han leído: las cifras se quedan cortas. */
  truncated: boolean;
}

/** Suma el libro de consumo de un mes. Pura: se prueba sin red. */
export function summarizeLedger(
  periodStart: string,
  rows: Pick<AiUsageRow, 'brand_id' | 'entry' | 'reserved_delta_micros' | 'cost_delta_micros'>[],
  truncated = false,
): MonthLedger {
  let consumed = 0;
  let reserved = 0;
  let generations = 0;
  const brands = new Map<string | null, BrandCost>();
  for (const row of rows) {
    reserved += Number(row.reserved_delta_micros);
    if (row.entry !== 'settle') continue;
    const cost = Number(row.cost_delta_micros);
    consumed += cost;
    generations += 1;
    const entry = brands.get(row.brand_id) ?? { brandId: row.brand_id, generations: 0, costMicros: 0 };
    entry.generations += 1;
    entry.costMicros += cost;
    brands.set(row.brand_id, entry);
  }
  return {
    periodStart,
    consumedMicros: consumed,
    reservedMicros: Math.max(0, reserved),
    generations,
    byBrand: [...brands.values()].sort((a, b) => b.costMicros - a.costMicros),
    truncated,
  };
}

/** Libro de consumo de un mes de la organización (solo administradores). */
export function useAiMonthLedger(orgId: string, periodStart: string, enabled = true) {
  return useQuery({
    queryKey: aiKeys.ledger(orgId, periodStart),
    enabled,
    queryFn: async (): Promise<MonthLedger> => {
      const rows: AiUsageRow[] = [];
      let truncated = false;
      for (let from = 0; ; from += LEDGER_PAGE) {
        const page = unwrap(
          await supabase
            .from('ai_usage')
            .select('id, brand_id, entry, reserved_delta_micros, cost_delta_micros')
            .eq('organization_id', orgId)
            .eq('period_start', periodStart)
            .order('id', { ascending: true })
            .range(from, from + LEDGER_PAGE - 1),
        ) as AiUsageRow[];
        rows.push(...page);
        if (page.length < LEDGER_PAGE) break;
        if (rows.length >= LEDGER_MAX_ROWS) {
          truncated = true;
          break;
        }
      }
      return summarizeLedger(periodStart, rows, truncated);
    },
  });
}

export interface MonthCost {
  periodStart: string;
  generations: number;
  costMicros: number;
}

/**
 * Coste de la organización mes a mes con `ai_cost_by_organization` (una
 * llamada por mes; la base suma por la fecha del apunte de cierre).
 */
export function useAiMonthlyCost(orgId: string, periods: string[], enabled = true) {
  return useQuery({
    queryKey: [...aiKeys.monthly(orgId, periods[periods.length - 1] ?? ''), periods.length],
    enabled: enabled && periods.length > 0,
    queryFn: async (): Promise<MonthCost[]> =>
      Promise.all(
        periods.map(async (periodStart): Promise<MonthCost> => {
          const rows = unwrap(
            await supabase.rpc('ai_cost_by_organization', {
              p_from: `${periodStart}T00:00:00Z`,
              p_to: `${nextPeriod(periodStart)}T00:00:00Z`,
            }),
          ) as AiCostByOrganizationRow[];
          const row = rows.find((r) => r.organization_id === orgId);
          return { periodStart, generations: Number(row?.generations ?? 0), costMicros: Number(row?.cost_micros ?? 0) };
        }),
      ),
  });
}

/** Coste de IA de todas las organizaciones en un mes (superadministrador). */
export function usePlatformAiCost(periodStart: string, enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.platformCost(periodStart),
    enabled,
    queryFn: async (): Promise<AiCostByOrganizationRow[]> =>
      unwrap(
        await supabase.rpc('ai_cost_by_organization', {
          p_from: `${periodStart}T00:00:00Z`,
          p_to: `${nextPeriod(periodStart)}T00:00:00Z`,
        }),
      ) as AiCostByOrganizationRow[],
  });
}

export interface SetQuotaInput {
  organizationId: string;
  monthlyLimitMicros: number;
}

/** Asigna el cupo mensual de una organización (solo superadministradores; queda auditado). */
export function useSetAiQuota(): Omit<UseMutationResult<UsageQuotaRow, unknown, SetQuotaInput>, 'mutate'> {
  const queryClient = useQueryClient();
  const mutation = useMutation<UsageQuotaRow, unknown, SetQuotaInput>({
    mutationFn: async ({ organizationId, monthlyLimitMicros }) =>
      unwrap(
        await supabase.rpc('admin_set_ai_quota', {
          p_organization_id: organizationId,
          p_monthly_limit_micros: monthlyLimitMicros,
        }),
      ) as UsageQuotaRow,
    onSuccess: (_row, { organizationId }) => queryClient.invalidateQueries({ queryKey: aiKeys.org(organizationId) }),
  });
  return withoutMutate(mutation);
}
