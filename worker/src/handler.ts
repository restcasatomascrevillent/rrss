// Lo que el bucle da a cada manejador y lo que espera de él.
import type { Logger } from './logger.ts';
import type { Job, JsonObject } from './queue.ts';
import type { MediaStorage } from './storage.ts';

export interface HandlerContext {
  job: Job;
  /** Se aborta al apagar el trabajador o al agotarse el tiempo reservado. */
  signal: AbortSignal;
  storage: MediaStorage;
  /** Carpeta temporal propia del intento; el bucle la borra al terminar. */
  workDir: string;
  log: Logger;
}

export interface Handler {
  /** Tipo de trabajo (`jobs.kind`) que atiende. */
  kind: string;
  run(context: HandlerContext): Promise<JsonObject>;
}
