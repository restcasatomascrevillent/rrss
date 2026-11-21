// Encargos (modo agencia), contra las migraciones reales: el ciclo completo
// pedir → tomar → entregar → pedir cambios → entregar → aceptar, el cerrojo
// entre sesiones, los permisos por rol y el modo de IA de la marca. El
// aislamiento entre organizaciones está en aislamiento.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addAsset,
  as,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  type Db,
  type TestUser,
} from './helpers';

let db: Db;
// Organización del cliente: dueña propietaria; la cuenta de la agencia es
// miembro con rol de editor en la marca; además cliente, revisor y lector.
let duena: TestUser, agencia: TestUser, cliente: TestUser, revisor: TestUser, lector: TestUser, otraSesion: TestUser;
let org: string, marca: string, otraMarca: string, asset: string, assetOtraMarca: string;

type Request = {
  id: string;
  status: string;
  content_id: string | null;
  delivered_version: number | null;
  claimed_by: string | null;
  claim_token: string | null;
  requested_by: string;
  network: string;
  format: string;
};

const DOC = (caption: string) => ({
  schemaVersion: 1,
  canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
  layers: [],
  copy: { caption, hashtags: [], mentions: [], altText: '', callToAction: { label: '', url: '' } },
});

async function rpc<T = Request>(user: TestUser, fn: string, args: Record<string, unknown>): Promise<T> {
  const names = Object.keys(args);
  const params = names.map((n) => {
    const v = args[n];
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const [row] = await as<{ data: T }>(db, user, `select to_jsonb(r) as data from public.${fn}(${list}) r`, params);
  return row!.data;
}

const pedir = (user: TestUser, extra: Record<string, unknown> = {}) =>
  rpc(user, 'create_content_request', {
    p_brand_id: marca,
    p_title: 'Post del menú de otoño',
    p_brief: 'Queremos anunciar el menú de otoño con la foto del guiso.',
    p_network: 'instagram',
    p_format: 'post',
    p_media_kind: 'image',
    p_reference_asset_ids: [asset],
    p_desired_date: '2026-12-01',
    ...extra,
  });

beforeAll(async () => {
  db = await createDb();
  duena = await createUser(db, 'duena@cliente.test', 'Dueña');
  agencia = await createUser(db, 'agencia@agencia.test', 'Agencia');
  cliente = await createUser(db, 'cliente@cliente.test', 'Cliente');
  revisor = await createUser(db, 'revisor@cliente.test', 'Revisor');
  lector = await createUser(db, 'lector@cliente.test', 'Lector');
  otraSesion = await createUser(db, 'otra@agencia.test', 'Otra persona de la agencia');

  org = await createOrg(db, duena, 'Restaurante');
  marca = await createBrand(db, duena, org, 'Marca');
  otraMarca = await createBrand(db, duena, org, 'Otra marca');
  await join(db, duena, agencia, org, 'member', marca, 'editor');
  await join(db, duena, otraSesion, org, 'member', marca, 'editor');
  await join(db, duena, cliente, org, 'member', marca, 'client');
  await join(db, duena, revisor, org, 'member', marca, 'reviewer');
  await join(db, duena, lector, org, 'member', marca, 'viewer');
  asset = await addAsset(db, duena, org, marca);
  assetOtraMarca = await addAsset(db, duena, org, otraMarca);
});

afterAll(async () => {
  await db?.close();
});

describe('ciclo de un encargo', () => {
  it('pedir → tomar → entregar → cambios → entregar → aceptar, con cada cambio apuntado', async () => {
    const pedido = await pedir(cliente);
    expect(pedido).toMatchObject({ status: 'requested', requested_by: cliente.id, content_id: null });

    // La agencia lo ve en su cola; el cliente no tiene cola (no edita).
    const cola = await as<{ id: string }>(db, agencia, `select id from public.pending_content_requests()`);
    expect(cola.map((r) => r.id)).toContain(pedido.id);
    expect(await as(db, cliente, `select id from public.pending_content_requests()`)).toEqual([]);

    const tomado = await rpc(agencia, 'take_content_request', {
      p_request_id: pedido.id,
      p_claim_token: 'sesion-1234',
    });
    expect(tomado).toMatchObject({ status: 'in_progress', claimed_by: agencia.id, claim_token: 'sesion-1234' });

    const entregado = await rpc(agencia, 'deliver_content_request', {
      p_request_id: pedido.id,
      p_data: DOC('Primera propuesta'),
      p_schema_version: 1,
      p_claim_token: 'sesion-1234',
    });
    expect(entregado).toMatchObject({ status: 'delivered', delivered_version: 1, claimed_by: null, claim_token: null });
    const [pieza] = await db.query(
      `select status, current_version, network, format, title, created_by from public.content_items where id = $1`,
      [entregado.content_id],
    );
    expect(pieza).toEqual({
      status: 'draft',
      current_version: 1,
      network: 'instagram',
      format: 'post',
      title: 'Post del menú de otoño',
      created_by: agencia.id,
    });
    const [version] = await db.query(`select change_note, data from public.content_versions where content_id = $1`, [
      entregado.content_id,
    ]);
    expect(version!.change_note).toBe('Entregado por la agencia');
    expect((version!.data as { copy: { caption: string } }).copy.caption).toBe('Primera propuesta');

    // El cliente lo ve y pide cambios; el mensaje es obligatorio.
    await denied(db, cliente, `select public.request_content_request_changes($1, '  ')`, [pedido.id], /Explica/);
    await rpc(cliente, 'request_content_request_changes', { p_request_id: pedido.id, p_message: 'Más corto' });

    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id, p_claim_token: 'sesion-5678' });
    const segunda = await rpc(agencia, 'deliver_content_request', {
      p_request_id: pedido.id,
      p_data: DOC('Más corto'),
      p_schema_version: 1,
      p_claim_token: 'sesion-5678',
      p_change_note: 'Entregado por la agencia (cambios)',
    });
    // Misma pieza, versión nueva.
    expect(segunda).toMatchObject({ status: 'delivered', content_id: entregado.content_id, delivered_version: 2 });

    const aceptado = await rpc(cliente, 'accept_content_request', { p_request_id: pedido.id });
    expect(aceptado.status).toBe('accepted');
    const [aprobada] = await db.query(`select status, current_version from public.content_items where id = $1`, [
      entregado.content_id,
    ]);
    expect(aprobada).toEqual({ status: 'approved', current_version: 2 });

    const historial = await as<{ kind: string; status: string | null; author_id: string; body: string }>(
      db,
      cliente,
      `select kind, status, author_id, body from public.content_request_comments where request_id = $1 order by created_at, id`,
      [pedido.id],
    );
    expect(historial.map((h) => [h.status, h.author_id])).toEqual([
      ['requested', cliente.id],
      ['in_progress', agencia.id],
      ['delivered', agencia.id],
      ['changes_requested', cliente.id],
      ['in_progress', agencia.id],
      ['delivered', agencia.id],
      ['accepted', cliente.id],
    ]);
    expect(historial.find((h) => h.status === 'changes_requested')!.body).toBe('Más corto');

    // Cerrado: ni se toma, ni se entrega, ni se cancela.
    await denied(db, agencia, `select public.take_content_request($1)`, [pedido.id], /no se puede tomar/);
    await denied(db, cliente, `select public.cancel_content_request($1)`, [pedido.id], /cerrado/);
  });

  it('el encargo sobre una pieza existente entrega una versión nueva de esa pieza', async () => {
    const [item] = await as<{ id: string }>(
      db,
      agencia,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Pieza propia', 'facebook', 'page_post') returning id`,
      [marca, org],
    );
    await as(db, agencia, `select public.save_content_version($1, $2::jsonb, 1)`, [item!.id, JSON.stringify(DOC('A'))]);
    const pedido = await pedir(agencia, { p_content_id: item!.id });
    // La red y el formato son los de la pieza.
    expect(pedido).toMatchObject({ content_id: item!.id, network: 'facebook', format: 'page_post' });
    // Una pieza, un encargo abierto.
    await denied(
      db,
      agencia,
      `select public.create_content_request($1, 'x', 'y', 'instagram', 'post', null, '{}', null, $2)`,
      [marca, item!.id],
      /ya tiene un encargo abierto/,
    );

    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id });
    const entregado = await rpc(agencia, 'deliver_content_request', {
      p_request_id: pedido.id,
      p_data: DOC('B'),
      p_schema_version: 1,
    });
    expect(entregado).toMatchObject({ content_id: item!.id, delivered_version: 2 });
  });

  it('aceptar exige que la pieza no haya cambiado desde la entrega', async () => {
    const pedido = await pedir(cliente);
    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id });
    const entregado = await rpc(agencia, 'deliver_content_request', {
      p_request_id: pedido.id,
      p_data: DOC('Entregado'),
      p_schema_version: 1,
    });
    // Alguien guarda otra versión después de entregar.
    await as(db, agencia, `select public.save_content_version($1, $2::jsonb, 1)`, [
      entregado.content_id,
      JSON.stringify(DOC('Retocado')),
    ]);
    await denied(db, cliente, `select public.accept_content_request($1)`, [pedido.id], /ha cambiado desde la entrega/);
    const [fila] = await db.query(`select status from public.content_requests where id = $1`, [pedido.id]);
    expect(fila!.status).toBe('delivered');
  });

  it('entregar es todo o nada', async () => {
    const pedido = await pedir(cliente);
    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id });
    // Un documento que no es un objeto: no se crea la pieza ni cambia el estado.
    const antes = await db.query(`select count(*)::int as n from public.content_items`);
    await denied(
      db,
      agencia,
      `select public.deliver_content_request($1, '[]'::jsonb, 1)`,
      [pedido.id],
      /no es válido|check constraint/,
    );
    expect(await db.query(`select count(*)::int as n from public.content_items`)).toEqual(antes);
    const [fila] = await db.query(`select status, content_id from public.content_requests where id = $1`, [pedido.id]);
    expect(fila).toEqual({ status: 'in_progress', content_id: null });
  });
});

