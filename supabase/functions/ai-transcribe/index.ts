// Edge Function `ai-transcribe`: subtítulos automáticos de los clips de un
// reel con OpenAI (docs/editor-reels.md). La lógica está en handler.ts.
//
// La clave de OpenAI es la de «Plataforma → Integraciones → IA de texto»
// (Vault) o la variable OPENAI_API_KEY de la función; nunca llega al
// navegador. Sin ella (o sin el endpoint de la UE), responde «no disponible» y
// la interfaz no enseña los subtítulos automáticos (`reelSubtitles`).
// SIN DESPLEGAR (21/11/2026).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RpcClient } from '../_shared/ai/contract.ts';
import { createAiService } from '../_shared/ai/service.ts';
import { loadTranscriptionConfig, transcriptionPrice } from '../_shared/ai/transcription/config.ts';
import { createRpcSettingsLoader, memoByEnv } from '../_shared/integrations/settings.ts';
import { createAiTranscribeHandler } from './handler.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY ?? '', options);
const rpc: RpcClient = (fn, args) => admin.rpc(fn, args);
const log = (event: string, data: Record<string, unknown>) =>
  console.error(`[ai-transcribe] ${event}`, JSON.stringify(data));
const settings = createRpcSettingsLoader(rpc, env, log);

const handlerFor = memoByEnv((effective) => {
  const config = loadTranscriptionConfig(effective);
  for (const problem of config.problems) console.warn(`[ai-transcribe] configuración: ${problem}`);
  return createAiTranscribeHandler({
    // Transcribir un trozo largo puede tardar; con 40 trozos, de sobra.
    service: createAiService({
      rpc,
      providers: config.providers,
      models: config.models,
      unavailable: config.unavailable,
      timeoutMs: 150_000,
    }),
    microsPerSecond: transcriptionPrice(config),
    async authenticate(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user ? null : { userId: data.user.id };
    },
    async brandVisible(accessToken, brandId) {
      const asUser = createClient(supabaseUrl, env.SUPABASE_ANON_KEY ?? '', {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const brand = await asUser.from('brands').select('id').eq('id', brandId).maybeSingle();
      if (brand.error) throw new Error('No se ha podido leer la marca');
      return Boolean(brand.data);
    },
    log,
    allowedOrigin: env.AI_ALLOWED_ORIGIN,
  });
});

Deno.serve(async (request) => handlerFor(await settings.get())(request));
