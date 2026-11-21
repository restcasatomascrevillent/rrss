// Utilidades para probar las migraciones REALES contra un Postgres de verdad.
//
// Por defecto se usa PGlite (Postgres compilado a WASM, en memoria): no hace
// falta instalar nada y vale para CI. Con DATABASE_URL (un superusuario de un
// Postgres local) se crea una base de datos temporal en ese servidor.
// Nunca se conecta a Supabase.
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const SCAFFOLD = path.join(ROOT, 'supabase/tests/andamiaje.sql');

export type Row = Record<string, unknown>;

export interface TestUser {
  id: string;
  email: string;
}

export interface Db {
  engine: 'pglite' | 'postgres';
  /** Ejecuta SQL (una o varias sentencias) como superusuario. */
  exec(sql: string): Promise<void>;
  /** Ejecuta una sentencia como superusuario. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  /**
   * Otra sesión contra la misma base de datos, para probar bloqueos entre
   * transacciones simultáneas. Solo existe con Postgres (DATABASE_URL): PGlite
   * tiene una única conexión.
   */
  connect?: () => Promise<Db>;
}

async function openPglite(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  return {
    engine: 'pglite',
    exec: async (sql) => {
      await pg.exec(sql);
    },
    query: async <T extends Row>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows,
    close: () => pg.close(),
  };
}

async function openPostgres(adminUrl: string): Promise<Db> {
  const { default: pgLib } = await import('pg');
  const name = `rrss_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pgLib.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const session = async (): Promise<Db> => {
    const client = new pgLib.Client({ connectionString: url.toString() });
    await client.connect();
    return {
      engine: 'postgres',
      exec: async (sql) => {
        await client.query(sql);
      },
      query: async <T extends Row>(sql: string, params: unknown[] = []) =>
        (await client.query(sql, params)).rows as T[],
      close: () => client.end(),
    };
  };
  const main = await session();
  return {
    ...main,
    connect: session,
    close: async () => {
      await main.close();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Base de datos nueva con el andamiaje de Supabase y todas las migraciones aplicadas.
 *
 * Por defecto, las organizaciones nuevas nacen en el plan «Heredado» (sin
 * límites de marcas, personas ni almacenamiento, todas las funciones y sin
 * cupo de IA del plan): es como funcionaba todo antes de los planes, y así las
 * pruebas de cada función no dependen de los límites comerciales. Las pruebas
 * de planes piden `{ plans: 'real' }` para tener el plan por defecto de verdad.
 */
export async function createDb(options: { plans?: 'legacy' | 'real' } = {}): Promise<Db> {
  const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite();
  await db.exec(await readFile(SCAFFOLD, 'utf8'));
  for (const file of await migrationFiles()) {
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  if ((options.plans ?? 'legacy') === 'legacy') {
    await db.exec(`update public.plans set is_default = false where is_default;
                   update public.plans set is_default = true where code = 'legacy';`);
  }
  return db;
}

export async function createUser(db: Db, email: string, fullName = ''): Promise<TestUser> {
  const [row] = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`,
    [email, fullName],
  );
  return { id: row!.id, email };
}

/**
 * Ejecuta una sentencia con la identidad de un usuario, igual que la API de
 * Supabase: rol `authenticated` (o `anon`) y el JWT en `request.jwt.claims`.
 * Si la sentencia falla, la transacción se deshace y el error se propaga.
 */
export async function as<T extends Row = Row>(
  db: Db,
  user: TestUser | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const role = user ? 'authenticated' : 'anon';
  const claims = user ? { sub: user.id, email: user.email, role } : { role };
  return runAs<T>(db, role, claims, sql, params);
}

/**
 * Ejecuta una sentencia como lo haría el servidor con la clave de servicio:
 * rol `service_role`, sin usuario.
 */
export async function asService<T extends Row = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return runAs<T>(db, 'service_role', { role: 'service_role' }, sql, params);
}

async function runAs<T extends Row>(
  db: Db,
  role: 'anon' | 'authenticated' | 'service_role',
  claims: Row,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await db.exec(`set local role ${role}`);
    const rows = await db.query<T>(sql, params);
    await db.exec('commit');
    return rows;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

/** La sentencia debe fallar con un error que cumpla el patrón. */
export async function denied(
  db: Db,
  user: TestUser | null,
  sql: string,
  params: unknown[] = [],
  pattern: RegExp = /permission denied|row-level security|permiso|Solo/i,
): Promise<void> {
  let error: unknown;
  try {
    await as(db, user, sql, params);
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error(`Se esperaba un rechazo y la sentencia se ejecutó: ${sql}`);
  const message = error instanceof Error ? error.message : String(error);
  if (!pattern.test(message)) throw new Error(`Rechazo inesperado («${message}») en: ${sql}`);
}

/**
 * Sentencia que llama a una función de `public` con argumentos por nombre y
 * devuelve el resultado como JSON, igual que lo entrega la API (los bigint
 * como números, las fechas como texto). Los objetos viajan como JSON.
 */
export function rpcStatement(fn: string, args: Record<string, unknown>): { sql: string; params: unknown[] } {
  const names = Object.keys(args).filter((name) => args[name] !== undefined);
  const params = names.map((name) => {
    const value = args[name];
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? JSON.stringify(value) : value;
  });
  const list = names.map((name, i) => `${name} => $${i + 1}`).join(', ');
  return { sql: `select to_jsonb(r) as data from public.${fn}(${list}) r`, params };
}

/** Llama a una función con la clave de servicio y devuelve su fila como JSON. */
export async function serviceRpc<T = Row>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { sql, params } = rpcStatement(fn, args);
  const rows = await asService<{ data: T }>(db, sql, params);
  return rows[0]!.data;
}

/** Fija el cupo mensual de IA de una organización (lo hace un superadministrador). */
export async function setAiQuota(db: Db, platformAdmin: TestUser, orgId: string, limitMicros: number): Promise<void> {
  await as(db, platformAdmin, `select public.admin_set_ai_quota($1, $2)`, [orgId, limitMicros]);
}

export async function createOrg(db: Db, user: TestUser, name: string, kind = 'business'): Promise<string> {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `select id from public.create_organization($1, $2::public.org_kind)`,
    [name, kind],
  );
  return row!.id;
}

export async function createBrand(db: Db, user: TestUser, orgId: string, name: string): Promise<string> {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.brands (organization_id, name) values ($1, $2) returning id`,
    [orgId, name],
  );
  return row!.id;
}

/** Invita y acepta: es la única vía real de entrar en una organización. */
export async function join(
  db: Db,
  inviter: TestUser,
  invitee: TestUser,
  orgId: string,
  orgRole: string,
  brandId: string | null = null,
  brandRole: string | null = null,
): Promise<void> {
  const [inv] = await as<{ token: string }>(
    db,
    inviter,
    `select token from public.create_invitation($1, $2, $3::public.org_role, $4, $5::public.brand_role)`,
    [orgId, invitee.email, orgRole, brandId, brandRole],
  );
  await as(db, invitee, `select public.accept_invitation($1)`, [inv!.token]);
}

export function assetPath(orgId: string, brandId: string, name = `${randomUUID()}.jpg`): string {
  return `${orgId}/${brandId}/media/${name}`;
}

export async function addAsset(db: Db, user: TestUser, orgId: string, brandId: string): Promise<string> {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
     values ($1, $2, 'image', $3, 'foto.jpg', 'image/jpeg', 1234) returning id`,
    [brandId, orgId, assetPath(orgId, brandId)],
  );
  return row!.id;
}