describe('cerrojo al tomar', () => {
  it('dos sesiones no toman ni entregan el mismo encargo', async () => {
    const pedido = await pedir(cliente);
    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id, p_claim_token: 'sesion-AAAA' });

    // Otra sesión de la misma cuenta, otra persona o una llamada sin clave: rechazadas.
    await denied(
      db,
      agencia,
      `select public.take_content_request($1, 'sesion-BBBB')`,
      [pedido.id],
      /otra persona u otra sesión/,
    );
    await denied(db, otraSesion, `select public.take_content_request($1, 'sesion-AAAA')`, [pedido.id], /otra persona/);
    await denied(db, agencia, `select public.take_content_request($1)`, [pedido.id], /otra persona/);
    await denied(
      db,
      agencia,
      `select public.deliver_content_request($1, $2::jsonb, 1, 'sesion-BBBB')`,
      [pedido.id, JSON.stringify(DOC('x'))],
      /otra persona u otra sesión/,
    );
    // Ya no está en la cola de otra persona.
    const cola = await as<{ id: string }>(db, otraSesion, `select id from public.pending_content_requests()`);
    expect(cola.map((r) => r.id)).not.toContain(pedido.id);

    // La misma sesión renueva sin repetir el apunte en el historial.
    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id, p_claim_token: 'sesion-AAAA' });
    const [{ n }] = (await db.query(
      `select count(*)::int as n from public.content_request_comments where request_id = $1 and status = 'in_progress'`,
      [pedido.id],
    )) as [{ n: number }];
    expect(n).toBe(1);

    // Caducado el cerrojo, otra sesión lo puede tomar.
    await db.query(`update public.content_requests set claimed_until = now() - interval '1 minute' where id = $1`, [
      pedido.id,
    ]);
    const cola2 = await as<{ id: string }>(db, otraSesion, `select id from public.pending_content_requests()`);
    expect(cola2.map((r) => r.id)).toContain(pedido.id);
    const retomado = await rpc(otraSesion, 'take_content_request', {
      p_request_id: pedido.id,
      p_claim_token: 'sesion-CCCC',
    });
    expect(retomado).toMatchObject({ claimed_by: otraSesion.id, claim_token: 'sesion-CCCC' });

    // Soltarlo lo devuelve a la cola.
    const suelto = await rpc(otraSesion, 'release_content_request', {
      p_request_id: pedido.id,
      p_claim_token: 'sesion-CCCC',
    });
    expect(suelto).toMatchObject({ status: 'requested', claimed_by: null });
  });

  it('el cerrojo dura entre 5 minutos y 24 horas', async () => {
    const pedido = await pedir(cliente);
    await denied(db, agencia, `select public.take_content_request($1, null, 1)`, [pedido.id], /entre 5 minutos/);
    await denied(db, agencia, `select public.take_content_request($1, 'corta')`, [pedido.id], /entre 8 y 100/);
  });
});

