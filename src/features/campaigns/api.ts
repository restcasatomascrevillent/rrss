import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STORAGE_BUCKET } from '@/config/app';
import { AiRequestError, aiErrorMessage, toAiError } from '@/features/ai/api';
import { contentKeys } from '@/features/content/api';
import { formatsOf } from '@/features/content/networks';
import { requestKeys } from '@/features/requests/api';
import type {
  CampaignContentRow,
  CampaignPlanRow,
  CampaignRequestRow,
  CampaignRow,
  ContentRequestRow,
  ContentStatus,
  Json,
} from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { planToDrafts, type EngineAsset } from './engine';
import {
  MAX_CAMPAIGN_NETWORKS,
  MAX_INSTRUCTION_CHARS,
  MAX_PLAN_DAYS,
  campaignPlanSchema,
  daysInclusive,
  isRealDate,
  type CampaignPlan,
} from './plan';

// Acceso a datos de las campañas. Pedir un plan (con la IA o a la agencia),
// leerlo, aceptarlo (motor → borradores) o descartarlo. Las reglas viven en la
// base de datos (migración 20261119510000); aquí solo se dice antes lo obvio.

export const campaignKeys = {
  all: (brandId: string) => ['brand', brandId, 'campaigns'] as const,
  list: (brandId: string) => ['brand', brandId, 'campaigns', 'list'] as const,
  item: (brandId: string, id: string) => ['brand', brandId, 'campaigns', 'item', id] as const,
  plan: (brandId: string, id: string, version: number) => ['brand', brandId, 'campaigns', 'plan', id, version] as const,
  contents: (brandId: string, id: string) => ['brand', brandId, 'campaigns', 'contents', id] as const,
  request: (brandId: string, id: string) => ['brand', brandId, 'campaigns', 'request', id] as const,
};

/** Recursos de la biblioteca que se ofrecen a la IA (solo su descripción). */
const MAX_LIBRARY_FOR_AI = 60;
/** Fuentes de texto que se envían a la IA. */
const MAX_SOURCES_FOR_AI = 5;
const MAX_SOURCES_CHARS = 60_000;

// ── Lectura ──────────────────────────────────────────────────────────────

export function useCampaigns(brandId: string) {
  return useQuery({
    queryKey: campaignKeys.list(brandId),
    queryFn: async (): Promise<CampaignRow[]> =>
      unwrap(
        await supabase
          .from('campaigns')
          .select('*')
          .eq('brand_id', brandId)
          .order('created_at', { ascending: false })
          .limit(200),
      ),
  });
}

export function useCampaign(brandId: string, campaignId: string) {
  return useQuery({
    queryKey: campaignKeys.item(brandId, campaignId),
    queryFn: async (): Promise<CampaignRow> =>
      unwrap(await supabase.from('campaigns').select('*').eq('id', campaignId).single()),
  });
}

/** Una versión del plan (0 = todavía no hay plan). */
export function useCampaignPlan(brandId: string, campaignId: string, version: number) {
  return useQuery({
    queryKey: campaignKeys.plan(brandId, campaignId, version),
    enabled: version > 0,
    queryFn: async (): Promise<CampaignPlanRow> =>
      unwrap(
        await supabase.from('campaign_plans').select('*').eq('campaign_id', campaignId).eq('version', version).single(),
      ),
  });
}

export interface CampaignPieceLink extends CampaignContentRow {
  title: string;
  status: ContentStatus | null;
  network: string;
  format: string;
  /** Versión vigente de la pieza (0 = sin documento). Para su vista previa. */
  current_version: number;
}

