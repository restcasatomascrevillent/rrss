// Lógica de la Edge Function `ai-generate`, sin nada de Deno: recibe sus
// dependencias (sesión, lectura del perfil, servicio de IA) y devuelve una
// `Response`. Así las pruebas la ejecutan en Node con la base de datos real y
// el proveedor simulado; `index.ts` solo la conecta con Supabase.
//
//   1. verifica la sesión (token del usuario);
//   2. valida la petición;
//   3. lee el perfil de marca CON LA IDENTIDAD DEL USUARIO (la RLS decide si lo ve);
//      si la marca redacta «por encargo a la agencia» (`brands.ai_mode = 'agency'`),
//      rechaza la petición (409 `agency_mode`) antes de tocar el cupo. Única
//      excepción: el copiloto por voz del editor (`editor.copilot`), que no
//      redacta texto (decisión provisional, docs/ESTADO.md);
//   4. llama a la tarea, que pasa por el servicio: reservar cupo → generar → registrar.
//
// El permiso de «crear contenido en la marca» lo impone la base de datos al
// reservar el cupo (`ai_reserve_generation`, error 42501 → 403), antes de
// llamar a ningún proveedor: no hay forma de generar sin él.
//
// Una petición = una llamada al proveedor. Aquí no hay bucles ni reintentos.
import { AiError, type AiErrorCode, type AiService, type Json } from '../_shared/ai/contract.ts';
import { summarizeAnalytics, type AnalyticsFactInput } from '../_shared/ai/text/tasks/analytics-summary.ts';
import { checkBrandCompliance } from '../_shared/ai/text/tasks/brand-check.ts';
import {
  runEditorCopilot,
  type CopilotAssetRef,
  type CopilotDocumentSummary,
} from '../_shared/ai/text/tasks/editor-copilot.ts';
import {
  planCampaign,
  type CampaignAssetRef,
  type CampaignSource,
  type CampaignTarget,
} from '../_shared/ai/text/tasks/campaign-plan.ts';
import { generatePostCopy, type NetworkLimits } from '../_shared/ai/text/tasks/post-copy.ts';
import { proposeBrandProfile, type ProfileSource } from '../_shared/ai/text/tasks/profile-proposal.ts';
import { AiTaskInputError, type TaskMeta } from '../_shared/ai/text/tasks/shared.ts';

export const AI_GENERATE_ACTIONS = [
  'post.caption',
  'profile.proposal',
  'brand.check',
  'campaign.plan',
  'analytics.summary',
  'editor.copilot',
] as const;
export type AiGenerateAction = (typeof AI_GENERATE_ACTIONS)[number];

export interface BrandProfileLookup {
  /** ¿Ve el usuario esta marca? Si no, se responde como si no existiera. */
  brandVisible: boolean;
  /** Perfil activo (`brand_profiles.data`), o `null` si la marca aún no tiene. */
  profile: Json | null;
  /** Cómo se redacta en la marca (`brands.ai_mode`). En `agency` no se usa este servicio. */
  aiMode: 'api' | 'agency';
}

export interface AiGenerateDeps {
  /** Valida el token de sesión y devuelve el usuario, o `null` si no vale. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  /** Lee la marca y su perfil activo con la identidad del usuario (RLS). */
  loadBrandProfile(accessToken: string, brandId: string): Promise<BrandProfileLookup>;
  service: AiService;
  /**
   * Analítica (Fase 5): cifras medidas de la marca en el periodo, leídas CON LA
   * IDENTIDAD DEL USUARIO y redactadas por el analista sin IA, y el modo de IA
   * de la marca. Sin esta dependencia, la acción no está disponible.
   */
  loadAnalyticsFacts?(
    accessToken: string,
    brandId: string,
    period: { from: string; to: string },
  ): Promise<{ aiMode: string; periodLabel: string; facts: AnalyticsFactInput[] }>;
  /**
   * Copiloto por voz: de las fotos que manda el editor, las que el usuario ve
   * en la marca (RLS) y son imágenes. Sin esta dependencia se aceptan tal cual
   * llegan (el documento solo se dibuja con lo que la RLS deja ver).
   */
  filterVisibleImages?(accessToken: string, brandId: string, ids: string[]): Promise<string[]>;
  /** Registro del servidor. Nunca recibe claves ni el contenido de la petición. */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Origen permitido para CORS (por defecto, cualquiera: la sesión va en cabecera, no en cookie). */
  allowedOrigin?: string;
}

