// El bucle del trabajador de medios (worker/src/worker.ts) contra la cola
// REAL de las migraciones: reclamar, cerrar, fallar con reintento, apagado
// ordenado (devolver sin gastar intento), renovar la reserva y cancelación. Los manejadores son de mentira (aquí no hay FFmpeg):
// lo que se prueba es el contrato entre el trabajador y las funciones SQL.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeaseLostError, PermanentError } from '../../worker/src/errors';
import type { Handler } from '../../worker/src/handler';
import type { Job, JobQueue } from '../../worker/src/queue';
import { createWorker, type WorkerOptions } from '../../worker/src/worker';
import {
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  rpcStatement,
  serviceRpc,
  type Db,
  type Row,
} from './helpers';

interface JobRow extends Row {
  id: string;
  status: string;
  attempts: number;
  locked_by: string | null;
  last_error: string | null;
  result: Row | null;
}

let db: Db;
let org: string, marca: string;
let tmpRoot: string;
let n = 0;

beforeAll(async () => {
  db = await createDb();
  const ana = await createUser(db, 'ana@a.test');
  org = await createOrg(db, ana, 'Empresa A');
  marca = await createBrand(db, ana, org, 'Marca A');
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'rrss-trabajador-'));
});

afterAll(async () => {
  await db?.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.exec(`delete from public.jobs`);
});