describe('permisos por rol', () => {
  it('pedir y comentar: quien puede comentar, también el cliente; el lector no', async () => {
    for (const user of [duena, agencia, cliente, revisor]) {
      const pedido = await pedir(user);
      expect(pedido.requested_by).toBe(user.id);
      await rpc(user, 'comment_content_request', { p_request_id: pedido.id, p_body: `Hola de ${user.email}` });
    }
    await denied(db, lector, `select public.create_content_request($1, 't', 'b', 'instagram', 'post')`, [marca]);
    const pedido = await pedir(cliente);
    await denied(db, lector, `select public.comment_content_request($1, 'hola')`, [pedido.id]);
    // Pero lo ve.
    expect(await as(db, lector, `select id from public.content_requests where id = $1`, [pedido.id])).toHaveLength(1);
    await denied(db, cliente, `select public.comment_content_request($1, '   ')`, [pedido.id], /Escribe/);
  });

  it('tomar y entregar: solo quien edita la marca', async () => {
    const pedido = await pedir(cliente);
    for (const user of [cliente, revisor, lector]) {
      await denied(db, user, `select public.take_content_request($1)`, [pedido.id], /No tienes permiso/);
    }
    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id });
    for (const user of [cliente, revisor, lector]) {
      await denied(
        db,
        user,
        `select public.deliver_content_request($1, $2::jsonb, 1)`,
        [pedido.id, JSON.stringify(DOC('x'))],
        /No tienes permiso/,
      );
    }
  });

  it('aceptar y pedir cambios: quien puede aprobar; el editor no', async () => {
    const pedido = await pedir(cliente);
    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id });
    await rpc(agencia, 'deliver_content_request', { p_request_id: pedido.id, p_data: DOC('x'), p_schema_version: 1 });
    for (const user of [agencia, lector]) {
      await denied(db, user, `select public.accept_content_request($1)`, [pedido.id], /No tienes permiso/);
      await denied(
        db,
        user,
        `select public.request_content_request_changes($1, 'x')`,
        [pedido.id],
        /No tienes permiso/,
      );
    }
    // El revisor también puede aceptar.
    expect((await rpc(revisor, 'accept_content_request', { p_request_id: pedido.id })).status).toBe('accepted');
  });

  it('cancelar: quien lo pidió o quien gestiona la marca', async () => {
    const pedido = await pedir(cliente);
    await denied(db, revisor, `select public.cancel_content_request($1)`, [pedido.id], /No tienes permiso/);
    await denied(db, agencia, `select public.cancel_content_request($1)`, [pedido.id], /No tienes permiso/);
    expect((await rpc(cliente, 'cancel_content_request', { p_request_id: pedido.id })).status).toBe('cancelled');
    const otro = await pedir(cliente);
    expect((await rpc(duena, 'cancel_content_request', { p_request_id: otro.id, p_reason: 'Ya no' })).status).toBe(
      'cancelled',
    );
  });

  it('nadie escribe las tablas a mano', async () => {
    const pedido = await pedir(cliente);
    await denied(
      db,
      duena,
      `insert into public.content_requests (brand_id, organization_id, title, brief, network, format)
       values ($1, $2, 't', 'b', 'instagram', 'post')`,
      [marca, org],
    );
    await denied(db, duena, `update public.content_requests set status = 'accepted' where id = $1`, [pedido.id]);
    await denied(db, duena, `delete from public.content_requests where id = $1`, [pedido.id]);
    await denied(
      db,
      cliente,
      `insert into public.content_request_comments (request_id, brand_id, organization_id, kind, body)
       values ($1, $2, $3, 'comment', 'hola')`,
      [pedido.id, marca, org],
    );
  });
});

