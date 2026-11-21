// Planes, suscripciones y límites (Fase 6), contra las migraciones reales y con
// el plan por defecto de verdad («Prueba»). Aceptación de la fase: cambiar un
// plan cambia sus límites sin desplegar, y se sabe cuánto deja cada cliente.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  join,
  MIGRATIONS_DIR,
  serviceRpc,
  setAiQuota,
  type Db,
  type TestUser,
} from './helpers';

interface PgError {
  code?: string;
  message: string;
  detail?: string;
}

interface PlanUsage {
  plan: { code: string; name: string; max_brands: number | null; max_members: number | null; features: string[] };
  subscription: { source: string; status: string; assigned_plan_code: string | null };
  usage: { brands: number; members: number; pending_invitations: number; storage_bytes: number };
  ai_limit_micros: number;
  ai_limit_overridden: boolean;
}

let db: Db;
let root: TestUser;
let n = 0;
const planIds: Record<string, string> = {};

beforeAll(async () => {
  db = await createDb({ plans: 'real' });
  root = await createUser(db, 'root@plataforma.test', 'Root');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  for (const row of await db.query<{ code: string; id: string }>(`select code, id from public.plans`)) {
    planIds[row.code] = row.id;
  }
});

afterAll(async () => {
  await db?.close();
});

async function failure(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (error) {
    return error as PgError;
  }
  throw new Error('Se esperaba un error y la llamada terminó bien');
}