/** Piezas que creó el motor, en el orden del plan, con su estado de ahora. */
export function useCampaignContents(brandId: string, campaignId: string, enabled: boolean) {
  return useQuery({
    queryKey: campaignKeys.contents(brandId, campaignId),
    enabled,
    queryFn: async (): Promise<CampaignPieceLink[]> => {
      const links = unwrap(
        await supabase
          .from('campaign_contents')
          .select('*')
          .eq('campaign_id', campaignId)
          .order('piece_index', { ascending: true }),
      );
      const ids = links.map((l) => l.content_id);
      const items = ids.length
        ? unwrap(await supabase.from('content_items').select('id, title, status, network, format, current_version').in('id', ids))
        : [];
      const byId = new Map(items.map((i) => [i.id, i]));
      return links.map((link) => {
        const item = byId.get(link.content_id);
        return {
          ...link,
          title: item?.title ?? 'Pieza',
          status: item?.status ?? null,
          network: item?.network ?? '',
          format: item?.format ?? '',
          current_version: item?.current_version ?? 0,
        };
      });
    },
  });
}

export interface CampaignOverview {
  /** Plan vigente de cada campaña que ya lo tiene (null si no tiene el formato esperado). */
  plans: Map<string, CampaignPlan | null>;
  /** Piezas creadas de cada campaña aceptada, en el orden del plan. */
  contents: Map<string, { content_id: string; piece_index: number; current_version: number }[]>;
}

/**
 * Para la lista: el plan vigente de cada campaña (cuántas piezas lleva y sus
 * recursos sugeridos) y las piezas creadas de las aceptadas (sus miniaturas).
 * Solo lectura; dos o tres consultas para toda la lista.
 */
export function useCampaignsOverview(brandId: string, campaigns: CampaignRow[]) {
  const withPlan = campaigns.filter((c) => c.current_plan_version > 0);
  const accepted = campaigns.filter((c) => c.status === 'accepted');
  const key = withPlan.map((c) => `${c.id}:${c.current_plan_version}:${c.status}`).join(',');
  return useQuery({
    queryKey: [...campaignKeys.all(brandId), 'overview', key] as const,
    enabled: withPlan.length > 0,
    queryFn: async (): Promise<CampaignOverview> => {
      const rows = unwrap(
        await supabase
          .from('campaign_plans')
          .select('campaign_id, version, data')
          .in(
            'campaign_id',
            withPlan.map((c) => c.id),
          ),
      );
      const plans = new Map<string, CampaignPlan | null>();
      for (const campaign of withPlan) {
        const row = rows.find((r) => r.campaign_id === campaign.id && r.version === campaign.current_plan_version);
        const parsed = row ? campaignPlanSchema.safeParse(row.data) : null;
        plans.set(campaign.id, parsed?.success ? parsed.data : null);
      }
      const contents = new Map<string, { content_id: string; piece_index: number; current_version: number }[]>();
      if (accepted.length) {
        const links = unwrap(
          await supabase
            .from('campaign_contents')
            .select('*')
            .in(
              'campaign_id',
              accepted.map((c) => c.id),
            )
            .order('piece_index', { ascending: true }),
        );
        const ids = links.map((l) => l.content_id);
        const items = ids.length
          ? unwrap(await supabase.from('content_items').select('id, current_version').in('id', ids))
          : [];
        const versions = new Map(items.map((i) => [i.id, i.current_version]));
        for (const link of links) {
          const list = contents.get(link.campaign_id) ?? [];
          list.push({
            content_id: link.content_id,
            piece_index: link.piece_index,
            current_version: versions.get(link.content_id) ?? 0,
          });
          contents.set(link.campaign_id, list);
        }
      }
      return { plans, contents };
    },
  });
}

/**
 * El encargo a la agencia de una campaña (modo agencia), o null. La columna
 * `campaign_id` la añade la migración de campañas (tipo CampaignRequestRow).
 */
export function useCampaignRequest(brandId: string, campaignId: string, enabled: boolean) {
  return useQuery({
    queryKey: campaignKeys.request(brandId, campaignId),
    enabled,
    queryFn: async (): Promise<CampaignRequestRow | null> => {
      const rows = unwrap(
        await supabase
          .from('content_requests')
          .select('*')
          .eq('campaign_id' as keyof ContentRequestRow, campaignId)
          .limit(1),
      ) as CampaignRequestRow[];
      return rows[0] ?? null;
    },
  });
}

