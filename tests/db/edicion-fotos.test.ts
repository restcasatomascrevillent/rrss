// Edición de fotos bajo demanda (docs/edicion-fotos.md) contra las migraciones
// reales:
//   · migración 20261128010000: qué hace cada modelo, modelos de ComfyUI
//     inactivos, guarda de la procedencia de las ediciones;
//   · elección de modelo: una edición nunca usa un modelo de generar, ni al revés;
//   · función `ai-media` (photo.options, photo.estimate, photo.edit) con la
//     edición simulada de las pruebas locales: el resultado es un recurso NUEVO
//     con procedencia `ai_edit` y la foto original no cambia;
//   · cupo y coste por organización, permisos y aislamiento;
//   · ComfyUI propio (flujos de quitar el fondo y ampliar) con HTTP simulado,
//     también el camino asíncrono hasta la biblioteca.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import {
  buildRemoveBackgroundGraph,
  buildUpscaleGraph,
  createComfyUiImageProvider,
} from '../../supabase/functions/_shared/ai/media/comfyui-image.ts';
import type {
  ImageEditRequest,
  MediaInput,
  MediaModel,
  MediaReader,
} from '../../supabase/functions/_shared/ai/media/contract.ts';
import {
  LOCAL_TEST_EDIT_MODELS,
  LOCAL_TEST_EDIT_PRICE_MICROS,
} from '../../supabase/functions/_shared/ai/media/local-test.ts';
import {
  mediaModelsFromRows,
  resolveEditModel,
  resolveMediaModel,
  type MediaModelRow,
} from '../../supabase/functions/_shared/ai/media/models.ts';
import { createMediaRuntime } from '../../supabase/functions/_shared/ai/media/runtime.ts';
import { mediaSelectionFromEnv } from '../../supabase/functions/_shared/ai/media/config.ts';
import { createMediaService } from '../../supabase/functions/_shared/ai/media/service.ts';
import {
  createSimulatedImageEditProvider,
  createSimulatedImageProvider,
  simulatedPng,
} from '../../supabase/functions/_shared/ai/media/simulated.ts';
import {
  createSupabaseMediaStorage,
  provenanceJson,
  type GeneratedAssetRow,
  type MediaStorageBackend,
} from '../../supabase/functions/_shared/ai/media/supabase-storage.ts';
import { createAiMediaHandler } from '../../supabase/functions/ai-media/handler.ts';
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
  rpcStatement,
  serviceRpc,
  setAiQuota,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

const LOCAL_ENV = { AI_E2E_SIMULATED_PROVIDER: 'true', SUPABASE_URL: 'http://127.0.0.1:55321' };

let db: Db;
let root: TestUser;
let n = 0;
const sessions = new Map<string, TestUser>();

const rpc: RpcClient = async (fn, args) => {
  try {
    if (fn === 'claim_jobs') {
      const { sql, params } = rpcStatement(fn, args);
      const rows = await asService<{ data: Row }>(db, sql, params);
      return { data: rows.map((r) => r.data), error: null };
    }
    return { data: await serviceRpc(db, fn, args), error: null };
  } catch (error) {
    const { code, message, detail } = error as { code?: string; message: string; detail?: string };
    return { data: null, error: { code, message, details: detail ?? null } };
  }
};

