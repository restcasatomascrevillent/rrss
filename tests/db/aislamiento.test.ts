// Aislamiento multi-tenant y permisos, contra las migraciones reales.
// Cada comprobación se hace con la identidad de un usuario (rol y JWT), igual
// que llegaría desde la API.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addAsset,
  as,
  asService,
  assetPath,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  serviceRpc,
  setAiQuota,
  type Db,
  type TestUser,
} from './helpers';

let db: Db;

// Organización A (empresa): ana es propietaria.
let ana: TestUser, adminA: TestUser, editorA: TestUser, clienteA: TestUser, sinMarcaA: TestUser, gestorA: TestUser;
// Organización B (otra empresa): berta es propietaria.
let berta: TestUser;
// Agencia: gema gestiona varias marcas; ana también está, pero solo de lectura en una.
let gema: TestUser;
let ajeno: TestUser, superadmin: TestUser;

let orgA: string, orgB: string, agencia: string;
let marcaA1: string, marcaA2: string, marcaB1: string, marcaG1: string, marcaG2: string;
let assetA1: string, assetB1: string;
// IA y cola de trabajos (Fase 2): una generación y un trabajo por organización.
let genA1: string, genB1: string, genG1: string;
let jobA1: string, jobOrgA: string, jobB1: string;
// Contenidos (Fase 2): una pieza con una versión guardada en cada marca.
let contentA1: string, contentA2: string, contentB1: string, contentG1: string;
// Encargos (modo agencia): uno por organización.
let requestA1: string, requestB1: string, requestG1: string;

const PROFILE = { business: { description: 'Negocio de prueba' } };

beforeAll(async () => {
  db = await createDb();

  ana = await createUser(db, 'ana@a.test', 'Ana');
  adminA = await createUser(db, 'admin@a.test', 'Admin A');
  editorA = await createUser(db, 'editor@a.test', 'Editor A');
  clienteA = await createUser(db, 'cliente@a.test', 'Cliente A');
  sinMarcaA = await createUser(db, 'sinmarca@a.test', 'Sin marca');
  gestorA = await createUser(db, 'gestor@a.test', 'Gestor A');
  berta = await createUser(db, 'berta@b.test', 'Berta');
  gema = await createUser(db, 'gema@agencia.test', 'Gema');
  ajeno = await createUser(db, 'ajeno@x.test', 'Ajeno');
  superadmin = await createUser(db, 'root@plataforma.test', 'Root');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [superadmin.id]);

  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  agencia = await createOrg(db, gema, 'Agencia G', 'agency');

  marcaA1 = await createBrand(db, ana, orgA, 'Marca A1');
  marcaA2 = await createBrand(db, ana, orgA, 'Marca A2');
  marcaB1 = await createBrand(db, berta, orgB, 'Marca B1');
  marcaG1 = await createBrand(db, gema, agencia, 'Cliente G1');
  marcaG2 = await createBrand(db, gema, agencia, 'Cliente G2');

  await join(db, ana, adminA, orgA, 'admin');
  await join(db, ana, editorA, orgA, 'member', marcaA1, 'editor');
  await join(db, ana, clienteA, orgA, 'member', marcaA1, 'client');
  await join(db, ana, gestorA, orgA, 'member', marcaA1, 'manager');
  await join(db, ana, sinMarcaA, orgA, 'member');
  await join(db, gema, ana, agencia, 'member', marcaG1, 'viewer');

  assetA1 = await addAsset(db, ana, orgA, marcaA1);
  await addAsset(db, ana, orgA, marcaA2);
  assetB1 = await addAsset(db, berta, orgB, marcaB1);
  await addAsset(db, gema, agencia, marcaG1);
  await addAsset(db, gema, agencia, marcaG2);

  await as(db, ana, `select public.save_brand_profile($1, $2::jsonb)`, [marcaA1, JSON.stringify(PROFILE)]);
  await as(db, berta, `select public.save_brand_profile($1, $2::jsonb)`, [marcaB1, JSON.stringify(PROFILE)]);
  await as(
    db,
    berta,
    `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, url) values ($1, $2, 'website', 'Web', 'https://b.test')`,
    [marcaB1, orgB],
  );
  // Tipografías de la marca (20261119211000): una en cada organización.
  for (const [user, org, brand] of [
    [ana, orgA, marcaA1],
    [berta, orgB, marcaB1],
  ] as const) {
    await as(
      db,
      user,
      `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type,
                                       bytes, license_confirmed)
       values ($1, $2, 'Propia', 'ttf', $3, 'propia.ttf', 'font/ttf', 1000, true)`,
      [brand, org, `${org}/${brand}/fonts/propia.ttf`],
    );
  }

  // Fase 2: cupo, generaciones (con su coste) y trabajos en cada organización.
  // Los escribe el servidor (clave de servicio); aquí se prueba quién los ve.
  for (const org of [orgA, orgB, agencia]) await setAiQuota(db, superadmin, org, 1_000_000);
  const generate = async (user: TestUser, brand: string, cost: number) => {
    const gen = await serviceRpc<{ id: string }>(db, 'ai_reserve_generation', {
      p_user_id: user.id,
      p_brand_id: brand,
      p_task: 'text',
      p_purpose: 'post.caption',
      p_provider: 'simulated',
      p_model: 'sim-text-1',
      p_reserve_micros: 5000,
    });
    await serviceRpc(db, 'ai_complete_generation', { p_generation_id: gen.id, p_cost_micros: cost });
    return gen.id;
  };
  genA1 = await generate(editorA, marcaA1, 1200);
  genB1 = await generate(berta, marcaB1, 3400);
  genG1 = await generate(gema, marcaG1, 500);

  const enqueue = async (org: string, brand: string | null, key: string) => {
    const job = await serviceRpc<{ id: string }>(db, 'enqueue_job', {
      p_organization_id: org,
      p_brand_id: brand,
      p_kind: 'media.render',
      p_payload: { pieza: key },
      p_idempotency_key: key,
    });
    return job.id;
  };
  jobA1 = await enqueue(orgA, marcaA1, 'a1');
  jobOrgA = await enqueue(orgA, null, 'org-a');
  jobB1 = await enqueue(orgB, marcaB1, 'b1');

  // Contenidos: una pieza con su primera versión en cada marca.
  const content = async (user: TestUser, org: string, brand: string) => {
    const [item] = await as<{ id: string }>(
      db,
      user,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Pieza', 'instagram', 'post') returning id`,
      [brand, org],
    );
    await as(db, user, `select public.save_content_version($1, '{"schemaVersion":1}'::jsonb, 1)`, [item!.id]);
    return item!.id;
  };
  contentA1 = await content(editorA, orgA, marcaA1);
  contentA2 = await content(ana, orgA, marcaA2);
  contentB1 = await content(berta, orgB, marcaB1);
  contentG1 = await content(gema, agencia, marcaG1);

  // Encargos: uno pedido en cada organización.
  const request = async (user: TestUser, brand: string) => {
    const [row] = await as<{ id: string }>(
      db,
      user,
      `select id from public.create_content_request($1, 'Encargo', 'Texto del encargo', 'instagram', 'post')`,
      [brand],
    );
    return row!.id;
  };
  requestA1 = await request(clienteA, marcaA1);
  requestB1 = await request(berta, marcaB1);
  requestG1 = await request(gema, marcaG1);
});

afterAll(async () => {
  await db?.close();
});

const TENANT_TABLES = [
  'profiles',
  'platform_admins',
  'organizations',
  'organization_members',
  'brands',
  'brand_members',
  'brand_profiles',
  'brand_knowledge_sources',
  'brand_fonts',
  'media_assets',
  'storage_cleanup_queue',
  'invitations',
  'audit_logs',
  'usage_quotas',
  'ai_generations',
  'ai_usage',
  'jobs',
  'content_items',
  'content_versions',
  'content_requests',
  'content_request_comments',
  'request_notifications',
  // Publicación (Fase 3).
  'social_accounts',
  'content_comments',
  'scheduled_publications',
  'publication_attempts',
  'subscriptions',
  'billing_events',
  'campaigns',
  'campaign_plans',
  'campaign_contents',
  'legal_acceptances',
  // Analítica (Fase 5).
  'account_metrics_daily',
  'media_metrics_daily',
  'analytics_capture_runs',
  'analytics_reports',
  // Biblioteca con Google Drive.
  'drive_connections',
  // Importar publicaciones de la cuenta y plantillas de diseño.
  'social_import_runs',
  'social_imported_media',
  'brand_design_templates',
];

// Catálogos de la plataforma: no son de ningún cliente. Los lee cualquier
// usuario con sesión y solo los escribe un superadministrador.
const PLATFORM_TABLES = ['ai_media_models', 'plans', 'analytics_metric_definitions'];

