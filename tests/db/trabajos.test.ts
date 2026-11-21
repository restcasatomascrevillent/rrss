// Cola de trabajos, contra las migraciones reales: encolar, reclamar,
// terminar, fallar con reintentos, caducidad de la reserva y cancelación.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  rpcStatement,
  serviceRpc,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

interface Job extends Row {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  locked_by: string | null;
  last_error: string | null;
}

let db: Db;
let ana: TestUser;
let orgA: string, orgB: string, marcaA: string;
let n = 0;

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test');
  const berta = await createUser(db, 'berta@b.test');
  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  marcaA = await createBrand(db, ana, orgA, 'Marca A');
});

afterAll(async () => {
  await db?.close();
});

// Cada prueba empieza con la cola vacía.
beforeEach(async () => {
  await db.exec(`delete from public.jobs`);
});

const enqueue = (extra: Row = {}) => {
  n += 1;
  return serviceRpc<Job>(db, 'enqueue_job', {
    p_organization_id: orgA,
    p_brand_id: marcaA,
    p_kind: 'media.render',
    p_payload: { n },
    p_idempotency_key: `clave-${n}`,
    ...extra,
  });
};
// claim_jobs devuelve un conjunto de filas: se piden todas, no solo la primera.
const claim = async (worker: string, extra: Row = {}) => {
  const { sql, params } = rpcStatement('claim_jobs', { p_worker: worker, p_limit: 10, ...extra });
  const rows = await asService<{ data: Job }>(db, sql, params);
  return rows.map((r) => r.data);
};
const complete = (id: string, worker: string, result: Row = { ok: true }) =>
  serviceRpc<Job>(db, 'complete_job', { p_job_id: id, p_worker: worker, p_result: result });
const fail = (id: string, worker: string, extra: Row = {}) =>
  serviceRpc<Job>(db, 'fail_job', { p_job_id: id, p_worker: worker, p_error: 'Se cayó el render', ...extra });
const cancel = (id: string) => serviceRpc<Job>(db, 'cancel_job', { p_job_id: id });
const release = (id: string, worker: string) => serviceRpc<Job>(db, 'release_job', { p_job_id: id, p_worker: worker });
const extend = (id: string, worker: string, seconds = 600) =>
  serviceRpc<Job>(db, 'extend_job_lease', { p_job_id: id, p_worker: worker, p_lease_seconds: seconds });
/** Segundos que le quedan a la reserva, medidos contra `now()` de la base. */
const leaseLeft = async (id: string) =>
  (
    await db.query<{ s: number }>(
      `select round(extract(epoch from locked_until - now()))::int as s from public.jobs where id = $1`,
      [id],
    )
  )[0]!.s;
const job = async (id: string) => (await db.query<Job>(`select * from public.jobs where id = $1`, [id]))[0]!;
const expireLease = (id: string) =>
  db.query(`update public.jobs set locked_until = now() - interval '1 second' where id = $1`, [id]);
const makeDue = (id: string) =>
  db.query(`update public.jobs set run_after = now() - interval '1 second' where id = $1`, [id]);

describe('encolar', () => {
  it('repetir la clave de idempotencia no duplica el trabajo', async () => {
    const primero = await enqueue({ p_idempotency_key: 'render-pieza-1', p_payload: { v: 1 } });
    const repetido = await enqueue({ p_idempotency_key: 'render-pieza-1', p_payload: { v: 2 } });
    expect(repetido.id).toBe(primero.id);
    expect(repetido.payload).toEqual({ v: 1 }); // el original no se toca
    expect(await db.query(`select 1 from public.jobs`)).toHaveLength(1);

    // La clave es por organización: otra puede usar la misma.
    const otra = await enqueue({ p_organization_id: orgB, p_brand_id: null, p_idempotency_key: 'render-pieza-1' });
    expect(otra.id).not.toBe(primero.id);
  });

  it('un trabajo no puede declararse de una marca de otra organización', async () => {
    await expect(enqueue({ p_organization_id: orgB })).rejects.toThrow(/foreign key/i);
    await expect(enqueue({ p_kind: 'Tipo Inválido' })).rejects.toThrow(/check constraint/i);
  });
});