describe('datos del encargo', () => {
  it('los recursos de referencia tienen que ser de la marca', async () => {
    await denied(
      db,
      cliente,
      `select public.create_content_request($1, 't', 'b', 'instagram', 'post', null, $2::uuid[])`,
      [marca, [assetOtraMarca]],
      /no es de esta marca/,
    );
    await denied(
      db,
      cliente,
      `select public.create_content_request($1, 't', 'b', 'instagram', 'post', 'gif')`,
      [marca],
      /check constraint/,
    );
    await denied(
      db,
      cliente,
      `select public.create_content_request($1, ' ', 'b', 'instagram', 'post')`,
      [marca],
      /título/,
    );
  });

  it('el registro de actividad apunta el encargo y sus cambios de estado', async () => {
    const pedido = await pedir(cliente);
    await rpc(cliente, 'cancel_content_request', { p_request_id: pedido.id });
    const registros = await as<{ action: string; actor_id: string }>(
      db,
      duena,
      `select action, actor_id from public.audit_logs where entity_type = 'content_requests' and entity_id = $1 order by id`,
      [pedido.id],
    );
    expect(registros.map((r) => r.action)).toEqual(['insert', 'update']);
    expect(registros.every((r) => r.actor_id === cliente.id)).toBe(true);
  });
});