describe('catálogo: nada queda abierto por olvido', () => {
  it('todas las tablas de public tienen RLS activado', async () => {
    const rows = await db.query<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('las tablas probadas aquí son todas las que existen', async () => {
    const rows = await db.query<{ relname: string }>(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...TENANT_TABLES, ...PLATFORM_TABLES].sort());
  });

  it('anon no tiene ningún privilegio sobre tablas ni funciones', async () => {
    const tables = await db.query(
      `select c.relname, p.priv from pg_class c
       cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_table_privilege('anon', c.oid, p.priv)`,
    );
    expect(tables).toEqual([]);
    const functions = await db.query(
      `select p.proname from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    expect(functions).toEqual([]);
  });

  it('las funciones SECURITY DEFINER fijan search_path', async () => {
    const rows = await db.query(
      `select p.proname from pg_proc p
       where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(rows).toEqual([]);
  });

  it('anon no puede leer ninguna tabla ni crear organizaciones', async () => {
    for (const table of [...TENANT_TABLES, ...PLATFORM_TABLES]) {
      await denied(db, null, `select * from public.${table}`);
    }
    await denied(db, null, `select public.create_organization('X')`);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('cada propietaria solo ve su organización y sus marcas', async () => {
    const orgsBerta = await as(db, berta, `select id from public.organizations`);
    expect(orgsBerta.map((r) => r.id)).toEqual([orgB]);
    const marcasBerta = await as(db, berta, `select id from public.brands`);
    expect(marcasBerta.map((r) => r.id)).toEqual([marcaB1]);

    const marcasAna = await as(db, ana, `select id from public.brands order by name`);
    // Ana ve sus dos marcas y la marca de la agencia donde es lectora; nunca la de B ni G2.
    expect(marcasAna.map((r) => r.id).sort()).toEqual([marcaA1, marcaA2, marcaG1].sort());
  });

  it('un usuario sin organizaciones no ve nada', async () => {
    for (const table of TENANT_TABLES.filter((t) => t !== 'profiles')) {
      expect(await as(db, ajeno, `select * from public.${table}`), table).toEqual([]);
    }
    const perfiles = await as(db, ajeno, `select user_id from public.profiles`);
    expect(perfiles.map((r) => r.user_id)).toEqual([ajeno.id]);
  });

  it('ninguna tabla deja ver filas de la otra organización', async () => {
    for (const table of [
      'organization_members',
      'brands',
      'brand_members',
      'brand_profiles',
      'brand_knowledge_sources',
      'brand_fonts',
      'media_assets',
      'invitations',
      'audit_logs',
      'usage_quotas',
      'ai_generations',
      'ai_usage',
      'jobs',
      'content_items',
      'content_versions',
      'content_requests',
      'content_request_comments',
      'request_notifications',
      'subscriptions',
      'campaigns',
      'campaign_plans',
      'campaign_contents',
    ]) {
      const column = table === 'brands' ? 'organization_id' : 'organization_id';
      const rows = await as(db, berta, `select distinct ${column}::text as org from public.${table}`);
      expect(
        rows.map((r) => r.org).filter((o) => o !== orgB),
        table,
      ).toEqual([]);
    }
    // Y al revés: B tiene filas que A no ve.
    expect(await as(db, ana, `select 1 from public.media_assets where id = $1`, [assetB1])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.brand_profiles where brand_id = $1`, [marcaB1])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.brand_knowledge_sources where brand_id = $1`, [marcaB1])).toEqual(
      [],
    );
    expect(await as(db, ana, `select 1 from public.organizations where id = $1`, [orgB])).toEqual([]);
  });

  it('no se puede escribir en la organización ajena', async () => {
    await denied(db, ana, `insert into public.brands (organization_id, name) values ($1, 'Intrusa')`, [orgB]);
    await denied(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
      [marcaB1, orgB, assetPath(orgB, marcaB1)],
    );
    await denied(
      db,
      ana,
      `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, url) values ($1, $2, 'website', 'x', 'https://x.test')`,
      [marcaB1, orgB],
    );
    await denied(db, ana, `select public.save_brand_profile($1, '{}'::jsonb)`, [marcaB1]);
    await denied(db, ana, `select * from public.create_invitation($1, 'x@x.test')`, [orgB]);
    await denied(
      db,
      ana,
      `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type,
                                       bytes, license_confirmed)
       values ($1, $2, 'Intrusa', 'ttf', $3, 'x.ttf', 'font/ttf', 1, true)`,
      [marcaB1, orgB, `${orgB}/${marcaB1}/fonts/intrusa.ttf`],
    );
    expect(await as(db, ana, `select 1 from public.brand_fonts where brand_id = $1`, [marcaB1])).toEqual([]);
    expect(await as(db, ana, `delete from public.brand_fonts where brand_id = $1 returning id`, [marcaB1])).toEqual([]);
    await denied(db, ana, `select * from public.brand_reel_font_info($1)`, [marcaB1], /No tienes acceso/);
    const [fuenteB] = await db.query<{ id: string }>(
      `select id from public.brand_knowledge_sources where brand_id = $1`,
      [marcaB1],
    );
    await denied(db, ana, `select public.request_source_extraction($1)`, [fuenteB!.id], /No tienes permiso/);

    // UPDATE y DELETE sobre filas ajenas no fallan: sencillamente no encuentran nada.
    expect(await as(db, ana, `update public.brands set name = 'Robada' where id = $1 returning id`, [marcaB1])).toEqual(
      [],
    );
    expect(
      await as(db, ana, `update public.organizations set name = 'Robada' where id = $1 returning id`, [orgB]),
    ).toEqual([]);
    expect(await as(db, ana, `delete from public.media_assets where id = $1 returning id`, [assetB1])).toEqual([]);
    const [marca] = await db.query(`select name from public.brands where id = $1`, [marcaB1]);
    expect(marca!.name).toBe('Marca B1');
  });

  it('una marca no se puede mover de organización ni mezclar con otra', async () => {
    // organization_id no es una columna que el cliente pueda actualizar.
    await denied(db, ana, `update public.brands set organization_id = $1 where id = $2`, [orgB, marcaA1]);
    // Un recurso de mi marca no puede declararse de otra organización (FK compuesta).
    await denied(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
      [marcaA1, orgB, assetPath(orgB, marcaA1)],
      /foreign key|row-level security/i,
    );
    // Ni guardarse en la ruta de otra marca.
    await denied(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
      [marcaA1, orgA, assetPath(orgB, marcaB1)],
      /check constraint/i,
    );
  });

  it('las organizaciones solo se crean con la RPC y no se borran desde el cliente', async () => {
    await denied(db, ana, `insert into public.organizations (name) values ('Directa')`);
    await denied(
      db,
      ana,
      `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')`,
      [orgB, ana.id],
    );
    await denied(db, ana, `delete from public.organizations where id = $1`, [orgA]);
    await denied(db, ana, `delete from public.brands where id = $1`, [marcaA1]);
  });

  it('los perfiles de usuario solo se ven entre compañeros de organización', async () => {
    const vistos = await as(db, berta, `select email from public.profiles`);
    expect(vistos.map((r) => r.email)).toEqual([berta.email]);
    const deAna = (await as(db, ana, `select email from public.profiles`)).map((r) => r.email);
    expect(deAna).toContain(editorA.email);
    expect(deAna).toContain(gema.email); // comparten la agencia
    expect(deAna).not.toContain(berta.email);

    expect(
      await as(db, ana, `update public.profiles set full_name = 'Hack' where user_id = $1 returning user_id`, [
        editorA.id,
      ]),
    ).toEqual([]);
    await denied(db, ana, `update public.profiles set email = 'otra@a.test' where user_id = $1`, [ana.id]);
  });
});

describe('roles dentro de una organización', () => {
  it('un miembro sin marcas no ve ninguna marca ni su contenido', async () => {
    expect(await as(db, sinMarcaA, `select id from public.brands`)).toEqual([]);
    expect(await as(db, sinMarcaA, `select id from public.media_assets`)).toEqual([]);
    expect(await as(db, sinMarcaA, `select id from public.brand_profiles`)).toEqual([]);
    // Pero sí sabe a qué organización pertenece.
    expect((await as(db, sinMarcaA, `select id from public.organizations`)).map((r) => r.id)).toEqual([orgA]);
  });

  it('el editor ve solo su marca; edita la biblioteca pero no la configuración', async () => {
    expect((await as(db, editorA, `select id from public.brands`)).map((r) => r.id)).toEqual([marcaA1]);
    const id = await addAsset(db, editorA, orgA, marcaA1);
    expect(
      await as(db, editorA, `update public.media_assets set tags = '{nuevo}' where id = $1 returning id`, [id]),
    ).toHaveLength(1);

    expect(
      await as(db, editorA, `update public.brands set name = 'Cambiada' where id = $1 returning id`, [marcaA1]),
    ).toEqual([]);
    await denied(db, editorA, `select public.save_brand_profile($1, '{}'::jsonb)`, [marcaA1]);
    await denied(
      db,
      editorA,
      `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, url) values ($1, $2, 'website', 'x', 'https://x.test')`,
      [marcaA1, orgA],
    );
    // La otra marca de su propia organización también le está vedada.
    await denied(
      db,
      editorA,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
      [marcaA2, orgA, assetPath(orgA, marcaA2)],
    );
    await denied(db, editorA, `insert into public.brands (organization_id, name) values ($1, 'Nueva')`, [orgA]);
  });

  it('el cliente ve su marca pero no escribe nada', async () => {
    expect(await as(db, clienteA, `select id from public.media_assets where id = $1`, [assetA1])).toHaveLength(1);
    await denied(
      db,
      clienteA,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
      [marcaA1, orgA, assetPath(orgA, marcaA1)],
    );
    expect(await as(db, clienteA, `delete from public.media_assets where id = $1 returning id`, [assetA1])).toEqual([]);
    expect(await as(db, clienteA, `select id from public.audit_logs`)).toEqual([]);
    expect(await as(db, clienteA, `select id from public.invitations`)).toEqual([]);
  });

  it('nadie se sube el rol a sí mismo', async () => {
    expect(
      await as(db, editorA, `update public.brand_members set role = 'manager' where user_id = $1 returning user_id`, [
        editorA.id,
      ]),
    ).toEqual([]);
    await denied(
      db,
      editorA,
      `insert into public.brand_members (brand_id, organization_id, user_id, role) values ($1, $2, $3, 'manager')`,
      [marcaA2, orgA, editorA.id],
    );
    await denied(db, editorA, `select public.set_member_role($1, $2, 'admin')`, [orgA, editorA.id]);
    await denied(db, editorA, `update public.organization_members set role = 'owner' where user_id = $1`, [editorA.id]);
  });

  it('el gestor de una marca gestiona su equipo, pero solo con miembros de la organización', async () => {
    expect(
      await as(
        db,
        gestorA,
        `insert into public.brand_members (brand_id, organization_id, user_id, role) values ($1, $2, $3, 'viewer') returning user_id`,
        [marcaA1, orgA, sinMarcaA.id],
      ),
    ).toHaveLength(1);
    await as(db, gestorA, `delete from public.brand_members where brand_id = $1 and user_id = $2`, [
      marcaA1,
      sinMarcaA.id,
    ]);

    // berta no es de la organización A: la FK lo impide aunque el gestor tenga permiso.
    await denied(
      db,
      gestorA,
      `insert into public.brand_members (brand_id, organization_id, user_id, role) values ($1, $2, $3, 'viewer')`,
      [marcaA1, orgA, berta.id],
      /foreign key/i,
    );
    // Y no gestiona la otra marca.
    await denied(
      db,
      gestorA,
      `insert into public.brand_members (brand_id, organization_id, user_id, role) values ($1, $2, $3, 'viewer')`,
      [marcaA2, orgA, sinMarcaA.id],
    );
  });

  it('el administrador gestiona todas las marcas pero no a los propietarios', async () => {
    expect((await as(db, adminA, `select id from public.brands`)).map((r) => r.id).sort()).toEqual(
      [marcaA1, marcaA2].sort(),
    );
    await denied(db, adminA, `select public.set_member_role($1, $2, 'member')`, [orgA, ana.id]);
    await denied(db, adminA, `select public.set_member_role($1, $2, 'owner')`, [orgA, adminA.id]);
    await denied(db, adminA, `select public.remove_member($1, $2)`, [orgA, ana.id]);
    await denied(db, adminA, `select * from public.create_invitation($1, 'jefe@a.test', 'owner')`, [orgA]);
  });

  it('la organización nunca se queda sin propietario', async () => {
    await denied(db, ana, `select public.remove_member($1, $2)`, [orgA, ana.id], /al menos un propietario/);
    await denied(db, ana, `select public.set_member_role($1, $2, 'admin')`, [orgA, ana.id], /al menos un propietario/);
  });

  it('un mismo usuario tiene permisos distintos en cada organización', async () => {
    // Ana es propietaria de A y solo lectora de una marca de la agencia.
    expect(await as(db, ana, `select id from public.brands where organization_id = $1`, [agencia])).toHaveLength(1);
    await denied(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1)`,
      [marcaG1, agencia, assetPath(agencia, marcaG1)],
    );
    await denied(db, ana, `insert into public.brands (organization_id, name) values ($1, 'Colada')`, [agencia]);
    expect(await as(db, ana, `select id from public.audit_logs where organization_id = $1`, [agencia])).toEqual([]);
    // Y la agencia no ve nada de la empresa A.
    expect(await as(db, gema, `select id from public.brands where organization_id = $1`, [orgA])).toEqual([]);
  });

  it('al salir de la organización se pierden también las marcas', async () => {
    const temporal = await createUser(db, 'temporal@a.test');
    await join(db, ana, temporal, orgA, 'member', marcaA1, 'editor');
    expect(await as(db, temporal, `select id from public.brands`)).toHaveLength(1);
    await as(db, ana, `select public.remove_member($1, $2)`, [orgA, temporal.id]);
    expect(await as(db, temporal, `select id from public.brands`)).toEqual([]);
    expect(await db.query(`select 1 from public.brand_members where user_id = $1`, [temporal.id])).toEqual([]);
  });
});

describe('perfil de marca versionado', () => {
  it('cada guardado crea una versión y solo una queda vigente', async () => {
    const marca = await createBrand(db, ana, orgA, 'Versionada');
    for (const n of [1, 2, 3]) {
      await as(db, ana, `select public.save_brand_profile($1, $2::jsonb, '{}'::jsonb, $3)`, [
        marca,
        JSON.stringify({ n }),
        `v${n}`,
      ]);
    }
    const versiones = await as(
      db,
      ana,
      `select version, status, data from public.brand_profiles where brand_id = $1 order by version`,
      [marca],
    );
    expect(versiones.map((v) => [v.version, v.status])).toEqual([
      [1, 'archived'],
      [2, 'archived'],
      [3, 'active'],
    ]);
    expect(versiones[0]!.data).toEqual({ n: 1 }); // las versiones antiguas no se pierden
  });

  it('el historial no se puede reescribir desde el cliente', async () => {
    await denied(
      db,
      ana,
      `insert into public.brand_profiles (brand_id, organization_id, version, data) values ($1, $2, 99, '{}')`,
      [marcaA1, orgA],
    );
    await denied(db, ana, `update public.brand_profiles set data = '{}' where brand_id = $1`, [marcaA1]);
    await denied(db, ana, `delete from public.brand_profiles where brand_id = $1`, [marcaA1]);
  });
});

describe('invitaciones', () => {
  it('el token solo sirve a la cuenta invitada, una vez', async () => {
    const invitado = await createUser(db, 'nuevo@a.test');
    const [inv] = await as<{ token: string }>(
      db,
      ana,
      `select token from public.create_invitation($1, 'Nuevo@A.test')`,
      [orgA],
    );
    const token = inv!.token;

    // Nadie puede leer la huella y el token no está guardado en claro.
    const guardado = await db.query(`select token_hash from public.invitations where token_hash = $1`, [token]);
    expect(guardado).toEqual([]);

    await denied(db, ajeno, `select public.accept_invitation($1)`, [token], /otra dirección/);
    await denied(db, ajeno, `select public.accept_invitation('token-inventado')`, [], /no existe/);
    expect(await as(db, ajeno, `select id from public.organizations`)).toEqual([]);

    await as(db, invitado, `select public.accept_invitation($1)`, [token]);
    expect((await as(db, invitado, `select id from public.organizations`)).map((r) => r.id)).toEqual([orgA]);
    await denied(db, invitado, `select public.accept_invitation($1)`, [token], /ya no es válida/);
  });

  it('una invitación caducada o anulada no vale', async () => {
    const tarde = await createUser(db, 'tarde@a.test');
    const [caducada] = await as<{ token: string; invitation_id: string }>(
      db,
      ana,
      `select invitation_id, token from public.create_invitation($1, $2)`,
      [orgA, tarde.email],
    );
    await db.query(`update public.invitations set expires_at = now() - interval '1 minute' where id = $1`, [
      caducada!.invitation_id,
    ]);
    await denied(db, tarde, `select public.accept_invitation($1)`, [caducada!.token], /ya no es válida/);

    const [anulada] = await as<{ token: string; invitation_id: string }>(
      db,
      ana,
      `select invitation_id, token from public.create_invitation($1, $2)`,
      [orgA, tarde.email],
    );
    await denied(db, berta, `select public.revoke_invitation($1)`, [anulada!.invitation_id], /No se puede anular/);
    await as(db, ana, `select public.revoke_invitation($1)`, [anulada!.invitation_id]);
    await denied(db, tarde, `select public.accept_invitation($1)`, [anulada!.token], /ya no es válida/);
    expect(await as(db, tarde, `select id from public.organizations`)).toEqual([]);
  });

  it('quién puede invitar y a qué', async () => {
    await denied(db, editorA, `select * from public.create_invitation($1, 'x@x.test')`, [orgA]);
    await denied(db, clienteA, `select * from public.create_invitation($1, 'x@x.test', 'member', $2, 'viewer')`, [
      orgA,
      marcaA1,
    ]);
    // El gestor de A1 invita a su marca, pero no a otra ni como administrador.
    expect(
      await as(db, gestorA, `select token from public.create_invitation($1, 'x@x.test', 'member', $2, 'client')`, [
        orgA,
        marcaA1,
      ]),
    ).toHaveLength(1);
    await denied(db, gestorA, `select * from public.create_invitation($1, 'x@x.test', 'member', $2, 'client')`, [
      orgA,
      marcaA2,
    ]);
    await denied(db, gestorA, `select * from public.create_invitation($1, 'x@x.test', 'admin', $2, 'client')`, [
      orgA,
      marcaA1,
    ]);
    await denied(db, gestorA, `select * from public.create_invitation($1, 'x@x.test')`, [orgA]);
    // No se puede invitar a una marca de otra organización.
    await denied(
      db,
      ana,
      `select * from public.create_invitation($1, 'x@x.test', 'member', $2, 'viewer')`,
      [orgA, marcaB1],
      /no pertenece/,
    );
  });

  it('aceptar una invitación no cambia el rol de quien ya era miembro', async () => {
    const [inv] = await as<{ token: string }>(db, ana, `select token from public.create_invitation($1, $2, 'admin')`, [
      orgA,
      editorA.email,
    ]);
    await as(db, editorA, `select public.accept_invitation($1)`, [inv!.token]);
    const [fila] = await db.query(
      `select role from public.organization_members where organization_id = $1 and user_id = $2`,
      [orgA, editorA.id],
    );
    expect(fila!.role).toBe('member');
  });

  it('la actividad registra las altas de una invitación como tales, y solo en esa transacción', async () => {
    const nueva = await createUser(db, 'actividad@a.test');
    const [inv] = await as<{ token: string; invitation_id: string }>(
      db,
      ana,
      `select invitation_id, token from public.create_invitation($1, $2, 'member', $3, 'editor')`,
      [orgA, nueva.email, marcaA1],
    );
    await as(db, nueva, `select public.accept_invitation($1)`, [inv!.token]);
    const filas = await db.query<{ entity_type: string; actor_id: string; via: string | null }>(
      `select entity_type, actor_id, data ->> 'via' as via from public.audit_logs
       where actor_id = $1 order by id`,
      [nueva.id],
    );
    expect(filas.map((f) => [f.entity_type, f.via])).toEqual([
      ['organization_members', 'invitation'],
      ['brand_members', 'invitation'],
      ['invitations', 'invitation'],
    ]);
    // La marca no se queda pegada: lo siguiente que se registra no la lleva.
    await as(db, ana, `select * from public.create_invitation($1, 'otra-mas@a.test')`, [orgA]);
    const [siguiente] = await db.query<{ via: string | null }>(
      `select data ->> 'via' as via from public.audit_logs where actor_id = $1 order by id desc limit 1`,
      [ana.id],
    );
    expect(siguiente!.via).toBeNull();
  });
});

describe('almacenamiento', () => {
  const insert = `insert into storage.objects (bucket_id, name) values ('brand-media', $1) returning id`;

  it('solo se sube a la ruta de una marca propia con permiso de edición', async () => {
    expect(await as(db, ana, insert, [assetPath(orgA, marcaA1)])).toHaveLength(1);
    expect(await as(db, editorA, insert, [assetPath(orgA, marcaA1)])).toHaveLength(1);

    await denied(db, ana, insert, [assetPath(orgB, marcaB1)]);
    await denied(db, editorA, insert, [assetPath(orgA, marcaA2)]);
    await denied(db, clienteA, insert, [assetPath(orgA, marcaA1)]);
    await denied(db, ajeno, insert, [assetPath(orgA, marcaA1)]);
  });

  it('rechaza rutas trucadas', async () => {
    // Organización propia + marca ajena, y al revés.
    await denied(db, ana, insert, [assetPath(orgA, marcaB1)]);
    await denied(db, ana, insert, [assetPath(orgB, marcaA1)]);
    for (const name of [
      'suelto.jpg',
      `${orgA}/suelto.jpg`,
      `${orgA}/${marcaA1}`,
      `${orgA}/${marcaA1}/`,
      `../${orgA}/${marcaA1}/x.jpg`,
      `no-es-uuid/tampoco/x.jpg`,
      `${orgA.toUpperCase()}/${marcaA1}/x.jpg`,
    ]) {
      await denied(db, ana, insert, [name]);
    }
    await denied(
      db,
      ana,
      `insert into storage.objects (bucket_id, name) values ('otro-cubo', $1)`,
      [assetPath(orgA, marcaA1)],
      /row-level security|foreign key/i,
    );
  });

  it('nadie ve ni borra los archivos de otra organización', async () => {
    const ruta = assetPath(orgB, marcaB1);
    await as(db, berta, insert, [ruta]);
    expect(await as(db, ana, `select name from storage.objects where name = $1`, [ruta])).toEqual([]);
    expect(await as(db, ana, `delete from storage.objects where name = $1 returning id`, [ruta])).toEqual([]);
    expect(
      await as(db, ana, `update storage.objects set name = $2 where name = $1 returning id`, [
        ruta,
        assetPath(orgA, marcaA1),
      ]),
    ).toEqual([]);
    const nombres = await as(db, ana, `select name from storage.objects`);
    expect(nombres.every((r) => String(r.name).startsWith(orgA) || String(r.name).startsWith(agencia))).toBe(true);
    // El cliente lee los de su marca.
    expect((await as(db, clienteA, `select name from storage.objects`)).length).toBeGreaterThan(0);
  });

  it('un archivo propio no se puede mover a la ruta de otra organización', async () => {
    const ruta = assetPath(orgA, marcaA1);
    await as(db, ana, insert, [ruta]);
    await denied(db, ana, `update storage.objects set name = $2 where name = $1`, [ruta, assetPath(orgB, marcaB1)]);
  });
});

describe('limpieza de archivos huérfanos', () => {
  const cola = `select storage_path from public.storage_cleanup_queue where storage_path = $1`;

  it('al borrar un recurso su ruta queda anotada, y solo la ve quien edita esa marca', async () => {
    const [creado] = await as<{ id: string }>(
      db,
      editorA,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'adios.jpg', 'image/jpeg', 10) returning id`,
      [marcaA1, orgA, assetPath(orgA, marcaA1, 'adios.jpg')],
    );
    const ruta = assetPath(orgA, marcaA1, 'adios.jpg');
    expect(
      await as(db, editorA, `delete from public.media_assets where id = $1 returning id`, [creado!.id]),
    ).toHaveLength(1);

    expect(await as(db, editorA, cola, [ruta])).toHaveLength(1);
    expect(await as(db, ana, cola, [ruta])).toHaveLength(1);
    // Ni otra organización, ni el cliente (solo lectura), ni quien no tiene la marca.
    expect(await as(db, berta, cola, [ruta])).toEqual([]);
    expect(await as(db, clienteA, cola, [ruta])).toEqual([]);
    expect(await as(db, sinMarcaA, cola, [ruta])).toEqual([]);
    expect(await as(db, superadmin, cola, [ruta])).toEqual([]);
  });

  it('el cliente no escribe en la cola: ni altas, ni cambios ni borrados', async () => {
    const ruta = assetPath(orgA, marcaA1, 'fantasma.jpg');
    for (const user of [ana, editorA, clienteA, berta]) {
      await denied(
        db,
        user,
        `insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path) values ($1, $2, $3)`,
        [orgA, marcaA1, ruta],
      );
      await denied(db, user, `update public.storage_cleanup_queue set storage_path = 'x'`);
    }
    await denied(db, null, `select * from public.storage_cleanup_queue`);
  });

  it('quien edita la marca limpia sus anotaciones; los demás no pueden', async () => {
    const ruta = assetPath(orgA, marcaA1, 'limpiar.jpg');
    await db.query(
      `insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path) values ($1, $2, $3)`,
      [orgA, marcaA1, ruta],
    );
    expect(
      await as(db, clienteA, `delete from public.storage_cleanup_queue where storage_path = $1 returning id`, [ruta]),
    ).toEqual([]);
    expect(
      await as(db, berta, `delete from public.storage_cleanup_queue where storage_path = $1 returning id`, [ruta]),
    ).toEqual([]);
    expect(
      await as(db, editorA, `delete from public.storage_cleanup_queue where storage_path = $1 returning id`, [ruta]),
    ).toHaveLength(1);
  });

  it('al borrar la marca entera también se anotan sus archivos', async () => {
    const marca = await createBrand(db, ana, orgA, 'Marca efímera');
    const ruta = assetPath(orgA, marca, 'cascada.jpg');
    await as(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'c.jpg', 'image/jpeg', 1)`,
      [marca, orgA, ruta],
    );
    await db.query(`delete from public.brands where id = $1`, [marca]);
    expect(await db.query(cola, [ruta])).toHaveLength(1);
    // Con la marca ya borrada nadie del cliente la ve: la barre el servidor.
    expect(await as(db, ana, cola, [ruta])).toEqual([]);
  });
});

describe('filtros de la biblioteca', () => {
  it('asset_facets devuelve todas las etiquetas y carpetas de la marca, sin pasar por el límite de 1.000', async () => {
    const marca = await createBrand(db, ana, orgA, 'Marca de filtros');
    await as(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, folder, tags)
       select $1::uuid, $2::uuid, 'image', $2::text || '/' || $1::text || '/media/f' || n || '.jpg', 'f.jpg', 'image/jpeg', 1,
              'carpeta-' || (n % 3), array['etiqueta-' || n]
       from generate_series(1, 1100) n`,
      [marca, orgA],
    );
    const [f] = await as<{ tags: string[]; folders: string[] }>(db, ana, `select * from public.asset_facets($1)`, [
      marca,
    ]);
    expect(f!.tags).toHaveLength(1100);
    expect([...f!.folders].sort()).toEqual(['carpeta-0', 'carpeta-1', 'carpeta-2']);
  });

  it('no filtra nada de otras marcas ni organizaciones', async () => {
    await as(db, editorA, `select 1`);
    const vacio = (r: { tags: string[]; folders: string[] }[]) => [r[0]!.tags, r[0]!.folders];
    const ajena = await as<{ tags: string[]; folders: string[] }>(db, ana, `select * from public.asset_facets($1)`, [
      marcaB1,
    ]);
    expect(vacio(ajena)).toEqual([[], []]);
    const sinAcceso = await as<{ tags: string[]; folders: string[] }>(
      db,
      sinMarcaA,
      `select * from public.asset_facets($1)`,
      [marcaA1],
    );
    expect(vacio(sinAcceso)).toEqual([[], []]);
    await denied(db, null, `select * from public.asset_facets($1)`, [marcaA1]);
  });
});

describe('IA y cola de trabajos', () => {
  // Las fuentes de conocimiento encolan su propia extracción (`source.extract`):
  // aquí cuentan solo los trabajos que crea la prueba.
  const ids = async (user: TestUser, table: string) =>
    (
      await as<{ id: string }>(
        db,
        user,
        `select id::text as id from public.${table}${table === 'jobs' ? ` where kind <> 'source.extract'` : ''}`,
      )
    ).map((r) => r.id);
  const orgsOf = async (user: TestUser, table: string) =>
    (await as<{ org: string }>(db, user, `select distinct organization_id::text as org from public.${table}`)).map(
      (r) => r.org,
    );

  it('una organización no ve generaciones, costes, cupos ni trabajos de otra', async () => {
    // Cada propietaria ve lo suyo (la prueba no pasa «porque no hay nada»)…
    for (const table of ['usage_quotas', 'ai_generations', 'ai_usage', 'jobs']) {
      expect(await orgsOf(ana, table), table).toEqual([orgA]);
      expect(await orgsOf(berta, table), table).toEqual([orgB]);
    }
    expect(await ids(ana, 'ai_generations')).toEqual([genA1]);
    expect(await ids(berta, 'ai_generations')).toEqual([genB1]);
    expect((await ids(ana, 'jobs')).sort()).toEqual([jobA1, jobOrgA].sort());
    expect(await ids(berta, 'jobs')).toEqual([jobB1]);

    // …y buscando por identificador tampoco aparece lo ajeno.
    expect(await as(db, ana, `select 1 from public.ai_generations where id = $1`, [genB1])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.ai_usage where generation_id = $1`, [genB1])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.usage_quotas where organization_id = $1`, [orgB])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.jobs where id = $1`, [jobB1])).toEqual([]);

    // El coste que ve cada una es solo el de su organización.
    const coste = (user: TestUser) =>
      as(
        db,
        user,
        `select organization_id, cost_micros::int as cost from public.ai_cost_by_organization(now() - interval '1 day', now() + interval '1 day')`,
      );
    expect(await coste(ana)).toEqual([{ organization_id: orgA, cost: 1200 }]);
    expect(await coste(berta)).toEqual([{ organization_id: orgB, cost: 3400 }]);
    expect(await coste(ajeno)).toEqual([]);
  });

  it('dentro de la organización: el dinero es de los administradores', async () => {
    expect(await orgsOf(adminA, 'usage_quotas')).toEqual([orgA]);
    expect(await orgsOf(adminA, 'ai_usage')).toEqual([orgA]);
    for (const user of [editorA, gestorA, clienteA, sinMarcaA]) {
      expect(await as(db, user, `select 1 from public.usage_quotas`), user.email).toEqual([]);
      expect(await as(db, user, `select 1 from public.ai_usage`), user.email).toEqual([]);
    }
  });

  it('las generaciones las ve quien crea contenido en la marca; los trabajos, quien ve la marca', async () => {
    expect(await ids(editorA, 'ai_generations')).toEqual([genA1]);
    expect(await ids(gestorA, 'ai_generations')).toEqual([genA1]);
    expect(await ids(clienteA, 'ai_generations')).toEqual([]);
    expect(await ids(sinMarcaA, 'ai_generations')).toEqual([]);

    // El trabajo de toda la organización solo lo ven sus administradores.
    expect((await ids(adminA, 'jobs')).sort()).toEqual([jobA1, jobOrgA].sort());
    expect(await ids(editorA, 'jobs')).toEqual([jobA1]);
    expect(await ids(clienteA, 'jobs')).toEqual([jobA1]);
    expect(await ids(sinMarcaA, 'jobs')).toEqual([]);

    // Ana solo es lectora en la agencia: no ve allí generaciones ni costes.
    expect(await as(db, ana, `select 1 from public.ai_generations where id = $1`, [genG1])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.ai_usage where organization_id = $1`, [agencia])).toEqual([]);
    expect(await ids(gema, 'ai_generations')).toEqual([genG1]);
  });

  it('nadie escribe estas tablas ni mueve la cola desde el cliente', async () => {
    for (const user of [ana, adminA, editorA]) {
      await denied(
        db,
        user,
        `insert into public.usage_quotas (organization_id, metric, limit_value) values ($1, 'ai_cost_micros', 1)`,
        [orgA],
      );
      await denied(db, user, `update public.usage_quotas set limit_value = limit_value * 10`);
      await denied(db, user, `update public.ai_generations set cost_micros = 0`);
      await denied(db, user, `delete from public.ai_generations`);
      await denied(db, user, `update public.ai_usage set cost_delta_micros = 0`);
      await denied(db, user, `delete from public.ai_usage`);
      await denied(db, user, `update public.jobs set status = 'succeeded'`);
      await denied(db, user, `delete from public.jobs`);
    }
    const noFunction = /permission denied for function/;
    await denied(
      db,
      ana,
      `select public.ai_reserve_generation($1, $2, 'text', 'x', 'p', 'm', 1)`,
      [ana.id, marcaA1],
      noFunction,
    );
    await denied(db, ana, `select public.ai_complete_generation($1, 0)`, [genA1], noFunction);
    await denied(db, ana, `select public.ai_fail_generation($1, 'x')`, [genA1], noFunction);
    await denied(db, ana, `select public.enqueue_job($1, 'media.render', '{}'::jsonb, 'k')`, [orgA], noFunction);
    await denied(db, ana, `select * from public.claim_jobs('yo')`, [], noFunction);
    await denied(db, ana, `select public.cancel_job($1)`, [jobA1], noFunction);
    await denied(db, ana, `select public.release_job($1, 'yo')`, [jobA1], noFunction);
    await denied(db, ana, `select public.extend_job_lease($1, 'yo', 60)`, [jobA1], noFunction);
    await denied(db, ana, `select public.admin_set_ai_quota($1, 999999999)`, [orgA]);
  });

  it('el servidor no puede generar en nombre de quien no pertenece a la marca', async () => {
    const reservar = (user: TestUser, brand: string) =>
      serviceRpc(db, 'ai_reserve_generation', {
        p_user_id: user.id,
        p_brand_id: brand,
        p_task: 'text',
        p_purpose: 'post.caption',
        p_provider: 'simulated',
        p_model: 'sim-text-1',
        p_reserve_micros: 1,
      });
    // Ana en la marca de B; el editor de A1 en A2; el cliente y la lectora de la agencia.
    await expect(reservar(ana, marcaB1)).rejects.toThrow(/No tienes permiso para generar/);
    await expect(reservar(editorA, marcaA2)).rejects.toThrow(/No tienes permiso para generar/);
    await expect(reservar(clienteA, marcaA1)).rejects.toThrow(/No tienes permiso para generar/);
    await expect(reservar(ana, marcaG1)).rejects.toThrow(/No tienes permiso para generar/);
    await expect(reservar(superadmin, marcaA1)).rejects.toThrow(/No tienes permiso para generar/);
  });

  it('desde la aplicación nadie encola medios en una marca ajena ni con rutas ajenas', async () => {
    const pathOf = async (id: string) =>
      (await db.query<{ p: string }>(`select storage_path as p from public.media_assets where id = $1`, [id]))[0]!.p;
    const fotoA1 = await pathOf(assetA1);
    const fotoB1 = await pathOf(assetB1);
    const reel = (photoPath: string) =>
      JSON.stringify({ template: { id: 'fundido-suave' }, plan: { media: [{ type: 'photo', path: photoPath }] } });
    const encargar = (user: TestUser, brand: string, photoPath: string, pattern: RegExp) =>
      denied(
        db,
        user,
        `select public.request_media_job($1, 'media.reel.template', $2::jsonb, $3)`,
        [brand, reel(photoPath), `aislamiento-${brand}-${user.email}`],
        pattern,
      );
    const sinPermiso = /No tienes permiso/;
    const rutaAjena = /no es un recurso de esta marca/;
    // Marca de otra organización, con fotos propias o ajenas.
    await encargar(ana, marcaB1, fotoA1, sinPermiso);
    await encargar(ana, marcaB1, fotoB1, sinPermiso);
    await encargar(berta, marcaA1, fotoA1, sinPermiso);
    // En la marca propia, con la foto de otra organización o de otra marca.
    await encargar(ana, marcaA1, fotoB1, rutaAjena);
    await encargar(editorA, marcaA1, fotoB1, rutaAjena);
    await encargar(gema, marcaG1, fotoA1, rutaAjena);
    // Dentro de la organización: sin permiso de edición en esa marca.
    await encargar(editorA, marcaA2, fotoA1, sinPermiso);
    await encargar(clienteA, marcaA1, fotoA1, sinPermiso);
    await encargar(sinMarcaA, marcaA1, fotoA1, sinPermiso);
    await encargar(ana, marcaG1, fotoA1, sinPermiso); // lectora en la agencia
    await encargar(superadmin, marcaA1, fotoA1, sinPermiso);
    await encargar(ajeno, marcaA1, fotoA1, sinPermiso);
    await denied(
      db,
      null,
      `select public.request_media_job($1, 'media.reel.template', $2::jsonb, 'anonimo-1')`,
      [marcaA1, reel(fotoA1)],
      /permission denied for function/,
    );
    expect(
      await db.query(`select 1 from public.jobs where kind in ('media.reel.template', 'media.image.process')`),
    ).toEqual([]);
  });

  it('editor de reels: un montaje no se une a la pieza ni usa la tipografía de otra marca u organización', async () => {
    const pathOf = async (id: string) =>
      (await db.query<{ p: string }>(`select storage_path as p from public.media_assets where id = $1`, [id]))[0]!.p;
    const fotoA1 = await pathOf(assetA1);
    // Un reel con versión guardada en la organización B y otro en la marca A2 de la misma organización.
    const reelPiece = async (user: TestUser, org: string, brand: string) => {
      const [row] = await as<{ id: string }>(
        db,
        user,
        `insert into public.content_items (brand_id, organization_id, title, network, format)
         values ($1, $2, 'Reel', 'instagram', 'reel') returning id`,
        [brand, org],
      );
      await as(db, user, `select public.save_content_version($1, $2::jsonb, 2, '')`, [
        row!.id,
        JSON.stringify({ kind: 'reel', template: { id: 'fundido-suave' }, plan: { version: 2, clips: [] } }),
      ]);
      return row!.id;
    };
    const reelB1 = await reelPiece(berta, orgB, marcaB1);
    const reelA2 = await reelPiece(ana, orgA, marcaA2);
    const [fontB1] = await as<{ storage_path: string }>(
      db,
      berta,
      `insert into public.brand_fonts (brand_id, organization_id, family, format, storage_path, file_name, mime_type,
                                       bytes, license_confirmed)
       values ($1, $2, 'Ajena', 'ttf', $3, 'f.ttf', 'font/ttf', 10, true) returning storage_path`,
      [marcaB1, orgB, `${orgB}/${marcaB1}/fonts/ajena.ttf`],
    );
    const plan = (style: Record<string, unknown> = {}) => ({
      version: 2,
      clips: [{ id: 'c1', type: 'photo', path: fotoA1, seconds: 2 }],
      texts: [
        {
          id: 't1',
          text: 'Hola',
          start: 0,
          end: 1,
          position: 'top',
          style: {
            sizeRatio: 0.06,
            color: '#FFFFFF',
            marginRatio: 0.2,
            maxWidthRatio: 0.8,
            lineHeight: 1.3,
            box: null,
            outline: null,
            fadeSeconds: 0,
            ...style,
          },
        },
      ],
    });
    const encargar = (input: Record<string, unknown>, pattern: RegExp, key: string) =>
      denied(
        db,
        ana,
        `select public.request_media_job($1, 'media.reel.template', $2::jsonb, $3)`,
        [marcaA1, JSON.stringify({ template: { id: 'fundido-suave' }, ...input }), key],
        pattern,
      );
    const piezaAjena = /no es un reel de esta marca/;
    await encargar({ plan: plan(), content: { id: reelB1, version: 1 } }, piezaAjena, 'aislamiento-reel-b1');
    await encargar({ plan: plan(), content: { id: reelA2, version: 1 } }, piezaAjena, 'aislamiento-reel-a2');
    await encargar({ plan: plan({ fontPath: fontB1!.storage_path }) }, /tipografía no es/, 'aislamiento-fuente-b1');
    // Y la otra organización no ve el montaje guardado de B.
    expect(await as(db, ana, `select 1 from public.content_versions where content_id = $1`, [reelB1])).toEqual([]);
    // Lo creado aquí no cuenta en las pruebas de contenidos de más abajo.
    await db.query(`delete from public.content_items where id = any($1::uuid[])`, [[reelB1, reelA2]]);
    await db.query(`delete from public.brand_fonts where storage_path = $1`, [fontB1!.storage_path]);
  });

  it('cancelar un trabajo de medios: solo de una marca que se edita y solo de medios', async () => {
    const reel = async (org: string, brand: string, key: string) =>
      (
        await serviceRpc<{ id: string }>(db, 'enqueue_job', {
          p_organization_id: org,
          p_brand_id: brand,
          p_kind: 'media.reel.template',
          p_payload: { output: { path: `${org}/${brand}/reels/${key}.mp4` } },
          p_idempotency_key: key,
        })
      ).id;
    const reelA1 = await reel(orgA, marcaA1, 'cancelar-a1');
    const reelB1 = await reel(orgB, marcaB1, 'cancelar-b1');
    const reelG1 = await reel(agencia, marcaG1, 'cancelar-g1');
    const cancelar = (user: TestUser | null, job: string, pattern = /No tienes permiso para cancelar/) =>
      denied(db, user, `select public.cancel_media_job($1)`, [job], pattern);
    // Otra organización, otra marca de la misma, sin permiso de edición o sin sesión.
    await cancelar(ana, reelB1);
    await cancelar(berta, reelA1);
    await cancelar(editorA, reelB1);
    await cancelar(clienteA, reelA1);
    await cancelar(sinMarcaA, reelA1);
    await cancelar(ana, reelG1); // lectora en la agencia
    await cancelar(superadmin, reelA1);
    await cancelar(ajeno, reelA1);
    await cancelar(null, reelA1, /permission denied for function/);
    // Un trabajo que no es de medios (o de toda la organización) no se cancela por aquí.
    await cancelar(ana, jobA1);
    await cancelar(ana, jobOrgA);
    for (const id of [reelA1, reelB1, reelG1, jobA1, jobOrgA]) {
      const [row] = await db.query<{ status: string }>(`select status from public.jobs where id = $1`, [id]);
      expect(row!.status, id).toBe('queued');
    }
    // Quien edita la marca, sí.
    const [hecho] = await as<{ status: string }>(db, editorA, `select status from public.cancel_media_job($1)`, [
      reelA1,
    ]);
    expect(hecho!.status).toBe('cancelled');
    await serviceRpc(db, 'cancel_job', { p_job_id: reelB1 });
    await serviceRpc(db, 'cancel_job', { p_job_id: reelG1 });
  });

  it('ser superadministrador no abre las generaciones ni el consumo de los clientes', async () => {
    for (const table of ['usage_quotas', 'ai_generations', 'ai_usage', 'jobs']) {
      expect(await as(db, superadmin, `select 1 from public.${table}`), table).toEqual([]);
    }
  });
});

