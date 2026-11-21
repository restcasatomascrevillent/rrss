// Cupo y coste de IA por organización, contra las migraciones reales.
// El cupo lo impone la base de datos: aquí se llama a las funciones como lo
// hará el servidor (clave de servicio) y se comprueba qué deja pasar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  rpcStatement,
  serviceRpc,
  setAiQuota,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

interface Tenant {
  owner: TestUser;
  org: string;
  brand: string;
}

interface Generation extends Row {
  id: string;
  status: string;
  cost_micros: number | null;
  reserved_micros: number;
}

interface PgError {
  code?: string;
  message: string;
  detail?: string;
}

let db: Db;
let root: TestUser;
let n = 0;

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@plataforma.test', 'Root');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
});

afterAll(async () => {
  await db?.close();
});

/** Organización nueva con una marca y, si se indica, su cupo mensual. */
async function tenant(limitMicros?: number): Promise<Tenant> {
  n += 1;
  const owner = await createUser(db, `propietaria${n}@org${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  if (limitMicros !== undefined) await setAiQuota(db, root, org, limitMicros);
  return { owner, org, brand };
}

const reserveArgs = (t: Tenant, micros: number, extra: Row = {}) => ({
  p_user_id: t.owner.id,
  p_brand_id: t.brand,
  p_task: 'text',
  p_purpose: 'post.caption',
  p_provider: 'simulated',
  p_model: 'sim-text-1',
  p_reserve_micros: micros,
  ...extra,
});

const reserve = (t: Tenant, micros: number, extra: Row = {}) =>
  serviceRpc<Generation>(db, 'ai_reserve_generation', reserveArgs(t, micros, extra));

const complete = (id: string, costMicros: number) =>
  serviceRpc<Generation>(db, 'ai_complete_generation', {
    p_generation_id: id,
    p_cost_micros: costMicros,
    p_usage: { input_tokens: 10, output_tokens: 20 },
    p_output: { text: 'hola' },
    p_latency_ms: 120,
  });

const fail = (id: string) =>
  serviceRpc<Generation>(db, 'ai_fail_generation', {
    p_generation_id: id,
    p_error_code: 'provider_down',
    p_error_message: 'El proveedor no responde',
  });

/** Cupo comprometido (reservas vivas + coste real) de una organización. */
async function committed(org: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `select coalesce(sum(reserved_delta_micros + cost_delta_micros), 0)::int as n from public.ai_usage where organization_id = $1`,
    [org],
  );
  return row!.n;
}

async function ledger(generationId: string): Promise<string[]> {
  const rows = await db.query<{ e: string }>(
    `select entry || ':' || reserved_delta_micros || ':' || cost_delta_micros as e from public.ai_usage where generation_id = $1 order by id`,
    [generationId],
  );
  return rows.map((r) => r.e);
}

async function failure(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (error) {
    return error as PgError;
  }
  throw new Error('Se esperaba un error y la llamada terminó bien');
}

describe('cupo de IA', () => {
  it('sin cupo asignado no se genera', async () => {
    const t = await tenant();
    const error = await failure(reserve(t, 100));
    expect(error.code).toBe('AI002');
    expect(error.message).toMatch(/no tiene cupo de IA asignado/);
    expect(await db.query(`select 1 from public.ai_generations where organization_id = $1`, [t.org])).toEqual([]);
  });

  it('solo reserva en nombre de quien puede crear contenido en la marca', async () => {
    const t = await tenant(1000);
    const editor = await createUser(db, `editor${n}@org${n}.test`);
    const cliente = await createUser(db, `cliente${n}@org${n}.test`);
    const ajeno = await createUser(db, `ajeno${n}@otra.test`);
    await join(db, t.owner, editor, t.org, 'member', t.brand, 'editor');
    await join(db, t.owner, cliente, t.org, 'member', t.brand, 'client');

    expect((await reserve(t, 100, { p_user_id: editor.id })).status).toBe('reserved');
    for (const user of [cliente.id, ajeno.id, null]) {
      const error = await failure(reserve(t, 100, { p_user_id: user }));
      expect(error.code).toBe('42501');
      expect(error.message).toMatch(/No tienes permiso para generar/);
    }
    // Ni en una marca que no existe.
    expect((await failure(reserve(t, 100, { p_brand_id: t.org }))).code).toBe('42501');
    expect(await committed(t.org)).toBe(100);
  });

  it('reservar aparta cupo y terminar lo cambia por el coste real', async () => {
    const t = await tenant(1000);
    const gen = await reserve(t, 400);
    expect(gen.status).toBe('reserved');
    expect(await committed(t.org)).toBe(400);

    const done = await complete(gen.id, 150);
    expect(done).toMatchObject({ status: 'succeeded', cost_micros: 150, latency_ms: 120, output: { text: 'hola' } });
    expect(done.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(await committed(t.org)).toBe(150);
    expect(await ledger(gen.id)).toEqual(['reserve:400:0', 'settle:-400:150']);
  });

  it('un fallo del proveedor devuelve la reserva entera', async () => {
    const t = await tenant(1000);
    const gen = await reserve(t, 400);
    const failed = await fail(gen.id);
    expect(failed).toMatchObject({ status: 'failed', cost_micros: null, error_code: 'provider_down' });
    expect(await committed(t.org)).toBe(0);
    expect(await ledger(gen.id)).toEqual(['reserve:400:0', 'release:-400:0']);
    // Con el cupo intacto cabe una generación que lo ocupe entero.
    expect((await reserve(t, 1000)).status).toBe('reserved');
  });

  it('un cupo agotado detiene la generación con un mensaje claro', async () => {
    const t = await tenant(1000);
    await complete((await reserve(t, 700)).id, 700);

    const error = await failure(reserve(t, 301));
    expect(error.code).toBe('AI001');
    expect(error.message).toBe(
      'El cupo de IA de este mes está agotado: no queda saldo suficiente para esta generación',
    );
    expect(JSON.parse(error.detail!)).toMatchObject({
      limit_micros: 1000,
      committed_micros: 700,
      requested_micros: 301,
    });
    // El rechazo no deja ni generación ni apunte.
    expect(await committed(t.org)).toBe(700);
    expect(await db.query(`select 1 from public.ai_generations where organization_id = $1`, [t.org])).toHaveLength(1);

    // Lo que sí cabe, pasa; y con el cupo justo en el límite ya no entra nada.
    await reserve(t, 300);
    expect((await failure(reserve(t, 1))).code).toBe('AI001');
  });

  it('las reservas en curso también cuentan', async () => {
    const t = await tenant(1000);
    await reserve(t, 600);
    expect((await failure(reserve(t, 600))).code).toBe('AI001');
  });

  it('un cupo de cero no deja generar', async () => {
    const t = await tenant(0);
    expect((await failure(reserve(t, 1))).code).toBe('AI001');
  });

  it('cada organización tiene su cupo: agotar uno no afecta a otra', async () => {
    const a = await tenant(500);
    const b = await tenant(500);
    await reserve(a, 500);
    expect((await failure(reserve(a, 1))).code).toBe('AI001');
    expect((await reserve(b, 500)).status).toBe('reserved');
    expect(await committed(b.org)).toBe(500);
  });

  it('subir el cupo desbloquea la generación sin tocar nada más', async () => {
    const t = await tenant(100);
    await reserve(t, 100);
    expect((await failure(reserve(t, 50))).code).toBe('AI001');
    await setAiQuota(db, root, t.org, 200);
    expect((await reserve(t, 50)).status).toBe('reserved');
  });

  it('una reserva que nadie cierra caduca y devuelve su cupo', async () => {
    const t = await tenant(1000);
    const colgada = await reserve(t, 800);
    expect((await failure(reserve(t, 800))).code).toBe('AI001');

    await db.query(`update public.ai_generations set reserved_until = now() - interval '1 second' where id = $1`, [
      colgada.id,
    ]);
    const siguiente = await reserve(t, 800);
    expect(siguiente.status).toBe('reserved');
    const [fila] = await db.query(`select status, error_code from public.ai_generations where id = $1`, [colgada.id]);
    expect(fila).toEqual({ status: 'expired', error_code: 'reservation_expired' });
    expect(await ledger(colgada.id)).toEqual(['reserve:800:0', 'release:-800:0']);

    // Si el proveedor acaba respondiendo tarde, el coste se apunta igual (el
    // gasto es real) y la reserva no se devuelve dos veces.
    await complete(colgada.id, 500);
    expect(await ledger(colgada.id)).toEqual(['reserve:800:0', 'release:-800:0', 'settle:0:500']);
    expect(await committed(t.org)).toBe(1300);
  });

  it('cerrar dos veces no apunta dos veces', async () => {
    const t = await tenant(1000);
    const bien = await reserve(t, 300);
    await complete(bien.id, 200);
    expect((await complete(bien.id, 999)).cost_micros).toBe(200);
    await expect(fail(bien.id)).rejects.toThrow(/ya se cerró como terminada/);

    const mal = await reserve(t, 300);
    await fail(mal.id);
    expect((await fail(mal.id)).status).toBe('failed');
    await expect(complete(mal.id, 10)).rejects.toThrow(/ya se cerró como fallida/);

    expect(await committed(t.org)).toBe(200);
    expect(await ledger(bien.id)).toHaveLength(2);
    expect(await ledger(mal.id)).toHaveLength(2);
  });

  it('el cupo es mensual: lo gastado el mes anterior no cuenta', async () => {
    const t = await tenant(1000);
    await complete((await reserve(t, 900)).id, 900);
    expect((await failure(reserve(t, 200))).code).toBe('AI001');

    // Se simula el cambio de mes moviendo los apuntes al periodo anterior.
    await db.query(
      `update public.ai_usage set period_start = (period_start - interval '1 month')::date where organization_id = $1`,
      [t.org],
    );
    expect((await reserve(t, 200)).status).toBe('reserved');
  });

  it('rechaza reservas sin importe o con una caducidad absurda', async () => {
    const t = await tenant(1000);
    for (const micros of [0, -5, null]) {
      expect((await failure(reserve(t, 1, { p_reserve_micros: micros }))).code).toBe('22023');
    }
    expect((await failure(reserve(t, 1, { p_ttl_seconds: 1 }))).code).toBe('22023');
    await expect(complete((await reserve(t, 10)).id, -1)).rejects.toThrow(/no puede ser negativo/);
  });
});

describe('reservas simultáneas', () => {
  // Desde los planes (20261119310000) se bloquea la fila de la suscripción, que
  // existe siempre, en vez de la del cupo sobrescrito.
  it('reservar bloquea la fila de la suscripción hasta el final de la transacción', async () => {
    const t = await tenant(1000);
    const { sql, params } = rpcStatement('ai_reserve_generation', reserveArgs(t, 100));
    await db.exec('begin');
    try {
      await db.query(sql, params);
      // xmax = transacción que tiene bloqueada la fila: la siguiente reserva
      // de esta organización tiene que esperar a que esta termine.
      const [row] = await db.query<{ locked: boolean }>(
        `select xmax = pg_current_xact_id()::xid as locked from public.subscriptions where organization_id = $1`,
        [t.org],
      );
      expect(row!.locked).toBe(true);
    } finally {
      await db.exec('rollback');
    }
  });

  // Con PGlite (una sola conexión) las diez llamadas se ejecutan seguidas; con
  // DATABASE_URL cada una va por su propia conexión y compiten de verdad.
  it('diez reservas a la vez no superan el cupo', async () => {
    const t = await tenant(1000);
    const { sql, params } = rpcStatement('ai_reserve_generation', reserveArgs(t, 300));
    const extra = db.connect ? await Promise.all(Array.from({ length: 10 }, () => db.connect!())) : [];
    const sessions = extra.length > 0 ? extra : Array.from({ length: 10 }, () => db);
    try {
      const results = await Promise.allSettled(sessions.map((session) => session.query(sql, params)));
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(rejected.map((r) => (r.reason as PgError).code)).toEqual(Array(7).fill('AI001'));
      expect(await committed(t.org)).toBe(900);
    } finally {
      await Promise.all(extra.map((session) => session.close()));
    }
  });

  it.skipIf(!process.env.DATABASE_URL)(
    'la segunda reserva espera a la primera y ve lo que apartó (dos conexiones)',
    async () => {
      const t = await tenant(1000);
      const { sql, params } = rpcStatement('ai_reserve_generation', reserveArgs(t, 800));
      const [first, second] = await Promise.all([db.connect!(), db.connect!()]);
      try {
        await first!.exec('begin');
        await first!.query(sql, params);

        let settled = false;
        const waiting = second!.query(sql, params).then(
          () => ({ code: 'ok' }),
          (error: PgError) => ({ code: error.code }),
        );
        void waiting.then(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);

        await first!.exec('commit');
        expect((await waiting).code).toBe('AI001');
        expect(await committed(t.org)).toBe(800);
      } finally {
        await Promise.all([first!.close(), second!.close()]);
      }
    },
  );
});

describe('quién puede tocar el cupo y el consumo', () => {
  it('desde el cliente no se reserva, no se cierra y no se escribe nada', async () => {
    const t = await tenant(1000);
    const gen = await reserve(t, 100);
    const noFunction = /permission denied for function/;
    await denied(
      db,
      t.owner,
      `select public.ai_reserve_generation($1, $2, 'text', 'x', 'p', 'm', 1)`,
      [t.owner.id, t.brand],
      noFunction,
    );
    await denied(db, t.owner, `select public.ai_complete_generation($1, 0)`, [gen.id], noFunction);
    await denied(db, t.owner, `select public.ai_fail_generation($1, 'x')`, [gen.id], noFunction);

    await denied(db, t.owner, `update public.usage_quotas set limit_value = 999999999 where organization_id = $1`, [
      t.org,
    ]);
    await denied(
      db,
      t.owner,
      `insert into public.usage_quotas (organization_id, metric, limit_value) values ($1, 'ai_cost_micros', 5)`,
      [t.org],
    );
    await denied(db, t.owner, `delete from public.ai_usage where organization_id = $1`, [t.org]);
    await denied(db, t.owner, `update public.ai_usage set cost_delta_micros = 0 where organization_id = $1`, [t.org]);
    await denied(db, t.owner, `update public.ai_generations set status = 'failed' where id = $1`, [gen.id]);
    await denied(db, t.owner, `delete from public.ai_generations where id = $1`, [gen.id]);
  });

  it('el cupo lo fija solo un superadministrador y queda auditado', async () => {
    const t = await tenant();
    await denied(db, t.owner, `select public.admin_set_ai_quota($1, 5000)`, [t.org], /Solo para superadministradores/);
    await denied(db, root, `select public.admin_set_ai_quota($1, -1)`, [t.org], /no puede ser negativo/);

    await setAiQuota(db, root, t.org, 5000);
    await setAiQuota(db, root, t.org, 7000);
    const cupos = await as(db, t.owner, `select limit_value::int as n, updated_by from public.usage_quotas`);
    expect(cupos).toEqual([{ n: 7000, updated_by: root.id }]);

    const audit = await as(
      db,
      t.owner,
      `select action, actor_id, (data ->> 'limit_value')::int as n from public.audit_logs
       where entity_type = 'usage_quotas' order by id`,
    );
    expect(audit).toEqual([
      { action: 'insert', actor_id: root.id, n: 5000 },
      { action: 'update', actor_id: root.id, n: 7000 },
    ]);
  });

  it('ni siquiera la clave de servicio escribe a mano el libro de consumo', async () => {
    const t = await tenant(1000);
    const gen = await reserve(t, 100);
    const noTable = /permission denied for table/;
    await expect(
      asService(db, `update public.ai_usage set reserved_delta_micros = 0 where generation_id = $1`, [gen.id]),
    ).rejects.toThrow(noTable);
    await expect(asService(db, `delete from public.ai_usage where generation_id = $1`, [gen.id])).rejects.toThrow(
      noTable,
    );
    await expect(
      asService(db, `update public.ai_generations set cost_micros = 0 where id = $1`, [gen.id]),
    ).rejects.toThrow(noTable);
  });
});

describe('coste de IA por organización', () => {
  const cost = (user: TestUser, from = `now() - interval '1 hour'`, to = `now() + interval '1 hour'`) =>
    as<{ organization_id: string; organization_name: string | null; generations: number; cost_micros: number }>(
      db,
      user,
      `select organization_id, organization_name, generations::int as generations, cost_micros::int as cost_micros
       from public.ai_cost_by_organization(${from}, ${to})`,
    );

  let a: Tenant, b: Tenant;
  let editor: TestUser;

  beforeAll(async () => {
    a = await tenant(100_000);
    b = await tenant(100_000);
    editor = await createUser(db, 'editora@coste.test');
    await join(db, a.owner, editor, a.org, 'member', a.brand, 'editor');

    await complete((await reserve(a, 500)).id, 150);
    await complete((await reserve(a, 500)).id, 50);
    await fail((await reserve(a, 500)).id); // fallida: no cuesta
    await reserve(a, 500); // en curso: todavía no cuesta
    await complete((await reserve(b, 500)).id, 70);
  });

  it('suma el coste real de cada organización: ni reservas ni fallos', async () => {
    const rows = (await cost(root)).filter((r) => [a.org, b.org].includes(r.organization_id));
    expect(rows).toEqual([
      {
        organization_id: a.org,
        organization_name: expect.stringMatching(/^Organización/),
        generations: 2,
        cost_micros: 200,
      },
      {
        organization_id: b.org,
        organization_name: expect.stringMatching(/^Organización/),
        generations: 1,
        cost_micros: 70,
      },
    ]);
  });

  it('cada administrador ve solo el coste de su organización', async () => {
    expect(await cost(a.owner)).toEqual([
      { organization_id: a.org, organization_name: expect.any(String), generations: 2, cost_micros: 200 },
    ]);
    expect((await cost(b.owner)).map((r) => [r.organization_id, r.cost_micros])).toEqual([[b.org, 70]]);
    // Quien no administra la organización no ve costes, aunque genere contenido.
    expect(await cost(editor)).toEqual([]);
    await denied(db, null, `select * from public.ai_cost_by_organization(now() - interval '1 day', now())`);
  });

  it('respeta el periodo pedido', async () => {
    // Una de las dos generaciones de A pasa a haberse cerrado hace 40 días.
    await db.query(
      `update public.ai_usage set created_at = now() - interval '40 days'
       where id = (select min(id) from public.ai_usage where organization_id = $1 and entry = 'settle')`,
      [a.org],
    );
    expect((await cost(a.owner)).map((r) => [r.generations, r.cost_micros])).toEqual([[1, 50]]);
    expect(
      (await cost(a.owner, `now() - interval '60 days'`, `now() - interval '30 days'`)).map((r) => [
        r.generations,
        r.cost_micros,
      ]),
    ).toEqual([[1, 150]]);
    expect(
      (await cost(a.owner, `now() - interval '60 days'`, `now() + interval '1 hour'`)).map((r) => r.cost_micros),
    ).toEqual([200]);
    expect(await cost(a.owner, `now() - interval '90 days'`, `now() - interval '60 days'`)).toEqual([]);

    await denied(
      db,
      a.owner,
      `select * from public.ai_cost_by_organization(now(), now() - interval '1 day')`,
      [],
      /periodo válido/,
    );
  });

  it('el coste sobrevive al borrado de la marca y de la organización', async () => {
    await db.query(`delete from public.organizations where id = $1`, [b.org]);
    expect(await db.query(`select 1 from public.ai_generations where organization_id = $1`, [b.org])).toEqual([]);
    const row = (await cost(root)).find((r) => r.organization_id === b.org);
    expect(row).toEqual({ organization_id: b.org, organization_name: null, generations: 1, cost_micros: 70 });
  });
});