describe('modo de IA de la marca', () => {
  it('nace en api y solo lo cambia quien gestiona la marca', async () => {
    const [antes] = await as<{ ai_mode: string }>(db, cliente, `select ai_mode from public.brands where id = $1`, [
      marca,
    ]);
    expect(antes!.ai_mode).toBe('api');
    // El editor no gestiona: no cambia nada.
    expect(
      await as(db, agencia, `update public.brands set ai_mode = 'agency' where id = $1 returning id`, [marca]),
    ).toEqual([]);
    await as(db, duena, `update public.brands set ai_mode = 'agency' where id = $1`, [marca]);
    const [despues] = await as<{ ai_mode: string }>(db, cliente, `select ai_mode from public.brands where id = $1`, [
      marca,
    ]);
    expect(despues!.ai_mode).toBe('agency');
    await denied(db, duena, `update public.brands set ai_mode = 'otro' where id = $1`, [marca], /check constraint/);
  });
});

describe('avisos dentro de la aplicación', () => {
  const avisos = (user: TestUser, request?: string) =>
    as<{ kind: string; request_id: string; read_at: string | null }>(
      db,
      user,
      `select kind, request_id, read_at from public.request_notifications
       where ($1::uuid is null or request_id = $1) order by created_at`,
      [request ?? null],
    );
  const sinLeer = async (user: TestUser, request: string) =>
    (await avisos(user, request)).filter((a) => a.read_at === null).map((a) => a.kind);

  it('un encargo nuevo avisa a quien puede prepararlo; la entrega, a quien lo pidió', async () => {
    const pedido = await pedir(cliente);
    // Quien edita la marca (también la propietaria de la organización); nadie más, ni quien lo pide.
    for (const user of [agencia, otraSesion, duena]) {
      expect(await sinLeer(user, pedido.id), user.email).toEqual(['request_created']);
    }
    for (const user of [cliente, revisor, lector]) expect(await avisos(user, pedido.id), user.email).toEqual([]);

    await rpc(agencia, 'take_content_request', { p_request_id: pedido.id });
    await rpc(agencia, 'deliver_content_request', {
      p_request_id: pedido.id,
      p_data: DOC('Hola'),
      p_schema_version: 1,
    });
    expect(await sinLeer(cliente, pedido.id)).toEqual(['request_delivered']);
    // Quien entrega no se avisa a sí mismo.
    expect((await avisos(agencia, pedido.id)).map((a) => a.kind)).toEqual(['request_created']);
  });

  it('quien edita y pide un encargo no se avisa a sí mismo', async () => {
    const pedido = await pedir(agencia);
    expect(await avisos(agencia, pedido.id)).toEqual([]);
    expect(await sinLeer(otraSesion, pedido.id)).toEqual(['request_created']);
  });

  it('marcar como leído: de un encargo o todos los de la marca, y solo los propios', async () => {
    const uno = await pedir(cliente);
    const dos = await pedir(cliente);
    const [marcados] = await as<{ n: number }>(
      db,
      agencia,
      `select public.mark_request_notifications_read($1, $2) as n`,
      [marca, uno.id],
    );
    expect(marcados!.n).toBe(1);
    expect(await sinLeer(agencia, uno.id)).toEqual([]);
    expect(await sinLeer(agencia, dos.id)).toEqual(['request_created']);
    // Los de otra persona no se tocan.
    expect(await sinLeer(otraSesion, uno.id)).toEqual(['request_created']);
    await as(db, agencia, `select public.mark_request_notifications_read($1)`, [marca]);
    expect(await sinLeer(agencia, dos.id)).toEqual([]);
    // Nadie escribe avisos a mano.
    await denied(
      db,
      agencia,
      `insert into public.request_notifications (user_id, request_id, brand_id, organization_id, kind)
       values ($1, $2, $3, $4, 'request_created')`,
      [cliente.id, uno.id, marca, org],
    );
    await denied(db, agencia, `update public.request_notifications set read_at = null where request_id = $1`, [uno.id]);
  });

  it('un encargo cancelado o aceptado deja de avisar', async () => {
    const pedido = await pedir(cliente);
    await rpc(cliente, 'cancel_content_request', { p_request_id: pedido.id });
    expect(await sinLeer(agencia, pedido.id)).toEqual([]);
  });

  it('quien pierde el acceso a la marca deja de ver sus avisos', async () => {
    const pasajera = await createUser(db, 'pasajera@cliente.test', 'Pasajera');
    await join(db, duena, pasajera, org, 'member', marca, 'editor');
    const pedido = await pedir(cliente);
    expect(await sinLeer(pasajera, pedido.id)).toEqual(['request_created']);
    await as(db, duena, `delete from public.brand_members where brand_id = $1 and user_id = $2`, [marca, pasajera.id]);
    expect(await avisos(pasajera, pedido.id)).toEqual([]);
  });
});