describe('contenidos y versiones', () => {
  const items = async (user: TestUser) =>
    (await as<{ id: string }>(db, user, `select id::text as id from public.content_items`)).map((r) => r.id).sort();
  const versionsOf = async (user: TestUser) =>
    (await as<{ id: string }>(db, user, `select distinct content_id::text as id from public.content_versions`))
      .map((r) => r.id)
      .sort();
  const insertItem = `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Intrusa', 'instagram', 'post')`;
  const save = `select public.save_content_version($1, '{"schemaVersion":1}'::jsonb, 1)`;
  const noEdit = /No tienes permiso para editar/;

  it('una organización no ve los contenidos ni las versiones de otra', async () => {
    // Cada una ve lo suyo (la prueba no pasa «porque no hay nada»). Ana ve además
    // la marca de la agencia donde es lectora; nunca la de B.
    expect(await items(berta)).toEqual([contentB1]);
    expect(await versionsOf(berta)).toEqual([contentB1]);
    expect(await items(ana)).toEqual([contentA1, contentA2, contentG1].sort());
    expect(await versionsOf(ana)).toEqual([contentA1, contentA2, contentG1].sort());
    expect(await items(gema)).toEqual([contentG1]);

    expect(await as(db, ana, `select 1 from public.content_items where id = $1`, [contentB1])).toEqual([]);
    expect(await as(db, ana, `select 1 from public.content_versions where content_id = $1`, [contentB1])).toEqual([]);
    expect(await as(db, berta, `select 1 from public.content_versions where content_id = $1`, [contentA1])).toEqual([]);
  });

  it('no se crea, guarda, restaura, aprueba ni archiva en la organización ajena', async () => {
    await denied(db, ana, insertItem, [marcaB1, orgB]);
    await denied(db, ana, save, [contentB1], noEdit);
    await denied(db, ana, `select public.restore_content_version($1, 1)`, [contentB1], noEdit);
    await denied(db, ana, `select public.set_content_status($1, 'in_review')`, [contentB1]);
    await denied(db, ana, `select public.set_content_status($1, 'approved', 1)`, [contentB1]);
    await denied(db, ana, `select public.archive_content_item($1)`, [contentB1]);
    expect(
      await as(db, ana, `update public.content_items set title = 'Robada' where id = $1 returning id`, [contentB1]),
    ).toEqual([]);

    const [item] = await db.query(
      `select title, status, current_version, archived_at from public.content_items where id = $1`,
      [contentB1],
    );
    expect(item).toEqual({ title: 'Pieza', status: 'draft', current_version: 1, archived_at: null });
  });

  it('una pieza no se puede mover de marca ni declararse de otra organización', async () => {
    await denied(db, ana, `update public.content_items set brand_id = $1 where id = $2`, [marcaA2, contentA1]);
    await denied(db, ana, `update public.content_items set organization_id = $1 where id = $2`, [orgB, contentA1]);
    // Marca propia con la organización ajena: lo impide la clave foránea compuesta.
    await denied(db, ana, insertItem, [marcaA1, orgB], /foreign key|row-level security/i);
  });

  it('dentro de la organización: ve quien ve la marca, escribe quien la edita', async () => {
    expect(await items(editorA)).toEqual([contentA1]);
    expect(await items(clienteA)).toEqual([contentA1]);
    expect(await versionsOf(clienteA)).toEqual([contentA1]);
    expect(await items(sinMarcaA)).toEqual([]);
    expect(await versionsOf(sinMarcaA)).toEqual([]);
    expect(await items(adminA)).toEqual([contentA1, contentA2].sort());

    // El cliente ve pero no crea ni guarda; el editor de A1 no toca A2.
    await denied(db, clienteA, insertItem, [marcaA1, orgA]);
    await denied(db, clienteA, save, [contentA1], noEdit);
    await denied(db, editorA, insertItem, [marcaA2, orgA]);
    await denied(db, editorA, save, [contentA2], noEdit);
    await denied(db, editorA, `select public.archive_content_item($1)`, [contentA2]);
    await denied(db, sinMarcaA, save, [contentA1], noEdit);

    // Ana solo es lectora en la agencia: ve la pieza, no la cambia.
    await denied(db, ana, save, [contentG1], noEdit);
    await denied(db, ana, `select public.set_content_status($1, 'draft')`, [contentG1]);
  });

  it('ser superadministrador no abre los contenidos de los clientes', async () => {
    expect(await items(superadmin)).toEqual([]);
    expect(await versionsOf(superadmin)).toEqual([]);
    await denied(db, superadmin, save, [contentA1], noEdit);
  });

  it('sin sesión no se ejecuta ninguna función de contenidos', async () => {
    const noFunction = /permission denied for function/;
    await denied(db, null, save, [contentA1], noFunction);
    await denied(db, null, `select public.restore_content_version($1, 1)`, [contentA1], noFunction);
    await denied(db, null, `select public.set_content_status($1, 'draft')`, [contentA1], noFunction);
    await denied(db, null, `select public.archive_content_item($1)`, [contentA1], noFunction);
  });
});

