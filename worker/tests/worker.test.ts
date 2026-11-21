// Bucle del trabajador contra una cola en memoria que se comporta como la de
// Postgres (reserva por trabajador, reintentos, cancelación). La misma lógica
// se prueba contra el SQL real en `tests/db/trabajador.test.ts` de la raíz.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaseLostError, PermanentError } from '../src/errors.ts';
import type { Handler, HandlerContext } from '../src/handler.ts';
import { createDocumentExportHandler, DOCUMENT_EXPORT_KIND } from '../src/handlers/document-export.ts';
import { createMediaHandlers } from '../src/handlers/index.ts';
import { createMemoryLogger } from '../src/logger.ts';
import type { Job, JobQueue, JsonObject } from '../src/queue.ts';
import { createFolderStorage } from '../src/storage.ts';
import { createWorker, type WorkerOptions } from '../src/worker.ts';
import { deps } from './helpers/media.ts';

interface StoredJob extends Job {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  locked_by: string | null;
  waiting?: boolean;
  result?: JsonObject;
  last_error?: string;
}

function createMemoryQueue() {
  const jobs: StoredJob[] = [];
  /** Renovaciones pedidas, y si la próxima falla por un error pasajero de la red. */
  const lease = { renewals: 0, failRenewals: false };
  const owned = (id: string, worker: string) => {
    const job = jobs.find((j) => j.id === id && j.status === 'running' && j.locked_by === worker);
    if (!job) throw new LeaseLostError('El trabajo no está reservado por este trabajador');
    return job;
  };
  const queue: JobQueue = {
    async claim({ worker, kinds, limit }) {
      const claimed = jobs.filter((j) => j.status === 'queued' && !j.waiting && kinds.includes(j.kind)).slice(0, limit);
      for (const job of claimed)
        Object.assign(job, { status: 'running', locked_by: worker, attempts: job.attempts + 1 });
      return claimed.map((job) => ({ ...job }));
    },
    async complete(id, worker, result) {
      Object.assign(owned(id, worker), { status: 'succeeded', locked_by: null, result });
    },
    async fail(id, worker, error, retry) {
      const job = owned(id, worker);
      const again = retry && job.attempts < job.max_attempts;
      // Si vuelve a la cola es con espera (`run_after`): aún no se puede reclamar.
      Object.assign(job, { status: again ? 'queued' : 'failed', waiting: again, locked_by: null, last_error: error });
    },
    // Como release_job: vuelve a la cola ya y sin gastar el intento.
    async release(id, worker) {
      const job = owned(id, worker);
      Object.assign(job, { status: 'queued', waiting: false, locked_by: null, attempts: job.attempts - 1 });
    },
    async extendLease(id, worker) {
      if (lease.failRenewals) throw new Error('La cola respondió 503');
      owned(id, worker);
      lease.renewals += 1;
    },
  };
  let n = 0;
  const add = (kind: string, payload: JsonObject = {}, maxAttempts = 3): StoredJob => {
    n += 1;
    const job: StoredJob = {
      id: `job-${n}`,
      organization_id: 'org',
      brand_id: 'marca',
      kind,
      payload,
      attempts: 0,
      max_attempts: maxAttempts,
      status: 'queued',
      locked_by: null,
    };
    jobs.push(job);
    return job;
  };
  return { queue, jobs, add, lease };
}

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'rrss-worker-loop-'));
});
afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function setup(handlers: Handler[], options: Partial<WorkerOptions> = {}) {
  const memory = createMemoryQueue();
  const logger = createMemoryLogger();
  const worker = createWorker({
    queue: memory.queue,
    storage: createFolderStorage(tmpRoot),
    handlers,
    logger,
    workerId: 'trabajador-1',
    mode: 'drain',
    pollIntervalMs: 20,
    tmpRoot: path.join(tmpRoot, 'tmp'),
    ...options,
  });
  const attempts = () => logger.entries.filter((e) => e.event === 'job.attempt');
  return { ...memory, logger, worker, attempts };
}

/** Manejador que espera hasta que se aborta, como un FFmpeg largo. */
const untilAborted = (context: HandlerContext) =>
  new Promise<JsonObject>((_, reject) => {
    context.signal.addEventListener('abort', () => reject(new Error('proceso interrumpido')), { once: true });
  });