const reader: MediaReader = {
  getGeneration: async (id) => {
    const rows = await asService<{
      id: string;
      organization_id: string;
      brand_id: string;
      provider: string;
      status: string;
    }>(
      db,
      `select id, organization_id, brand_id, provider, status::text as status from public.ai_generations where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },
  getJob: async (organizationId, key) => {
    const rows = await asService<{ id: string; status: string; payload: unknown }>(
      db,
      `select id, status::text as status, payload from public.jobs where organization_id = $1 and idempotency_key = $2`,
      [organizationId, key],
    );
    return rows[0] ?? null;
  },
};

const backend: MediaStorageBackend = {
  async upload(path, bytes, contentType) {
    await asService(
      db,
      `insert into storage.objects (bucket_id, name, metadata) values ('brand-media', $1, $2::jsonb)
       on conflict (bucket_id, name) do update set metadata = excluded.metadata`,
      [path, JSON.stringify({ size: bytes.byteLength, mimetype: contentType })],
    );
  },
  async saveAsset(row: GeneratedAssetRow) {
    const [saved] = await asService<{ id: string }>(
      db,
      `insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type, bytes,
         width, height, folder, tags, provenance, created_by)
       values ($1, $2, $3::public.asset_kind, 'generated', $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::jsonb, $13)
       on conflict (storage_path) do update set bytes = excluded.bytes, provenance = excluded.provenance
       returning id`,
      [
        row.brand_id,
        row.organization_id,
        row.kind,
        row.storage_path,
        row.file_name,
        row.mime_type,
        row.bytes,
        row.width,
        row.height,
        row.folder,
        row.tags,
        JSON.stringify(row.provenance),
        row.created_by,
      ],
    );
    return { id: saved!.id };
  },
};
const storage = createSupabaseMediaStorage(backend);

beforeAll(async () => {
  db = await createDb();
  root = await createUser(db, 'root@plataforma.test');
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [root.id]);
});

afterAll(async () => {
  await db?.close();
});

function login(user: TestUser): string {
  const token = `sesion-${user.id}`;
  sessions.set(token, user);
  return token;
}

async function modelRows(): Promise<MediaModelRow[]> {
  return db.query<MediaModelRow & Row>(
    `select provider, model, task::text as task, operation, display_name, billing_unit, price_micros, price_details,
            price_verified, data_region, trains_on_inputs, delivery, settings, priority, active
     from public.ai_media_models where active`,
  );
}

/** Igual que la función real: con la identidad del usuario, bajo RLS; las de Drive y sin medidas, no. */
async function loadPhoto(token: string, brandId: string, assetId: string, options: { sign: boolean }) {
  const [row] = await as<{
    id: string;
    mime_type: string;
    kind: string;
    width: number | null;
    height: number | null;
    file_name: string;
    source: string;
  }>(
    db,
    sessions.get(token)!,
    `select id, mime_type, kind::text as kind, width, height, file_name, source
     from public.media_assets where brand_id = $1 and id = $2`,
    [brandId, assetId],
  );
  if (!row || (row.kind !== 'image' && row.kind !== 'logo') || row.source === 'google_drive') return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(row.mime_type) || !row.width || !row.height) return null;
  const input: MediaInput & { width: number; height: number } = {
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    ...(options.sign ? { url: `https://firmada.test/${row.id}` } : {}),
  };
  return { input, fileName: row.file_name };
}

function mediaHandler(env: Record<string, string | undefined> = LOCAL_ENV) {
  return createAiMediaHandler({
    authenticate: async (token) => {
      const user = sessions.get(token);
      return user ? { userId: user.id } : null;
    },
    brandVisible: async (token, brandId) =>
      (await as(db, sessions.get(token)!, `select id from public.brands where id = $1`, [brandId])).length > 0,
    loadReferences: async () => null,
    loadPhoto,
    runtime: async () =>
      createMediaRuntime({
        env,
        fetch: async () => new Response(null, { status: 599 }),
        rpc,
        reader,
        storage,
        modelRows: await modelRows(),
        serviceOptions: { pollIntervalMs: 0 },
      }),
  });
}