describe('encargos (modo agencia)', () => {
  const requests = async (user: TestUser) =>
    (await as<{ id: string }>(db, user, `select id::text as id from public.content_requests`)).map((r) => r.id).sort();
  const threads = async (user: TestUser) =>
    (await as<{ id: string }>(db, user, `select distinct request_id::text as id from public.content_request_comments`))
      .map((r) => r.id)
      .sort();

  it('una organización no ve los encargos ni la conversación de otra', async () => {
    expect(await requests(berta)).toEqual([requestB1]);
    expect(await threads(berta)).toEqual([requestB1]);
    expect(await requests(ana)).toEqual([requestA1, requestG1].sort());
    expect(await requests(gema)).toEqual([requestG1]);
    expect(await requests(superadmin)).toEqual([]);
    expect(await as(db, berta, `select id from public.pending_content_requests()`)).toEqual([{ id: requestB1 }]);
  });

  it('no se pide, comenta, toma, entrega, acepta ni cancela en la organización ajena', async () => {
    await denied(db, ana, `select public.create_content_request($1, 't', 'b', 'instagram', 'post')`, [marcaB1]);
    await denied(db, ana, `select public.comment_content_request($1, 'hola')`, [requestB1]);
    await denied(db, ana, `select public.take_content_request($1)`, [requestB1]);
    await denied(db, ana, `select public.release_content_request($1)`, [requestB1]);
    await denied(db, ana, `select public.deliver_content_request($1, '{"schemaVersion":1}'::jsonb, 1)`, [requestB1]);
    await denied(db, ana, `select public.request_content_request_changes($1, 'x')`, [requestB1]);
    await denied(db, ana, `select public.accept_content_request($1)`, [requestB1]);
    await denied(db, ana, `select public.cancel_content_request($1)`, [requestB1]);
    // Un recurso o una pieza de otra organización no se cuelan en un encargo propio.
    await denied(
      db,
      ana,
      `select public.create_content_request($1, 't', 'b', 'instagram', 'post', null, array[$2::uuid])`,
      [marcaA1, assetB1],
      /no es de esta marca/,
    );
    await denied(
      db,
      ana,
      `select public.create_content_request($1, 't', 'b', 'instagram', 'post', null, '{}', null, $2)`,
      [marcaA1, contentB1],
      /no es de esta marca/,
    );
    const [fila] = await db.query(`select status from public.content_requests where id = $1`, [requestB1]);
    expect(fila!.status).toBe('requested');
  });

  it('dentro de la organización: ve quien ve la marca; el lector de la agencia no toma nada', async () => {
    expect(await requests(clienteA)).toEqual([requestA1]);
    expect(await requests(editorA)).toEqual([requestA1]);
    expect(await requests(sinMarcaA)).toEqual([]);
    // Ana es solo lectora en la agencia: ve el encargo, no lo comenta ni lo toma.
    await denied(db, ana, `select public.comment_content_request($1, 'hola')`, [requestG1]);
    await denied(db, ana, `select public.take_content_request($1)`, [requestG1]);
  });

  it('sin sesión no se ejecuta ninguna función de encargos', async () => {
    const noFunction = /permission denied for function/;
    await denied(
      db,
      null,
      `select public.create_content_request($1, 't', 'b', 'instagram', 'post')`,
      [marcaA1],
      noFunction,
    );
    await denied(db, null, `select * from public.pending_content_requests()`, [], noFunction);
    await denied(db, null, `select public.take_content_request($1)`, [requestA1], noFunction);
    await denied(db, null, `select public.accept_content_request($1)`, [requestA1], noFunction);
    await denied(db, null, `select public.mark_request_notifications_read($1)`, [marcaA1], noFunction);
  });

  it('los avisos de encargos son de cada persona y de su organización', async () => {
    const mine = async (user: TestUser) =>
      (await as<{ id: string }>(db, user, `select request_id::text as id from public.request_notifications`))
        .map((r) => r.id)
        .sort();
    // El encargo de A1 (pedido por el cliente) avisa a quien edita A1: Ana, la administradora y el editor.
    expect(await mine(editorA)).toEqual([requestA1]);
    expect(await mine(clienteA)).toEqual([]);
    expect(await mine(sinMarcaA)).toEqual([]);
    expect(await mine(berta)).toEqual([]); // Berta pidió el suyo: no se avisa a sí misma.
    expect(await mine(superadmin)).toEqual([]);
    expect(await mine(ajeno)).toEqual([]);
    // Ninguna fila de otra persona, aunque sea de la misma organización.
    const [ajenos] = await as<{ n: number }>(
      db,
      editorA,
      `select count(*)::int as n from public.request_notifications where user_id <> $1`,
      [editorA.id],
    );
    expect(ajenos!.n).toBe(0);
    // Marcar como leído solo toca los propios, también con la marca ajena.
    await as(db, berta, `select public.mark_request_notifications_read($1)`, [marcaA1]);
    const [sigue] = await db.query<{ read_at: string | null }>(
      `select read_at from public.request_notifications where user_id = $1 and request_id = $2`,
      [editorA.id, requestA1],
    );
    expect(sigue!.read_at).toBeNull();
  });
});

describe('registro de modelos de imagen y vídeo (catálogo de plataforma)', () => {
  const NEW_MODEL = `insert into public.ai_media_models
      (provider, model, task, display_name, billing_unit, price_micros, price_checked_on, price_source,
       data_region, trains_on_inputs, delivery)
    values ('proveedor-x', $1, 'image', 'Modelo de prueba', 'image', 1000, '2026-11-17', 'prueba', 'eu', 'no', 'sync')
    returning id`;
  const models = (user: TestUser) =>
    as<{ model: string; price: number; active: boolean }>(
      db,
      user,
      `select model, price_micros::int as price, active from public.ai_media_models order by provider, model`,
    );

  it('lo lee cualquier usuario con sesión, y todos ven lo mismo', async () => {
    const deAna = await models(ana);
    expect(deAna.length).toBeGreaterThan(0);
    for (const user of [berta, clienteA, sinMarcaA, ajeno, superadmin]) {
      expect(await models(user), user.email).toEqual(deAna);
    }
    await denied(db, null, `select * from public.ai_media_models`);
  });

  it('nace sin nada activo y con el origen de cada precio', async () => {
    const rows = await db.query(
      `select 1 from public.ai_media_models where active or price_source = '' or price_checked_on is null`,
    );
    expect(rows).toEqual([]);
  });

  it('solo lo escribe un superadministrador', async () => {
    const antes = await models(ana);
    for (const user of [ana, adminA, editorA, ajeno]) {
      await denied(db, user, NEW_MODEL, ['intruso']);
      // Con RLS, cambiar o borrar filas ajenas no da error: no toca ninguna.
      await as(db, user, `update public.ai_media_models set price_micros = 1, price_verified = true`);
      await as(db, user, `delete from public.ai_media_models`);
    }
    expect(await models(ana)).toEqual(antes);

    const [nuevo] = await as<{ id: string }>(db, superadmin, NEW_MODEL, ['modelo-nuevo']);
    await as(
      db,
      superadmin,
      `update public.ai_media_models set price_micros = 2500, price_verified = true where id = $1`,
      [nuevo!.id],
    );
    await as(db, superadmin, `update public.ai_media_models set active = true where id = $1`, [nuevo!.id]);
    const [fila] = await db.query(
      `select price_micros::int as price, active, updated_by from public.ai_media_models where id = $1`,
      [nuevo!.id],
    );
    expect(fila).toEqual({ price: 2500, active: true, updated_by: superadmin.id });

    // Ni un superadministrador cambia de proveedor una fila: se crea otra.
    await denied(db, superadmin, `update public.ai_media_models set provider = 'otro' where id = $1`, [nuevo!.id]);

    await as(db, superadmin, `delete from public.ai_media_models where id = $1`, [nuevo!.id]);
    expect(await models(ana)).toEqual(antes);
  });

  it('un modelo con el precio sin verificar no se puede activar', async () => {
    const [nuevo] = await as<{ id: string }>(db, superadmin, NEW_MODEL, ['sin-verificar']);
    await denied(
      db,
      superadmin,
      `update public.ai_media_models set active = true where id = $1`,
      [nuevo!.id],
      /violates check constraint/,
    );
    // Tampoco el servidor, con la clave de servicio.
    await expect(
      asService(db, `update public.ai_media_models set active = true where id = $1`, [nuevo!.id]),
    ).rejects.toThrow(/violates check constraint/);
    await as(db, superadmin, `delete from public.ai_media_models where id = $1`, [nuevo!.id]);
  });

  it('la unidad de cobro tiene que casar con el tipo de medio', async () => {
    await denied(
      db,
      superadmin,
      `insert into public.ai_media_models
         (provider, model, task, display_name, billing_unit, price_micros, price_checked_on, price_source,
          data_region, trains_on_inputs, delivery)
       values ('proveedor-x', 'video-por-imagen', 'video', 'Mal', 'image', 1, '2026-11-17', 'prueba', 'eu', 'no', 'async')`,
      [],
      /violates check constraint/,
    );
  });
});

