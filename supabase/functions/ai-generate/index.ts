// Edge Function `ai-generate`: la puerta de la interfaz a las tareas de IA de texto.
//
// Desplegada en staging (18/11/2026) SIN ningún proveedor de IA: arranca y
// responde, pero toda generación devuelve «no configurada». La lógica
// (handler.ts) está probada en Node con la base de datos real y el proveedor
// simulado; con proveedor solo se ha ejecutado en local (`supabase functions
// serve`, prueba de extremo a extremo de la Fase 2, proveedor simulado).
//
// Secretos: la clave de servicio y las de los proveedores solo existen en el
// servidor: las de los proveedores, en «Plataforma → Integraciones» (cifradas
// en Vault) o en las variables de entorno de la función (ver `.env.example`).
// Nada de esto llega al navegador. `SUPABASE_URL`, `SUPABASE_ANON_KEY` y
// `SUPABASE_SERVICE_ROLE_KEY` las pone Supabase en todas las funciones.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Json, RpcClient } from '../_shared/ai/contract.ts';
import { createAiService } from '../_shared/ai/service.ts';
import { loadAiTextConfig } from '../_shared/ai/text/config.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { loadLocalTestTextConfig } from '../_shared/ai/text/local-test.ts';
import { analyze, previousPeriod, type MediaSummary, type MetricDefinition } from '../_shared/analytics/analyst.ts';
import { createAiGenerateHandler } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };

// Con la clave de servicio: solo para validar la sesión y para las funciones
// SQL del cupo, que no se pueden ejecutar de otra forma.
const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY ?? '', options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);

// Sin proveedor simulado: si falta configuración, la función responde que la
// IA no está disponible. Los avisos (solo nombres de variables) van al registro.
// Única excepción: la prueba de extremo a extremo en local, que exige
// AI_E2E_SIMULATED_PROVIDER=true Y un Supabase local; si la variable está en
// cualquier otro entorno, la función no arranca (ver local-test.ts).
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[ai-generate] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);

const serviceFor = memoByEnv((effective) => {
  const config = loadLocalTestTextConfig(effective) ?? loadAiTextConfig(effective);
  for (const problem of config.problems) console.warn(`[ai-generate] configuración: ${problem}`);
  return createAiService({
    rpc,
    providers: config.providers,
    models: config.models,
    unavailable: config.unavailable,
    timeoutMs: config.timeoutMs,
  });
});

const handlerFor = memoByEnv((effective) =>
  createAiGenerateHandler({
    service: serviceFor(effective),

    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user ? null : { userId: data.user.id };
    },

    // Con la identidad del usuario: la RLS decide qué marca y qué perfil ve.
    async loadBrandProfile(accessToken, brandId) {
      const asUser = createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const brand = await asUser.from('brands').select('id, ai_mode').eq('id', brandId).maybeSingle();
      if (brand.error) throw new Error('No se ha podido leer la marca');
      if (!brand.data) return { brandVisible: false, profile: null, aiMode: 'api' };
      const aiMode = brand.data.ai_mode === 'agency' ? 'agency' : 'api';
      const profile = await asUser
        .from('brand_profiles')
        .select('data')
        .eq('brand_id', brandId)
        .eq('status', 'active')
        .maybeSingle();
      if (profile.error) throw new Error('No se ha podido leer el perfil de marca');
      return { brandVisible: true, profile: (profile.data?.data as Json | undefined) ?? null, aiMode };
    },

    // Copiloto por voz: solo las fotos de la marca que el usuario ve (RLS).
    async filterVisibleImages(accessToken, brandId, ids) {
      if (ids.length === 0) return [];
      const asUser = createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const rows = await asUser
        .from('media_assets')
        .select('id')
        .eq('brand_id', brandId)
        .eq('kind', 'image')
        .in('id', ids);
      if (rows.error) throw new Error('No se han podido leer las fotos');
      return (rows.data ?? []).map((row: { id: string }) => row.id);
    },

    // Analítica (Fase 5): las cifras se leen con la identidad del usuario (RLS) y
    // las redacta el analista sin IA; a la IA solo le llegan esos datos.
    async loadAnalyticsFacts(accessToken, brandId, period) {
      const asUser = createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const previous = previousPeriod(period);
      const summary = (p: { from: string; to: string }) =>
        asUser.rpc('analytics_media_summary', {
          p_brand_id: brandId,
          p_from: `${p.from}T00:00:00Z`,
          p_to: `${p.to}T00:00:00Z`,
        });
      const [brand, defs, points, media, prevMedia, accounts, runs] = await Promise.all([
        asUser.from('brands').select('ai_mode').eq('id', brandId).maybeSingle(),
        asUser.from('analytics_metric_definitions').select('*'),
        asUser
          .from('account_metrics_daily')
          .select('metric_id, metric_date, value, provisional')
          .eq('brand_id', brandId)
          .gte('metric_date', previous.from)
          .lt('metric_date', period.to),
        summary(period),
        summary(previous),
        asUser.from('social_accounts').select('network, username, status').eq('brand_id', brandId),
        asUser
          .from('analytics_capture_runs')
          .select('social_account_id, unavailable')
          .eq('brand_id', brandId)
          .order('started_at', { ascending: false })
          .limit(20),
      ]);
      for (const r of [brand, defs, points, media, prevMedia, accounts, runs]) {
        if (r.error) throw new Error('No se han podido leer las cifras');
      }
      const toMedia = (rows: unknown): MediaSummary[] =>
        ((rows ?? []) as Array<Omit<MediaSummary, 'metrics'> & { metrics: Record<string, number | string> }>).map(
          (m) => ({
            ...m,
            metrics: Object.fromEntries(Object.entries(m.metrics ?? {}).map(([k, v]) => [k, Number(v)])),
          }),
        );
      type Run = {
        social_account_id: string;
        unavailable: Array<{ metric_id: string; reason: string; message: string }>;
      };
      const seen = new Set<string>();
      const unavailable = ((runs.data ?? []) as Run[])
        .filter((r) => !seen.has(r.social_account_id) && Boolean(seen.add(r.social_account_id)))
        .flatMap((r) => r.unavailable ?? []);
      type Point = { metric_id: string; metric_date: string; value: number | string; provisional: boolean };
      const analysis = analyze({
        definitions: (defs.data ?? []) as MetricDefinition[],
        points: ((points.data ?? []) as Point[]).map((x) => ({
          metric_id: x.metric_id,
          date: x.metric_date,
          value: Number(x.value),
          provisional: x.provisional,
        })),
        media: toMedia(media.data),
        previousMedia: toMedia(prevMedia.data),
        period,
        previous,
        unavailable,
        accounts: (accounts.data ?? []) as Array<{ network: string; username: string; status: string }>,
      });
      return {
        aiMode: (brand.data as { ai_mode?: string } | null)?.ai_mode ?? 'api',
        periodLabel: `del ${period.from} al ${period.to} (este último día no incluido)`,
        facts: [
          ...analysis.facts.map((f) => ({ id: f.id, text: f.text })),
          ...analysis.caveats.map((c, i) => ({ id: `caveat:${i + 1}`, text: `Aviso: ${c}` })),
        ],
      };
    },

    log,
    allowedOrigin: env.AI_ALLOWED_ORIGIN,
  }),
);

Deno.serve(async (request) => handlerFor(await settings.get())(request));