// ── Pedir un plan ────────────────────────────────────────────────────────

export interface PlanRequestInput {
  brandId: string;
  title: string;
  instruction: string;
  networks: string[];
  /** AAAA-MM-DD, ambas incluidas. */
  startsOn: string;
  endsOn: string;
  /** Enviar a la IA las fuentes de texto de la marca. */
  useSources?: boolean;
}

export function validatePlanRequest(input: PlanRequestInput): string | null {
  if (!input.title.trim()) return 'Ponle un nombre a la campaña.';
  if (input.title.trim().length > 200) return 'El nombre es demasiado largo.';
  if (!input.instruction.trim()) return 'Escribe qué quieres preparar.';
  if (input.instruction.trim().length > MAX_INSTRUCTION_CHARS)
    return `La instrucción es demasiado larga (máximo ${MAX_INSTRUCTION_CHARS} caracteres).`;
  if (input.networks.length === 0) return 'Elige al menos una red.';
  if (input.networks.length > MAX_CAMPAIGN_NETWORKS) return `Como mucho ${MAX_CAMPAIGN_NETWORKS} redes.`;
  if (!isRealDate(input.startsOn) || !isRealDate(input.endsOn)) return 'Las fechas no son válidas.';
  if (input.endsOn < input.startsOn) return 'La fecha final es anterior a la inicial.';
  if (daysInclusive(input.startsOn, input.endsOn) > MAX_PLAN_DAYS)
    return `Un plan dura como mucho ${MAX_PLAN_DAYS} días.`;
  return null;
}

/** Destinos que se ofrecen a la IA: todos los formatos del catálogo de las redes elegidas. */
export function targetsFor(networks: string[]) {
  return networks.flatMap((network) => formatsOf(network).map((spec) => ({ network, format: spec.format })));
}

export interface GeneratedPlan {
  action: 'campaign.plan';
  generationId: string;
  status: 'proposal';
  plan: CampaignPlan;
  discarded: { index: number; reason: string }[];
}

async function textSources(brandId: string) {
  const rows = unwrap(
    await supabase
      .from('brand_knowledge_sources')
      .select('*')
      .eq('brand_id', brandId)
      .eq('kind', 'text')
      .order('created_at', { ascending: false })
      .limit(MAX_SOURCES_FOR_AI),
  ).filter((source) => source.storage_path !== null);
  const sources: { title: string; text: string }[] = [];
  let total = 0;
  for (const source of rows) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(source.storage_path!);
    if (error || !data) throw error ?? new Error(`No se ha podido leer «${source.title}».`);
    const text = (await data.text()).slice(0, MAX_SOURCES_CHARS - total);
    if (!text.trim()) continue;
    total += text.length;
    sources.push({ title: source.title, text });
    if (total >= MAX_SOURCES_CHARS) break;
  }
  return sources;
}

async function libraryForAi(brandId: string) {
  const rows = unwrap(
    await supabase
      .from('media_assets')
      .select('id, file_name, kind, tags, folder')
      .eq('brand_id', brandId)
      .in('kind', ['image', 'video'])
      .order('created_at', { ascending: false })
      .limit(MAX_LIBRARY_FOR_AI),
  );
  return rows.map((a) => ({ id: a.id, name: a.file_name, kind: a.kind, tags: a.tags ?? [], folder: a.folder ?? '' }));
}