describe('auditoría y superadministración', () => {
  it('las acciones quedan registradas con su autor y solo las ven los administradores', async () => {
    const registros = await as(
      db,
      ana,
      `select action, entity_type, actor_id from public.audit_logs where organization_id = $1`,
      [orgA],
    );
    const tipos = new Set(registros.map((r) => `${r.action}:${r.entity_type}`));
    for (const esperado of [
      'insert:organizations',
      'insert:brands',
      'insert:organization_members',
      'insert:brand_profiles',
      'insert:invitations',
    ]) {
      expect(tipos, esperado).toContain(esperado);
    }
    expect(registros.some((r) => r.actor_id === ana.id)).toBe(true);
    expect(await as(db, adminA, `select id from public.audit_logs limit 1`)).toHaveLength(1);
    expect(await as(db, editorA, `select id from public.audit_logs`)).toEqual([]);
  });

  it('el registro no guarda contenidos ni huellas de token y no se puede manipular', async () => {
    const rows = await db.query(`select data from public.audit_logs where data ? 'token_hash' or data ? 'data'`);
    expect(rows).toEqual([]);
    await denied(
      db,
      ana,
      `insert into public.audit_logs (organization_id, action, entity_type) values ($1, 'x', 'x')`,
      [orgA],
    );
    await denied(db, ana, `delete from public.audit_logs where organization_id = $1`, [orgA]);
    await denied(db, ana, `update public.audit_logs set action = 'x' where organization_id = $1`, [orgA]);
  });

  it('el resumen global es solo para superadministradores', async () => {
    await denied(db, ana, `select * from public.admin_list_organizations()`);
    const todas = await as(db, superadmin, `select id, brands, assets from public.admin_list_organizations()`);
    expect(todas.map((r) => r.id).sort()).toEqual([orgA, orgB, agencia].sort());
    // Ser superadministrador no abre las tablas de los clientes.
    expect(await as(db, superadmin, `select id from public.media_assets`)).toEqual([]);
    await denied(db, ana, `insert into public.platform_admins (user_id) values ($1)`, [ana.id]);
    expect(await as(db, ana, `select user_id from public.platform_admins`)).toEqual([]);
  });
});

describe('imágenes generadas con IA en la biblioteca', () => {
  /** Un recurso generado como lo crea el servidor (clave de servicio), con la procedencia de su generación. */
  const generated = async (orgId: string, brandId: string, generationId: string) => {
    const [row] = await asService<{ id: string }>(
      db,
      `insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type, bytes,
         provenance)
       values ($1, $2, 'image', 'generated', $3, 'IA.png', 'image/png', 10,
               jsonb_build_object('type', 'ai_generation', 'generation_id', $4::text, 'prompt', 'encargo privado'))
       returning id`,
      [brandId, orgId, assetPath(orgId, brandId, `${generationId}.png`), generationId],
    );
    return row!.id;
  };

  it('la otra organización no ve ni el recurso ni su procedencia', async () => {
    const deA = await generated(orgA, marcaA1, genA1);
    const deB = await generated(orgB, marcaB1, genB1);
    expect(
      await as(db, ana, `select provenance->>'prompt' as p from public.media_assets where id = $1`, [deA]),
    ).toEqual([{ p: 'encargo privado' }]);
    expect(
      await as(db, ana, `select 1 from public.media_assets where id = $1 or provenance->>'generation_id' = $2`, [
        deB,
        genB1,
      ]),
    ).toEqual([]);
    expect(
      await as(db, berta, `select 1 from public.media_assets where provenance->>'generation_id' = $1`, [genA1]),
    ).toEqual([]);
  });

  it('nadie se hace pasar por el servidor: desde el cliente no se declara un recurso «generado con IA»', async () => {
    await denied(
      db,
      editorA,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', $3, 'falsa.png', 'image/png', 1, '{"type":"ai_generation","generation_id":"x"}')`,
      [marcaA1, orgA, assetPath(orgA, marcaA1)],
      /servidor|permission denied/,
    );
    // La procedencia de una exportación del editor sí la escribe el cliente al crear (20261118120000)…
    const [exportado] = await as<{ id: string }>(
      db,
      editorA,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', $3, 'exportada.png', 'image/png', 1, '{"type":"export"}') returning id`,
      [marcaA1, orgA, assetPath(orgA, marcaA1)],
    );
    expect(exportado?.id).toBeTruthy();
    // …pero nadie la cambia después.
    await denied(db, editorA, `update public.media_assets set provenance = '{}' where id = $1`, [assetA1]);
  });

  it('una imagen generada con IA se renombra, se mueve y se etiqueta como cualquier otra, sin perder su procedencia', async () => {
    const generada = await generated(orgA, marcaA1, `${genA1}-ficha`);
    const [editada] = await as<{ file_name: string; folder: string; tipo: string }>(
      db,
      editorA,
      `update public.media_assets set file_name = 'Portada.png', folder = 'Campaña', tags = array['ia']
       where id = $1 returning file_name, folder, provenance ->> 'type' as tipo`,
      [generada],
    );
    expect(editada).toEqual({ file_name: 'Portada.png', folder: 'Campaña', tipo: 'ai_generation' });
  });

  it('el disparador del seguimiento por pg_cron no lo ejecuta nadie desde la API', async () => {
    for (const user of [ana, superadmin]) {
      await denied(db, user, `select private.ai_media_poll_dispatch()`, [], /permission denied/);
    }
    await denied(db, null, `select private.ai_media_poll_dispatch()`, [], /permission denied/);
  });
});

describe('publicación: cuentas, calendario, intentos y comentarios (Fase 3)', () => {
  let cuentaA1: string, cuentaB1: string, pubA1: string, pubB1: string;

  const connect = async (user: TestUser, brand: string, externalId: string) =>
    (
      await serviceRpc<{ id: string }>(db, 'social_account_connect', {
        p_user_id: user.id,
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
      })
    ).id;

  const schedule = async (user: TestUser, contentId: string, account: string | null) => {
    const [row] = await as<{ id: string }>(
      db,
      user,
      `select id from public.save_publication(null, $1, now() + interval '1 day', $2, '{}'::uuid[])`,
      [contentId, account],
    );
    return row!.id;
  };

  beforeAll(async () => {
    cuentaA1 = await connect(ana, marcaA1, '1001');
    cuentaB1 = await connect(berta, marcaB1, '2001');
    pubA1 = await schedule(editorA, contentA1, cuentaA1);
    pubB1 = await schedule(berta, contentB1, cuentaB1);
    await as(db, editorA, `select public.comment_content_item($1, 'Comentario de A')`, [contentA1]);
    await as(db, berta, `select public.comment_content_item($1, 'Comentario de B')`, [contentB1]);
    // Un intento registrado en cada organización (lo escribe el publicador).
    for (const pub of [pubA1, pubB1]) {
      await db.query(
        `insert into public.publication_attempts (publication_id, brand_id, organization_id, attempt_no, outcome)
         select id, brand_id, organization_id, 1, 'not_ready' from public.scheduled_publications where id = $1`,
        [pub],
      );
    }
  });

  it('una organización no ve las cuentas, el calendario, los intentos ni los comentarios de otra', async () => {
    for (const table of ['social_accounts', 'scheduled_publications', 'publication_attempts', 'content_comments']) {
      const deB = await as(db, berta, `select distinct organization_id::text as org from public.${table}`);
      expect(
        deB.map((r) => r.org),
        table,
      ).toEqual([orgB]);
      const deA = await as(db, ana, `select distinct organization_id::text as org from public.${table}`);
      expect(
        deA.map((r) => r.org),
        table,
      ).not.toContain(orgB);
    }
    expect(await as(db, ana, `select 1 from public.scheduled_publications where id = $1`, [pubB1])).toEqual([]);
    expect(await as(db, superadmin, `select 1 from public.social_accounts`)).toEqual([]);
    expect(await as(db, superadmin, `select 1 from public.scheduled_publications`)).toEqual([]);
  });

  it('nadie programa, mueve, cancela, reintenta ni comenta en la organización ajena', async () => {
    await denied(db, ana, `select public.save_publication(null, $1, now() + interval '1 day')`, [contentB1]);
    await denied(db, ana, `select public.reschedule_publication($1, now() + interval '2 days')`, [pubB1]);
    await denied(db, ana, `select public.cancel_publication($1)`, [pubB1]);
    await denied(db, ana, `select public.retry_publication($1)`, [pubB1]);
    await denied(db, ana, `select public.publish_publication_now($1, null, '{}'::uuid[], 1, null)`, [contentB1]);
    await denied(db, ana, `select public.publication_publish_kick($1)`, [pubB1]);
    await denied(db, ana, `select public.comment_content_item($1, 'intrusa')`, [contentB1]);
    await denied(db, ana, `select public.request_content_changes($1, 'intrusa')`, [contentB1]);
    const [lote] = await as<{ ok: boolean }>(db, ana, `select * from public.approve_content_items($1::jsonb)`, [
      JSON.stringify([{ content_id: contentB1, version: 1 }]),
    ]);
    expect(lote?.ok).toBe(false);
  });

  it('una pieza no se programa en la cuenta de otra marca u organización', async () => {
    await expect(
      as(db, ana, `select public.save_publication($1, $2, now() + interval '1 day', $3)`, [pubA1, contentA1, cuentaB1]),
    ).rejects.toThrow(/cuenta/);
    await expect(
      as(db, ana, `select public.save_publication(null, $1, now() + interval '1 day', $2)`, [contentA2, cuentaA1]),
    ).rejects.toThrow(/cuenta/);
    // Ni con recursos de otra organización.
    await expect(
      as(db, ana, `select public.save_publication($1, $2, now() + interval '1 day', $3, $4::uuid[])`, [
        pubA1,
        contentA1,
        cuentaA1,
        [assetB1],
      ]),
    ).rejects.toThrow(/biblioteca/);
  });

  it('conectar y desconectar es de quien gestiona la marca, y nunca en la ajena', async () => {
    await denied(db, ana, `select public.social_oauth_begin($1, 'instagram')`, [marcaB1], /gestiona/);
    await denied(db, editorA, `select public.social_oauth_begin($1, 'instagram')`, [marcaA1], /gestiona/);
    await denied(db, clienteA, `select public.social_oauth_begin($1, 'instagram')`, [marcaA1], /gestiona/);
    expect(
      await as(db, gestorA, `select public.social_oauth_begin($1, 'instagram') is not null as ok`, [marcaA1]),
    ).toEqual([{ ok: true }]);
    await denied(db, ana, `select public.disconnect_social_account($1)`, [cuentaB1], /gestiona/);
    await denied(db, editorA, `select public.disconnect_social_account($1)`, [cuentaA1], /gestiona/);
    // El servidor tampoco conecta una cuenta en nombre de quien no gestiona la marca.
    await expect(connect(editorA, marcaA1, '1002')).rejects.toThrow(/gestiona/);
    await expect(connect(ana, marcaB1, '1003')).rejects.toThrow(/gestiona/);
  });

  it('los tokens y el estado del OAuth no se leen ni se escriben desde el cliente', async () => {
    for (const table of ['private.social_account_secrets', 'private.social_oauth_states']) {
      await denied(db, ana, `select * from ${table}`, [], /permission denied/);
      await denied(db, null, `select * from ${table}`, [], /permission denied/);
      await denied(db, ana, `delete from ${table}`, [], /permission denied/);
    }
    await denied(
      db,
      ana,
      `update public.social_accounts set status = 'active' where id = $1`,
      [cuentaA1],
      /permission denied/,
    );
    await denied(db, ana, `delete from public.social_accounts where id = $1`, [cuentaA1], /permission denied/);
    await denied(
      db,
      editorA,
      `insert into public.publication_attempts (publication_id, brand_id, organization_id, attempt_no) values ($1, $2, $3, 9)`,
      [pubA1, marcaA1, orgA],
      /permission denied/,
    );
    await denied(
      db,
      editorA,
      `insert into public.content_comments (content_id, brand_id, organization_id, kind, body) values ($1, $2, $3, 'approved', '')`,
      [contentA1, marcaA1, orgA],
      /permission denied/,
    );
  });

  it('las funciones del servidor (token, publicar, reloj) no las ejecuta nadie desde la API', async () => {
    const calls: Array<[string, unknown[]]> = [
      [`select public.social_account_token($1)`, [cuentaA1]],
      [`select public.social_oauth_consume('x')`, []],
      [`select public.social_account_report($1, 'active')`, [cuentaA1]],
      [`select public.social_enqueue_due_publications()`, []],
      [`select public.social_publication_begin($1, gen_random_uuid())`, [pubA1]],
      [`select public.social_publication_container($1, gen_random_uuid(), 'x')`, [pubA1]],
      [`select public.social_publication_succeed($1, gen_random_uuid(), 'x')`, [pubA1]],
      [`select public.social_publication_fail($1, gen_random_uuid(), 'x', 'x')`, [pubA1]],
      [`select public.social_publication_defer($1, gen_random_uuid(), 'w', 60, false)`, [pubA1]],
      [`select private.social_publish_dispatch()`, []],
      [`select private.publication_refresh()`, []],
    ];
    for (const [sql, params] of calls) {
      await denied(db, ana, sql, params, /permission denied/);
      await denied(db, null, sql, params, /permission denied/);
    }
    // El reloj tampoco lo ejecuta la clave de servicio: solo pg_cron.
    await expect(asService(db, `select private.social_publish_dispatch()`)).rejects.toThrow(/permission denied/);
  });
});

describe('planes y suscripciones (Fase 6)', () => {
  it('cada organización solo ve su suscripción, y solo sus administradores', async () => {
    expect(
      (await as(db, ana, `select organization_id from public.subscriptions`)).map((r) => r.organization_id),
    ).toEqual([orgA]);
    expect(
      (await as(db, berta, `select organization_id from public.subscriptions`)).map((r) => r.organization_id),
    ).toEqual([orgB]);
    // Un miembro sin administración no ve el dinero de su organización.
    expect(await as(db, editorA, `select organization_id from public.subscriptions`)).toEqual([]);
    expect(await as(db, sinMarcaA, `select organization_id from public.subscriptions`)).toEqual([]);
    const todas = await as(db, superadmin, `select organization_id from public.subscriptions`);
    expect(todas.map((r) => r.organization_id)).toEqual(expect.arrayContaining([orgA, orgB, agencia]));
  });

  it('nadie escribe a mano una suscripción, ni siquiera su propietaria', async () => {
    const legacy = await db.query<{ id: string }>(`select id from public.plans where code = 'enterprise'`);
    await denied(db, ana, `update public.subscriptions set plan_id = $1 where organization_id = $2`, [
      legacy[0]!.id,
      orgA,
    ]);
    await denied(db, ana, `insert into public.subscriptions (organization_id) values ($1)`, [orgA]);
    await denied(db, ana, `delete from public.subscriptions where organization_id = $1`, [orgA]);
  });

  it('el plan y su uso solo los consultan los administradores de la organización', async () => {
    const [propio] = await as<{ data: { plan: { code: string } } }>(
      db,
      ana,
      `select public.organization_plan_usage($1) as data`,
      [orgA],
    );
    expect(propio!.data.plan.code).toBe('legacy');
    await denied(db, ana, `select public.organization_plan_usage($1)`, [orgB], /administradores/);
    await denied(db, editorA, `select public.organization_plan_usage($1)`, [orgA], /administradores/);
    await denied(db, ajeno, `select public.organization_plan_usage($1)`, [orgA], /administradores/);
    await denied(db, null, `select public.organization_plan_usage($1)`, [orgA]);
  });

  it('los planes los lee cualquiera con sesión y solo los cambia un superadministrador', async () => {
    const vistos = (await as(db, ajeno, `select code from public.plans order by sort_order`)).map((r) => r.code);
    expect(vistos).toEqual(expect.arrayContaining(['trial', 'basic', 'professional', 'agency', 'enterprise']));
    await denied(db, ana, `insert into public.plans (code, name) values ('pirata', 'Pirata')`);
    expect(await as(db, ana, `update public.plans set price_micros = 0 where code = 'agency' returning id`)).toEqual(
      [],
    );
    await denied(db, ana, `delete from public.plans where code = 'agency'`);
    await denied(db, superadmin, `update public.plans set is_default = true where code = 'agency'`);
    await denied(db, superadmin, `update public.plans set code = 'otro' where code = 'agency'`);
  });

  it('las funciones de superadministración y las de Stripe no las usa nadie más', async () => {
    const [plan] = await db.query<{ id: string }>(`select id from public.plans where code = 'agency'`);
    for (const user of [ana, adminA, editorA, ajeno]) {
      await denied(db, user, `select public.admin_set_organization_plan($1, $2)`, [orgA, plan!.id]);
      await denied(db, user, `select * from public.admin_billing_overview('2026-11-01')`);
      await denied(db, user, `select public.admin_set_default_plan($1)`, [plan!.id]);
      await denied(db, user, `select public.admin_clear_ai_quota($1)`, [orgA]);
      await denied(db, user, `select public.billing_checkout_context($1, $2)`, [ana.id, orgA]);
      await denied(db, user, `select public.billing_apply_stripe_event('evt_x', 'customer.subscription.updated')`);
    }
    expect(await as(db, ana, `select id from public.billing_events`)).toEqual([]);
  });

  it('los límites del plan no los esquiva nadie escribiendo directamente con su sesión', async () => {
    // Una organización nueva con el plan «Prueba»: una marca y dos personas.
    const owner = await createUser(db, 'limites@l.test');
    const org = await createOrg(db, owner, 'Con límites');
    const [prueba] = await db.query<{ id: string }>(`select id from public.plans where code = 'trial'`);
    await as(db, superadmin, `select public.admin_set_organization_plan($1, $2)`, [org, prueba!.id]);
    await createBrand(db, owner, org, 'Única');
    await denied(
      db,
      owner,
      `insert into public.brands (organization_id, name) values ($1, 'Segunda')`,
      [org],
      /límite de marcas/,
    );
    // La propietaria no puede subirse el plan ni el cupo.
    await denied(db, owner, `select public.admin_set_organization_plan($1, null)`, [org]);
  });
});

