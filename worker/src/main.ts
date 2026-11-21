// Entrada del trabajador de medios: `node src/main.ts`.
//
// Lee la configuración del entorno, conecta la cola y el almacenamiento (por
// el intermediario `worker-gateway`, o con la clave de servicio en local) y
// arranca el bucle. Por defecto (`WORKER_MODE=drain`) vacía la cola
// y termina, para alojamientos que arrancan el contenedor bajo demanda.
import { loadConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import { findDefaultFont } from './ffmpeg/fonts.ts';
import { runProcess, toolsFromEnv } from './ffmpeg/run.ts';
import { createMediaHandlers } from './handlers/index.ts';
import { createJsonLogger } from './logger.ts';
import { createGatewayQueue, createGatewayStorage } from './gateway.ts';
import type { JobQueue } from './queue.ts';
import type { MediaStorage } from './storage.ts';
import { createSupabaseQueue, createSupabaseStorage } from './supabase.ts';
import { createWorker } from './worker.ts';

async function main(): Promise<number> {
  const logger = createJsonLogger({ service: 'rrss-worker' });
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('worker.config_invalid', { error: errorMessage(error) });
    return 2;
  }

  const tools = toolsFromEnv();
  try {
    const version = (await runProcess(tools.ffmpeg, ['-version'])).split('\n')[0];
    logger.info('worker.ffmpeg', { version });
  } catch (error) {
    logger.error('worker.ffmpeg_missing', { error: errorMessage(error) });
    return 2;
  }
  const defaultFontFile = findDefaultFont();
  if (!defaultFontFile)
    logger.warn('worker.font_missing', { hint: 'Define WORKER_FONT_FILE para poner texto en los vídeos' });

  // Por defecto, el intermediario `worker-gateway` con el token del trabajador
  // (sin ninguna clave de Supabase). Con la clave de servicio, solo en local/CI.
  let queue: JobQueue;
  let storage: MediaStorage;
  if (config.WORKER_SUPABASE_ACCESS === 'gateway') {
    const gateway = {
      supabaseUrl: config.SUPABASE_URL,
      token: config.WORKER_GATEWAY_TOKEN!,
      gatewayUrl: config.WORKER_GATEWAY_URL,
      maxObjectBytes: config.WORKER_MAX_UPLOAD_BYTES,
    };
    queue = createGatewayQueue(gateway);
    storage = createGatewayStorage(gateway);
  } else {
    logger.warn('worker.service_key_mode', {
      hint: 'Modo local con la clave de servicio (WORKER_SUPABASE_ACCESS=service-key): nunca en Fly.io',
    });
    const supabase = { url: config.SUPABASE_URL, serviceKey: config.SUPABASE_SERVICE_ROLE_KEY! };
    queue = createSupabaseQueue(supabase);
    storage = createSupabaseStorage({
      ...supabase,
      bucket: config.WORKER_BUCKET,
      maxObjectBytes: config.WORKER_MAX_UPLOAD_BYTES,
      mediaStorage: config.WORKER_MEDIA_STORAGE === 'auto',
    });
  }
  logger.info('worker.supabase_access', { mode: config.WORKER_SUPABASE_ACCESS });
  const worker = createWorker({
    queue,
    storage,
    handlers: createMediaHandlers({ tools, defaultFontFile, fontsDir: config.WORKER_FONTS_DIR }),
    logger,
    workerId: config.WORKER_ID,
    mode: config.WORKER_MODE,
    concurrency: config.WORKER_CONCURRENCY,
    leaseSeconds: config.WORKER_LEASE_SECONDS,
    maxAttemptSeconds: config.WORKER_MAX_ATTEMPT_SECONDS,
    pollIntervalMs: config.WORKER_POLL_MS,
    idleExitMs: config.WORKER_IDLE_EXIT_MS,
    shutdownGraceMs: config.WORKER_SHUTDOWN_GRACE_MS,
    tmpRoot: config.WORKER_TMP_DIR,
  });

  // Apagado ordenado: el alojamiento avisa con SIGTERM antes de matar el contenedor.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => worker.stop(`Señal ${signal}`));
  }

  const summary = await worker.run();
  return summary.stoppedBy === 'queue-error' ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  },
);
