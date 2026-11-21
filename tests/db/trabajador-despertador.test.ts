// El trabajador de medios en Fly.io (supabase/migrations/20261208010000_media_worker_wake.sql):
//   · el despertador contra la cola REAL y un pg_net simulado: `net.http_post`
//     apunta cada llamada en una tabla en vez de salir a la red. Vault es el
//     sustituto del andamiaje (supabase/tests/andamiaje.sql);
//   · la integración «Trabajador de medios (Fly.io)» de Plataforma →
//     Integraciones, de donde el despertador lee el token, la app y la máquina;
//   · «Probar conexión» contra una API de Fly simulada.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateSetting } from '../../supabase/functions/_shared/integrations/catalog.ts';
import { probeIntegration, type ProbeFetch } from '../../supabase/functions/_shared/integrations/probes.ts';
import {
  as,
  asService,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  serviceRpc,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

interface Call extends Row {
  url: string;
  headers: Record<string, string>;
  body: Row;
  timeout_milliseconds: number;
}

const FLY_TOKEN = 'FlyV1 fm2_tokendeprueba0123,fm2_otrapartedeprueba';
const START_URL = 'https://api.machines.dev/v1/apps/rrss-worker/machines/148e21dc7d0189/start';

let db: Db;
let ana: TestUser, root: TestUser;
let org: string, marca: string;
let n = 0;

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test');
  root = await createUser(db, 'root@a.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
  org = await createOrg(db, ana, 'Empresa A');
  marca = await createBrand(db, ana, org, 'Marca A');
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from public.jobs;
                 update private.media_worker_wake_state set last_requested_at = null, last_request_id = null;`);
  if ((await db.query(`select to_regnamespace('net') as s`))[0]!.s) await db.exec(`delete from net.calls`);
});

/** pg_net simulado, con la misma firma que `net.http_post` de Supabase. */
async function installNet(): Promise<void> {
  await db.exec(`
    create schema if not exists net;
    create table if not exists net.calls (
      id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer
    );
    create or replace function net.http_post(
      url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000
    ) returns bigint language sql as $$
      insert into net.calls (url, body, headers, timeout_milliseconds) values ($1, $2, $4, $5) returning id
    $$;`);
}

async function setSecret(name: string, value: string | null): Promise<void> {
  await db.query(`delete from vault.secrets where name = $1`, [name]);
  if (value !== null) await db.query(`select vault.create_secret($1, $2)`, [value, name]);
}

async function setFlySecrets(token: string | null = FLY_TOKEN): Promise<void> {
  await setSecret('rrss_fly_api_token', token);
  await setSecret('rrss_fly_app', 'rrss-worker');
  await setSecret('rrss_fly_machine_id', '148e21dc7d0189');
}

const calls = () => db.query<Call>(`select url, headers, body, timeout_milliseconds from net.calls order by id`);
const wake = async () => (await db.query<{ r: string | null }>(`select private.media_worker_wake() as r`))[0]!.r;
const forgetLastWake = () => db.exec(`update private.media_worker_wake_state set last_requested_at = null`);

/** Encola como lo hace el servidor (clave de servicio). */
function enqueue(kind: string, extra: Row = {}): Promise<Row> {
  n += 1;
  return serviceRpc(db, 'enqueue_job', {
    p_organization_id: org,
    p_brand_id: marca,
    p_kind: kind,
    p_payload: {},
    p_idempotency_key: `despertador-${n}`,
    ...extra,
  });
}

describe('sin pg_net, sin Vault o sin secretos: avisa y no llama a nada', () => {
  it('sin pg_net, encolar funciona y no hay llamada', async () => {
    expect((await db.query(`select to_regnamespace('net') as s`))[0]!.s).toBeNull();
    await setFlySecrets();
    const job = await enqueue('media.reel.template');
    expect(job.status).toBe('queued');
    expect(await wake()).toBeNull();
  });

  it('con pg_net pero sin los tres secretos, no llama', async () => {
    await installNet();
    for (const missing of ['rrss_fly_api_token', 'rrss_fly_app', 'rrss_fly_machine_id']) {
      await setFlySecrets();
      await setSecret(missing, null);
      await enqueue('media.image.process');
      expect(await wake()).toBeNull();
    }
    await setFlySecrets();
    await setSecret('rrss_fly_api_token', '   ');
    expect(await wake()).toBeNull();
    expect(await calls()).toEqual([]);
  });

  it('una app o máquina con formato raro no acaba en la URL', async () => {
    await installNet();
    await setFlySecrets();
    await setSecret('rrss_fly_app', 'rrss-worker/../otra');
    await enqueue('media.reel.template');
    expect(await wake()).toBeNull();
    await setFlySecrets();
    await setSecret('rrss_fly_machine_id', '148e21dc7d0189?x=1');
    expect(await wake()).toBeNull();
    expect(await calls()).toEqual([]);
  });
});

describe('con pg_net y los secretos', () => {
  beforeAll(async () => {
    await installNet();
  });
  beforeEach(async () => {
    await setFlySecrets();
  });

  it('al encolar un trabajo del trabajador, arranca la máquina con la API de Fly', async () => {
    await enqueue('media.reel.template');
    const [call, ...rest] = await calls();
    expect(rest).toEqual([]);
    expect(call!.url).toBe(START_URL);
    // Los tokens de `fly tokens create` («FlyV1 …») van tal cual.
    expect(call!.headers.Authorization).toBe(FLY_TOKEN);
    expect(call!.body).toEqual({});
    const [state] = await db.query<{ last_requested_at: string | null; last_request_id: string | null }>(
      `select last_requested_at, last_request_id::text from private.media_worker_wake_state`,
    );
    expect(state!.last_requested_at).not.toBeNull();
    expect(state!.last_request_id).not.toBeNull();
  });

  it('también despierta con la extracción de fuentes y el informe en PDF', async () => {
    await enqueue('source.extract');
    await forgetLastWake();
    await db.exec(`delete from public.jobs`);
    await enqueue('media.report.pdf');
    expect((await calls()).length).toBe(2);
  });

  it('un token que no es FlyV1 viaja como Bearer', async () => {
    await setSecret('rrss_fly_api_token', 'fo1_tokenantiguo');
    await enqueue('media.video.derivatives');
    expect((await calls())[0]!.headers.Authorization).toBe('Bearer fo1_tokenantiguo');
  });

  it('los trabajos de otros (publicar, analítica, IA) no la despiertan', async () => {
    for (const kind of ['social.publish', 'analytics.capture', 'analytics.report', 'ai.media.poll']) {
      await enqueue(kind);
    }
    expect(await calls()).toEqual([]);
    expect(await wake()).toBeNull();
  });

  it('un trabajo con espera (run_after futuro) no despierta al encolarlo; el cron lo hará cuando toque', async () => {
    await enqueue('media.reel.template', { p_run_after: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await calls()).toEqual([]);
    expect(await wake()).toBeNull();
    await db.exec(`update public.jobs set run_after = now() - interval '1 second'`);
    expect(await wake()).not.toBeNull();
    expect((await calls()).length).toBe(1);
  });

  it('sin ráfagas: varios encolados seguidos hacen una sola llamada; pasados 10 s, otra', async () => {
    await enqueue('media.reel.template');
    await enqueue('media.image.process');
    await enqueue('media.image.process');
    expect(await wake()).toBeNull();
    expect((await calls()).length).toBe(1);

    await db.exec(`update private.media_worker_wake_state set last_requested_at = now() - interval '11 seconds'`);
    expect(await wake()).not.toBeNull();
    expect((await calls()).length).toBe(2);
  });

  it('idempotente: con la máquina trabajando (reserva viva) no vuelve a llamar', async () => {
    await enqueue('media.reel.template');
    await forgetLastWake();
    await db.exec(`delete from net.calls`);
    const claimed = await asService(db, `select id from public.claim_jobs('media-fly-1', null, 1, 300)`);
    expect(claimed.length).toBe(1);

    await enqueue('media.image.process');
    expect(await wake()).toBeNull();
    expect(await calls()).toEqual([]);

    // Si el trabajador murió (reserva caducada), el cron lo vuelve a arrancar.
    await db.exec(`update public.jobs set locked_until = now() - interval '1 second' where status = 'running'`);
    expect(await wake()).not.toBeNull();
    expect((await calls()).length).toBe(1);
  });

  it('sin nada pendiente, el cron no llama', async () => {
    expect(await wake()).toBeNull();
    await enqueue('media.reel.template');
    await forgetLastWake();
    await db.exec(`update public.jobs set status = 'cancelled', finished_at = now()`);
    expect(await wake()).toBeNull();
    expect((await calls()).length).toBe(1);
  });

  it('un fallo al despertar nunca impide encolar', async () => {
    await db.exec(`create or replace function net.http_post(
        url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
        headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000
      ) returns bigint language plpgsql as $$ begin raise exception 'pg_net caído'; end $$;`);
    try {
      const job = await enqueue('media.reel.template');
      expect(job.status).toBe('queued');
      // La marca de la última llamada no se queda puesta: el cron lo reintenta.
      const [state] = await db.query(`select last_requested_at from private.media_worker_wake_state`);
      expect(state!.last_requested_at).toBeNull();
    } finally {
      await installNet();
    }
  });
});

describe('desde Plataforma → Integraciones', () => {
  beforeAll(async () => {
    await installNet();
  });

  it('el superadministrador pega token, app y máquina; el despertador los usa antes que los secretos sueltos', async () => {
    await setFlySecrets('FlyV1 fm2_secretosuelto0000');
    await setSecret('rrss_fly_app', 'otra-app');
    await as(db, root, `select public.admin_set_integration_setting('FLY_APP', 'rrss-worker-staging')`);
    await as(db, root, `select public.admin_set_integration_setting('FLY_MACHINE_ID', '0e286039f42e86')`);
    await as(db, root, `select public.admin_set_integration_setting('FLY_API_TOKEN', $1)`, [FLY_TOKEN]);
    try {
      // El token va a Vault, no a la tabla.
      const [row] = await db.query<{ plain_value: string | null; vault_secret_id: string | null }>(
        `select plain_value, vault_secret_id from private.integration_settings where setting_key = 'FLY_API_TOKEN'`,
      );
      expect(row).toMatchObject({ plain_value: null });
      expect(row!.vault_secret_id).not.toBeNull();

      await enqueue('media.reel.template');
      const [call] = await calls();
      expect(call!.url).toBe('https://api.machines.dev/v1/apps/rrss-worker-staging/machines/0e286039f42e86/start');
      expect(call!.headers.Authorization).toBe(FLY_TOKEN);

      // Lo que falte en la integración se toma de los secretos sueltos.
      await as(db, root, `select public.admin_delete_integration_setting('FLY_API_TOKEN')`);
      await forgetLastWake();
      await db.exec(`delete from public.jobs`);
      await enqueue('media.reel.template');
      expect((await calls())[1]!.headers.Authorization).toBe('FlyV1 fm2_secretosuelto0000');
    } finally {
      for (const key of ['FLY_APP', 'FLY_MACHINE_ID', 'FLY_API_TOKEN']) {
        await as(db, root, `select public.admin_delete_integration_setting($1)`, [key]);
      }
    }
  });

  it('el resultado de «Probar conexión» se anota con la integración nueva', async () => {
    await asService(db, `select public.integration_record_test($1, 'media_worker', true, 'máquina parada')`, [root.id]);
    const [test] = await db.query(
      `select ok, message from private.integration_tests where integration = 'media_worker'`,
    );
    expect(test).toEqual({ ok: true, message: 'máquina parada' });
  });

  it('valida la forma del token, la app y la máquina antes de guardarlos', () => {
    expect(validateSetting('FLY_API_TOKEN', FLY_TOKEN)).toBeNull();
    expect(validateSetting('FLY_API_TOKEN', 'fo1_tokenantiguo0123')).toBeNull();
    expect(validateSetting('FLY_API_TOKEN', 'fm2_sinprefijo0123456')).toMatch(/FlyV1/);
    expect(validateSetting('FLY_APP', 'rrss-worker')).toBeNull();
    expect(validateSetting('FLY_APP', 'RRSS worker')).not.toBeNull();
    expect(validateSetting('FLY_MACHINE_ID', '148e21dc7d0189')).toBeNull();
    expect(validateSetting('FLY_MACHINE_ID', '148e21dc7d0189/start')).not.toBeNull();
  });
});

describe('Probar conexión del trabajador (API de Fly simulada)', () => {
  const env = { FLY_API_TOKEN: FLY_TOKEN, FLY_APP: 'rrss-worker', FLY_MACHINE_ID: '148e21dc7d0189' };
  const machineUrl = 'https://api.machines.dev/v1/apps/rrss-worker/machines/148e21dc7d0189';
  type Seen = Array<{ url: string; init?: RequestInit }>;
  const fly =
    (status: number, body: unknown, seen: Seen = []): ProbeFetch =>
    async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    };

  it('consulta la máquina (GET, sin arrancarla) y dice su estado', async () => {
    const seen: Seen = [];
    const machine = { id: '148e21dc7d0189', state: 'stopped', region: 'fra', config: { restart: { policy: 'no' } } };
    const r = await probeIntegration('media_worker', env, { fetch: fly(200, machine, seen) });
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/estado «stopped», región fra/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(machineUrl);
    expect(seen[0]!.init?.method ?? 'GET').toBe('GET');
    expect(new Headers(seen[0]!.init?.headers).get('Authorization')).toBe(FLY_TOKEN);
    expect(r.message).not.toContain('fm2_');
  });

  it('avisa si la máquina se reinicia sola, está fuera de Fráncfort o publica puertos', async () => {
    const machine = { state: 'started', region: 'ams', config: { restart: { policy: 'always' }, services: [{}] } };
    const r = await probeIntegration('media_worker', env, { fetch: fly(200, machine) });
    expect(r.ok).toBe(true);
    // Sin el token del trabajador (20261210010000), también lo avisa.
    expect(r.checks.map((c) => c.name)).toEqual(['Máquina', 'Reinicio', 'Región', 'Puertos', 'Acceso a Supabase']);
    const withToken = await probeIntegration(
      'media_worker',
      { ...env, WORKER_GATEWAY_TOKEN: `sha256:${'0'.repeat(64)}` },
      { fetch: fly(200, machine) },
    );
    expect(withToken.checks.map((c) => c.name)).toEqual(['Máquina', 'Reinicio', 'Región', 'Puertos']);
  });

  it('token rechazado, máquina que no existe, sin red y configuración incompleta', async () => {
    expect((await probeIntegration('media_worker', env, { fetch: fly(401, {}) })).message).toMatch(/rechaza la clave/);
    expect((await probeIntegration('media_worker', env, { fetch: fly(404, {}) })).message).toMatch(/no encuentra/);
    const offline = await probeIntegration('media_worker', env, {
      fetch: async () => {
        throw new TypeError('sin red');
      },
    });
    expect(offline).toMatchObject({ ok: false });
    const incomplete = await probeIntegration('media_worker', { FLY_APP: 'rrss-worker' }, { fetch: fly(200, {}) });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.message).toMatch(/FLY_MACHINE_ID.*FLY_API_TOKEN/);
  });
});

describe('privilegios', () => {
  it('nadie lo ejecuta ni lee su estado desde la API: solo el disparador y pg_cron', async () => {
    for (const sql of [
      `select private.media_worker_wake()`,
      `select * from private.media_worker_wake_state`,
      `select private.is_media_worker_kind('media.x')`,
    ]) {
      await denied(db, ana, sql, [], /permission denied/);
      await denied(db, null, sql, [], /permission denied/);
      await expect(asService(db, sql)).rejects.toThrow(/permission denied/);
    }
  });
});