describe('campañas (Fase 4)', () => {
  // Una campaña aceptada en B (con su pieza) y otra propuesta en A.
  let campaignA1: string, campaignB1: string;
  const START = '2026-11-23';
  const plan = (asset: string) => ({
    objective: 'Objetivo',
    summary: '',
    reasoning: { observed: [], dataBacked: [], hypotheses: [], dataNote: '' },
    pieces: [
      {
        network: 'instagram',
        format: 'post',
        date: START,
        idea: 'Idea',
        caption: 'Texto',
        hashtags: [],
        assetIds: [asset],
        why: '',
      },
    ],
  });
  const create = async (user: TestUser, brand: string, asset: string) => {
    const gen = await serviceRpc<{ id: string }>(db, 'ai_reserve_generation', {
      p_user_id: user.id,
      p_brand_id: brand,
      p_task: 'text',
      p_purpose: 'campaign.plan',
      p_provider: 'simulated',
      p_model: 'sim-text-1',
      p_reserve_micros: 5000,
    });
    await serviceRpc(db, 'ai_complete_generation', { p_generation_id: gen.id, p_cost_micros: 100 });
    const [row] = await as<{ id: string }>(
      db,
      user,
      `select id from public.create_campaign($1, 'Campaña', 'Prepara la semana', array['instagram'], $2::date, $2::date, $3::jsonb, $4)`,
      [brand, START, JSON.stringify(plan(asset)), gen.id],
    );
    return row!.id;
  };
  const DOC = { schemaVersion: 1, canvas: {}, layers: [], copy: { caption: 'Texto' } };

  beforeAll(async () => {
    campaignA1 = await create(editorA, marcaA1, assetA1);
    campaignB1 = await create(berta, marcaB1, assetB1);
    await as(db, berta, `select public.accept_campaign_plan($1, 1, $2::jsonb, $3::jsonb)`, [
      campaignB1,
      JSON.stringify(plan(assetB1)),
      JSON.stringify([{ title: 'Pieza', schemaVersion: 1, data: DOC }]),
    ]);
  });

  const ids = async (user: TestUser, table: string, column = 'id') =>
    (await as<{ id: string }>(db, user, `select distinct ${column}::text as id from public.${table}`))
      .map((r) => r.id)
      .sort();

  it('una organización no ve las campañas, los planes ni las piezas enlazadas de otra', async () => {
    expect(await ids(berta, 'campaigns')).toEqual([campaignB1]);
    expect(await ids(berta, 'campaign_plans', 'campaign_id')).toEqual([campaignB1]);
    expect(await ids(berta, 'campaign_contents', 'campaign_id')).toEqual([campaignB1]);
    expect(await ids(ana, 'campaigns')).toEqual([campaignA1]);
    expect(await ids(ana, 'campaign_contents', 'campaign_id')).toEqual([]);
    expect(await ids(superadmin, 'campaigns')).toEqual([]);
  });

  it('no se crea, acepta, descarta ni entrega en la organización ajena, ni con recursos ajenos', async () => {
    await denied(db, ana, `select public.accept_campaign_plan($1, 1, $2::jsonb, '[]'::jsonb)`, [
      campaignB1,
      JSON.stringify(plan(assetB1)),
    ]);
    await denied(db, ana, `select public.discard_campaign($1)`, [campaignB1]);
    await denied(db, ana, `select public.request_campaign_plan($1, 't', 'i', array['instagram'], $2::date, $2::date)`, [
      marcaB1,
      START,
    ]);
    await denied(
      db,
      ana,
      `select public.create_campaign($1, 't', 'i', array['instagram'], $2::date, $2::date, $3::jsonb, $4)`,
      [marcaB1, START, JSON.stringify(plan(assetB1)), genB1],
    );
    await denied(db, ana, `select public.deliver_campaign_plan($1, '{}'::jsonb)`, [requestB1]);
    // Un recurso de otra organización no se cuela en un plan propio.
    await denied(
      db,
      editorA,
      `select public.accept_campaign_plan($1, 1, $2::jsonb, $3::jsonb)`,
      [campaignA1, JSON.stringify(plan(assetB1)), JSON.stringify([{ title: 'P', schemaVersion: 1, data: DOC }])],
      /no es de esta marca/,
    );
    const [row] = await db.query(`select status from public.campaigns where id = $1`, [campaignA1]);
    expect(row!.status).toBe('proposed');
  });

  it('dentro de la organización: ve quien ve la marca; el cliente no acepta un plan de la IA', async () => {
    expect(await ids(clienteA, 'campaigns')).toEqual([campaignA1]);
    expect(await ids(sinMarcaA, 'campaigns')).toEqual([]);
    await denied(db, clienteA, `select public.discard_campaign($1)`, [campaignA1]);
  });

  it('sin sesión no se ejecuta ninguna función de campañas', async () => {
    const noFunction = /permission denied for function/;
    await denied(db, null, `select public.discard_campaign($1)`, [campaignA1], noFunction);
    await denied(
      db,
      null,
      `select public.accept_campaign_plan($1, 1, '{}'::jsonb, '[]'::jsonb)`,
      [campaignA1],
      noFunction,
    );
    await denied(
      db,
      null,
      `select public.request_campaign_plan($1, 't', 'i', array['instagram'], $2::date, $2::date)`,
      [marcaA1, START],
      noFunction,
    );
  });
});

describe('RGPD: aceptaciones, exportar y borrar', () => {
  /** Llama a una función de supresión como el servidor (clave de servicio). */
  const service = (fn: string, args: Record<string, unknown>) => serviceRpc<Record<string, unknown>>(db, fn, args);

  it('cada persona ve solo sus aceptaciones, y nadie las escribe ni las cambia desde el cliente', async () => {
    await as(db, ana, `select * from public.accept_legal_documents('2026-11-19', '2026-11-19')`);
    await as(db, berta, `select * from public.accept_legal_documents('2026-11-19', '2026-11-19')`);
    const deAna = await as(db, ana, `select user_id from public.legal_acceptances`);
    expect(deAna.length).toBe(2);
    expect(deAna.every((r) => r.user_id === ana.id)).toBe(true);
    await denied(
      db,
      ana,
      `insert into public.legal_acceptances (user_id, document, version, source) values ($1, 'terms', '2026-11-19', 'app')`,
      [berta.id],
    );
    await denied(db, ana, `update public.legal_acceptances set version = '2020-01-01'`);
    await denied(db, ana, `delete from public.legal_acceptances`);
    expect(await db.query(`select 1 from public.legal_acceptances where user_id = $1`, [berta.id])).toHaveLength(2);
  });

  it('«descargar mis datos» devuelve solo los de la sesión, sin forma de pedir los de otra persona', async () => {
    const [fila] = await as<{ data: Record<string, unknown> }>(db, ana, `select public.export_my_data() as data`);
    const data = fila!.data;
    const texto = JSON.stringify(data);
    expect((data.account as Record<string, unknown>).id).toBe(ana.id);
    expect(texto).not.toContain(berta.id);
    expect(texto).not.toContain(berta.email);
    expect(texto).not.toContain(orgB);
    // Sin parámetros: no hay a quién más pedir.
    await denied(db, ana, `select public.export_my_data($1)`, [berta.id], /function|does not exist/);
    await denied(db, null, `select public.export_my_data()`, [], /permission denied/);
  });

  it('exportar una organización es solo para sus propietarios, y nunca incluye otra', async () => {
    for (const user of [berta, adminA, editorA, gestorA, clienteA, ajeno, superadmin]) {
      await denied(db, user, `select public.export_organization_data($1)`, [orgA], /propietario|permission denied/);
    }
    await denied(db, null, `select public.export_organization_data($1)`, [orgA], /permission denied/);
    const [fila] = await as<{ data: Record<string, unknown> }>(
      db,
      ana,
      `select public.export_organization_data($1) as data`,
      [orgA],
    );
    const data = fila!.data;
    const marcas = data.brands as { id: string; organization_id: string }[];
    expect(marcas.map((b) => b.id)).toEqual(expect.arrayContaining([marcaA1, marcaA2]));
    expect(marcas.every((b) => b.organization_id === orgA)).toBe(true);
    const texto = JSON.stringify(data);
    for (const ajena of [orgB, marcaB1, marcaG1, contentB1, contentG1, requestB1, requestG1, assetB1]) {
      expect(texto).not.toContain(ajena);
    }
    expect(texto).not.toContain('token_hash');
    expect(texto).not.toContain('claim_token');
  });

  it('desde la aplicación no se ejecuta ninguna función de borrado: solo el servidor', async () => {
    for (const user of [ana, berta, superadmin]) {
      await denied(db, user, `select public.gdpr_delete_account_data($1)`, [user.id], /permission denied/);
      await denied(
        db,
        user,
        `select public.gdpr_delete_organization($1, $2, 'Empresa A')`,
        [user.id, orgA],
        /permission denied/,
      );
      await denied(db, user, `select public.gdpr_forget_storage_paths(array['x'])`, [], /permission denied/);
      await denied(db, user, `select private.delete_organization_data($1, $2)`, [orgB, user.id], /permission denied/);
    }
  });

  it('el servidor tampoco borra una organización en nombre de quien no es su propietario', async () => {
    for (const user of [berta, adminA, gestorA, gema, ajeno]) {
      await expect(
        service('gdpr_delete_organization', {
          p_user_id: user.id,
          p_organization_id: orgA,
          p_confirmation: 'Empresa A',
        }),
      ).rejects.toThrow(/propietario/);
    }
    await expect(
      service('gdpr_delete_organization', { p_user_id: ana.id, p_organization_id: orgA, p_confirmation: 'Empresa B' }),
    ).rejects.toThrow(/nombre exacto/);
    expect(await db.query(`select 1 from public.organizations where id = $1`, [orgA])).toHaveLength(1);
  });

  it('borrar una cuenta solo toca a esa persona: su autoría queda anónima y el trabajo de los demás sigue', async () => {
    // Una cuenta de usar y tirar, editora en la marca A1 y propietaria de su propia organización vacía.
    const borrable = await createUser(db, 'borrable@a.test', 'Borrable');
    await join(db, ana, borrable, orgA, 'member', marcaA1, 'editor');
    const propia = await createOrg(db, borrable, 'Solo mía');
    const [pieza] = await as<{ id: string }>(
      db,
      borrable,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Hecha por borrable', 'instagram', 'post') returning id`,
      [marcaA1, orgA],
    );
    await as(db, borrable, `select public.save_content_version($1, '{"schemaVersion":1}'::jsonb, 1)`, [pieza!.id]);
    await as(db, borrable, `select public.comment_content_request($1, 'Comentario de borrable')`, [requestA1]);
    const antes = await db.query(`select count(*)::int as n from public.content_items where brand_id = $1`, [marcaA1]);

    const resultado = await service('gdpr_delete_account_data', { p_user_id: borrable.id });
    expect((resultado.deleted_organizations as { organization_id: string }[]).map((o) => o.organization_id)).toEqual([
      propia,
    ]);
    await db.query(`delete from auth.users where id = $1`, [borrable.id]);

    // Su organización vacía ya no existe; la de Ana, sí, con todo su contenido.
    expect(await db.query(`select 1 from public.organizations where id = $1`, [propia])).toEqual([]);
    expect(
      await db.query(`select count(*)::int as n from public.content_items where brand_id = $1`, [marcaA1]),
    ).toEqual(antes);
    expect(await db.query(`select created_by from public.content_items where id = $1`, [pieza!.id])).toEqual([
      { created_by: null },
    ]);
    expect(
      await db.query(`select author_id from public.content_request_comments where body = 'Comentario de borrable'`),
    ).toEqual([{ author_id: null }]);
    // Ni su id ni su correo quedan en el registro de auditoría.
    expect(
      await db.query(
        `select id from public.audit_logs
         where actor_id = $1 or entity_id = $2 or data::text like $3 or data::text ilike $4`,
        [borrable.id, borrable.id, `%${borrable.id}%`, `%${borrable.email}%`],
      ),
    ).toEqual([]);
    // Los demás siguen con sus datos y su autoría.
    expect(await as(db, ana, `select 1 from public.content_items where id = $1`, [contentA1])).toHaveLength(1);
    expect(await db.query(`select 1 from public.audit_logs where actor_id = $1 limit 1`, [ana.id])).toHaveLength(1);
    expect(await db.query(`select 1 from public.profiles where user_id = $1`, [berta.id])).toHaveLength(1);
  });

  it('quien es la única propietaria de una organización con más miembros no puede borrar su cuenta', async () => {
    await expect(service('gdpr_delete_account_data', { p_user_id: ana.id })).rejects.toThrow(/traspasa la propiedad/);
    // Ni siquiera borrando la cuenta de Auth a mano: la organización no se queda sin propietario.
    await expect(db.query(`delete from auth.users where id = $1`, [ana.id])).rejects.toThrow(/propietario/);
    expect(await db.query(`select 1 from public.organizations where id = $1`, [orgA])).toHaveLength(1);
  });
});