async function call(
  handler: (request: Request) => Promise<Response>,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request('http://funcion.test/ai-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function setup(options: { quota?: number | null } = {}) {
  n += 1;
  const owner = await createUser(db, `propietaria${n}@fotos${n}.test`);
  const org = await createOrg(db, owner, `Organización ${n}`);
  const brand = await createBrand(db, owner, org, `Marca ${n}`);
  if (options.quota !== null) await setAiQuota(db, root, org, options.quota ?? 10_000_000);
  return { owner, org, brand, token: login(owner) };
}

/** Una foto de la biblioteca con medidas, como las que sube la interfaz. */
async function addPhoto(
  user: TestUser,
  org: string,
  brand: string,
  extra: { mime?: string; w?: number; h?: number } = {},
) {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, width, height)
     values ($1, $2, 'image', $3, 'Chuletón en la parrilla.jpg', $4, 54321, $5, $6) returning id`,
    [brand, org, assetPath(org, brand), extra.mime ?? 'image/jpeg', extra.w ?? 1200, extra.h ?? 900],
  );
  return row!.id;
}

const assetRow = async (id: string) =>
  (await asService<Row>(db, `select * from public.media_assets where id = $1`, [id]))[0];
const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };

// ─────────────────────────────── Migración ───────────────────────────────

describe('migración de la edición de fotos', () => {
  it('cada modelo dice qué hace; los de edición de ComfyUI nacen inactivos y sin precio verificado', async () => {
    const rows = await db.query<Row>(
      `select model, operation, active, price_verified, delivery from public.ai_media_models
       where provider = 'comfyui' order by model`,
    );
    expect(rows).toEqual([
      {
        model: 'birefnet-general',
        operation: 'remove_background',
        active: false,
        price_verified: false,
        delivery: 'async',
      },
      { model: 'flux-2-klein-4b', operation: 'generate', active: false, price_verified: false, delivery: 'async' },
      { model: 'realesrgan-x4plus', operation: 'upscale', active: false, price_verified: false, delivery: 'async' },
    ]);
    // Los demás modelos siguen siendo de generar.
    const [other] = await db.query<{ n: number }>(
      `select count(*)::int as n from public.ai_media_models where provider not in ('comfyui', 'openai') and operation <> 'generate'`,
    );
    expect(other!.n).toBe(0);
  });

  it('una edición de foto solo puede ser de imagen, y no se admiten operaciones desconocidas', async () => {
    await expect(
      db.query(
        `insert into public.ai_media_models (provider, model, task, operation, display_name, billing_unit, price_micros,
           price_checked_on, price_source, data_region, trains_on_inputs, delivery)
         values ('x', 'y', 'video', 'upscale', 'X', 'second', 1, '2026-11-20', 'prueba', 'eu', 'no', 'sync')`,
      ),
    ).rejects.toThrow(/ai_media_models_edit_is_image/);
    await expect(
      db.query(
        `insert into public.ai_media_models (provider, model, task, operation, display_name, billing_unit, price_micros,
           price_checked_on, price_source, data_region, trains_on_inputs, delivery)
         values ('x', 'z', 'image', 'colorize', 'X', 'image', 1, '2026-11-20', 'prueba', 'eu', 'no', 'sync')`,
      ),
    ).rejects.toThrow(/ai_media_models_operation_check/);
  });

  it('un superadministrador puede cambiar qué hace un modelo; nadie más', async () => {
    const someone = await createUser(db, 'nadie@modelos.test');
    const rows = await as(
      db,
      someone,
      `update public.ai_media_models set operation = 'upscale' where model = 'flux-2-klein-4b' returning id`,
    ).catch(() => []);
    expect(rows).toHaveLength(0);
    await as(
      db,
      root,
      `update public.ai_media_models set notes = notes, operation = operation where model = 'birefnet-general'`,
    );
  });
});

// ─────────────────────── Cambiar el fondo con IA (OpenAI y simulado) ───────────────────────

/** PNG mínimo con la cabecera IHDR de esas medidas (la función solo mira la cabecera). */
function maskPng(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}

describe('ai-media · cambiar el fondo con IA', () => {
  it('pide la descripción del fondo y no admite descripción en otras ediciones', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand);
    const handler = mediaHandler();
    const sin = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'replace_background' },
    });
    expect(sin.status).toBe(400);
    expect(errorOf(sin.body).message).toMatch(/Describe el fondo/);
    const demasiado = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'replace_background', prompt: 'x'.repeat(501) },
    });
    expect(demasiado.status).toBe(400);
    const otra = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'enhance', prompt: 'mármol' },
    });
    expect(otra.status).toBe(400);
  });

  it('la máscara tiene que ser un PNG con las medidas de la foto', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand, { w: 1200, h: 900 });
    const handler = mediaHandler();
    const edit = (subjectMask: string) =>
      call(handler, token, {
        action: 'photo.edit',
        brandId: brand,
        input: { assetId: photo, operation: 'replace_background', prompt: 'mesa de mármol', subjectMask },
      });
    expect((await edit(Buffer.from('no es un png de verdad, ni de lejos').toString('base64'))).status).toBe(400);
    const otraMedida = await edit(maskPng(600, 450));
    expect(otraMedida.status).toBe(400);
    expect(errorOf(otraMedida.body).message).toMatch(/mismas medidas/);
  });

  it('cambia el fondo: recurso nuevo con procedencia ai_edit y el encargo; el original no cambia', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand, { w: 1200, h: 900 });
    const before = await assetRow(photo);
    const handler = mediaHandler();
    const options = await call(handler, token, { action: 'photo.options', brandId: brand });
    expect(
      (options.body.edits as { operation: string; usesSubjectMask: boolean }[]).find(
        (e) => e.operation === 'replace_background',
      )?.usesSubjectMask,
    ).toBe(true);
    const estimate = await call(handler, token, {
      action: 'photo.estimate',
      brandId: brand,
      input: { assetId: photo, operation: 'replace_background', prompt: 'fondo', maskPresent: true },
    });
    expect(estimate.status).toBe(200);
    const result = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: {
        assetId: photo,
        operation: 'replace_background',
        prompt: 'mesa de mármol blanco con luz cálida',
        subjectMask: maskPng(1200, 900),
      },
    });
    expect(result.status).toBe(200);
    const created = await assetRow((result.body.asset as { id: string }).id);
    expect(created).toMatchObject({
      origin: 'generated',
      file_name: 'Fondo nuevo · Chuletón en la parrilla.png',
      provenance: {
        type: 'ai_edit',
        operation: 'replace_background',
        source_asset_id: photo,
        purpose: 'photo.replace_background',
        prompt: 'mesa de mármol blanco con luz cálida',
      },
    });
    expect(await assetRow(photo)).toEqual(before);
  });
});

// ─────────────────────────── Procedencia y aislamiento ───────────────────────────

describe('procedencia de las fotos editadas', () => {
  it('quien edita la marca guarda una edición del navegador que apunta a una foto de la misma marca', async () => {
    const { owner, org, brand } = await setup();
    const source = await addPhoto(owner, org, brand);
    const [edited] = await as<{ id: string }>(
      db,
      owner,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', $3, 'Mejorada.jpg', 'image/jpeg', 100, $4::jsonb) returning id`,
      [
        brand,
        org,
        assetPath(org, brand),
        JSON.stringify({ type: 'photo_edit', source_asset_id: source, operations: ['enhance'] }),
      ],
    );
    const ediciones = await as(
      db,
      owner,
      `select id from public.media_assets where provenance->>'source_asset_id' = $1`,
      [source],
    );
    expect(ediciones.map((r) => r.id)).toEqual([edited!.id]);
  });

  it('no se puede decir que una edición sale de una foto de otra marca u otra organización (aislamiento)', async () => {
    const a = await setup();
    const b = await setup();
    const otherBrand = await createBrand(db, a.owner, a.org, 'Otra marca de A');
    const fotoB = await addPhoto(b.owner, b.org, b.brand);
    const fotoOtraMarca = await addPhoto(a.owner, a.org, otherBrand);
    for (const source of [fotoB, fotoOtraMarca, '00000000-0000-4000-8000-000000000000', 'no-es-un-uuid']) {
      await denied(
        db,
        a.owner,
        `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
         values ($1, $2, 'image', $3, 'x.jpg', 'image/jpeg', 1, $4::jsonb)`,
        [a.brand, a.org, assetPath(a.org, a.brand), JSON.stringify({ type: 'photo_edit', source_asset_id: source })],
        /no existe o no es de esta marca/,
      );
    }
    // Y la organización A no ve las ediciones de B (la RLS de siempre).
    expect(
      await as(db, a.owner, `select id from public.media_assets where provenance->>'source_asset_id' = $1`, [fotoB]),
    ).toEqual([]);
  });

  it('solo el servidor registra una foto editada con IA', async () => {
    const { owner, org, brand } = await setup();
    const source = await addPhoto(owner, org, brand);
    const provenance = JSON.stringify({ type: 'ai_edit', operation: 'remove_background', source_asset_id: source });
    await denied(
      db,
      owner,
      `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', $3, 'x.png', 'image/png', 1, $4::jsonb)`,
      [brand, org, assetPath(org, brand), provenance],
      /Solo el servidor/,
    );
    const rows = await asService(
      db,
      `insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type, bytes, provenance)
       values ($1, $2, 'image', 'generated', $3, 'x.png', 'image/png', 1, $4::jsonb) returning id`,
      [brand, org, assetPath(org, brand), provenance],
    );
    expect(rows).toHaveLength(1);
    // Renombrar la edición (lo que el cliente sí puede cambiar) sigue funcionando.
    await as(db, owner, `update public.media_assets set file_name = 'Sin fondo.png' where id = $1`, [rows[0]!.id]);
  });

  it('la procedencia de una edición con IA cabe en la columna y no lleva el encargo', () => {
    const json = provenanceJson('00000000-0000-4000-8000-000000000001', {
      provider: 'comfyui',
      model: 'birefnet-general',
      purpose: 'photo.remove_background',
      dataRegion: 'unknown',
      trainsOnInputs: 'no',
      untestedAdapter: true,
      edit: {
        operation: 'remove_background',
        sourceAssetId: '00000000-0000-4000-8000-000000000002',
        sourceName: 'x'.repeat(5000),
      },
    });
    expect(json).toMatchObject({
      type: 'ai_edit',
      operation: 'remove_background',
      source_asset_id: '00000000-0000-4000-8000-000000000002',
    });
    expect(json).not.toHaveProperty('prompt');
    expect(new TextEncoder().encode(JSON.stringify(json)).length).toBeLessThan(2048);
  });
});