/** Pide el plan a la IA (ai-generate, `campaign.plan`). Solo propone: no guarda nada. */
export async function generateCampaignPlan(input: PlanRequestInput): Promise<GeneratedPlan> {
  const [assets, sources] = await Promise.all([
    libraryForAi(input.brandId),
    input.useSources ? textSources(input.brandId) : Promise.resolve([]),
  ]);
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke('ai-generate', {
      body: {
        action: 'campaign.plan',
        brandId: input.brandId,
        input: {
          instruction: input.instruction.trim(),
          startDate: input.startsOn,
          endDate: input.endsOn,
          targets: targetsFor(input.networks),
          assets,
          sources,
        },
      },
      timeout: 120_000,
    });
  } catch (error) {
    throw await toAiError(error);
  }
  if (result.error) throw await toAiError(result.error);
  const data = result.data as GeneratedPlan | null;
  if (!data || data.action !== 'campaign.plan' || !data.plan) {
    throw new AiRequestError('internal', aiErrorMessage('internal'), { retryable: true });
  }
  return data;
}

export function useCampaignMutations(brandId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: campaignKeys.all(brandId) });

  /** Con la IA: genera el plan y guarda la campaña con él (queda «por revisar»). */
  const createWithAi = useMutation({
    mutationFn: async (input: PlanRequestInput) => {
      const problem = validatePlanRequest(input);
      if (problem) throw new Error(problem);
      const generated = await generateCampaignPlan(input);
      const campaign = unwrap(
        await supabase.rpc('create_campaign', {
          p_brand_id: input.brandId,
          p_title: input.title.trim(),
          p_instruction: input.instruction.trim(),
          p_networks: input.networks,
          p_starts_on: input.startsOn,
          p_ends_on: input.endsOn,
          p_plan: generated.plan as unknown as Json,
          p_generation_id: generated.generationId,
        }),
      );
      return { campaign, discarded: generated.discarded };
    },
    onSuccess: refresh,
  });

  /** Modo agencia: pide el plan a la agencia (crea el encargo). */
  const requestFromAgency = useMutation({
    mutationFn: async (input: PlanRequestInput) => {
      const problem = validatePlanRequest(input);
      if (problem) throw new Error(problem);
      return unwrap(
        await supabase.rpc('request_campaign_plan', {
          p_brand_id: input.brandId,
          p_title: input.title.trim(),
          p_instruction: input.instruction.trim(),
          p_networks: input.networks,
          p_starts_on: input.startsOn,
          p_ends_on: input.endsOn,
        }),
      );
    },
    onSuccess: async () => {
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: requestKeys.all(brandId) })]);
    },
  });

  /** El motor: plan revisado → borradores. */
  const accept = useMutation({
    mutationFn: async ({ campaign, plan }: { campaign: CampaignRow; plan: unknown }) => {
      const ids = [
        ...new Set(
          ((plan as CampaignPlan).pieces ?? []).flatMap((piece) =>
            Array.isArray(piece.assetIds) ? piece.assetIds : [],
          ),
        ),
      ];
      const assets = ids.length
        ? unwrap(
            await supabase.from('media_assets').select('id, kind, file_name').eq('brand_id', brandId).in('id', ids),
          )
        : [];
      const map = new Map<string, EngineAsset>(
        assets.map((a) => [a.id, { id: a.id, kind: a.kind, name: a.file_name }]),
      );
      const built = planToDrafts(plan, campaign, map);
      return unwrap(
        await supabase.rpc('accept_campaign_plan', {
          p_campaign_id: campaign.id,
          p_expected_version: campaign.current_plan_version,
          p_plan: built.plan as unknown as Json,
          p_drafts: built.drafts as unknown as Json,
        }),
      );
    },
    onSuccess: async () => {
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: contentKeys.all(brandId) }),
        queryClient.invalidateQueries({ queryKey: requestKeys.all(brandId) }),
      ]);
    },
  });

  const discard = useMutation({
    mutationFn: async (campaignId: string) =>
      unwrap(await supabase.rpc('discard_campaign', { p_campaign_id: campaignId, p_reason: '' })),
    onSuccess: async () => {
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: requestKeys.all(brandId) })]);
    },
  });

  return { createWithAi, requestFromAgency, accept, discard };
}
