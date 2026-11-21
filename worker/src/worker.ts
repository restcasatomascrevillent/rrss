// Bucle del trabajador: reclama trabajos, ejecuta el manejador de su tipo y
// los cierra. No sabe nada de Supabase ni de FFmpeg: cola, almacenamiento y
// manejadores se inyectan.
//
// Reserva: el trabajador pide una reserva corta y la renueva
// (`extend_job_lease`) mientras el manejador avanza. Si no consigue renovarla,
// aborta el manejador un margen antes de que caduque: así nunca hay dos
// trabajadores con el mismo trabajo, que es lo que pasaría si FFmpeg siguiera
// más allá de la reserva. Si al renovar descubre que la reserva ya no es suya
// (cancelado o reclamado por otro), aborta en el acto. Cada intento tiene
// además un tiempo máximo, renueve o no.
//
// Apagado ordenado: lo que queda a medias se devuelve con `release_job`, que
// no gasta intento (no es un fallo del trabajo).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, LeaseLostError, LeaseTimeoutError, PermanentError, ShutdownError } from './errors.ts';
import type { Handler } from './handler.ts';
import type { Logger } from './logger.ts';
import type { Job, JobQueue } from './queue.ts';
import type { MediaStorage } from './storage.ts';

export interface WorkerOptions {
  queue: JobQueue;
  storage: MediaStorage;
  handlers: Handler[];
  logger: Logger;
  /** Nombre con el que se reservan los trabajos (`jobs.locked_by`). */
  workerId: string;
  /**
   * `drain`: sale cuando la cola está vacía (alojamientos que escalan a cero).
   * `continuous`: sigue sondeando hasta que se le pida parar.
   */
  mode: 'drain' | 'continuous';
  /** Trabajos a la vez. FFmpeg ya usa todos los núcleos: 1 suele bastar. */
  concurrency?: number;
  /** Duración de la reserva (5–3600 s). Se renueva mientras el trabajo avanza. */
  leaseSeconds?: number;
  /** Margen antes de que caduque la reserva (sin renovar) en el que se aborta el manejador. */
  leaseMarginSeconds?: number;
  /** Cada cuánto se renueva la reserva. Por defecto, un tercio de la reserva (y siempre antes del margen). */
  renewEveryMs?: number;
  /** Tiempo máximo de un intento, aunque la reserva se vaya renovando. */
  maxAttemptSeconds?: number;
  /** Espera entre sondeos con la cola vacía (modo continuo). */
  pollIntervalMs?: number;
  /** En modo `drain`, cuánto sigue sondeando con la cola vacía antes de salir. */
  idleExitMs?: number;
  /** Al pedir el apagado, tiempo que se deja a los trabajos en curso para acabar. */
  shutdownGraceMs?: number;
  /** Carpeta donde se crean las carpetas temporales de cada intento. */
  tmpRoot: string;
}

export type AttemptOutcome = 'succeeded' | 'retry' | 'failed' | 'released' | 'timeout' | 'lease_lost';

export interface RunSummary {
  claimed: number;
  outcomes: Record<AttemptOutcome, number>;
  stoppedBy: 'empty-queue' | 'shutdown' | 'queue-error';
}

export interface Worker {
  /** Arranca el bucle. Se resuelve cuando el trabajador termina. */
  run(): Promise<RunSummary>;
  /** Apagado ordenado: no reclama más y devuelve a la cola lo que tenga a medias. */
  stop(reason?: string): void;
}

const MAX_QUEUE_ERRORS = 5;