// ─────────────────────────── Elección del modelo ───────────────────────────

describe('elección del modelo de una edición', () => {
  const base: MediaModel = {
    provider: 'simulated-image-edit',
    model: 'quitar',
    kind: 'image',
    displayName: 'Quitar',
    billingUnit: 'image',
    priceMicros: 1,
    priceDetails: {},
    priceVerified: true,
    dataRegion: 'eu',
    trainsOnInputs: 'no',
    delivery: 'sync',
    settings: {},
    priority: 10,
    active: true,
    operation: 'remove_background',
  };
  const availability = {
    providers: [createSimulatedImageEditProvider(), createSimulatedImageProvider()],
    unavailable: [],
  };

  it('una edición nunca usa un modelo de generar, ni generar uno de edición', () => {
    const generate: MediaModel = {
      ...base,
      provider: 'simulated-image',
      model: 'generar',
      operation: undefined,
      priority: 100,
    };
    expect(resolveEditModel('remove_background', [generate, base], availability).model.model).toBe('quitar');
    expect(resolveMediaModel('image', [base, generate], availability).model.model).toBe('generar');
    expect(() => resolveMediaModel('image', [base], availability)).toThrow(/No hay ningún modelo de imagen activo/);
    expect(() => resolveEditModel('upscale', [base, generate], availability)).toThrow(/ampliar la resolución/);
  });

  it('respeta el criterio de datos: fuera de la UE solo si se fija o se permite', () => {
    const outside = { ...base, dataRegion: 'unknown' as const };
    expect(() => resolveEditModel('remove_background', [outside], availability)).toThrow(/UE/);
    expect(
      resolveEditModel('remove_background', [outside], availability, {
        preferredEdits: { remove_background: 'simulated-image-edit:quitar' },
      }).model.model,
    ).toBe('quitar');
    expect(resolveEditModel('remove_background', [outside], availability, { allowNonEu: true }).model.model).toBe(
      'quitar',
    );
  });

  it('el modelo de cada edición se puede fijar por variable del servidor', () => {
    expect(
      mediaSelectionFromEnv({
        AI_MEDIA_REMOVE_BACKGROUND_MODEL: 'comfyui:birefnet-general',
        AI_MEDIA_UPSCALE_MODEL: ' comfyui:realesrgan-x4plus ',
      }).preferredEdits,
    ).toEqual({ remove_background: 'comfyui:birefnet-general', upscale: 'comfyui:realesrgan-x4plus' });
    expect(mediaSelectionFromEnv({}).preferredEdits).toBeUndefined();
  });

  it('el adaptador tiene que saber hacer esa edición', () => {
    const wrong = { ...base, provider: 'simulated-image' };
    expect(() => resolveEditModel('remove_background', [wrong], availability)).toThrow(/no sabe quitar el fondo/);
  });

  it('del registro se descartan las ediciones que no son de imagen', () => {
    const row = {
      provider: 'p',
      model: 'm',
      task: 'video',
      operation: 'upscale',
      display_name: 'M',
      billing_unit: 'second',
      price_micros: 1,
      price_details: {},
      price_verified: true,
      data_region: 'eu',
      trains_on_inputs: 'no',
      delivery: 'sync',
      settings: {},
      priority: 0,
      active: true,
    };
    expect(mediaModelsFromRows([row])).toEqual([]);
    expect(mediaModelsFromRows([{ ...row, task: 'image', billing_unit: 'image' }])[0]?.operation).toBe('upscale');
    // Filas de antes de la migración (sin el campo): son de generar.
    const { operation: _omit, ...legacy } = { ...row, task: 'image', billing_unit: 'image' };
    void _omit;
    expect(mediaModelsFromRows([legacy])[0]?.operation).toBe('generate');
  });
});