describe('entregar desde la aplicación', () => {
  it('sin clave de sesión: la aplicación toma y entrega; la herramienta (con clave) es otra sesión', async () => {
    const pedido = await pedir(cliente);
    const tomado = await rpc(agencia, 'take_content_request', { p_request_id: pedido.id, p_claim_token: null });
    expect(tomado).toMatchObject({ status: 'in_progress', claimed_by: agencia.id, claim_token: null });
    // La misma cuenta desde la herramienta, con su clave, no puede quitárselo ni entregar.
    await denied(
      db,
      agencia,
      `select public.take_content_request($1, 'sesion-herramienta')`,
      [pedido.id],
      /otra persona u otra sesión/,
    );
    await denied(
      db,
      agencia,
      `select public.deliver_content_request($1, $2::jsonb, 1, 'sesion-herramienta')`,
      [pedido.id, JSON.stringify(DOC('x'))],
      /otra persona u otra sesión/,
    );
    // Entregar una pieza existente = su documento como versión de la pieza del encargo.
    const entregado = await rpc(agencia, 'deliver_content_request', {
      p_request_id: pedido.id,
      p_data: DOC('Ya llega el otoño'),
      p_schema_version: 1,
      p_claim_token: null,
      p_title: 'Menú de otoño',
      p_change_note: 'Entregado desde la aplicación',
    });
    expect(entregado).toMatchObject({ status: 'delivered', delivered_version: 1 });
    const [nota] = await db.query<{ body: string }>(
      `select body from public.content_request_comments where request_id = $1 and status = 'delivered'`,
      [pedido.id],
    );
    expect(nota!.body).toBe('Entregado desde la aplicación');
  });
});
