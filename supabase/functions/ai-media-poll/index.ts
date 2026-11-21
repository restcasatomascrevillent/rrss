// Edge Function `ai-media-poll`: sigue las generaciones asíncronas de imagen.
// La dispara pg_cron (migración 20261118210000) y solo atiende a la clave de
// servicio. En config.toml lleva `verify_jwt = false` porque la clave puede
// llegar en la cabecera `apikey` (como indica la guía de Supabase para
// programar funciones); la comprobación la hace handler.ts.
import { createAiMediaPollHandler } from './handler.ts';
import { checkConfiguration, env, loadRuntime, rpc } from '../ai-media/setup.ts';

checkConfiguration('ai-media-poll');

const handler = createAiMediaPollHandler({
  serviceKeys: [env.SUPABASE_SERVICE_ROLE_KEY ?? ''],
  rpc,
  service: async () => (await loadRuntime()).serviceFor(),
  workerName: `ai-media-poll:${crypto.randomUUID()}`,
  log: (event, data) => console.error(`[ai-media-poll] ${event}`, JSON.stringify(data)),
});

Deno.serve(handler);
