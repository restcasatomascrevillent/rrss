// Contenidos y versiones (Fase 2), contra las migraciones reales: numeración,
// inmutabilidad, guardado con versión esperada, restaurar, estados por rol,
// archivado y auditoría. El aislamiento entre organizaciones está en
// aislamiento.test.ts.
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
  type Db,
  type TestUser,
} from './helpers';

let db: Db;
let ana: TestUser, editor: TestUser, revisor: TestUser, cliente: TestUser, lector: TestUser;
let org: string, marca: string, otraMarca: string;

type Item = {
  id: string;
  status: string;
  current_version: number;
  archived_at: string | null;
  created_by: string;
  network: string;
  format: string;
};
type Version = {
  id: string;
  version: number;
  schema_version: number;
  data: unknown;
  change_note: string;
  restored_from: number | null;
  created_by: string;
};

const doc = (n: number) => ({ schemaVersion: 1, marca: `documento ${n}` });

async function crear(user: TestUser, brand = marca, title = 'Pieza'): Promise<string> {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.content_items (brand_id, organization_id, title, network, format)
     values ($1, $2, $3, 'instagram', 'post') returning id`,
    [brand, org, title],
  );
  return row!.id;
}

const guardar = (user: TestUser, id: string, data: unknown, note = '', expected: number | null = null) =>
  as<Version>(db, user, `select * from public.save_content_version($1, $2::jsonb, 1, $3, $4::integer)`, [
    id,
    JSON.stringify(data),
    note,
    expected,
  ]).then((rows) => rows[0]!);

const restaurar = (user: TestUser, id: string, version: number, expected: number | null = null) =>
  as<Version>(db, user, `select * from public.restore_content_version($1, $2, '', $3::integer)`, [
    id,
    version,
    expected,
  ]).then((rows) => rows[0]!);

const estado = (user: TestUser, id: string, status: string, expected: number | null = null) =>
  as<Item>(db, user, `select * from public.set_content_status($1, $2::public.content_status, $3::integer)`, [
    id,
    status,
    expected,
  ]).then((rows) => rows[0]!);

const archivar = (user: TestUser, id: string, archived = true) =>
  as<Item>(db, user, `select * from public.archive_content_item($1, $2)`, [id, archived]).then((rows) => rows[0]!);

const pieza = async (id: string) =>
  (await db.query<Item>(`select * from public.content_items where id = $1`, [id]))[0]!;
const versiones = (id: string) =>
  db.query<Version>(`select * from public.content_versions where content_id = $1 order by version`, [id]);

async function rechaza(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(promise).rejects.toThrow(pattern);
}

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@c.test', 'Ana');
  editor = await createUser(db, 'editor@c.test', 'Editor');
  revisor = await createUser(db, 'revisor@c.test', 'Revisor');
  cliente = await createUser(db, 'cliente@c.test', 'Cliente');
  lector = await createUser(db, 'lector@c.test', 'Lector');

  org = await createOrg(db, ana, 'Empresa C');
  marca = await createBrand(db, ana, org, 'Marca C1');
  otraMarca = await createBrand(db, ana, org, 'Marca C2');
  await join(db, ana, editor, org, 'member', marca, 'editor');
  await join(db, ana, revisor, org, 'member', marca, 'reviewer');
  await join(db, ana, cliente, org, 'member', marca, 'client');
  await join(db, ana, lector, org, 'member', marca, 'viewer');
});

afterAll(async () => {
  await db?.close();
});

describe('crear una pieza', () => {
  it('nace como idea, sin documento y con su autor', async () => {
    const id = await crear(editor);
    const item = await pieza(id);
    expect([item.status, item.current_version, item.archived_at, item.created_by]).toEqual([
      'idea',
      0,
      null,
      editor.id,
    ]);
    expect(await versiones(id)).toEqual([]);
  });

  it('el cliente no elige estado, versión, autor ni archivado al crear', async () => {
    const insert = (column: string, value: string) =>
      `insert into public.content_items (brand_id, organization_id, title, network, format, ${column})
       values ($1, $2, 'x', 'instagram', 'post', ${value})`;
    await denied(db, editor, insert('status', `'approved'`), [marca, org]);
    await denied(db, editor, insert('current_version', '7'), [marca, org]);
    await denied(db, editor, insert('archived_at', 'now()'), [marca, org]);
    await denied(db, editor, insert('created_by', `'${ana.id}'`), [marca, org]);
  });

  it('solo crea quien edita la marca', async () => {
    for (const user of [revisor, cliente, lector]) {
      await rechaza(crear(user), /row-level security/);
    }
    // El editor de C1 no crea en C2.
    await rechaza(crear(editor, otraMarca), /row-level security/);
  });

  it('la red y el formato son identificadores, y el título no puede quedar vacío', async () => {
    const insert = `insert into public.content_items (brand_id, organization_id, title, network, format) values ($1, $2, $3, $4, $5)`;
    await denied(db, editor, insert, [marca, org, 'x', 'Instagram', 'post'], /check constraint/);
    await denied(db, editor, insert, [marca, org, 'x', 'instagram', 'post; drop'], /check constraint/);
    await denied(db, editor, insert, [marca, org, '   ', 'instagram', 'post'], /check constraint/);
  });
});

describe('versiones', () => {
  it('cada guardado crea una versión numerada, con su nota y su autor', async () => {
    const id = await crear(editor);
    const v1 = await guardar(editor, id, doc(1), 'Primera');
    const v2 = await guardar(ana, id, doc(2), 'Segunda');
    const v3 = await guardar(editor, id, doc(3));
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);

    const filas = await versiones(id);
    expect(filas.map((v) => [v.version, v.change_note, v.created_by, v.schema_version, v.restored_from])).toEqual([
      [1, 'Primera', editor.id, 1, null],
      [2, 'Segunda', ana.id, 1, null],
      [3, '', editor.id, 1, null],
    ]);
    // Las versiones antiguas conservan su documento.
    expect(filas.map((v) => v.data)).toEqual([doc(1), doc(2), doc(3)]);
    expect((await pieza(id)).current_version).toBe(3);
  });

  it('una idea con documento pasa a borrador', async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1));
    expect((await pieza(id)).status).toBe('draft');
  });

  it('con versión esperada, no pisa lo que guardó otra persona', async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1), '', 0);
    await guardar(ana, id, doc(2), '', 1);
    // El editor seguía trabajando sobre la 1.
    let error: { code?: string; detail?: string; message?: string } | undefined;
    try {
      await guardar(editor, id, doc(3), '', 1);
    } catch (e) {
      error = e as typeof error;
    }
    expect(error?.code).toBe('CT001');
    expect(error?.message).toMatch(/Otra persona ha guardado/);
    expect(JSON.parse(error!.detail!)).toEqual({ current_version: 2, expected_version: 1 });
    expect((await versiones(id)).map((v) => v.version)).toEqual([1, 2]);
    // Sin versión esperada se guarda encima, a sabiendas.
    expect((await guardar(editor, id, doc(3))).version).toBe(3);
  });

  it('solo guarda quien edita la marca', async () => {
    const id = await crear(editor);
    for (const user of [revisor, cliente, lector]) {
      await rechaza(guardar(user, id, doc(1)), /No tienes permiso para editar/);
    }
    await rechaza(guardar(editor, '00000000-0000-0000-0000-000000000000', doc(1)), /No tienes permiso para editar/);
    expect(await versiones(id)).toEqual([]);
  });

  it('rechaza un documento que no es un objeto o no dice su versión de esquema', async () => {
    const id = await crear(editor);
    await rechaza(guardar(editor, id, [1, 2]), /El documento no es válido/);
    await rechaza(guardar(editor, id, 'texto'), /El documento no es válido/);
    await rechaza(
      as(db, editor, `select public.save_content_version($1, '{}'::jsonb, 0)`, [id]),
      /El documento no es válido/,
    );
    await rechaza(as(db, editor, `select public.save_content_version($1, null, 1)`, [id]), /El documento no es válido/);
  });

  it('son inmutables: nadie las cambia, las borra ni las inserta a mano', async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1));
    for (const user of [ana, editor]) {
      await denied(db, user, `update public.content_versions set data = '{}' where content_id = $1`, [id]);
      await denied(db, user, `update public.content_versions set change_note = 'x' where content_id = $1`, [id]);
      await denied(db, user, `delete from public.content_versions where content_id = $1`, [id]);
      await denied(
        db,
        user,
        `insert into public.content_versions (content_id, brand_id, organization_id, version, schema_version, data)
         values ($1, $2, $3, 99, 1, '{}')`,
        [id, marca, org],
      );
      // Ni se adelanta el número de versión de la pieza, ni se borra la pieza.
      await denied(db, user, `update public.content_items set current_version = 9 where id = $1`, [id]);
      await denied(db, user, `delete from public.content_items where id = $1`, [id]);
    }
    // Tampoco con la clave de servicio.
    await rechaza(
      asService(db, `update public.content_versions set data = '{}' where content_id = $1`, [id]),
      /permission denied/,
    );
    await rechaza(
      asService(db, `delete from public.content_versions where content_id = $1`, [id]),
      /permission denied/,
    );
    expect((await versiones(id)).map((v) => v.data)).toEqual([doc(1)]);
  });

  it('una versión no puede declararse de otra marca que su pieza', async () => {
    const id = await crear(editor);
    await expect(
      db.query(
        `insert into public.content_versions (content_id, brand_id, organization_id, version, schema_version, data)
         values ($1, $2, $3, 1, 1, '{}')`,
        [id, otraMarca, org],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('restaurar', () => {
  it('crea una versión nueva con el documento de la antigua y no toca el historial', async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1));
    await guardar(editor, id, doc(2));
    const restaurada = await restaurar(ana, id, 1);
    expect([restaurada.version, restaurada.restored_from, restaurada.created_by]).toEqual([3, 1, ana.id]);

    const filas = await versiones(id);
    expect(filas.map((v) => v.data)).toEqual([doc(1), doc(2), doc(1)]);
    expect((await pieza(id)).current_version).toBe(3);
  });

  it('conserva la versión de esquema con la que se guardó el documento', async () => {
    const id = await crear(editor);
    await as(db, editor, `select public.save_content_version($1, '{"a":1}'::jsonb, 4)`, [id]);
    await guardar(editor, id, doc(2));
    expect((await restaurar(editor, id, 1)).schema_version).toBe(4);
  });

  it('falla si la versión no existe, si falta el permiso o si alguien guardó entretanto', async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1));
    await rechaza(restaurar(editor, id, 5), /Esa versión no existe/);
    await rechaza(restaurar(revisor, id, 1), /No tienes permiso para editar/);
    await rechaza(restaurar(editor, id, 1, 0), /Otra persona ha guardado/);
    expect((await versiones(id)).map((v) => v.version)).toEqual([1]);
  });
});

describe('estados', () => {
  const enRevision = async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1));
    await estado(editor, id, 'in_review');
    return id;
  };

  it('quien edita mueve la pieza entre idea, borrador y revisión, pero no aprueba', async () => {
    const id = await crear(editor);
    expect((await estado(editor, id, 'draft')).status).toBe('draft');
    expect((await estado(editor, id, 'idea')).status).toBe('idea');
    await guardar(editor, id, doc(1));
    expect((await estado(editor, id, 'in_review')).status).toBe('in_review');
    await rechaza(estado(editor, id, 'approved', 1), /No tienes permiso para aprobar/);
    expect((await pieza(id)).status).toBe('in_review');
  });

  it('no se manda a revisión ni se aprueba una pieza sin documento', async () => {
    const id = await crear(ana);
    await rechaza(estado(ana, id, 'in_review'), /todavía no tiene ningún documento/);
    await estado(ana, id, 'draft');
    await rechaza(estado(ana, id, 'approved', 0), /todavía no tiene ningún documento/);
  });

  it('aprueba quien tiene esa capacidad, diciendo qué versión aprueba', async () => {
    for (const user of [revisor, cliente, ana]) {
      const id = await enRevision();
      await rechaza(estado(user, id, 'approved'), /Indica qué versión apruebas/);
      expect((await estado(user, id, 'approved', 1)).status).toBe('approved');
    }
    const id = await enRevision();
    await rechaza(estado(lector, id, 'approved', 1), /No tienes permiso/);
    await rechaza(estado(lector, id, 'draft'), /No tienes permiso/);
  });

  it('no se aprueba una versión que no es la que se estaba mirando', async () => {
    const id = await enRevision();
    await guardar(editor, id, doc(2)); // el editor retoca mientras el revisor mira la 1
    await rechaza(estado(revisor, id, 'approved', 1), /Otra persona ha guardado/);
    expect((await pieza(id)).status).toBe('in_review');
    expect((await estado(revisor, id, 'approved', 2)).status).toBe('approved');
  });

  it('quien solo aprueba puede devolver a borrador, y nada más', async () => {
    const id = await enRevision();
    await rechaza(estado(revisor, id, 'idea'), /No tienes permiso/);
    expect((await estado(revisor, id, 'draft')).status).toBe('draft');
    // Un borrador no lo aprueba ni lo manda a revisión quien no edita.
    await rechaza(estado(revisor, id, 'approved', 1), /Solo se puede aprobar un contenido que está en revisión/);
    await rechaza(estado(revisor, id, 'in_review'), /No tienes permiso/);
    // Y puede retirar una aprobación.
    await estado(editor, id, 'in_review');
    await estado(revisor, id, 'approved', 1);
    expect((await estado(cliente, id, 'draft')).status).toBe('draft');
  });

  it('quien edita y aprueba puede aprobar un borrador directamente', async () => {
    const id = await crear(ana);
    await guardar(ana, id, doc(1));
    expect((await estado(ana, id, 'approved', 1)).status).toBe('approved');
  });

  it('una versión nueva retira la aprobación', async () => {
    const id = await enRevision();
    await estado(revisor, id, 'approved', 1);
    await guardar(editor, id, doc(2));
    expect((await pieza(id)).status).toBe('draft');
    // También al restaurar.
    await estado(editor, id, 'in_review');
    await estado(revisor, id, 'approved', 2);
    await restaurar(editor, id, 1);
    expect((await pieza(id)).status).toBe('draft');
  });

  it('cambiar la red o el formato retira la aprobación; cambiar el título no', async () => {
    const id = await enRevision();
    await estado(revisor, id, 'approved', 1);
    await as(db, editor, `update public.content_items set title = 'Otro nombre' where id = $1`, [id]);
    expect((await pieza(id)).status).toBe('approved');
    await as(db, editor, `update public.content_items set format = 'reel' where id = $1`, [id]);
    const item = await pieza(id);
    expect([item.status, item.format]).toEqual(['draft', 'reel']);
  });

  it('el estado no se cambia con un UPDATE directo', async () => {
    const id = await enRevision();
    for (const user of [ana, editor, revisor]) {
      await denied(db, user, `update public.content_items set status = 'approved' where id = $1`, [id]);
    }
    // Quien no edita no retoca título, red ni formato.
    expect(
      await as(db, revisor, `update public.content_items set title = 'x' where id = $1 returning id`, [id]),
    ).toEqual([]);
  });
});

describe('archivar', () => {
  it('una pieza archivada no admite cambios hasta recuperarla, y conserva su estado', async () => {
    const id = await crear(editor);
    await guardar(editor, id, doc(1));
    await estado(editor, id, 'in_review');

    const archivada = await archivar(editor, id);
    expect(archivada.archived_at).not.toBeNull();
    expect(archivada.status).toBe('in_review');

    await rechaza(guardar(editor, id, doc(2)), /está archivado/);
    await rechaza(restaurar(editor, id, 1), /está archivado/);
    await rechaza(estado(revisor, id, 'approved', 1), /está archivado/);
    expect(
      await as(db, editor, `update public.content_items set title = 'x' where id = $1 returning id`, [id]),
    ).toEqual([]);
    // Se sigue viendo, con su historial.
    expect(
      await as(db, lector, `select version from public.content_versions where content_id = $1`, [id]),
    ).toHaveLength(1);

    const recuperada = await archivar(ana, id, false);
    expect([recuperada.archived_at, recuperada.status]).toEqual([null, 'in_review']);
    expect((await guardar(editor, id, doc(2))).version).toBe(2);
  });

  it('solo archiva quien edita, y no con un UPDATE directo', async () => {
    const id = await crear(editor);
    for (const user of [revisor, cliente, lector]) {
      await rechaza(archivar(user, id), /No tienes permiso para archivar/);
    }
    await denied(db, editor, `update public.content_items set archived_at = now() where id = $1`, [id]);
    expect((await pieza(id)).archived_at).toBeNull();
  });
});

describe('auditoría y borrado en cascada', () => {
  it('quedan registradas la pieza, sus cambios de estado y cada versión, sin el documento', async () => {
    const id = await crear(editor);
    const v1 = await guardar(editor, id, { schemaVersion: 1, secreto: 'no debe copiarse' });
    await guardar(editor, id, doc(2));
    await estado(editor, id, 'in_review');
    await estado(revisor, id, 'approved', 2);
    await archivar(editor, id);

    const registros = await as<{
      action: string;
      entity_type: string;
      actor_id: string;
      data: Record<string, unknown>;
    }>(
      db,
      ana,
      `select action, entity_type, actor_id, data from public.audit_logs
       where entity_id = $1 or entity_id in (select id::text from public.content_versions where content_id = $1::uuid)
       order by id`,
      [id],
    );
    expect(registros.map((r) => `${r.action}:${r.entity_type}:${r.data.status ?? r.data.version}`)).toEqual([
      'insert:content_items:idea',
      'insert:content_versions:1',
      'update:content_items:draft', // la idea pasó a borrador al guardar
      'insert:content_versions:2', // el segundo guardado no cambia el estado: no hay «update»
      'update:content_items:in_review',
      'update:content_items:approved',
      'update:content_items:approved', // archivada
    ]);
    expect(registros[5]!.actor_id).toBe(revisor.id);
    expect(registros.at(-1)!.data.archived_at).not.toBeNull();
    expect(JSON.stringify(registros)).not.toContain('no debe copiarse');
    expect(registros.every((r) => !('data' in r.data))).toBe(true);
    expect(v1.id).toBeTruthy();
  });

  it('al borrar la marca desaparecen sus contenidos y versiones', async () => {
    const efimera = await createBrand(db, ana, org, 'Marca efímera');
    const id = await crear(ana, efimera);
    await guardar(ana, id, doc(1));
    await db.query(`delete from public.brands where id = $1`, [efimera]);
    expect(await db.query(`select 1 from public.content_items where id = $1`, [id])).toEqual([]);
    expect(await versiones(id)).toEqual([]);
  });
});