describe('analítica: métricas, capturas e informes (Fase 5)', () => {
  let cuentaA1: string, cuentaB1: string;
  const today = new Date().toISOString().slice(0, 10);

  const connect = async (user: TestUser, brand: string, externalId: string) =>
    (
      await serviceRpc<{ id: string }>(db, 'social_account_connect', {
        p_user_id: user.id,
        p_brand_id: brand,
        p_network: 'instagram',
        p_external_id: externalId,
        p_username: 'cuenta',
        p_display_name: 'Cuenta',
        p_page_id: '1',
        p_scopes: ['instagram_basic', 'instagram_manage_insights'],
        p_token_expires_at: null,
        p_key_id: 'k1',
        p_access_token_ciphertext: 'c'.repeat(40),
        p_refresh_token_ciphertext: null,
      })
    ).id;

  beforeAll(async () => {
    // Las mismas cuentas que en la publicación (volver a conectarlas solo renueva el token).
    cuentaA1 = await connect(ana, marcaA1, '1001');
    cuentaB1 = await connect(berta, marcaB1, '2001');
    for (const cuenta of [cuentaA1, cuentaB1]) {
      await serviceRpc(db, 'analytics_record_capture', {
        p_account_id: cuenta,
        p_job_id: null,
        p_status: 'partial',
        p_started_at: new Date().toISOString(),
        p_window_from: today,
        p_window_to: today,
        p_account_rows: [{ metric_id: 'instagram.account.followers', date: today, value: 100 }],
        p_media_rows: [],
        p_unavailable: [{ metric_id: 'instagram.account.views', reason: 'no_data', message: 'Sin cifras' }],
      });
    }
    for (const brand of [marcaA1, marcaB1]) {
      await db.query(`select private.analytics_report_enqueue($1, '2026-10-01', 'manual', null)`, [brand]);
    }
  });

  it('una organización no ve las cifras, las capturas ni los informes de otra; el superadministrador tampoco', async () => {
    for (const table of ['account_metrics_daily', 'analytics_capture_runs', 'analytics_reports']) {
      const deB = await as(db, berta, `select distinct organization_id::text as org from public.${table}`);
      expect(
        deB.map((r) => r.org),
        table,
      ).toEqual([orgB]);
      const deA = await as(db, ana, `select distinct organization_id::text as org from public.${table}`);
      expect(
        deA.map((r) => r.org),
        table,
      ).toEqual([orgA]);
      expect(await as(db, superadmin, `select 1 from public.${table}`), table).toEqual([]);
      expect(await as(db, ajeno, `select 1 from public.${table}`), table).toEqual([]);
    }
    expect(await as(db, ana, `select 1 from public.media_metrics_daily where brand_id = $1`, [marcaB1])).toEqual([]);
    expect(
      await as(
        db,
        ana,
        `select * from public.analytics_media_summary($1, now() - interval '1 year', now() + interval '1 day')`,
        [marcaB1],
      ),
    ).toEqual([]);
    // Dentro de la organización: quien no ve la marca no ve sus cifras; el cliente de la marca, sí.
    expect(await as(db, sinMarcaA, `select 1 from public.account_metrics_daily`)).toEqual([]);
    expect((await as(db, clienteA, `select 1 from public.account_metrics_daily`)).length).toBeGreaterThan(0);
    // El catálogo de métricas es de la plataforma: lo leen todos igual.
    const [a] = await as<{ n: string }>(db, ana, `select count(*)::text as n from public.analytics_metric_definitions`);
    const [b] = await as<{ n: string }>(
      db,
      ajeno,
      `select count(*)::text as n from public.analytics_metric_definitions`,
    );
    expect(a).toEqual(b);
  });

  it('nadie escribe cifras, capturas, informes ni el catálogo desde la API', async () => {
    for (const table of [
      'account_metrics_daily',
      'media_metrics_daily',
      'analytics_capture_runs',
      'analytics_reports',
      'analytics_metric_definitions',
    ]) {
      await denied(db, ana, `delete from public.${table}`, [], /permission denied/);
      await denied(db, ana, `update public.${table} set id = id`, [], /permission denied/);
    }
    await denied(
      db,
      ana,
      `insert into public.analytics_reports (brand_id, organization_id, period_start, source)
       values ($1, $2, '2026-09-01', 'manual')`,
      [marcaA1, orgA],
      /permission denied/,
    );
  });

  it('no se piden informes de la marca ajena, y las funciones del servidor no se ejecutan desde la API', async () => {
    await denied(db, ana, `select public.request_analytics_report($1, '2026-09-01')`, [marcaB1], /edita/);
    await denied(db, clienteA, `select public.request_analytics_report($1, '2026-09-01')`, [marcaA1], /edita/);
    const calls: Array<[string, unknown[]]> = [
      [`select public.analytics_enqueue_captures()`, []],
      [`select public.analytics_capture_begin($1)`, [cuentaA1]],
      [`select public.analytics_record_capture($1, null, 'succeeded', now(), null, null, '[]', '[]')`, [cuentaA1]],
      [`select public.analytics_defer_job(gen_random_uuid(), 'w', 60)`, []],
      [`select public.analytics_enqueue_monthly_reports()`, []],
      [`select public.analytics_report_source(gen_random_uuid())`, []],
      [`select public.analytics_report_render(gen_random_uuid(), gen_random_uuid(), '{}', '{}')`, []],
      [`select private.analytics_report_enqueue($1, '2026-09-01', 'manual', null)`, [marcaA1]],
      [`select private.analytics_dispatch()`, []],
    ];
    for (const [sql, params] of calls) {
      await denied(db, ana, sql, params, /permission denied/);
      await denied(db, null, sql, params, /permission denied/);
    }
    // El reloj tampoco lo ejecuta la clave de servicio: solo pg_cron.
    await expect(asService(db, `select private.analytics_dispatch()`)).rejects.toThrow(/permission denied/);
  });
});

describe('despertador del trabajador de medios (20261208010000)', () => {
  it('nadie lo ejecuta ni toca su estado desde la API: solo el disparador y pg_cron', async () => {
    const statements = [
      `select private.media_worker_wake()`,
      `select private.is_media_worker_kind('media.reel.template')`,
      `select * from private.media_worker_wake_state`,
      `update private.media_worker_wake_state set last_requested_at = null`,
    ];
    for (const user of [ana, adminA, superadmin, ajeno, null]) {
      for (const sql of statements) await denied(db, user, sql, [], /permission denied/);
    }
    for (const sql of statements) {
      await expect(asService(db, sql)).rejects.toThrow(/permission denied/);
    }
  });
});

describe('intermediario del trabajador de medios (20261210010000)', () => {
  it('ni personas ni anónimos llaman a sus funciones ni ven su contador; la clave de servicio, solo por las funciones', async () => {
    const hash = '0'.repeat(64);
    const statements = [
      `select * from public.worker_gateway_claim('${hash}', 'w', null, 1, 60)`,
      `select public.worker_gateway_complete('${hash}', 'w', gen_random_uuid(), '{}')`,
      `select public.worker_gateway_authorize_path('${hash}', 'w', gen_random_uuid(), 'a/b/c', false)`,
      `select private.worker_gateway_identity('${hash}', 'w')`,
      `select * from private.worker_gateway_calls`,
      `delete from private.worker_gateway_calls`,
    ];
    for (const user of [ana, adminA, superadmin, ajeno, null]) {
      for (const sql of statements) await denied(db, user, sql, [], /permission denied/);
    }
    for (const sql of statements.slice(3)) {
      await expect(asService(db, sql)).rejects.toThrow(/permission denied/);
    }
    // Sin token configurado, la clave de servicio tampoco reclama nada por aquí.
    await expect(asService(db, statements[0]!)).rejects.toThrow(/no es válido/);
  });
});

describe('Plataforma → Integraciones (20261120010000)', () => {
  const ADMIN_CALLS: Array<[string, unknown[]]> = [
    [`select * from public.admin_integration_settings()`, []],
    [`select * from public.admin_integration_tests()`, []],
    [`select * from public.admin_integration_audit(10)`, []],
    [`select public.admin_set_integration_setting('META_APP_ID', '123456')`, []],
    [`select public.admin_delete_integration_setting('META_APP_ID')`, []],
  ];
  const SERVER_CALLS: Array<[string, unknown[]]> = [
    [`select public.integration_settings_for_service()`, []],
    [`select public.integration_record_test(gen_random_uuid(), 'meta', true, 'x')`, []],
    [
      `select public.social_account_connect_token(gen_random_uuid(), gen_random_uuid(), 'instagram', '1', '', '', null,
                                                  '{}', null, 'k1', 'cifrado-xxxxxxxxxxxx')`,
      [],
    ],
  ];
  const TABLES = ['integration_setting_keys', 'integration_settings', 'integration_tests', 'integration_audit'];

  it('ni propietarios, ni administradores, ni miembros, ni anónimos leen o escriben las integraciones', async () => {
    await as(
      db,
      superadmin,
      `select public.admin_set_integration_setting('META_APP_SECRET', 'secreto-aislamiento-0001')`,
    );
    for (const user of [ana, berta, adminA, gema, ajeno, null]) {
      for (const [sql, params] of ADMIN_CALLS) {
        await denied(db, user, sql, params, /permission denied|Solo para superadministradores/);
      }
      for (const [sql, params] of SERVER_CALLS) await denied(db, user, sql, params, /permission denied/);
      for (const table of TABLES) {
        await denied(db, user, `select * from private.${table}`, [], /permission denied/);
        await denied(db, user, `delete from private.${table}`, [], /permission denied/);
      }
    }
  });

  it('el superadministrador gestiona por las funciones, pero no toca las tablas ni lee los secretos en claro', async () => {
    const rows = await as<{ setting_key: string; value: string | null }>(
      db,
      superadmin,
      `select * from public.admin_integration_settings()`,
    );
    expect(rows.find((r) => r.setting_key === 'META_APP_SECRET')?.value).toBeNull();
    for (const table of TABLES) {
      await denied(db, superadmin, `select * from private.${table}`, [], /permission denied/);
    }
    await denied(db, superadmin, `select public.integration_settings_for_service()`, [], /permission denied/);
    // Ser superadministrador no abre los datos de los clientes.
    expect(await as(db, superadmin, `select 1 from public.social_accounts`)).toEqual([]);
  });

  it('la clave de servicio solo obtiene los valores por su función, no por las tablas', async () => {
    const [row] = await asService<{ data: Record<string, string> }>(
      db,
      `select public.integration_settings_for_service() as data`,
    );
    expect(row!.data.META_APP_SECRET).toBe('secreto-aislamiento-0001');
    for (const table of TABLES) {
      await expect(asService(db, `select * from private.${table}`)).rejects.toThrow(/permission denied/);
    }
    await as(db, superadmin, `select public.admin_delete_integration_setting('META_APP_SECRET')`);
  });

  it('cómo se conectó una cuenta lo ve quien ve la marca, y no se cambia desde el cliente', async () => {
    await denied(db, ana, `update public.social_accounts set connection_method = 'token'`, [], /permission denied/);
  });
});

describe('biblioteca con Google Drive', () => {
  let conexionA: string, conexionB: string;
  const cifrado = Buffer.alloc(40, 1).toString('base64');
  const conectar = async (user: TestUser, orgId: string, email: string): Promise<string> => {
    const [estado] = await as<{ s: string }>(db, user, `select public.drive_oauth_begin($1) as s`, [orgId]);
    const [ctx] = await asService<{ c: { user_id: string } }>(db, `select public.drive_oauth_consume($1) as c`, [
      estado!.s,
    ]);
    const [fila] = await asService<{ id: string }>(
      db,
      `select (public.drive_connection_save($1, $2, $3, '', '{}', 'k1', $4)).id as id`,
      [ctx!.c.user_id, orgId, email, cifrado],
    );
    return fila!.id;
  };

  beforeAll(async () => {
    conexionA = await conectar(ana, orgA, 'drive-a@a.test');
    conexionB = await conectar(berta, orgB, 'drive-b@b.test');
  });

  it('cada organización ve solo sus conexiones; los secretos y estados no los ve nadie del cliente', async () => {
    expect((await as(db, ana, `select id from public.drive_connections`)).map((r) => r.id)).toEqual([conexionA]);
    expect((await as(db, berta, `select id from public.drive_connections`)).map((r) => r.id)).toEqual([conexionB]);
    expect(await as(db, ajeno, `select id from public.drive_connections`)).toEqual([]);
    expect(await as(db, superadmin, `select id from public.drive_connections`)).toEqual([]);
    for (const table of ['drive_connection_secrets', 'drive_oauth_states']) {
      await denied(db, ana, `select * from private.${table}`, [], /permission denied/);
    }
  });

  it('nadie escribe las conexiones desde el cliente', async () => {
    await denied(
      db,
      ana,
      `insert into public.drive_connections (organization_id, account_email) values ($1, 'x@x.test')`,
      [orgA],
      /permission denied/,
    );
    await denied(db, ana, `update public.drive_connections set status = 'active'`, [], /permission denied/);
    await denied(db, ana, `delete from public.drive_connections`, [], /permission denied/);
  });

  it('solo administra la conexión quien administra la organización, y nunca la de otra', async () => {
    await denied(db, editorA, `select public.drive_oauth_begin($1)`, [orgA], /administra/);
    await denied(db, ana, `select public.drive_oauth_begin($1)`, [orgB], /administra/);
    await denied(db, ana, `select public.disconnect_drive($1)`, [conexionB], /administra/);
    // Solo la clave de servicio guarda, lee el token cifrado o da de alta recursos.
    await denied(db, ana, `select public.drive_connection_token($1)`, [conexionA], /permission denied/);
    await denied(
      db,
      ana,
      `select public.drive_connection_save($1, $2, 'x@x.test', '', '{}', 'k1', 'aaaaaaaaaaaaaaaaaaaa')`,
      [ana.id, orgA],
      /permission denied/,
    );
  });

  it('para añadir fotos hace falta editar una marca de la organización de la conexión', async () => {
    const [ok] = await as<{ c: { id: string } }>(db, editorA, `select public.drive_connection_for_brand($1) as c`, [
      marcaA1,
    ]);
    expect(ok!.c.id).toBe(conexionA);
    await denied(db, clienteA, `select public.drive_connection_for_brand($1)`, [marcaA1], /edita la marca/);
    await denied(db, editorA, `select public.drive_connection_for_brand($1)`, [marcaA2], /edita la marca/);
    await denied(db, ana, `select public.drive_connection_for_brand($1, $2)`, [marcaB1, conexionB], /edita la marca/);
    // Con una conexión de otra organización no se encuentra ninguna.
    await denied(
      db,
      ana,
      `select public.drive_connection_for_brand($1, $2)`,
      [marcaA1, conexionB],
      /no tiene Google Drive/,
    );
  });

  it('un recurso de Drive se aísla como cualquier otro y el servidor no lo cruza de organización', async () => {
    const archivos = JSON.stringify([
      { id: 'driveFileAislamiento01', name: 'a.jpg', mime_type: 'image/jpeg', bytes: 10 },
    ]);
    const [recurso] = await asService<{ id: string }>(
      db,
      `select id from public.drive_assets_import($1, $2, $3, $4::jsonb)`,
      [ana.id, marcaA1, conexionA, archivos],
    );
    expect(await as(db, berta, `select 1 from public.media_assets where id = $1`, [recurso!.id])).toEqual([]);
    await expect(
      asService(db, `select * from public.drive_assets_import($1, $2, $3, $4::jsonb)`, [
        ana.id,
        marcaA1,
        conexionB,
        archivos,
      ]),
    ).rejects.toThrow(/no es de la organización/);
    await expect(
      asService(db, `select * from public.drive_assets_import($1, $2, $3, $4::jsonb)`, [
        berta.id,
        marcaA1,
        conexionA,
        archivos,
      ]),
    ).rejects.toThrow(/edita la marca/);
    await as(db, ana, `delete from public.media_assets where id = $1`, [recurso!.id]);
  });
});