export function createWorker(options: WorkerOptions): Worker {
  const {
    queue,
    storage,
    logger,
    workerId,
    mode,
    concurrency = 1,
    leaseSeconds = 300,
    leaseMarginSeconds = Math.min(30, Math.max(1, Math.floor(leaseSeconds * 0.1))),
    renewEveryMs = Math.max(
      100,
      Math.floor(Math.min(leaseSeconds / 3, (leaseSeconds - leaseMarginSeconds) / 2) * 1000),
    ),
    maxAttemptSeconds = 3600,
    pollIntervalMs = 5_000,
    idleExitMs = 0,
    shutdownGraceMs = 0,
    tmpRoot,
  } = options;
  if (concurrency < 1 || concurrency > 100) throw new Error('La concurrencia debe estar entre 1 y 100');
  if (leaseSeconds < 5 || leaseSeconds > 3600) throw new Error('La reserva debe durar entre 5 segundos y una hora');
  if (leaseMarginSeconds >= leaseSeconds) throw new Error('El margen debe ser menor que la reserva');
  if (!(renewEveryMs > 0)) throw new Error('La renovación de la reserva debe tener un intervalo positivo');
  if (!(maxAttemptSeconds > 0)) throw new Error('El tiempo máximo de un intento debe ser positivo');

  const handlers = new Map(options.handlers.map((h) => [h.kind, h]));
  const kinds = [...handlers.keys()];
  if (kinds.length === 0) throw new Error('El trabajador no tiene ningún manejador');

  const summary: RunSummary = {
    claimed: 0,
    outcomes: { succeeded: 0, retry: 0, failed: 0, released: 0, timeout: 0, lease_lost: 0 },
    stoppedBy: 'empty-queue',
  };
  const inFlight = new Map<string, AbortController>();
  const stopController = new AbortController();
  let graceTimer: NodeJS.Timeout | undefined;
  let graceOver = false;

  const abortInFlight = (reason: string) => {
    graceOver = true;
    for (const controller of inFlight.values()) controller.abort(new ShutdownError(reason));
  };

  function stop(reason = 'Apagado del trabajador'): void {
    if (stopController.signal.aborted) return;
    logger.info('worker.stopping', { reason, inFlight: inFlight.size, graceMs: shutdownGraceMs });
    stopController.abort(new ShutdownError(reason));
    if (shutdownGraceMs > 0 && inFlight.size > 0) {
      graceTimer = setTimeout(() => abortInFlight(reason), shutdownGraceMs);
    } else {
      abortInFlight(reason);
    }
  }

  /** Espera que se interrumpe al pedir el apagado. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopController.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        stopController.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stopController.signal.addEventListener('abort', done, { once: true });
    });

  /** Anota el fallo en la cola y dice cómo quedó el trabajo. */
  async function closeFailed(job: Job, message: string, retry: boolean): Promise<'retry' | 'failed' | 'lease_lost'> {
    const requeued = retry && job.attempts < job.max_attempts;
    try {
      await queue.fail(job.id, workerId, message, retry);
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lease_lost';
      // No se pudo anotar el fallo: la reserva caducará y la cola lo recuperará.
      logger.error('job.close_failed', { jobId: job.id, kind: job.kind, error: errorMessage(error) });
    }
    return requeued ? 'retry' : 'failed';
  }

  /** Devuelve a la cola el trabajo a medias, sin gastar intento. */
  async function release(job: Job): Promise<'released' | 'lease_lost'> {
    try {
      await queue.release(job.id, workerId);
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lease_lost';
      // No se pudo devolver: la reserva caducará y la cola lo recuperará (gastando ese intento).
      logger.error('job.release_failed', { jobId: job.id, kind: job.kind, error: errorMessage(error) });
    }
    return 'released';
  }

  async function runJob(job: Job, claimStartedAt: number): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    inFlight.set(job.id, controller);
    // Si el apagado ya venció mientras se reclamaba, el trabajo vuelve sin empezar.
    if (graceOver) controller.abort(stopController.signal.reason);

    // Reserva: vence `leaseSeconds` después de pedirla (o de la última renovación).
    let leaseUntil = claimStartedAt + leaseSeconds * 1000;
    let leaseTimer: NodeJS.Timeout | undefined;
    const armLeaseTimer = () => {
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(
        () =>
          controller.abort(
            new LeaseTimeoutError(`El trabajo superó el tiempo reservado (${leaseSeconds} s) sin poder renovarlo`),
          ),
        Math.max(0, leaseUntil - leaseMarginSeconds * 1000 - Date.now()),
      );
    };
    armLeaseTimer();
    const maxTimer = setTimeout(
      () =>
        controller.abort(
          new LeaseTimeoutError(`El trabajo superó el tiempo máximo de un intento (${maxAttemptSeconds} s)`),
        ),
      maxAttemptSeconds * 1000,
    );
    let renewing = false;
    const renewTimer = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      const askedAt = Date.now();
      queue
        .extendLease(job.id, workerId, leaseSeconds)
        .then(
          () => {
            if (controller.signal.aborted) return;
            leaseUntil = askedAt + leaseSeconds * 1000;
            armLeaseTimer();
          },
          (error: unknown) => {
            if (error instanceof LeaseLostError) controller.abort(error);
            else logger.warn('job.lease_renew_failed', { jobId: job.id, kind: job.kind, error: errorMessage(error) });
          },
        )
        .finally(() => {
          renewing = false;
        });
    }, renewEveryMs);

    const fields = { jobId: job.id, kind: job.kind, attempt: job.attempts, maxAttempts: job.max_attempts };
    logger.info('job.started', fields);

    let outcome: AttemptOutcome;
    let failure: string | undefined;
    let workDir: string | undefined;
    try {
      const handler = handlers.get(job.kind);
      if (!handler) throw new PermanentError(`No hay manejador para el tipo «${job.kind}»`);
      controller.signal.throwIfAborted();
      await mkdir(tmpRoot, { recursive: true });
      workDir = await mkdtemp(path.join(tmpRoot, 'job-'));
      const jobStorage = storage.forJob ? storage.forJob(job, workerId) : storage;
      const result = await handler.run({ job, signal: controller.signal, storage: jobStorage, workDir, log: logger });
      // Un manejador que ignora la señal no puede cerrar fuera de plazo. Si lo
      // que llegó fue el apagado y aun así terminó, su resultado vale.
      if (controller.signal.reason instanceof LeaseTimeoutError) throw controller.signal.reason;
      await queue.complete(job.id, workerId, result);
      outcome = 'succeeded';
    } catch (error) {
      // Si se abortó, manda el motivo del aborto y no el error que provocó en el manejador.
      const cause: unknown =
        controller.signal.aborted && !(error instanceof LeaseLostError) ? controller.signal.reason : error;
      failure = errorMessage(cause);
      if (cause instanceof LeaseLostError) {
        outcome = 'lease_lost';
      } else if (cause instanceof ShutdownError) {
        outcome = await release(job);
      } else if (cause instanceof LeaseTimeoutError) {
        const closed = await closeFailed(job, failure, true);
        outcome = closed === 'retry' ? 'timeout' : closed;
      } else {
        outcome = await closeFailed(job, failure, !(cause instanceof PermanentError));
      }
    } finally {
      clearTimeout(leaseTimer);
      clearTimeout(maxTimer);
      clearInterval(renewTimer);
      inFlight.delete(job.id);
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }

    summary.outcomes[outcome] += 1;
    const entry = { ...fields, outcome, ms: Date.now() - startedAt, ...(failure ? { error: failure } : {}) };
    if (outcome === 'succeeded') logger.info('job.attempt', entry);
    else if (outcome === 'failed') logger.error('job.attempt', entry);
    else logger.warn('job.attempt', entry);
  }

  async function run(): Promise<RunSummary> {
    const active = new Set<Promise<void>>();
    let queueErrors = 0;
    let idleSince: number | undefined;
    logger.info('worker.started', { workerId, mode, kinds, concurrency, leaseSeconds });

    while (!stopController.signal.aborted) {
      const free = concurrency - active.size;
      if (free === 0) {
        await Promise.race(active);
        continue;
      }

      let jobs: Job[];
      const claimStartedAt = Date.now();
      try {
        jobs = await queue.claim({ worker: workerId, kinds, limit: free, leaseSeconds });
        queueErrors = 0;
      } catch (error) {
        queueErrors += 1;
        logger.error('queue.claim_failed', { error: errorMessage(error), consecutive: queueErrors });
        if (mode === 'drain' && queueErrors >= MAX_QUEUE_ERRORS) {
          summary.stoppedBy = 'queue-error';
          break;
        }
        await sleep(Math.min(pollIntervalMs * queueErrors, 60_000));
        continue;
      }

      for (const job of jobs) {
        summary.claimed += 1;
        const attempt: Promise<void> = runJob(job, claimStartedAt).finally(() => active.delete(attempt));
        active.add(attempt);
      }
      if (jobs.length > 0) {
        idleSince = undefined;
        if (jobs.length === free) continue;
      }

      // La cola no tiene más por ahora.
      if (active.size > 0) {
        await Promise.race([...active, sleep(pollIntervalMs)]);
      } else if (mode === 'drain') {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= idleExitMs) break;
        await sleep(Math.min(pollIntervalMs, idleExitMs));
      } else {
        await sleep(pollIntervalMs);
      }
    }

    if (stopController.signal.aborted) summary.stoppedBy = 'shutdown';
    await Promise.allSettled(active);
    clearTimeout(graceTimer);
    logger.info('worker.stopped', { ...summary });
    return summary;
  }

  return { run, stop };
}