/**
 * Acciones que se admiten en marcas en modo agencia. Solo el copiloto por voz:
 * coloca lo que la persona dicta, literalmente, y no redacta texto. Decisión
 * PROVISIONAL del producto (docs/ESTADO.md, «Decisiones del dueño pendientes»).
 */
export const AGENCY_MODE_ALLOWED_ACTIONS: readonly AiGenerateAction[] = ['editor.copilot'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_500_000;

const STATUS: Record<AiErrorCode, number> = {
  quota_exhausted: 402,
  quota_missing: 402,
  forbidden: 403,
  not_configured: 503,
  provider_failed: 502,
  provider_timeout: 504,
  invalid_output: 502,
  refused: 422,
  internal: 500,
};

/** Lo que la interfaz necesita de la generación; el coste se consulta en `ai_generations`. */
function strip(result: TaskMeta): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...result };
  for (const key of ['provider', 'model', 'usage', 'costMicros', 'latencyMs']) delete rest[key];
  return rest;
}

export function createAiGenerateHandler(deps: AiGenerateDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });
  const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    json(status, { error: { code, message, retryable: false, ...extra } });

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    // 1. Sesión.
    const header = request.headers.get('authorization') ?? '';
    const accessToken = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    if (!accessToken) return fail(401, 'unauthenticated', 'Inicia sesión para usar la IA.');
    let user: { userId: string } | null;
    try {
      user = await deps.authenticate(accessToken);
    } catch {
      return fail(500, 'internal', 'No se ha podido comprobar la sesión. Inténtalo de nuevo.', { retryable: true });
    }
    if (!user) return fail(401, 'unauthenticated', 'La sesión ha caducado. Vuelve a iniciar sesión.');

    // 2. Petición.
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'La petición es demasiado grande.');
      body = JSON.parse(raw);
    } catch {
      return fail(400, 'invalid_request', 'La petición no es JSON válido.');
    }
    const { action, brandId, input } = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (typeof action !== 'string' || !(AI_GENERATE_ACTIONS as readonly string[]).includes(action)) {
      return fail(400, 'invalid_request', `Indica la acción: ${AI_GENERATE_ACTIONS.join(', ')}.`);
    }
    if (typeof brandId !== 'string' || !UUID.test(brandId)) {
      return fail(400, 'invalid_request', 'Indica la marca (brandId).');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail(400, 'invalid_request', 'Faltan los datos de la petición (input).');
    }
    const data = input as Record<string, unknown>;
    const actor = { userId: user.userId, brandId };

    try {
      // 3. Perfil de marca, con la identidad del usuario.
      const lookup = await deps.loadBrandProfile(accessToken, brandId);
      if (!lookup.brandVisible) return fail(404, 'brand_not_found', 'No existe esa marca o no tienes acceso a ella.');
      // Modo agencia: la marca ha decidido que redacta la agencia por encargo.
      // Se impone aquí (no solo ocultando botones) y antes de reservar cupo.
      if (lookup.aiMode === 'agency' && !AGENCY_MODE_ALLOWED_ACTIONS.includes(action as AiGenerateAction)) {
        return fail(
          409,
          'agency_mode',
          action === 'campaign.plan'
            ? 'Esta marca trabaja por encargo a la agencia: pide el plan de campaña desde «Campañas».'
            : action === 'analytics.summary'
              ? 'Esta marca trabaja en modo agencia: la interpretación con IA no está disponible.'
              : 'Esta marca redacta por encargo a la agencia: pide la pieza desde «Encargos».',
        );
      }
      // La interpretación de la analítica no necesita perfil: solo cita cifras medidas.
      if (action !== 'profile.proposal' && action !== 'analytics.summary' && lookup.profile === null) {
        return fail(
          409,
          'brand_profile_missing',
          'Esta marca todavía no tiene perfil. Complétalo antes de usar la IA.',
        );
      }

      // 4. Tarea.
      let result: Record<string, unknown>;
      if (action === 'post.caption') {
        result = strip(
          await generatePostCopy(deps.service, actor, {
            brandProfile: lookup.profile,
            brief: data.brief as string,
            network: data.network as NetworkLimits,
            variants: data.variants === undefined ? 3 : (data.variants as number),
          }),
        );
      } else if (action === 'analytics.summary') {
        const day = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
        if (
          typeof data.from !== 'string' ||
          typeof data.to !== 'string' ||
          !day.test(data.from) ||
          !day.test(data.to) ||
          data.from >= data.to
        ) {
          return fail(400, 'invalid_request', 'Indica el periodo (from y to, AAAA-MM-DD).');
        }
        if (!deps.loadAnalyticsFacts)
          return fail(503, 'not_configured', 'La interpretación de la analítica no está disponible.');
        const figures = await deps.loadAnalyticsFacts(accessToken, brandId, { from: data.from, to: data.to });
        // En modo agencia la marca no usa el servicio de IA: tampoco para interpretar cifras.
        if (figures.aiMode === 'agency') {
          return fail(
            409,
            'agency_mode',
            'Esta marca trabaja en modo agencia: la interpretación con IA no está disponible.',
          );
        }
        result = strip(
          await summarizeAnalytics(deps.service, actor, {
            brandProfile: lookup.profile,
            periodLabel: figures.periodLabel,
            facts: figures.facts,
          }),
        );
      } else if (action === 'editor.copilot') {
        // Solo devuelve operaciones validadas; las aplica (y las valida otra vez) el editor.
        let assets = Array.isArray(data.assets) ? (data.assets as CopilotAssetRef[]) : undefined;
        if (assets && deps.filterVisibleImages) {
          const ids = assets.map((asset) => (typeof asset?.id === 'string' ? asset.id.toLowerCase() : ''));
          const visible = new Set(
            (await deps.filterVisibleImages(accessToken, brandId, ids.filter((id) => UUID.test(id)))).map((id) =>
              id.toLowerCase(),
            ),
          );
          assets = assets.filter((_, index) => visible.has(ids[index]!));
        }
        result = strip(
          await runEditorCopilot(deps.service, actor, {
            brandProfile: lookup.profile,
            transcript: data.transcript as string,
            document: data.document as CopilotDocumentSummary,
            assets,
          }),
        );
      } else if (action === 'brand.check') {
        result = strip(
          await checkBrandCompliance(deps.service, actor, { brandProfile: lookup.profile, text: data.text as string }),
        );
      } else if (action === 'campaign.plan') {
        // Solo propone: el plan no se guarda aquí ni crea nada (ver campaign-plan.ts).
        result = strip(
          await planCampaign(deps.service, actor, {
            brandProfile: lookup.profile,
            instruction: data.instruction as string,
            startDate: data.startDate as string,
            endDate: data.endDate as string,
            targets: data.targets as CampaignTarget[],
            assets: data.assets as CampaignAssetRef[] | undefined,
            sources: data.sources as CampaignSource[] | undefined,
            maxPieces: data.maxPieces as number | undefined,
          }),
        );
      } else {
        result = strip(
          await proposeBrandProfile(deps.service, actor, {
            sources: data.sources as ProfileSource[],
            currentProfile: lookup.profile ?? undefined,
          }),
        );
      }
      return json(200, { action, ...result });
    } catch (error) {
      if (error instanceof AiTaskInputError) return fail(400, 'invalid_request', error.message);
      if (error instanceof AiError) {
        deps.log?.('ai_error', {
          action,
          brandId,
          code: error.code,
          generationId: error.generationId,
          // El motivo exacto (qué variable falta, qué respondió el proveedor) se queda en el servidor.
          detail: error.code === 'not_configured' ? error.message : error.details,
        });
        const message =
          error.code === 'not_configured'
            ? 'La IA no está disponible en este momento. Avisa a quien administra la plataforma.'
            : error.message;
        return json(STATUS[error.code], {
          error: { code: error.code, message, retryable: error.retryable, generationId: error.generationId },
        });
      }
      deps.log?.('unexpected_error', { action, brandId });
      return fail(500, 'internal', 'Algo ha fallado al usar la IA. Inténtalo de nuevo.', { retryable: true });
    }
  };
}