describe('almacenamiento en Cloudflare R2 (20261124010000)', () => {
  it('nadie del cliente lee ni escribe lo apuntado por el servidor, ni llama a sus funciones', async () => {
    const path = `${orgA}/${marcaA1}/media/${randomUUID()}-r2.jpg`;
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [editorA.id, path]);
    for (const user of [ana, adminA, editorA, clienteA, berta, gema, ajeno, superadmin, null]) {
      await denied(db, user, `select * from private.media_object_locations`, [], /permission denied/);
      await denied(db, user, `delete from private.media_object_locations`, [], /permission denied/);
      await denied(
        db,
        user,
        `select public.media_storage_register_upload($1, $2)`,
        [user?.id ?? null, `${orgA}/${marcaA1}/media/x.jpg`],
        /permission denied/,
      );
      await denied(db, user, `select public.media_storage_forget_paths($1::text[])`, [[path]], /permission denied/);
    }
  });

  it('una organización no apunta subidas a R2 en otra, ni con la ruta de una marca ajena', async () => {
    await expect(
      asService(db, `select public.media_storage_register_upload($1, $2)`, [
        berta.id,
        `${orgA}/${marcaA1}/media/x.jpg`,
      ]),
    ).rejects.toThrow(/edita la marca/);
    await expect(
      asService(db, `select public.media_storage_register_upload($1, $2)`, [
        berta.id,
        `${orgB}/${marcaA1}/media/x.jpg`,
      ]),
    ).rejects.toThrow(/ninguna marca/);
    await expect(
      asService(db, `select public.media_storage_register_upload($1, $2)`, [
        clienteA.id,
        `${orgA}/${marcaA1}/media/x.jpg`,
      ]),
    ).rejects.toThrow(/edita la marca/);
  });

  it('el almacén de un recurso lo ve quien ve la marca, y no se cambia desde el cliente', async () => {
    const path = `${orgA}/${marcaA1}/media/${randomUUID()}-r2.jpg`;
    await asService(db, `select public.media_storage_register_upload($1, $2)`, [editorA.id, path]);
    await as(
      db,
      editorA,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
       values ($1, $2, 'image', $3, 'r2.jpg', 'image/jpeg', 10)`,
      [marcaA1, orgA, path],
    );
    const [visto] = await as<{ storage_backend: string }>(
      db,
      clienteA,
      `select storage_backend from public.media_assets where storage_path = $1`,
      [path],
    );
    expect(visto?.storage_backend).toBe('r2');
    expect(await as(db, berta, `select 1 from public.media_assets where storage_path = $1`, [path])).toEqual([]);
    await denied(
      db,
      ana,
      `update public.media_assets set storage_backend = 'supabase' where storage_path = $1`,
      [path],
      /permission denied/,
    );
    // Al borrarlo, la cola (que solo ve quien edita la marca) recuerda que estaba en R2.
    await as(db, editorA, `delete from public.media_assets where storage_path = $1`, [path]);
    expect(await as(db, berta, `select 1 from public.storage_cleanup_queue where storage_path = $1`, [path])).toEqual(
      [],
    );
    expect(
      (
        await as<{ b: string }>(
          db,
          editorA,
          `select storage_backend as b from public.storage_cleanup_queue where storage_path = $1`,
          [path],
        )
      )[0]?.b,
    ).toBe('r2');
    await denied(
      db,
      editorA,
      `update public.storage_cleanup_queue set storage_backend = 'supabase'`,
      [],
      /permission denied/,
    );
  });
});

describe('importar publicaciones y plantillas de diseño (20261201010000)', () => {
  let cuentaA1: string, cuentaB1: string;
  let importadaA1: string, importadaB1: string;
  let runA1: string;

  const connect = async (user: TestUser, brand: string, externalId: string) =>
    (
      await serviceRpc<{ id: string }>(db, 'social_account_connect', {
        p_user_id: user.id,
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
      })
    ).id;

  const doc = (assetId?: string) => ({
    schemaVersion: 3,
    canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
    layers: assetId
      ? [
          {
            id: 'foto',
            type: 'image',
            x: 0,
            y: 0,
            width: 1080,
            height: 1080,
            source: { kind: 'asset', assetId },
          },
        ]
      : [],
    copy: { caption: '', hashtags: [], mentions: [], altText: '', callToAction: { label: '', url: '' } },
  });
  const template = (permalink: string, assetId?: string) =>
    JSON.stringify([
      {
        key: 'plato-del-dia',
        name: 'Plato',
        network: 'instagram',
        format: 'post',
        document: doc(assetId),
        analysis: { examples: [{ permalink }, { permalink }] },
      },
    ]);
  const manualTemplate = (analysis: Record<string, unknown>, key = 'cartel-manual') =>
    JSON.stringify([
      {
        key,
        name: 'Cartel manual',
        network: 'instagram',
        format: 'post',
        source: 'manual',
        document: doc(),
        analysis,
      },
    ]);
  const deliver = `select public.deliver_design_templates($1, $2::jsonb)`;

  beforeAll(async () => {
    // Las mismas cuentas que en la publicación (volver a conectarlas solo renueva el token).
    cuentaA1 = await connect(ana, marcaA1, '1001');
    cuentaB1 = await connect(berta, marcaB1, '2001');
    const [run] = await as<{ data: { id: string } }>(
      db,
      ana,
      `select to_jsonb(r) as data from public.social_import_begin($1, false) r`,
      [cuentaA1],
    );
    runA1 = run!.data.id;
    const [runB] = await as<{ data: { id: string } }>(
      db,
      berta,
      `select to_jsonb(r) as data from public.social_import_begin($1, false) r`,
      [cuentaB1],
    );
    for (const [id, brand] of [
      [runA1, marcaA1],
      [runB!.data.id, marcaB1],
    ] as const) {
      await serviceRpc(db, 'social_import_save_page', {
        p_run_id: id,
        p_items: [{ id: `m-${brand}`, media_type: 'IMAGE', permalink: `https://ig.invalid/p/${brand}/` }],
        p_from_cursor: null,
        p_next_cursor: 'siguiente',
      });
    }
    importadaA1 = `https://ig.invalid/p/${marcaA1}/`;
    importadaB1 = `https://ig.invalid/p/${marcaB1}/`;
  });

  it('una organización no ve las importaciones, las publicaciones importadas ni las plantillas de otra', async () => {
    await as(db, ana, deliver, [marcaA1, template(importadaA1)]);
    await as(db, berta, deliver, [marcaB1, template(importadaB1)]);
    for (const table of ['social_import_runs', 'social_imported_media', 'brand_design_templates']) {
      const deB = await as(db, berta, `select distinct organization_id::text as org from public.${table}`);
      expect(
        deB.map((r) => r.org),
        table,
      ).toEqual([orgB]);
      const deA = await as(db, ana, `select distinct organization_id::text as org from public.${table}`);
      expect(
        deA.map((r) => r.org),
        table,
      ).toEqual([orgA]);
      expect(await as(db, superadmin, `select 1 from public.${table}`), table).toEqual([]);
      expect(await as(db, ajeno, `select 1 from public.${table}`), table).toEqual([]);
      // Dentro de la organización: quien no ve la marca no ve nada; quien la ve (cliente), sí.
      expect(await as(db, sinMarcaA, `select 1 from public.${table}`), table).toEqual([]);
      expect((await as(db, clienteA, `select 1 from public.${table}`)).length, table).toBeGreaterThan(0);
    }
  });

  it('nadie escribe estas tablas desde la API', async () => {
    for (const table of ['social_import_runs', 'social_imported_media', 'brand_design_templates']) {
      await denied(db, ana, `delete from public.${table}`, [], /permission denied/);
      await denied(db, ana, `update public.${table} set id = id`, [], /permission denied/);
    }
    await denied(
      db,
      ana,
      `insert into public.social_imported_media (social_account_id, brand_id, organization_id, external_id, media_type)
       values ($1, $2, $3, 'x', 'IMAGE')`,
      [cuentaA1, marcaA1, orgA],
      /permission denied/,
    );
    await denied(
      db,
      ana,
      `insert into public.brand_design_templates (brand_id, organization_id, template_key, name, network, format, document)
       values ($1, $2, 'x', 'x', 'instagram', 'post', '{"schemaVersion":3}')`,
      [marcaA1, orgA],
      /permission denied/,
    );
  });

  it('solo quien gestiona la marca importa, y nunca en la cuenta de otra organización', async () => {
    await denied(db, editorA, `select public.social_import_begin($1, false)`, [cuentaA1], /gestiona/);
    await denied(db, clienteA, `select public.social_import_begin($1, false)`, [cuentaA1], /gestiona/);
    await denied(db, ana, `select public.social_import_begin($1, false)`, [cuentaB1], /gestiona/);
    await denied(db, berta, `select public.social_import_pause($1)`, [runA1], /gestiona/);
    await denied(db, null, `select public.social_import_begin($1, false)`, [cuentaA1], /permission denied/);
  });

  it('las plantillas las entrega quien edita la marca, con recursos y ejemplos de esa marca', async () => {
    await denied(db, clienteA, deliver, [marcaA1, template(importadaA1)], /edita/);
    await denied(db, berta, deliver, [marcaA1, template(importadaA1)], /edita/);
    // Un ejemplo que no es una publicación importada de la marca (ni la de otra) se rechaza.
    await denied(db, ana, deliver, [marcaA1, template(importadaB1)], /ejemplo/);
    await denied(db, ana, deliver, [marcaA1, template('https://ig.invalid/inventada')], /ejemplo/);
    // Un recurso de otra marca no vale en el documento.
    await denied(db, ana, deliver, [marcaA1, template(importadaA1, assetB1)], /recurso/);
    // Tampoco escondido en otra página de un documento v4 (carrusel).
    const paged = JSON.parse(template(importadaA1)) as { document: Record<string, unknown> }[];
    const v3 = doc(assetB1);
    paged[0]!.document = {
      schemaVersion: 4,
      canvas: v3.canvas,
      pages: [
        { id: 'p1', layers: [] },
        { id: 'p2', layers: v3.layers },
      ],
      copy: v3.copy,
    };
    await denied(db, ana, deliver, [marcaA1, JSON.stringify(paged)], /recurso/);
    // Con recursos de la marca, un documento v4 (carrusel) sí se guarda.
    const ownV3 = doc(assetA1);
    paged[0]!.document = {
      schemaVersion: 4,
      canvas: ownV3.canvas,
      pages: [
        { id: 'p1', layers: [] },
        { id: 'p2', layers: ownV3.layers },
      ],
      copy: ownV3.copy,
    };
    await as(db, editorA, deliver, [marcaA1, JSON.stringify(paged)]);
    // Entregarla otra vez la actualiza, no la duplica.
    await as(db, editorA, deliver, [marcaA1, template(importadaA1, assetA1)]);
    expect(
      await as(db, ana, `select 1 from public.brand_design_templates where brand_id = $1`, [marcaA1]),
    ).toHaveLength(1);
  });

  it('las plantillas importadas exigen de 2 a 3 ejemplos y no llevan referencias', async () => {
    const importada = (analysis: Record<string, unknown>) =>
      JSON.stringify([{ ...JSON.parse(template(importadaA1))[0], key: 'sin-ejemplos', analysis }]);
    await denied(db, ana, deliver, [marcaA1, importada({})], /2 a 3 ejemplos/);
    await denied(db, ana, deliver, [marcaA1, importada({ examples: [{ permalink: importadaA1 }] })], /2 a 3 ejemplos/);
    await denied(
      db,
      ana,
      deliver,
      [
        marcaA1,
        importada({
          examples: [{ permalink: importadaA1 }, { permalink: importadaA1 }],
          references: [{ url: 'https://instagram.com/p/a/', note: 'x' }],
        }),
      ],
      /no lleva referencias/,
    );
  });

  it('una plantilla manual se acepta sin publicaciones importadas, con referencias públicas con nota', async () => {
    const referencias = [
      { url: 'https://www.instagram.com/p/EJEMPLO1/', note: 'Titular sobre foto' },
      { url: 'https://facebook.com/ejemplo/posts/2', note: 'Lo mismo en Facebook' },
    ];
    const [row] = await as<{ source: string; analysis: { references: unknown[] } }>(
      db,
      ana,
      `select t.source, t.analysis from public.deliver_design_templates($1, $2::jsonb) t`,
      [marcaA1, manualTemplate({ references: referencias })],
    );
    expect(row!.source).toBe('manual');
    expect(row!.analysis.references).toHaveLength(2);
    // Sin referencias ni ejemplos también vale (de 0 a 10); entregarla otra vez la actualiza.
    await as(db, editorA, deliver, [marcaA1, manualTemplate({})]);
    expect(
      await as(
        db,
        ana,
        `select 1 from public.brand_design_templates where brand_id = $1 and template_key = 'cartel-manual'`,
        [marcaA1],
      ),
    ).toHaveLength(1);
    // Si trae ejemplos importados, se validan como siempre.
    await as(db, ana, deliver, [marcaA1, manualTemplate({ examples: [{ permalink: importadaA1 }] }, 'con-ejemplo')]);
    await denied(
      db,
      ana,
      deliver,
      [marcaA1, manualTemplate({ examples: [{ permalink: importadaB1 }] }, 'ajeno')],
      /ejemplo/,
    );
    // Enlaces que no valen: no https, otro dominio, parecido, con usuario.
    for (const url of [
      'http://instagram.com/p/a/',
      'https://otra.example/p/a/',
      'https://instagram.com.malo.example/p/a/',
      'https://usuario@instagram.com/p/a/',
      'https://notinstagram.com/p/a/',
    ]) {
      await denied(db, ana, deliver, [marcaA1, manualTemplate({ references: [{ url, note: 'x' }] })], /referencia/);
    }
    // Sin nota, o más de 10.
    await denied(
      db,
      ana,
      deliver,
      [marcaA1, manualTemplate({ references: [{ url: referencias[0]!.url, note: '' }] })],
      /referencia/,
    );
    await denied(
      db,
      ana,
      deliver,
      [marcaA1, manualTemplate({ references: Array.from({ length: 11 }, () => referencias[0]) })],
      /10 referencias/,
    );
    // La web de la marca sí vale (y sus subdominios); un dominio que solo acaba igual, no.
    await db.query(`update public.brands set website = 'https://www.casa-ejemplo.invalid' where id = $1`, [marcaA1]);
    await as(db, ana, deliver, [
      marcaA1,
      manualTemplate({ references: [{ url: 'https://casa-ejemplo.invalid/carta', note: 'Carta' }] }, 'con-web'),
    ]);
    await as(db, ana, deliver, [
      marcaA1,
      manualTemplate({ references: [{ url: 'https://blog.casa-ejemplo.invalid/', note: 'Blog' }] }, 'con-blog'),
    ]);
    await denied(
      db,
      ana,
      deliver,
      [marcaA1, manualTemplate({ references: [{ url: 'https://xcasa-ejemplo.invalid/', note: 'x' }] })],
      /referencia/,
    );
    // El origen debe ser uno de los dos.
    const raro = JSON.stringify([{ ...JSON.parse(manualTemplate({}))[0], source: 'otro' }]);
    await denied(db, ana, deliver, [marcaA1, raro], /origen/);
    // Aislamiento: ni quien no edita ni otra organización la entregan, y la de A no la ve B.
    await denied(db, clienteA, deliver, [marcaA1, manualTemplate({})], /edita/);
    await denied(db, berta, deliver, [marcaA1, manualTemplate({})], /edita/);
    expect(
      await as(db, berta, `select 1 from public.brand_design_templates where source = 'manual' and brand_id = $1`, [
        marcaA1,
      ]),
    ).toEqual([]);
    // Limpieza: las pruebas siguientes parten de las plantillas importadas.
    await db.query(`delete from public.brand_design_templates where source = 'manual'`);
    await db.query(`update public.brands set website = '' where id = $1`, [marcaA1]);
  });

  it('las funciones del servidor no se ejecutan desde la API', async () => {
    const calls: Array<[string, unknown[]]> = [
      [`select public.social_import_claim($1, $2)`, [runA1, ana.id]],
      [`select public.social_import_save_page($1, '[]'::jsonb, null, null)`, [runA1]],
      [`select public.social_import_pending_copies($1)`, [runA1]],
      [`select public.social_import_check_space($1, 1)`, [runA1]],
      [`select public.social_import_end_step($1)`, [runA1]],
      [`select public.social_import_mark_copy($1, gen_random_uuid(), 'failed')`, [runA1]],
      [`select public.social_import_register_copy($1, $2, gen_random_uuid(), '[]'::jsonb)`, [runA1, ana.id]],
    ];
    for (const user of [ana, editorA, null]) {
      for (const [sql, params] of calls) await denied(db, user, sql, params, /permission denied/);
    }
  });

  it('quien edita la marca borra una plantilla; quien solo la ve, no; y nadie la de otra marca', async () => {
    const [t] = await as<{ id: string }>(db, ana, `select id from public.brand_design_templates where brand_id = $1`, [
      marcaA1,
    ]);
    await denied(db, clienteA, `select public.delete_design_template($1)`, [t!.id], /edita/);
    await denied(db, berta, `select public.delete_design_template($1)`, [t!.id], /edita/);
    await as(db, editorA, `select public.delete_design_template($1)`, [t!.id]);
    expect(await as(db, ana, `select 1 from public.brand_design_templates where brand_id = $1`, [marcaA1])).toEqual([]);
  });

  it('al borrar la cuenta conectada se van sus importaciones y publicaciones importadas', async () => {
    expect(
      await db.query(`select 1 from public.social_imported_media where social_account_id = $1`, [cuentaB1]),
    ).toHaveLength(1);
    await db.query(`delete from public.scheduled_publications where social_account_id = $1`, [cuentaB1]);
    await db.query(`delete from public.social_accounts where id = $1`, [cuentaB1]);
    expect(
      await db.query(`select 1 from public.social_imported_media where social_account_id = $1`, [cuentaB1]),
    ).toEqual([]);
    expect(await db.query(`select 1 from public.social_import_runs where social_account_id = $1`, [cuentaB1])).toEqual(
      [],
    );
  });
});