/** La cola tal como la ve el trabajador, sobre las funciones SQL con la clave de servicio. */
const sqlQueue: JobQueue = {
  async claim({ worker, kinds, limit, leaseSeconds }) {
    const { sql, params } = rpcStatement('claim_jobs', {
      p_worker: worker,
      p_kinds: kinds,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    return (await asService<{ data: Job }>(db, sql, params)).map((r) => r.data);
  },
  async complete(jobId, worker, result) {
    await closing(() => serviceRpc(db, 'complete_job', { p_job_id: jobId, p_worker: worker, p_result: result }));
  },
  async fail(jobId, worker, error, retry) {
    await closing(() =>
      serviceRpc(db, 'fail_job', { p_job_id: jobId, p_worker: worker, p_error: error, p_retry: retry }),
    );
  },
  async release(jobId, worker) {
    await closing(() => serviceRpc(db, 'release_job', { p_job_id: jobId, p_worker: worker }));
  },
  async extendLease(jobId, worker, leaseSeconds) {
    await closing(() =>
      serviceRpc(db, 'extend_job_lease', { p_job_id: jobId, p_worker: worker, p_lease_seconds: leaseSeconds }),
    );
  },
};

// Igual que el adaptador de Supabase: el aviso de la función se convierte en LeaseLostError.
async function closing(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    if (error instanceof Error && /no está reservado por este trabajador/.test(error.message)) {
      throw new LeaseLostError(error.message);
    }
    throw error;
  }
}

const enqueue = (kind: string, payload: Row = {}, extra: Row = {}) => {
  n += 1;
  return serviceRpc<JobRow>(db, 'enqueue_job', {
    p_organization_id: org,
    p_brand_id: marca,
    p_kind: kind,
    p_payload: payload,
    p_idempotency_key: `trabajador-${n}`,
    ...extra,
  });
};
const job = async (id: string) => (await db.query<JobRow>(`select * from public.jobs where id = $1`, [id]))[0]!;

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const worker = (handlers: Handler[], options: Partial<WorkerOptions> = {}) =>
  createWorker({
    queue: sqlQueue,
    storage: { download: async () => undefined, upload: async () => undefined },
    handlers,
    logger: silent,
    workerId: 'medios-1',
    mode: 'drain',
    pollIntervalMs: 20,
    tmpRoot,
    ...options,
  });

describe('trabajador de medios contra la cola real', () => {
  it('vacía la cola: cada trabajo de sus tipos queda terminado con su resultado, y sale', async () => {
    const uno = await enqueue('media.image.process', { n: 1 });
    const dos = await enqueue('media.image.process', { n: 2 }, { p_priority: 10 });
    const ajeno = await enqueue('source.process');
    const order: unknown[] = [];

    const summary = await worker([
      {
        kind: 'media.image.process',
        async run({ job: claimed }) {
          order.push(claimed.payload.n);
          // El trabajo llega con su organización y su marca: de ahí sale qué rutas puede tocar.
          expect(claimed).toMatchObject({ organization_id: org, brand_id: marca, attempts: 1 });
          return { hecho: claimed.payload.n };
        },
      },
    ]).run();

    expect(summary).toMatchObject({ claimed: 2, stoppedBy: 'empty-queue', outcomes: { succeeded: 2 } });
    expect(order).toEqual([2, 1]); // por prioridad
    expect(await job(uno.id)).toMatchObject({ status: 'succeeded', result: { hecho: 1 }, locked_by: null });
    expect(await job(dos.id)).toMatchObject({ status: 'succeeded', result: { hecho: 2 } });
    expect(await job(ajeno.id)).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('un fallo pasajero vuelve a la cola con espera; uno sin remedio queda fallido a la primera', async () => {
    const pasajero = await enqueue('media.reel.template');
    const invalido = await enqueue('media.reel.template', { invalido: true });

    const summary = await worker([
      {
        kind: 'media.reel.template',
        async run({ job: claimed }) {
          if (claimed.payload.invalido) throw new PermanentError('Carga del trabajo inválida: plan.media');
          throw new Error('FFmpeg terminó con código 1');
        },
      },
    ]).run();

    // Sale aunque quede un trabajo en espera: no toca hasta dentro de 30 s.
    expect(summary).toMatchObject({ claimed: 2, stoppedBy: 'empty-queue', outcomes: { retry: 1, failed: 1 } });
    expect(await job(pasajero.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error: 'FFmpeg terminó con código 1',
    });
    expect(await job(invalido.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'Carga del trabajo inválida: plan.media',
    });
  });

  it('apagado ordenado: el trabajo a medias vuelve a la cola sin gastar intento y otro lo termina', async () => {
    const { id } = await enqueue('media.video.derivatives');
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const first = worker([
      {
        kind: 'media.video.derivatives',
        run: ({ signal }) =>
          new Promise((_, reject) => {
            started();
            signal.addEventListener('abort', () => reject(new Error('FFmpeg interrumpido')), { once: true });
          }),
      },
    ]);

    const finished = first.run();
    await running;
    expect(await job(id)).toMatchObject({ status: 'running', locked_by: 'medios-1' });
    first.stop('SIGTERM');
    expect(await finished).toMatchObject({ stoppedBy: 'shutdown', outcomes: { released: 1 } });
    expect(await job(id)).toMatchObject({ status: 'queued', locked_by: null, attempts: 0, last_error: null });

    // Sin espera: otro trabajador lo recoge en el acto y lo termina en su primer intento.
    const second = worker([{ kind: 'media.video.derivatives', run: async () => ({ ok: true }) }], {
      workerId: 'medios-2',
    });
    expect(await second.run()).toMatchObject({ outcomes: { succeeded: 1 } });
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 1, result: { ok: true } });
  });

  it('un trabajo cancelado mientras se ejecuta no se cierra: su resultado se descarta', async () => {
    const { id } = await enqueue('media.image.process');

    const summary = await worker([
      {
        kind: 'media.image.process',
        async run() {
          await serviceRpc(db, 'cancel_job', { p_job_id: id });
          return { tarde: true };
        },
      },
    ]).run();

    expect(summary.outcomes).toMatchObject({ lease_lost: 1, succeeded: 0, failed: 0 });
    expect(await job(id)).toMatchObject({ status: 'cancelled', result: null });
  });

  it('un trabajo largo renueva su reserva en la cola real y nadie más lo recoge mientras', async () => {
    const { id } = await enqueue('media.reel.template');
    const leaseLeft = async () =>
      (
        await db.query<{ s: number }>(
          `select extract(epoch from locked_until - now())::float as s from public.jobs where id = $1`,
          [id],
        )
      )[0]!.s;
    const seen: number[] = [];

    const summary = await worker(
      [
        {
          kind: 'media.reel.template',
          async run() {
            // 1,5 s: sin renovar, la reserva de 5 s se habría abortado a los 0,5 s.
            for (let i = 0; i < 5; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 300));
              seen.push(await leaseLeft());
            }
            const rival = rpcStatement('claim_jobs', { p_worker: 'medios-2', p_limit: 10 });
            expect(await asService(db, rival.sql, rival.params)).toEqual([]);
            return { ok: true };
          },
        },
      ],
      { leaseSeconds: 5, leaseMarginSeconds: 4.5, renewEveryMs: 100 },
    ).run();

    expect(summary.outcomes).toMatchObject({ succeeded: 1, timeout: 0 });
    // Tras cada renovación a la reserva le quedan casi los 5 s enteros.
    expect(Math.min(...seen)).toBeGreaterThan(4);
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('respeta la reserva: si no puede renovarla, aborta antes de que caduque y nadie más lo recoge a la vez', async () => {
    const { id } = await enqueue('media.reel.template');
    const startedAt = Date.now();

    const summary = await worker(
      [
        {
          kind: 'media.reel.template',
          run: ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(new Error('FFmpeg interrumpido')), { once: true });
            }),
        },
      ],
      // Una cola que no deja renovar (la red cae justo en esas llamadas).
      {
        leaseSeconds: 5,
        leaseMarginSeconds: 4.5,
        renewEveryMs: 100,
        queue: {
          ...sqlQueue,
          extendLease: async () => {
            throw new Error('La cola respondió 503');
          },
        },
      },
    ).run();

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(summary.outcomes).toMatchObject({ timeout: 1 });
    const after = await job(id);
    expect(after).toMatchObject({ status: 'queued', locked_by: null });
    expect(after.last_error).toMatch(/superó el tiempo reservado/);
  });
});