describe('reclamar', () => {
  it('entrega cada trabajo a un solo trabajador, por prioridad y antigüedad', async () => {
    const normal = await enqueue();
    const urgente = await enqueue({ p_priority: 10 });
    const otroNormal = await enqueue();

    const deUno = await claim('trabajador-1', { p_limit: 2 });
    expect(deUno.map((j) => j.id).sort()).toEqual([urgente.id, normal.id].sort());
    expect(deUno.every((j) => j.status === 'running' && j.locked_by === 'trabajador-1' && j.attempts === 1)).toBe(true);

    const deDos = await claim('trabajador-2');
    expect(deDos.map((j) => j.id)).toEqual([otroNormal.id]);
    expect(await claim('trabajador-3')).toEqual([]);
  });

  it('filtra por tipo y no entrega lo que aún no toca', async () => {
    const render = await enqueue();
    await enqueue({ p_kind: 'source.process' });
    const futuro = await enqueue({ p_run_after: new Date(Date.now() + 3_600_000).toISOString() });

    expect((await claim('t1', { p_kinds: ['media.render'] })).map((j) => j.id)).toEqual([render.id]);
    expect((await claim('t1', { p_kinds: ['source.process', 'otro'] })).map((j) => j.kind)).toEqual(['source.process']);
    expect(await claim('t1')).toEqual([]);
    expect((await job(futuro.id)).status).toBe('queued');
  });

  it.skipIf(!process.env.DATABASE_URL)(
    'dos trabajadores a la vez no se bloquean ni se pisan (SKIP LOCKED, dos conexiones)',
    async () => {
      await enqueue();
      await enqueue();
      const { sql, params } = rpcStatement('claim_jobs', { p_worker: 't', p_limit: 1 });
      const [first, second] = await Promise.all([db.connect!(), db.connect!()]);
      try {
        await first!.exec('begin');
        const [mine] = await first!.query<{ data: Job }>(sql, params);
        // Con la primera transacción aún abierta, la segunda no espera: se lleva el otro.
        const [theirs] = await second!.query<{ data: Job }>(sql, params);
        await first!.exec('commit');
        expect(theirs!.data.id).not.toBe(mine!.data.id);
      } finally {
        await Promise.all([first!.close(), second!.close()]);
      }
    },
  );
});

describe('terminar y fallar', () => {
  it('solo cierra el trabajo quien lo tiene reservado', async () => {
    const { id } = await enqueue();
    await expect(complete(id, 't1')).rejects.toThrow(/no está reservado/); // aún en cola
    await claim('t1');
    await expect(complete(id, 'otro')).rejects.toThrow(/no está reservado/);
    await expect(fail(id, 'otro')).rejects.toThrow(/no está reservado/);

    const hecho = await complete(id, 't1', { asset: 'abc' });
    expect(hecho).toMatchObject({ status: 'succeeded', result: { asset: 'abc' }, locked_by: null });
    expect(hecho.finished_at).toBeTruthy();
    await expect(complete(id, 't1')).rejects.toThrow(/no está reservado/);
  });

  it('un fallo vuelve a la cola con espera creciente; agotados los intentos queda fallido', async () => {
    const { id } = await enqueue({ p_max_attempts: 3 });
    const esperas: number[] = [];
    for (const intento of [1, 2]) {
      expect((await claim('t1')).map((j) => j.attempts)).toEqual([intento]);
      const fallido = await fail(id, 't1');
      expect(fallido).toMatchObject({ status: 'queued', last_error: 'Se cayó el render', locked_by: null });
      // La espera se mide contra `updated_at`, que fail_job fija en la misma
      // transacción: medirla contra el reloj de ahora depende de lo que tarde
      // la prueba (con Postgres real salía 29 y 59).
      const [row] = await db.query<{ s: number }>(
        `select round(extract(epoch from run_after - updated_at))::int as s from public.jobs where id = $1`,
        [id],
      );
      esperas.push(row!.s);
      expect(await claim('t1')).toEqual([]); // todavía no toca
      await makeDue(id);
    }
    expect(esperas).toEqual([30, 60]);

    await claim('t1');
    const final = await fail(id, 't1');
    expect(final).toMatchObject({ status: 'failed', attempts: 3, last_error: 'Se cayó el render' });
    expect(final.finished_at).toBeTruthy();
    await makeDue(id);
    expect(await claim('t1')).toEqual([]);
  });

  it('un fallo sin remedio no se reintenta', async () => {
    const { id } = await enqueue();
    await claim('t1');
    expect(await fail(id, 't1', { p_retry: false })).toMatchObject({ status: 'failed', attempts: 1 });
  });
});

describe('reserva con caducidad', () => {
  it('si el trabajador muere, otro recoge el trabajo y el primero ya no puede cerrarlo', async () => {
    const { id } = await enqueue();
    await claim('muerto');
    expect(await claim('vivo')).toEqual([]); // la reserva sigue vigente
    await expireLease(id);

    const [recogido] = await claim('vivo');
    expect(recogido).toMatchObject({ id, locked_by: 'vivo', attempts: 2 });
    await expect(complete(id, 'muerto')).rejects.toThrow(/no está reservado/);
    expect((await complete(id, 'vivo')).status).toBe('succeeded');
  });

  it('una reserva caducada sin intentos restantes queda como fallida, a la vista', async () => {
    const { id } = await enqueue({ p_max_attempts: 1 });
    await claim('muerto');
    await expireLease(id);

    expect(await claim('vivo')).toEqual([]);
    expect(await job(id)).toMatchObject({
      status: 'failed',
      locked_by: null,
      last_error: 'El trabajador dejó de responder y no quedan intentos',
    });
  });
});