async function tenant(plan?: string) {
  n += 1;
  const owner = await createUser(db, `duena${n}@org${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  if (plan) await assign(org, plan);
  return { owner, org };
}

const assign = (org: string, plan: string | null, price: number | null = null) =>
  as(db, root, `select public.admin_set_organization_plan($1, $2, $3, 'prueba')`, [
    org,
    plan ? planIds[plan] : null,
    price,
  ]);

async function usage(user: TestUser, org: string): Promise<PlanUsage> {
  const [row] = await as<{ data: PlanUsage }>(db, user, `select public.organization_plan_usage($1) as data`, [org]);
  return row!.data;
}

const addBrand = (user: TestUser, org: string, name: string) =>
  as(db, user, `insert into public.brands (organization_id, name) values ($1, $2) returning id`, [org, name]);

async function invite(owner: TestUser, org: string, email: string) {
  const [row] = await as<{ token: string }>(db, owner, `select token from public.create_invitation($1, $2)`, [
    org,
    email,
  ]);
  return row!.token;
}

const asset = (user: TestUser, org: string, brand: string, bytes: number) =>
  as(
    db,
    user,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
     values ($1, $2, 'image', $2::uuid::text || '/' || $1::uuid::text || '/media/' || gen_random_uuid() || '.jpg', 'foto.jpg', 'image/jpeg', $3)
     returning id`,
    [brand, org, bytes],
  );

const reserve = (user: TestUser, brand: string, task = 'text', micros = 100) =>
  serviceRpc<{ id: string }>(db, 'ai_reserve_generation', {
    p_user_id: user.id,
    p_brand_id: brand,
    p_task: task,
    p_purpose: 'post.caption',
    p_provider: 'simulated',
    p_model: 'sim-1',
    p_reserve_micros: micros,
  });

describe('plan por defecto', () => {
  it('una organización nueva nace en «Prueba», con sus límites a la vista de su propietaria', async () => {
    const t = await tenant();
    const u = await usage(t.owner, t.org);
    expect(u.plan).toMatchObject({ code: 'trial', name: 'Prueba', max_brands: 1, max_members: 2 });
    expect(u.subscription).toMatchObject({ source: 'default', status: 'active', assigned_plan_code: null });
    expect(u.usage).toMatchObject({ brands: 0, members: 1, pending_invitations: 0, storage_bytes: 0 });
    expect(u.ai_limit_micros).toBe(0);
  });

  it('cambiar el plan por defecto cambia a la vez el de todas las organizaciones sin plan', async () => {
    const t = await tenant();
    await as(db, root, `select public.admin_set_default_plan($1)`, [planIds.basic]);
    try {
      expect((await usage(t.owner, t.org)).plan.code).toBe('basic');
    } finally {
      await as(db, root, `select public.admin_set_default_plan($1)`, [planIds.trial]);
    }
    expect((await usage(t.owner, t.org)).plan.code).toBe('trial');
    const [{ n: defaults }] = (await db.query(`select count(*)::int as n from public.plans where is_default`)) as [
      { n: number },
    ];
    expect(defaults).toBe(1);
  });

  it('el plan por defecto no se puede desactivar', async () => {
    await expect(as(db, root, `update public.plans set active = false where code = 'trial'`)).rejects.toThrow(
      /check constraint/,
    );
  });
});

describe('límites impuestos por la base de datos', () => {
  it('marcas: no se pasa del máximo; archivar libera plaza y desarchivar la vuelve a pedir', async () => {
    const t = await tenant();
    const [primera] = await addBrand(t.owner, t.org, 'Primera');
    const error = await failure(addBrand(t.owner, t.org, 'Segunda'));
    expect(error.code).toBe('PL001');
    expect(error.message).toMatch(/límite de marcas activas de tu plan «Prueba»: 1 de 1/);
    expect(JSON.parse(error.detail!)).toMatchObject({ limit: 'brands', used: 1, max: 1 });

    await as(db, t.owner, `update public.brands set status = 'archived' where id = $1`, [primera!.id]);
    await addBrand(t.owner, t.org, 'Segunda');
    const reabrir = await failure(
      as(db, t.owner, `update public.brands set status = 'active' where id = $1`, [primera!.id]),
    );
    expect(reabrir.code).toBe('PL001');
    // Una marca se puede crear ya archivada (importación), no ocupa plaza.
    await as(
      db,
      t.owner,
      `insert into public.brands (organization_id, name, status) values ($1, 'Archivo', 'archived')`,
      [t.org],
    );
  });

  it('personas: las invitaciones pendientes ocupan plaza; aceptar también comprueba el límite', async () => {
    const t = await tenant();
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const uno = await createUser(db, `uno${n}@x.test`);
    const dos = await createUser(db, `dos${n}@x.test`);
    const token = await invite(t.owner, t.org, uno.email);
    const error = await failure(invite(t.owner, t.org, dos.email));
    expect(error.code).toBe('PL001');
    expect(error.message).toMatch(/admite 2 personas: ya hay 1 en la organización y 1 invitaciones pendientes/);
    // Repetir la invitación a la misma persona no cuenta doble.
    await invite(t.owner, t.org, uno.email);
    await as(db, uno, `select public.accept_invitation($1)`, [token]);
    expect((await usage(t.owner, t.org)).usage.members).toBe(2);

    // Ya lleno: una invitación con rol de marca a quien ya es miembro sí se puede.
    const [porMarca] = await as<{ token: string }>(
      db,
      t.owner,
      `select token from public.create_invitation($1, $2, 'member', $3, 'editor')`,
      [t.org, uno.email, brand],
    );
    await as(db, uno, `select public.accept_invitation($1)`, [porMarca!.token]);

    // Si se baja el plan con invitaciones ya repartidas, aceptarlas también choca.
    await assign(t.org, 'professional');
    const tres = await createUser(db, `tres${n}@x.test`);
    const pendiente = await invite(t.owner, t.org, tres.email);
    await assign(t.org, 'trial');
    const aceptar = await failure(as(db, tres, `select public.accept_invitation($1)`, [pendiente]));
    expect(aceptar.code).toBe('PL001');
    expect(aceptar.message).toMatch(/límite de personas de tu plan «Prueba»: 2 de 2/);
  });

  it('almacenamiento: lo que sube una persona no puede pasar del plan; el servidor no tiene ese freno', async () => {
    const t = await tenant();
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    await asset(t.owner, t.org, brand, 400 * 1024 * 1024);
    const error = await failure(asset(t.owner, t.org, brand, 200 * 1024 * 1024));
    expect(error.code).toBe('PL001');
    expect(error.message).toMatch(/No queda espacio en tu plan «Prueba»: usas 400 MB de 500 MB/);
    await asset(t.owner, t.org, brand, 50 * 1024 * 1024);

    // Las fuentes de conocimiento cuentan igual.
    const fuente = await failure(
      as(
        db,
        t.owner,
        `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, storage_path, mime_type, bytes)
         values ($1, $2, 'pdf', 'Manual', $2::uuid::text || '/' || $1::uuid::text || '/fuentes/manual.pdf', 'application/pdf', $3)`,
        [brand, t.org, 100 * 1024 * 1024],
      ),
    );
    expect(fuente.code).toBe('PL001');

    // Lo que da de alta el servidor (resultados ya encargados) entra igualmente.
    await asService(
      db,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, created_by)
       values ($1, $2, 'video', $2::uuid::text || '/' || $1::uuid::text || '/reels/r.mp4', 'r.mp4', 'video/mp4', $3, $4)`,
      [brand, t.org, 100 * 1024 * 1024, t.owner.id],
    );
    // Pero con el espacio ya lleno no se encarga nada nuevo.
    await assign(t.org, 'professional');
    await assign(t.org, 'trial');
    const encargo = await failure(
      serviceRpc(db, 'enqueue_job', {
        p_organization_id: t.org,
        p_brand_id: brand,
        p_kind: 'media.image.process',
        p_payload: {},
        p_idempotency_key: `lleno-${n}`,
      }),
    );
    expect(encargo.code).toBe('PL001');
  });

  it('los reels son una función del plan', async () => {
    const t = await tenant('basic');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const reel = (key: string) =>
      serviceRpc(db, 'enqueue_job', {
        p_organization_id: t.org,
        p_brand_id: brand,
        p_kind: 'media.reel.template',
        p_payload: {},
        p_idempotency_key: key,
      });
    const error = await failure(reel(`reel-${n}`));
    expect(error.code).toBe('PL002');
    expect(error.message).toBe('Tu plan «Básico» no incluye los reels. Cambia de plan para usarlo.');
    await assign(t.org, 'professional');
    await reel(`reel-${n}-b`);
  });
});

describe('cambiar un plan cambia los límites sin desplegar', () => {
  it('asignar otro plan a una organización levanta o aprieta sus límites al momento', async () => {
    const t = await tenant();
    await createBrand(db, t.owner, t.org, 'Una');
    expect((await failure(addBrand(t.owner, t.org, 'Dos'))).code).toBe('PL001');
    await assign(t.org, 'professional');
    await addBrand(t.owner, t.org, 'Dos');
    await addBrand(t.owner, t.org, 'Tres');
    expect((await usage(t.owner, t.org)).plan.code).toBe('professional');
    // Volver al plan por defecto: lo que hay se queda, pero no se crea más.
    await assign(t.org, null);
    expect((await usage(t.owner, t.org)).subscription.source).toBe('default');
    expect((await failure(addBrand(t.owner, t.org, 'Cuatro'))).code).toBe('PL001');
  });

  it('editar un plan cambia los límites de todas las organizaciones que lo tienen', async () => {
    const a = await tenant('agency');
    const b = await tenant('agency');
    await as(db, root, `update public.plans set max_brands = 1 where code = 'agency'`);
    try {
      await createBrand(db, a.owner, a.org, 'A1');
      await createBrand(db, b.owner, b.org, 'B1');
      expect((await failure(addBrand(a.owner, a.org, 'A2'))).message).toMatch(/«Agencia»: 1 de 1/);
      expect((await failure(addBrand(b.owner, b.org, 'B2'))).code).toBe('PL001');
    } finally {
      await as(db, root, `update public.plans set max_brands = 25 where code = 'agency'`);
    }
    await addBrand(a.owner, a.org, 'A2');
    const [{ updated_by }] = (await db.query(`select updated_by from public.plans where code = 'agency'`)) as [
      { updated_by: string },
    ];
    expect(updated_by).toBe(root.id);
  });

  it('asignar un plan queda en el registro de actividad de la organización', async () => {
    const t = await tenant();
    await assign(t.org, 'enterprise', 950_000_000);
    const audit = await as(
      db,
      t.owner,
      `select actor_id, data ->> 'source' as source, (data ->> 'custom_price_micros')::bigint as price
       from public.audit_logs where entity_type = 'subscriptions' order by id desc limit 1`,
    );
    expect(audit).toEqual([{ actor_id: root.id, source: 'manual', price: 950_000_000 }]);
  });

  it('un plan desactivado no se asigna, pero quien ya lo tiene lo conserva', async () => {
    const t = await tenant('basic');
    await as(db, root, `update public.plans set active = false where code = 'basic'`);
    try {
      const otra = await tenant();
      expect((await failure(assign(otra.org, 'basic'))).message).toMatch(/desactivado/);
      expect((await usage(t.owner, t.org)).plan.code).toBe('basic');
    } finally {
      await as(db, root, `update public.plans set active = true where code = 'basic'`);
    }
  });
});

describe('cupo de IA: del plan, salvo que se sobrescriba', () => {
  it('sin IA en el plan no se genera; con un plan que la incluye, el cupo es el del plan', async () => {
    const t = await tenant();
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const sinIa = await failure(reserve(t.owner, brand));
    expect(sinIa.code).toBe('AI002');
    expect(sinIa.message).toMatch(/no tiene cupo de IA asignado: su plan «Prueba» no incluye IA/);

    await assign(t.org, 'basic');
    await reserve(t.owner, brand, 'text', 4_000_000);
    const agotado = await failure(reserve(t.owner, brand, 'text', 2_000_000));
    expect(agotado.code).toBe('AI001');
    expect(JSON.parse(agotado.detail!)).toMatchObject({ limit_micros: 5_000_000 });
  });

  it('las tareas de imagen y vídeo piden su función en el plan', async () => {
    const t = await tenant('basic');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const imagen = await failure(reserve(t.owner, brand, 'image'));
    expect(imagen.code).toBe('PL002');
    expect(imagen.message).toMatch(/no incluye la imagen con IA/);
    await assign(t.org, 'professional');
    await reserve(t.owner, brand, 'image');
    expect((await failure(reserve(t.owner, brand, 'video'))).message).toMatch(/no incluye el vídeo con IA/);
  });

  it('el superadministrador sobrescribe el cupo del plan y lo puede devolver al del plan', async () => {
    const t = await tenant('basic');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    await setAiQuota(db, root, t.org, 50);
    let u = await usage(t.owner, t.org);
    expect(u).toMatchObject({ ai_limit_micros: 50, ai_limit_overridden: true });
    expect((await failure(reserve(t.owner, brand, 'text', 100))).code).toBe('AI001');

    await as(db, root, `select public.admin_clear_ai_quota($1)`, [t.org]);
    u = await usage(t.owner, t.org);
    expect(u).toMatchObject({ ai_limit_micros: 5_000_000, ai_limit_overridden: false });
    await reserve(t.owner, brand, 'text', 100);
    const borrado = await as(
      db,
      t.owner,
      `select action from public.audit_logs where entity_type = 'usage_quotas' order by id`,
    );
    expect(borrado.map((r) => r.action)).toEqual(['insert', 'delete']);
  });

  it('un cupo sobrescrito también vale en un plan sin IA (se conserva lo de antes de los planes)', async () => {
    const t = await tenant();
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    await setAiQuota(db, root, t.org, 1000);
    await reserve(t.owner, brand, 'text', 500);
  });
});

describe('margen por cliente', () => {
  it('ingresos del plan del mes, coste de IA del mes y margen por organización', async () => {
    const pro = await tenant('professional');
    const pactado = await tenant();
    await assign(pactado.org, 'enterprise', 950_000_000);
    const prueba = await tenant();

    const brand = await createBrand(db, pro.owner, pro.org, 'Marca');
    const gen = await reserve(pro.owner, brand, 'text', 2_000_000);
    await serviceRpc(db, 'ai_complete_generation', { p_generation_id: gen.id, p_cost_micros: 1_250_000 });

    const month = new Date().toISOString().slice(0, 7) + '-01';
    const rows = await as<{
      organization_id: string;
      plan_code: string;
      monthly_revenue_micros: number;
      ai_cost_micros: number;
      margin_micros: number;
    }>(db, root, `select * from public.admin_billing_overview($1)`, [month]);
    const by = (org: string) => rows.find((r) => r.organization_id === org)!;
    expect(by(pro.org)).toMatchObject({
      plan_code: 'professional',
      monthly_revenue_micros: 79_000_000,
      ai_cost_micros: 1_250_000,
      margin_micros: 77_750_000,
    });
    expect(by(pactado.org)).toMatchObject({ plan_code: 'enterprise', monthly_revenue_micros: 950_000_000 });
    expect(by(prueba.org)).toMatchObject({ plan_code: 'trial', monthly_revenue_micros: 0, margin_micros: 0 });

    // Un mes sin coste.
    const [antes] = await as<{ ai_cost_micros: number }>(
      db,
      root,
      `select ai_cost_micros from public.admin_billing_overview('2020-01-01') where organization_id = $1`,
      [pro.org],
    );
    expect(antes!.ai_cost_micros).toBe(0);
    await expect(as(db, root, `select * from public.admin_billing_overview('2026-11-15')`)).rejects.toThrow(
      /primer día del mes/,
    );
  });

  it('un plan anual cuenta su doceava parte al mes', async () => {
    await as(
      db,
      root,
      `insert into public.plans (code, name, price_micros, billing_interval, ai_monthly_micros) values ('anual', 'Anual', 1200000000, 'year', 0)`,
    );
    const [plan] = await db.query<{ id: string }>(`select id from public.plans where code = 'anual'`);
    const t = await tenant();
    await as(db, root, `select public.admin_set_organization_plan($1, $2)`, [t.org, plan!.id]);
    const month = new Date().toISOString().slice(0, 7) + '-01';
    const [row] = await as<{ monthly_revenue_micros: number }>(
      db,
      root,
      `select monthly_revenue_micros from public.admin_billing_overview($1) where organization_id = $2`,
      [month, t.org],
    );
    expect(row!.monthly_revenue_micros).toBe(100_000_000);
  });
});

describe('suscripciones de Stripe (eventos simulados)', () => {
  const apply = (args: Record<string, unknown>) =>
    serviceRpc<{ result: string; reason?: string }>(db, 'billing_apply_stripe_event', args);

  it('alta, renovación, impago y cancelación; idempotente por evento', async () => {
    await db.query(`update public.plans set stripe_price_id = 'price_pro_test' where code = 'professional'`);
    const t = await tenant();
    const base = {
      p_event_type: 'customer.subscription.updated',
      p_organization_id: t.org,
      p_customer_id: 'cus_T1',
      p_subscription_id: 'sub_T1',
      p_price_id: 'price_pro_test',
      p_current_period_end: '2026-12-18T00:00:00Z',
    };
    expect(await apply({ ...base, p_event_id: 'evt_1', p_status: 'active' })).toMatchObject({ result: 'applied' });
    expect(await apply({ ...base, p_event_id: 'evt_1', p_status: 'canceled' })).toEqual({ result: 'duplicate' });
    let u = await usage(t.owner, t.org);
    expect(u.plan.code).toBe('professional');
    expect(u.subscription).toMatchObject({ source: 'stripe', status: 'active' });

    // Impago: Stripe reintenta; mientras, se conserva el plan.
    await apply({ ...base, p_event_id: 'evt_2', p_status: 'past_due' });
    u = await usage(t.owner, t.org);
    expect(u.plan.code).toBe('professional');
    expect(u.subscription.status).toBe('past_due');

    // Mientras paga con Stripe, no se le asigna un plan a mano.
    expect((await failure(assign(t.org, 'agency'))).message).toMatch(/paga con Stripe/);

    // Cancelada: vuelve al plan por defecto, y el plan contratado queda anotado.
    await apply({ ...base, p_event_id: 'evt_3', p_status: 'canceled' });
    u = await usage(t.owner, t.org);
    expect(u.plan.code).toBe('trial');
    expect(u.subscription).toMatchObject({ status: 'canceled', assigned_plan_code: 'professional' });
    const [{ outcome }] = (await db.query(`select outcome from public.billing_events where id = 'evt_3'`)) as [
      { outcome: string },
    ];
    expect(outcome).toBe('applied');

    // Ya cancelada, sí se le puede asignar un plan a mano.
    await assign(t.org, 'agency');
    expect((await usage(t.owner, t.org)).plan.code).toBe('agency');
  });

  it('lo que no reconoce lo anota como ignorado, sin fallar', async () => {
    const t = await tenant();
    expect(
      await apply({
        p_event_id: 'evt_desconocido',
        p_event_type: 'customer.subscription.updated',
        p_organization_id: t.org,
        p_customer_id: 'cus_T2',
        p_subscription_id: 'sub_T2',
        p_price_id: 'price_que_no_existe',
        p_status: 'active',
      }),
    ).toEqual({ result: 'ignored', reason: 'unknown_price' });
    expect(
      await apply({
        p_event_id: 'evt_sin_org',
        p_event_type: 'customer.subscription.updated',
        p_subscription_id: 'sub_nadie',
        p_price_id: 'price_pro_test',
        p_status: 'active',
      }),
    ).toEqual({ result: 'ignored', reason: 'organization_not_found' });
    expect(
      await apply({ p_event_id: 'evt_otro', p_event_type: 'charge.refunded', p_ignore_reason: 'unhandled_type' }),
    ).toEqual({ result: 'ignored', reason: 'unhandled_type' });
    expect((await usage(t.owner, t.org)).plan.code).toBe('trial');
  });

  it('una suscripción antigua que termina no le quita el plan a la vigente, y nadie roba otra', async () => {
    const t = await tenant();
    const base = {
      p_event_type: 'customer.subscription.updated',
      p_organization_id: t.org,
      p_customer_id: 'cus_T3',
      p_price_id: 'price_pro_test',
    };
    await apply({ ...base, p_event_id: 'evt_n1', p_subscription_id: 'sub_nueva', p_status: 'active' });
    expect(
      await apply({ ...base, p_event_id: 'evt_n2', p_subscription_id: 'sub_vieja', p_status: 'canceled' }),
    ).toEqual({ result: 'ignored', reason: 'stale_subscription' });
    expect((await usage(t.owner, t.org)).plan.code).toBe('professional');

    // La misma suscripción no puede acabar en otra organización.
    const otra = await tenant();
    expect(
      await apply({
        ...base,
        p_event_id: 'evt_n3',
        p_organization_id: otra.org,
        p_subscription_id: 'sub_nueva',
        p_status: 'active',
      }),
    ).toEqual({ result: 'ignored', reason: 'belongs_to_other_organization' });
    // Sin metadatos, se encuentra por la suscripción.
    expect(
      await apply({
        p_event_id: 'evt_n4',
        p_event_type: 'customer.subscription.updated',
        p_subscription_id: 'sub_nueva',
        p_customer_id: 'cus_T3',
        p_price_id: 'price_pro_test',
        p_status: 'past_due',
      }),
    ).toMatchObject({ result: 'applied', organization_id: t.org });
  });

  it('el contexto de pago solo se entrega a propietarios y administradores, y solo de planes en línea', async () => {
    const t = await tenant();
    const editor = await createUser(db, `editor${n}@x.test`);
    await assign(t.org, 'professional');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    await join(db, t.owner, editor, t.org, 'member', brand, 'editor');
    const ctx = await serviceRpc<Record<string, unknown>>(db, 'billing_checkout_context', {
      p_user_id: t.owner.id,
      p_organization_id: t.org,
      p_plan_code: 'professional',
    });
    expect(ctx).toMatchObject({ stripe_price_id: 'price_pro_test', stripe_subscription_active: false });
    expect(
      (await failure(serviceRpc(db, 'billing_checkout_context', { p_user_id: editor.id, p_organization_id: t.org })))
        .code,
    ).toBe('42501');
    expect(
      (
        await failure(
          serviceRpc(db, 'billing_checkout_context', {
            p_user_id: t.owner.id,
            p_organization_id: t.org,
            p_plan_code: 'enterprise',
          }),
        )
      ).message,
    ).toMatch(/no se puede contratar en línea/);
  });
});

describe('organizaciones que ya existían', () => {
  it('al aplicar la migración quedan en «Heredado», sin límites y con su cupo de IA de antes', async () => {
    const file = '20261119310000_plans_subscriptions.sql';
    const sql = (dir: string) => readFile(path.join(dir, file), 'utf8');
    const local = await createDb({ plans: 'real' });
    try {
      // Antes, la vuelta atrás de lo que se apoya en los planes (20261119710000).
      await local.exec(
        await readFile(path.join(MIGRATIONS_DIR, '../rollbacks/20261119710000_plan_publishing_storage.sql'), 'utf8'),
      );
      await local.exec(await sql(path.join(MIGRATIONS_DIR, '../rollbacks')));
      const owner = await createUser(local, 'antigua@a.test');
      const admin = await createUser(local, 'root@a.test');
      await local.query(`insert into public.platform_admins (user_id) values ($1)`, [admin.id]);
      const org = await createOrg(local, owner, 'Antigua');
      for (const name of ['M1', 'M2', 'M3']) await createBrand(local, owner, org, name);
      await as(local, admin, `select public.admin_set_ai_quota($1, 7000)`, [org]);

      await local.exec(await sql(MIGRATIONS_DIR));
      const [row] = await as<{ data: PlanUsage }>(local, owner, `select public.organization_plan_usage($1) as data`, [
        org,
      ]);
      expect(row!.data.plan.code).toBe('legacy');
      expect(row!.data.subscription.source).toBe('manual');
      expect(row!.data.usage.brands).toBe(3);
      expect(row!.data).toMatchObject({ ai_limit_micros: 7000, ai_limit_overridden: true });
      await createBrand(local, owner, org, 'M4');
    } finally {
      await local.close();
    }
  });
});

// Fases 3–6 juntas: lo que trajeron las otras ramas respeta el plan
// (20261119710000_plan_publishing_storage).
describe('publicación, tipografías y extracción frente al plan', () => {
  const connectAccount = (owner: TestUser, brand: string, externalId: string) =>
    serviceRpc<{ id: string }>(db, 'social_account_connect', {
      p_user_id: owner.id,
      p_brand_id: brand,
      p_network: 'instagram',
      p_external_id: externalId,
      p_username: 'cuenta',
      p_display_name: 'Cuenta',
      p_page_id: '1',
      p_scopes: ['instagram_basic'],
      p_token_expires_at: null,
      p_key_id: 'k1',
      p_access_token_ciphertext: 'c'.repeat(40),
      p_refresh_token_ciphertext: null,
    });

  const piece = async (owner: TestUser, org: string, brand: string) => {
    const [item] = await as<{ id: string }>(
      db,
      owner,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Pieza', 'instagram', 'post') returning id`,
      [brand, org],
    );
    return item!.id;
  };

  const schedule = (owner: TestUser, content: string, account: string | null) =>
    as<{ id: string; social_account_id: string | null }>(
      db,
      owner,
      `select id, social_account_id from public.save_publication(null, $1, now() + interval '1 day', $2)`,
      [content, account],
    );

  it('sin publicación en el plan no se conecta una cuenta ni se programa en ella; planificar sí', async () => {
    const t = await tenant('basic');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const begin = await failure(as(db, t.owner, `select public.social_oauth_begin($1, 'instagram')`, [brand]));
    expect(begin.code).toBe('PL002');
    expect(begin.message).toBe('Tu plan «Básico» no incluye la publicación en redes. Cambia de plan para usarlo.');
    // Ni el servidor da de alta la cuenta al volver de Meta.
    expect((await failure(connectAccount(t.owner, brand, `b-${n}`))).code).toBe('PL002');
    expect(await db.query(`select 1 from public.social_accounts where organization_id = $1`, [t.org])).toEqual([]);

    // Con un plan que la incluye, sí.
    await assign(t.org, 'professional');
    await as(db, t.owner, `select public.social_oauth_begin($1, 'instagram')`, [brand]);
    const account = (await connectAccount(t.owner, brand, `p-${n}`)).id;
    const content = await piece(t.owner, t.org, brand);
    const [armada] = await schedule(t.owner, content, account);
    expect(armada!.social_account_id).toBe(account);

    // Al bajar de plan: planificar sin cuenta sigue, programar en una cuenta no.
    await assign(t.org, 'basic');
    const otra = await piece(t.owner, t.org, brand);
    const [plan] = await schedule(t.owner, otra, null);
    expect(plan!.social_account_id).toBeNull();
    expect((await failure(schedule(t.owner, await piece(t.owner, t.org, brand), account))).code).toBe('PL002');
    const cambio = await failure(
      as(db, t.owner, `select public.save_publication($1, null, now() + interval '2 days', $2)`, [plan!.id, account]),
    );
    expect(cambio.code).toBe('PL002');
    // Mover la fecha de lo planificado no pide la función.
    await as(db, t.owner, `select public.reschedule_publication($1, now() + interval '3 days')`, [plan!.id]);
  });

  it('las tipografías de la marca cuentan en el espacio y no se suben si no caben', async () => {
    const t = await tenant('trial');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const font = (bytes: number, name: string) =>
      as(
        db,
        t.owner,
        `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type,
                                         bytes, license_confirmed)
         values ($1, $2, 'Marca Sans', 'woff2', $2::uuid::text || '/' || $1::uuid::text || '/fonts/' || $3 || '.woff2',
                 $3 || '.woff2', 'font/woff2', $4, true)`,
        [brand, t.org, name, bytes],
      );
    await font(4096, 'regular');
    expect((await usage(t.owner, t.org)).usage.storage_bytes).toBe(4096);
    // Casi lleno (500 MB del plan «Prueba»): la siguiente tipografía ya no cabe.
    await asset(t.owner, t.org, brand, 524288000 - 4096 - 1000);
    const error = await failure(font(2048, 'negrita'));
    expect(error.code).toBe('PL001');
    expect(error.message).toMatch(/No queda espacio en tu plan «Prueba»/);
  });

  it('sin espacio no se encarga la extracción de texto de una fuente', async () => {
    const t = await tenant('trial');
    const brand = await createBrand(db, t.owner, t.org, 'Marca');
    const extract = (key: string) =>
      serviceRpc(db, 'enqueue_job', {
        p_organization_id: t.org,
        p_brand_id: brand,
        p_kind: 'source.extract',
        p_payload: {},
        p_idempotency_key: key,
      });
    await extract(`extraer-${n}`);
    await asset(t.owner, t.org, brand, 524288000);
    expect((await failure(extract(`extraer-${n}-lleno`))).code).toBe('PL001');
  });
});