describe('bucle del trabajador', () => {
  it('vacía la cola, cierra cada trabajo con su resultado y sale solo', async () => {
    const dirs: string[] = [];
    const t = setup([
      {
        kind: 'eco',
        async run({ job, workDir }) {
          dirs.push(workDir);
          expect(existsSync(workDir)).toBe(true);
          return { eco: job.payload.n };
        },
      },
    ]);
    t.add('eco', { n: 1 });
    t.add('eco', { n: 2 });
    t.add('otro.tipo'); // sin manejador: ni se reclama

    const summary = await t.worker.run();

    expect(summary).toMatchObject({ claimed: 2, stoppedBy: 'empty-queue', outcomes: { succeeded: 2 } });
    expect(t.jobs.map((j) => [j.status, j.result])).toEqual([
      ['succeeded', { eco: 1 }],
      ['succeeded', { eco: 2 }],
      ['queued', undefined],
    ]);
    // Cada intento deja su línea de registro, y su carpeta temporal se borra.
    expect(t.attempts()).toMatchObject([
      { jobId: 'job-1', kind: 'eco', attempt: 1, maxAttempts: 3, outcome: 'succeeded' },
      { jobId: 'job-2', kind: 'eco', attempt: 1, outcome: 'succeeded' },
    ]);
    expect(dirs).toHaveLength(2);
    expect(dirs.some((dir) => existsSync(dir))).toBe(false);
  });

  it('un fallo pasajero vuelve a la cola; uno sin remedio (o agotados los intentos) queda fallido', async () => {
    const t = setup([
      {
        kind: 'falla',
        async run({ job }) {
          if (job.payload.permanente) throw new PermanentError('Carga del trabajo inválida');
          throw new Error('FFmpeg se cayó');
        },
      },
    ]);
    const pasajero = t.add('falla');
    const permanente = t.add('falla', { permanente: true });
    const ultimo = t.add('falla', {}, 1);

    const summary = await t.worker.run();

    expect(summary.outcomes).toMatchObject({ retry: 1, failed: 2 });
    expect(pasajero).toMatchObject({ status: 'queued', last_error: 'FFmpeg se cayó', locked_by: null });
    expect(permanente).toMatchObject({ status: 'failed', last_error: 'Carga del trabajo inválida' });
    expect(ultimo).toMatchObject({ status: 'failed', last_error: 'FFmpeg se cayó' });
    expect(t.attempts().map((e) => [e.outcome, e.level])).toEqual([
      ['retry', 'warn'],
      ['failed', 'error'],
      ['failed', 'error'],
    ]);
  });

  it('un trabajo largo renueva su reserva y termina aunque dure más que ella', async () => {
    // Sin renovar, el manejador se abortaría a los 0,2 s (5 s de reserva − 4,8 de margen).
    const t = setup(
      [
        {
          kind: 'largo',
          async run() {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return { ok: true };
          },
        },
      ],
      { leaseSeconds: 5, leaseMarginSeconds: 4.8, renewEveryMs: 50 },
    );
    const job = t.add('largo');

    const summary = await t.worker.run();

    expect(summary.outcomes).toMatchObject({ succeeded: 1, timeout: 0 });
    expect(job.status).toBe('succeeded');
    expect(t.lease.renewals).toBeGreaterThan(3);
  });

  it('si no consigue renovar, aborta el manejador antes de que caduque y devuelve el trabajo', async () => {
    const t = setup([{ kind: 'largo', run: untilAborted }], {
      leaseSeconds: 5,
      leaseMarginSeconds: 4.8,
      renewEveryMs: 50,
    });
    t.lease.failRenewals = true;
    const job = t.add('largo');
    const startedAt = Date.now();

    const summary = await t.worker.run();

    expect(Date.now() - startedAt).toBeLessThan(3_000); // muy por debajo de los 5 s de reserva
    expect(summary.outcomes).toMatchObject({ timeout: 1 });
    expect(job).toMatchObject({ status: 'queued', locked_by: null });
    expect(job.last_error).toMatch(/superó el tiempo reservado/);
    expect(t.logger.entries.some((e) => e.event === 'job.lease_renew_failed')).toBe(true);
  });

  it('si al renovar la reserva ya no es suya (cancelado), aborta en el acto sin tocar la cola', async () => {
    const t = setup(
      [
        {
          kind: 'largo',
          run(context) {
            // Lo que hace cancel_job mientras el trabajo avanza.
            Object.assign(
              t.jobs.find((j) => j.id === context.job.id)!,
              { status: 'cancelled', locked_by: null },
            );
            return untilAborted(context);
          },
        },
      ],
      { renewEveryMs: 20 },
    );
    const job = t.add('largo');
    const startedAt = Date.now();

    const summary = await t.worker.run();

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(summary.outcomes).toMatchObject({ lease_lost: 1 });
    expect(job).toMatchObject({ status: 'cancelled' });
    expect(job.last_error).toBeUndefined();
  });

  it('aunque renueve, un intento no pasa de su tiempo máximo', async () => {
    const t = setup([{ kind: 'eterno', run: untilAborted }], { renewEveryMs: 20, maxAttemptSeconds: 0.3 });
    const job = t.add('eterno');

    const summary = await t.worker.run();

    expect(summary.outcomes).toMatchObject({ timeout: 1 });
    expect(job.status).toBe('queued');
    expect(job.last_error).toMatch(/tiempo máximo de un intento/);
  });

  it('apagado ordenado: no reclama más y el trabajo a medias vuelve a la cola', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const t = setup([
      {
        kind: 'largo',
        run(context) {
          started();
          return untilAborted(context);
        },
      },
    ]);
    const enCurso = t.add('largo');
    const sinEmpezar = t.add('largo');

    const finished = t.worker.run();
    await running;
    t.worker.stop('SIGTERM');
    const summary = await finished;

    expect(summary).toMatchObject({ claimed: 1, stoppedBy: 'shutdown', outcomes: { released: 1 } });
    // Devuelto con release_job: sin gastar el intento y sin anotarlo como error.
    expect(enCurso).toMatchObject({ status: 'queued', locked_by: null, attempts: 0 });
    expect(enCurso.last_error).toBeUndefined();
    expect(sinEmpezar).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('con margen de apagado, deja terminar el trabajo en curso', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const t = setup(
      [
        {
          kind: 'corto',
          async run() {
            started();
            await new Promise((resolve) => setTimeout(resolve, 80));
            return { ok: true };
          },
        },
      ],
      { shutdownGraceMs: 5_000 },
    );
    const job = t.add('corto');

    const finished = t.worker.run();
    await running;
    t.worker.stop();
    const summary = await finished;

    expect(summary).toMatchObject({ stoppedBy: 'shutdown', outcomes: { succeeded: 1 } });
    expect(job.status).toBe('succeeded');
  });

  it('si cancelan el trabajo mientras se ejecuta, el resultado se descarta sin tocar la cola', async () => {
    const t = setup([
      {
        kind: 'cancelable',
        async run({ job }) {
          // Lo que hace cancel_job: el trabajo deja de estar reservado.
          Object.assign(
            t.jobs.find((j) => j.id === job.id)!,
            { status: 'cancelled', locked_by: null },
          );
          return { ok: true };
        },
      },
    ]);
    const job = t.add('cancelable');

    const summary = await t.worker.run();

    expect(summary.outcomes).toMatchObject({ lease_lost: 1, succeeded: 0 });
    expect(job).toMatchObject({ status: 'cancelled' });
    expect(job.result).toBeUndefined();
  });

  it('en modo continuo sigue sondeando y recoge lo que llegue, hasta que se le pide parar', async () => {
    const done: string[] = [];
    const t = setup(
      [
        {
          kind: 'eco',
          async run({ job }) {
            done.push(job.id);
            return {};
          },
        },
      ],
      { mode: 'continuous' },
    );
    t.add('eco');

    const finished = t.worker.run();
    await new Promise((resolve) => setTimeout(resolve, 100)); // cola vacía: sigue vivo
    const late = t.add('eco');
    while (late.status !== 'succeeded') await new Promise((resolve) => setTimeout(resolve, 10));
    t.worker.stop();
    const summary = await finished;

    expect(done).toEqual(['job-1', 'job-2']);
    expect(summary).toMatchObject({ claimed: 2, stoppedBy: 'shutdown', outcomes: { succeeded: 2 } });
  });

  it('con concurrencia 2 lleva dos trabajos a la vez, y no más', async () => {
    let now = 0;
    let peak = 0;
    const t = setup(
      [
        {
          kind: 'lento',
          async run() {
            now += 1;
            peak = Math.max(peak, now);
            await new Promise((resolve) => setTimeout(resolve, 60));
            now -= 1;
            return {};
          },
        },
      ],
      { concurrency: 2 },
    );
    for (let i = 0; i < 5; i += 1) t.add('lento');

    const summary = await t.worker.run();

    expect(summary.outcomes.succeeded).toBe(5);
    expect(peak).toBe(2);
  });

  it('si la cola no responde, en modo de vaciado termina con error en vez de quedarse colgado', async () => {
    const logger = createMemoryLogger();
    const worker = createWorker({
      queue: {
        claim: async () => {
          throw new Error('La cola respondió 503');
        },
        complete: async () => undefined,
        fail: async () => undefined,
        release: async () => undefined,
        extendLease: async () => undefined,
      },
      storage: createFolderStorage(tmpRoot),
      handlers: [{ kind: 'eco', run: async () => ({}) }],
      logger,
      workerId: 't',
      mode: 'drain',
      pollIntervalMs: 1,
      tmpRoot,
    });
    expect(await worker.run()).toMatchObject({ claimed: 0, stoppedBy: 'queue-error' });
    expect(logger.entries.filter((e) => e.event === 'queue.claim_failed')).toHaveLength(5);
  });
});

describe('registro de manejadores', () => {
  it('reclama los cinco tipos implementados; el de documentos por capas no está registrado ni simulado', async () => {
    const kinds = createMediaHandlers(deps).map((h) => h.kind);
    expect(kinds.sort()).toEqual([
      'media.image.process',
      'media.reel.template',
      'media.report.pdf',
      'media.video.derivatives',
      'source.extract',
    ]);
    expect(kinds).not.toContain(DOCUMENT_EXPORT_KIND);
    await expect(createDocumentExportHandler(deps).run({} as HandlerContext)).rejects.toThrow(/no está implementada/);
  });
});