describe('devolver y renovar la reserva', () => {
  it('devolver un trabajo no gasta intento: vuelve a la cola ya, con los intentos de antes', async () => {
    const { id } = await enqueue({ p_max_attempts: 1 });
    await expect(release(id, 't1')).rejects.toThrow(/no está reservado/); // aún en cola
    await claim('t1');
    await expect(release(id, 'otro')).rejects.toThrow(/no está reservado/);

    const devuelto = await release(id, 't1');
    expect(devuelto).toMatchObject({ status: 'queued', attempts: 0, locked_by: null, locked_until: null });
    expect(devuelto.last_error).toBeNull();
    // Con un solo intento, si hubiera contado, no se podría volver a reclamar.
    const [otraVez] = await claim('t2');
    expect(otraVez).toMatchObject({ id, attempts: 1, locked_by: 't2' });
    await expect(complete(id, 't1')).rejects.toThrow(/no está reservado/);
    expect((await complete(id, 't2')).status).toBe('succeeded');
  });

  it('con fail_job sí se gasta: la diferencia que justifica release_job', async () => {
    const { id } = await enqueue({ p_max_attempts: 1 });
    await claim('t1');
    expect(await fail(id, 't1')).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('renovar alarga la reserva desde ahora; solo quien la tiene y dentro de los límites', async () => {
    const { id } = await enqueue();
    await expect(extend(id, 't1')).rejects.toThrow(/no está reservado/);
    await claim('t1', { p_lease_seconds: 30 });
    expect(await leaseLeft(id)).toBeLessThanOrEqual(30);

    const renovado = await extend(id, 't1', 600);
    expect(renovado).toMatchObject({ status: 'running', locked_by: 't1', attempts: 1 });
    expect(await leaseLeft(id)).toBeGreaterThan(590);
    await expect(extend(id, 'otro')).rejects.toThrow(/no está reservado/);
    await expect(extend(id, 't1', 4)).rejects.toThrow(/entre 5 segundos y una hora/);
    await expect(extend(id, 't1', 3601)).rejects.toThrow(/entre 5 segundos y una hora/);
  });

  it('una reserva renovada no la recoge otro; una caducada y ya reclamada no se puede renovar', async () => {
    const { id } = await enqueue();
    await claim('lento', { p_lease_seconds: 5 });
    await expireLease(id);
    // Caducada pero sin reclamar: sigue siendo suya y la puede renovar.
    await extend(id, 'lento', 60);
    expect(await claim('otro')).toEqual([]);

    await expireLease(id);
    await claim('otro');
    await expect(extend(id, 'lento')).rejects.toThrow(/no está reservado/);
    await expect(release(id, 'lento')).rejects.toThrow(/no está reservado/);
  });

  it('un trabajo cancelado no se renueva ni se devuelve', async () => {
    const { id } = await enqueue();
    await claim('t1');
    await cancel(id);
    await expect(extend(id, 't1')).rejects.toThrow(/no está reservado/);
    await expect(release(id, 't1')).rejects.toThrow(/no está reservado/);
    expect((await job(id)).status).toBe('cancelled');
  });
});

describe('cancelar', () => {
  it('un trabajo cancelado no se reclama, y si estaba en curso no se puede cerrar', async () => {
    const enCola = await enqueue();
    expect((await cancel(enCola.id)).status).toBe('cancelled');
    expect(await claim('t1')).toEqual([]);

    const enCurso = await enqueue();
    await claim('t1');
    expect(await cancel(enCurso.id)).toMatchObject({ status: 'cancelled', locked_by: null });
    await expect(complete(enCurso.id, 't1')).rejects.toThrow(/no está reservado/);

    await expect(cancel(enCurso.id)).rejects.toThrow(/ya ha terminado/);
  });
});

describe('quién mueve la cola', () => {
  it('desde el cliente no se encola, no se reclama y no se escribe la tabla', async () => {
    const { id } = await enqueue();
    const noFunction = /permission denied for function/;
    await denied(db, ana, `select public.enqueue_job($1, 'media.render', '{}'::jsonb, 'k')`, [orgA], noFunction);
    await denied(db, ana, `select * from public.claim_jobs('yo')`, [], noFunction);
    await denied(db, ana, `select public.complete_job($1, 'yo')`, [id], noFunction);
    await denied(db, ana, `select public.fail_job($1, 'yo', 'x')`, [id], noFunction);
    await denied(db, ana, `select public.cancel_job($1)`, [id], noFunction);
    await denied(db, ana, `select public.release_job($1, 'yo')`, [id], noFunction);
    await denied(db, ana, `select public.extend_job_lease($1, 'yo', 60)`, [id], noFunction);

    await denied(
      db,
      ana,
      `insert into public.jobs (organization_id, kind, idempotency_key) values ($1, 'media.render', 'mia')`,
      [orgA],
    );
    await denied(db, ana, `update public.jobs set priority = 100 where id = $1`, [id]);
    await denied(db, ana, `delete from public.jobs where id = $1`, [id]);
  });
});
