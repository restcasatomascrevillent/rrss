// Recursos provisionales (logotipos subidos en el editor del perfil sin
// guardar) y su limpieza en el servidor, contra las migraciones reales.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, asService, createBrand, createDb, createOrg, createUser, denied, type Db, type TestUser } from './helpers';

let db: Db;
let ana: TestUser;
let org: string, brand: string;
let n = 0;

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@provisional.test');
  org = await createOrg(db, ana, 'Empresa');
  brand = await createBrand(db, ana, org, 'Marca');
});

afterAll(async () => {
  await db?.close();
});

/** Sube un recurso como lo hace la aplicación; `provisional` = desde el editor del perfil. */
async function upload(provisional: boolean, kind = 'logo') {
  n += 1;
  const [row] = await as<{ id: string; storage_path: string; provisional_until: string | null }>(
    db,
    ana,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provisional_until)
     values ($1, $2, $3::public.asset_kind, $4, $5, 'image/png', 10, $6)
     returning id, storage_path, provisional_until`,
    [brand, org, kind, `${org}/${brand}/media/logo-${n}.png`, `logo-${n}.png`, provisional ? '2999-01-01' : null],
  );
  return row!;
}

/** Hace caducar el plazo de un provisional (como si hubieran pasado 48 horas). */
const expire = (id: string) =>
  db.query(`update public.media_assets set provisional_until = now() - interval '1 minute' where id = $1`, [id]);
const purge = async () =>
  Number((await db.query<{ n: number }>(`select private.purge_provisional_assets() as n`))[0]!.n);
const exists = async (id: string) =>
  (await db.query(`select 1 from public.media_assets where id = $1`, [id])).length === 1;
const saveProfile = (logoIds: string[]) =>
  as(db, ana, `select public.save_brand_profile($1, $2::jsonb)`, [
    brand,
    JSON.stringify({ visual: { logoAssetIds: logoIds } }),
  ]);

describe('recursos provisionales', () => {
  it('el plazo lo pone la base de datos (48 h), no el cliente; lo normal no es provisional', async () => {
    const logo = await upload(true);
    const hours = (new Date(logo.provisional_until!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
    expect((await upload(false)).provisional_until).toBeNull();
  });

  it('el cliente no puede alargar ni quitar el plazo después', async () => {
    const logo = await upload(true);
    await denied(db, ana, `update public.media_assets set provisional_until = null where id = $1`, [logo.id]);
    await denied(db, ana, `update public.media_assets set provisional_until = '2999-01-01' where id = $1`, [logo.id]);
  });

  it('un logotipo subido y nunca guardado se borra al caducar, y su archivo queda anotado para el barrido', async () => {
    const logo = await upload(true);
    // Antes de caducar no se toca.
    await purge();
    expect(await exists(logo.id)).toBe(true);
    await expire(logo.id);
    expect(await purge()).toBeGreaterThanOrEqual(1);
    expect(await exists(logo.id)).toBe(false);
    const queued = await db.query(`select 1 from public.storage_cleanup_queue where storage_path = $1`, [
      logo.storage_path,
    ]);
    expect(queued).toHaveLength(1);
    // Queda en la actividad como obra del sistema.
    const [audit] = await db.query<{ actor_id: string | null }>(
      `select actor_id from public.audit_logs where entity_type = 'media_assets' and entity_id = $1`,
      [logo.id],
    );
    expect(audit!.actor_id).toBeNull();
  });

  it('guardar el perfil con el logotipo lo deja de considerar provisional', async () => {
    const logo = await upload(true);
    await saveProfile([logo.id]);
    const [row] = await db.query<{ provisional_until: string | null }>(
      `select provisional_until from public.media_assets where id = $1`,
      [logo.id],
    );
    expect(row!.provisional_until).toBeNull();
  });

  it('enlazado en cualquier versión del perfil (también una archivada) no se borra', async () => {
    const logo = await upload(true);
    await saveProfile([logo.id]);
    await saveProfile([]); // La versión que lo enlaza queda archivada, pero se puede restaurar.
    await db.query(`update public.media_assets set provisional_until = now() - interval '1 minute' where id = $1`, [
      logo.id,
    ]);
    await purge();
    expect(await exists(logo.id)).toBe(true);
  });

  it('movido, renombrado o etiquetado en la biblioteca deja de ser provisional', async () => {
    for (const change of [
      `folder = 'Marca'`,
      `tags = array['logo']`,
      `file_name = 'logotipo-bueno.png'`,
      `rights = '{"license": "propia"}'::jsonb`,
    ]) {
      const logo = await upload(true);
      await as(db, ana, `update public.media_assets set ${change} where id = $1`, [logo.id]);
      const [row] = await db.query<{ provisional_until: string | null }>(
        `select provisional_until from public.media_assets where id = $1`,
        [logo.id],
      );
      expect(row!.provisional_until, change).toBeNull();
    }
  });

  it('no se borra si lo usa un contenido, un encargo, otro recurso o un trabajo en marcha', async () => {
    // Contenido que lo cita en su documento.
    const enContenido = await upload(true);
    const [item] = await as<{ id: string }>(
      db,
      ana,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, 'Pieza', 'instagram', 'feed_square') returning id`,
      [brand, org],
    );
    await as(db, ana, `select public.save_content_version($1, $2::jsonb, 1, '')`, [
      item!.id,
      JSON.stringify({ layers: [{ type: 'image', assetId: enContenido.id }] }),
    ]);
    // Encargo que lo cita como referencia.
    const enEncargo = await upload(true);
    await as(db, ana, `select public.create_content_request($1, 'T', 'B', 'instagram', 'feed_square', null, $2)`, [
      brand,
      [enEncargo.id],
    ]);
    // Recurso derivado de él.
    const origen = await upload(true);
    await as(
      db,
      ana,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', $3, 'derivado.png', 'image/png', 10, $4::jsonb)`,
      [
        brand,
        org,
        `${org}/${brand}/media/derivado.png`,
        JSON.stringify({ type: 'export', source_asset_id: origen.id }),
      ],
    );
    // Trabajo de medios en marcha con su ruta.
    const enTrabajo = await upload(true, 'image');
    await asService(db, `select public.enqueue_job($1, 'media.image.process', $2::jsonb, 'provisional-job', $3)`, [
      org,
      JSON.stringify({ source: { path: enTrabajo.storage_path } }),
      brand,
    ]);

    for (const asset of [enContenido, enEncargo, origen, enTrabajo]) await expire(asset.id);
    await purge();
    for (const asset of [enContenido, enEncargo, origen, enTrabajo]) expect(await exists(asset.id)).toBe(true);
  });

  it('nadie la puede llamar desde la API; solo el servidor', async () => {
    await denied(db, ana, `select private.purge_provisional_assets()`, [], /permission denied/);
    await denied(db, null, `select private.purge_provisional_assets()`, [], /permission denied/);
  });
});