// ─────────────────────────── Función ai-media ───────────────────────────

describe('ai-media · editar una foto con IA', () => {
  it('sin proveedor de edición no se ofrece nada y editar responde «no disponible»', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand);
    const handler = mediaHandler({});
    const options = await call(handler, token, { action: 'photo.options', brandId: brand });
    expect(options).toMatchObject({ status: 200, body: { edits: [] } });
    const edit = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'remove_background' },
    });
    expect(edit.status).toBe(503);
    expect(errorOf(edit.body).code).toBe('not_configured');
  });

  it('con la edición simulada ofrece quitar el fondo y ampliar, y estima sin reservar', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand);
    const handler = mediaHandler();
    const options = await call(handler, token, { action: 'photo.options', brandId: brand });
    expect((options.body.edits as { operation: string; model: string }[]).map((e) => [e.operation, e.model])).toEqual([
      ['remove_background', `simulated-image-edit:${LOCAL_TEST_EDIT_MODELS.remove_background}`],
      ['upscale', `simulated-image-edit:${LOCAL_TEST_EDIT_MODELS.upscale}`],
      ['replace_background', `simulated-image-edit:${LOCAL_TEST_EDIT_MODELS.replace_background}`],
      ['enhance', `simulated-image-edit:${LOCAL_TEST_EDIT_MODELS.enhance}`],
    ]);
    const estimate = await call(handler, token, {
      action: 'photo.estimate',
      brandId: brand,
      input: { assetId: photo, operation: 'upscale', scale: 2 },
    });
    expect(estimate).toMatchObject({ status: 200, body: { costMicros: LOCAL_TEST_EDIT_PRICE_MICROS } });
    const [gens] = await asService<{ n: number }>(
      db,
      `select count(*)::int as n from public.ai_generations where brand_id = $1`,
      [brand],
    );
    expect(gens!.n).toBe(0);
  });

  it('quitar el fondo crea un recurso NUEVO con su procedencia; la foto original no cambia', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand);
    const before = await assetRow(photo);
    const [objectsBefore] = await asService<{ n: number }>(
      db,
      `select count(*)::int as n from storage.objects where name = $1`,
      [before!.storage_path],
    );

    const result = await call(mediaHandler(), token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'remove_background' },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'completed',
      operation: 'remove_background',
      costMicros: LOCAL_TEST_EDIT_PRICE_MICROS,
    });
    const assetId = (result.body.asset as { id: string }).id;
    expect(assetId).not.toBe(photo);

    const created = await assetRow(assetId);
    expect(created).toMatchObject({
      brand_id: brand,
      origin: 'generated',
      mime_type: 'image/png',
      folder: 'Ediciones',
      tags: ['ia', 'edición'],
      file_name: 'Sin fondo · Chuletón en la parrilla.png',
      created_by: owner.id,
      provenance: {
        type: 'ai_edit',
        operation: 'remove_background',
        source_asset_id: photo,
        provider: 'simulated-image-edit',
        purpose: 'photo.remove_background',
        untested_adapter: true,
      },
    });
    expect(created!.storage_path).not.toBe(before!.storage_path);

    // El original, intacto: misma fila, mismo archivo.
    expect(await assetRow(photo)).toEqual(before);
    const [objectsAfter] = await asService<{ n: number }>(
      db,
      `select count(*)::int as n from storage.objects where name = $1`,
      [before!.storage_path],
    );
    expect(objectsAfter!.n).toBe(objectsBefore!.n);

    // Cupo y coste por organización: la generación queda con su propósito y su coste.
    const [generation] = await asService<Row>(
      db,
      `select task::text as task, purpose, status::text as status, cost_micros, organization_id
       from public.ai_generations where id = $1`,
      [result.body.generationId],
    );
    expect(generation).toMatchObject({
      task: 'image',
      purpose: 'photo.remove_background',
      status: 'succeeded',
      organization_id: org,
    });
    expect(Number(generation!.cost_micros)).toBe(LOCAL_TEST_EDIT_PRICE_MICROS);
  });

  it('ampliar ×2 crea otro recurso; ×4 que pasaría de 4096 px se rechaza antes de gastar', async () => {
    const { owner, org, brand, token } = await setup();
    const photo = await addPhoto(owner, org, brand, { w: 1200, h: 900 });
    const handler = mediaHandler();
    const ok = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'upscale', scale: 2 },
    });
    expect(ok.status).toBe(200);
    const created = await assetRow((ok.body.asset as { id: string }).id);
    expect(created).toMatchObject({
      file_name: 'Ampliada ×2 · Chuletón en la parrilla.png',
      provenance: { type: 'ai_edit', operation: 'upscale', scale: 2, source_asset_id: photo },
    });
    const tooBig = await call(handler, token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'upscale', scale: 4 },
    });
    expect(tooBig.status).toBe(400);
    expect(errorOf(tooBig.body).message).toMatch(/4096 px/);
    const [gens] = await asService<{ n: number }>(
      db,
      `select count(*)::int as n from public.ai_generations where brand_id = $1`,
      [brand],
    );
    expect(gens!.n).toBe(1);
  });

  it('sin cupo no se llama al proveedor ni se crea nada', async () => {
    const { owner, org, brand, token } = await setup({ quota: 1 });
    const photo = await addPhoto(owner, org, brand);
    const result = await call(mediaHandler(), token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: photo, operation: 'remove_background' },
    });
    expect(result.status).toBe(402);
    expect(errorOf(result.body).code).toBe('quota_exhausted');
    const rows = await asService(db, `select id from public.media_assets where brand_id = $1`, [brand]);
    expect(rows).toHaveLength(1);
  });

  it('quien solo ve la marca no puede editar; una foto de otra organización no existe para quien pide', async () => {
    const a = await setup();
    const b = await setup();
    const viewer = await createUser(db, `lectora${n}@fotos.test`);
    await join(db, a.owner, viewer, a.org, 'member', a.brand, 'viewer');
    const photoA = await addPhoto(a.owner, a.org, a.brand);
    const photoB = await addPhoto(b.owner, b.org, b.brand);

    const asViewer = await call(mediaHandler(), login(viewer), {
      action: 'photo.edit',
      brandId: a.brand,
      input: { assetId: photoA, operation: 'remove_background' },
    });
    expect(asViewer.status).toBe(403);

    const crossOrg = await call(mediaHandler(), a.token, {
      action: 'photo.edit',
      brandId: a.brand,
      input: { assetId: photoB, operation: 'remove_background' },
    });
    expect(crossOrg.status).toBe(400);
    const otherBrand = await call(mediaHandler(), a.token, {
      action: 'photo.edit',
      brandId: b.brand,
      input: { assetId: photoB, operation: 'remove_background' },
    });
    expect(otherBrand.status).toBe(404);
  });

  it('no edita lo que no es una foto JPEG, PNG o WebP con medidas', async () => {
    const { owner, org, brand, token } = await setup();
    const sinMedidas = await addAsset(db, owner, org, brand);
    const gif = await addPhoto(owner, org, brand, { mime: 'image/gif' });
    for (const assetId of [sinMedidas, gif]) {
      const result = await call(mediaHandler(), token, {
        action: 'photo.edit',
        brandId: brand,
        input: { assetId, operation: 'remove_background' },
      });
      expect(result.status).toBe(400);
    }
    const badInput = await call(mediaHandler(), token, {
      action: 'photo.edit',
      brandId: brand,
      input: { assetId: sinMedidas, operation: 'remove_background', scale: 2 },
    });
    expect(badInput.status).toBe(400);
  });
});

// ─────────────────────────── ComfyUI propio ───────────────────────────

describe('ComfyUI · flujos de edición (HTTP simulado)', () => {
  it('quitar el fondo: nodo configurable, máscara invertida y unida como alfa', () => {
    const graph = buildRemoveBackgroundGraph({ image: 'foto.png', filenamePrefix: 'rrss/x', settings: {} });
    expect(graph['2']).toEqual({ class_type: 'BiRefNetRMBG', inputs: { model: 'BiRefNet-general', image: ['1', 0] } });
    expect(graph['3']).toEqual({ class_type: 'InvertMask', inputs: { mask: ['2', 1] } });
    expect(graph['4']).toEqual({ class_type: 'JoinImageWithAlpha', inputs: { image: ['1', 0], alpha: ['3', 0] } });
    expect(graph['9']!.inputs.images).toEqual(['4', 0]);

    const custom = buildRemoveBackgroundGraph({
      image: 'foto.png',
      filenamePrefix: 'rrss/x',
      settings: {
        rmbg_class_type: 'OtroNodo',
        rmbg_inputs: { modelo: 'x' },
        rmbg_image_input: 'images',
        rmbg_mask_output: 0,
        rmbg_mask_is_foreground: false,
      },
    });
    expect(custom['2']).toEqual({ class_type: 'OtroNodo', inputs: { modelo: 'x', images: ['1', 0] } });
    expect(custom['3']).toBeUndefined();
    expect(custom['4']!.inputs.alpha).toEqual(['2', 0]);
  });

  it('ampliar: solo nodos del núcleo, tamaño exacto y alfa escalado si la foto puede tenerlo', () => {
    const plain = buildUpscaleGraph({
      image: 'f.jpg',
      width: 2400,
      height: 1800,
      keepAlpha: false,
      filenamePrefix: 'p',
      settings: {},
    });
    expect(
      Object.values(plain)
        .map((node) => node.class_type)
        .sort(),
    ).toEqual(['ImageScale', 'ImageUpscaleWithModel', 'LoadImage', 'SaveImage', 'UpscaleModelLoader'].sort());
    expect(plain['2']!.inputs.model_name).toBe('RealESRGAN_x4plus.pth');
    expect(plain['4']!.inputs).toMatchObject({ width: 2400, height: 1800, upscale_method: 'lanczos' });
    const alpha = buildUpscaleGraph({
      image: 'f.png',
      width: 2400,
      height: 1800,
      keepAlpha: true,
      filenamePrefix: 'p',
      settings: {},
    });
    expect(alpha['5']).toEqual({ class_type: 'MaskToImage', inputs: { mask: ['1', 1] } });
    expect(alpha['9']!.inputs.images).toEqual(['8', 0]);
  });

  it('de punta a punta asíncrono: sube la foto, lanza el flujo y, al sondear, deja un recurso nuevo con su procedencia', async () => {
    const { owner, org, brand } = await setup();
    const photo = await addPhoto(owner, org, brand, { mime: 'image/png' });
    const before = await assetRow(photo);
    const result = simulatedPng('sin-fondo');
    const posted: unknown[] = [];
    const fetch = async (input: string, init: RequestInit = {}) => {
      if (input === 'https://firmada.test/foto') return new Response(simulatedPng('original'));
      if (input.endsWith('/upload/image')) return Response.json({ name: 'subida.png', subfolder: '', type: 'input' });
      if (input.endsWith('/prompt')) {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ prompt_id: 'trabajo-1', number: 1, node_errors: {} });
      }
      if (input.endsWith('/history/trabajo-1')) {
        return Response.json({
          'trabajo-1': {
            status: { status_str: 'success', completed: true },
            outputs: { '9': { images: [{ filename: 'r.png', subfolder: 'rrss', type: 'output' }] } },
          },
        });
      }
      if (input.includes('/view?')) return new Response(result, { headers: { 'content-type': 'image/png' } });
      return new Response('no', { status: 404 });
    };
    const provider = createComfyUiImageProvider({ baseUrl: 'https://comfy.ejemplo.test', fetch, dataRegion: 'eu' });
    const model: MediaModel = {
      provider: 'comfyui',
      model: 'birefnet-general',
      kind: 'image',
      displayName: 'BiRefNet',
      billingUnit: 'image',
      priceMicros: 5000,
      priceDetails: {},
      priceVerified: true,
      dataRegion: 'unknown',
      trainsOnInputs: 'no',
      delivery: 'async',
      settings: {},
      priority: 0,
      active: true,
      operation: 'remove_background',
    };
    const service = createMediaService({
      rpc,
      reader,
      storage,
      fetch,
      providers: { providers: [provider], unavailable: [] },
      models: [model],
      pollIntervalMs: 0,
    });
    const request: ImageEditRequest = {
      kind: 'image_edit',
      operation: 'remove_background',
      source: { mimeType: 'image/png', url: 'https://firmada.test/foto', width: 1200, height: 900 },
    };
    const started = await service.generate({
      userId: owner.id,
      brandId: brand,
      purpose: 'photo.remove_background',
      request,
      edit: { sourceAssetId: photo, sourceName: 'Terraza.png' },
    });
    expect(started.status).toBe('pending');
    expect(JSON.stringify(posted[0])).toContain('JoinImageWithAlpha');

    const claim = rpcStatement('claim_jobs', { p_worker: 'prueba', p_kinds: ['ai.media.poll'], p_limit: 1 });
    const [job] = await asService<{ data: Row }>(db, claim.sql, claim.params);
    const done = await service.processJob(job!.data as never, 'prueba');
    expect(done.status).toBe('completed');
    const assetId = done.status === 'completed' ? done.assets[0]!.assetId! : '';
    expect(await assetRow(assetId)).toMatchObject({
      file_name: 'Sin fondo · Terraza.png',
      folder: 'Ediciones',
      provenance: { type: 'ai_edit', operation: 'remove_background', source_asset_id: photo, provider: 'comfyui' },
    });
    expect(await assetRow(photo)).toEqual(before);
  });
});
