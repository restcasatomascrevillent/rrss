// Genera las miniaturas (WebP de unos 400 px) de las imágenes que YA están en la
// biblioteca y no la tienen (migración 20261209010000, `media_assets.thumb_path`).
// Las que se suben desde ahora la generan en el navegador; esto es para las
// existentes (p. ej. las ~520 fotos de R2 de Casa Tomás y Touza, y las de EnerGym).
//
//   node scripts/miniaturas-biblioteca.ts [--dry-run | --apply] [opciones]
//
// Por defecto es EN SECO: solo LEE la base de datos y cuenta qué miniaturas se
// generarían por marca y almacén; no descarga, no sube ni escribe nada.
// Con --apply, para cada imagen sin miniatura:
//   1. descarga el original con una URL firmada de su almacén (R2 o Supabase);
//   2. la reduce (lado largo 400 px, WebP, orientación EXIF aplicada);
//   3. si el almacén es R2, apunta la ruta (`media_storage_register_upload`,
//      igual que hace `media-storage`) y sube la miniatura a
//      <org>/<marca>/thumbs/<id>.webp en el MISMO almacén que el original;
//   4. guarda `thumb_path` en el recurso (solo si seguía sin miniatura).
// Se puede relanzar: salta lo que ya tiene miniatura y no duplica nada. Las
// imágenes que pesan menos de 40 KB o que no se pueden leer se saltan y se
// cuentan aparte.
//
// Opciones:
//   --marca <brand_id>    solo esa marca
//   --concurrency <n>     imágenes a la vez (por defecto 4, máximo 8)
//   --limit <n>           como mucho n imágenes en esta pasada
//
// Credenciales (nunca se imprimen ni se guardan; se piden en el momento):
//   SUPABASE_URL                 URL del proyecto (la de staging, producción…)
//   SUPABASE_SERVICE_ROLE_KEY    clave de servicio; si falta y hay terminal, la pide sin mostrarla
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET [, R2_JURISDICTION]
//                                solo si hay imágenes en R2 (las mismas que scripts/migrar-a-r2.ts)
//
// Para reducir las imágenes usa `sharp`, que NO es dependencia del proyecto:
//   npm install --no-save sharp
//
// Se ejecuta con Node ≥ 23.6 (TypeScript sin compilar).
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { ObjectStorage, StorageBackend } from '../supabase/functions/_shared/storage/contract.ts';
import { createSupabaseObjectStorage } from '../supabase/functions/_shared/storage/supabase.ts';
import { args, r2FromEnv } from './migrar-a-r2.ts';

export const THUMB_MAX_SIDE = 400;
/** Por debajo de este tamaño el original ya es una miniatura. */
export const SKIP_BELOW_BYTES = 40 * 1024;
export const READABLE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

export interface AssetToThumb {
  id: string;
  organization_id: string;
  brand_id: string;
  storage_path: string;
  mime_type: string;
  bytes: number;
  storage_backend: StorageBackend;
}

export const thumbKey = (a: Pick<AssetToThumb, 'organization_id' | 'brand_id' | 'id'>) =>
  `${a.organization_id}/${a.brand_id}/thumbs/${a.id}.webp`;

export interface ThumbPlan {
  todo: AssetToThumb[];
  skipped: Record<string, number>;
}

/** Qué imágenes necesitan miniatura y cuáles se saltan (y por qué). */
export function planThumbs(rows: AssetToThumb[]): ThumbPlan {
  const todo: AssetToThumb[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const row of rows) {
    if (!READABLE_MIMES.includes(row.mime_type)) skip(`formato no admitido (${row.mime_type})`);
    else if (Number(row.bytes) <= SKIP_BELOW_BYTES) skip('ya es pequeña (menos de 40 KB)');
    else todo.push(row);
  }
  return { todo, skipped };
}

/** Recuento por almacén y marca, para el modo en seco. */
export function formatThumbSummary(plan: ThumbPlan): string {
  const groups = new Map<string, { n: number; bytes: number }>();
  for (const a of plan.todo) {
    const key = `${a.brand_id} | ${a.storage_backend}`;
    const g = groups.get(key) ?? { n: 0, bytes: 0 };
    g.n++;
    g.bytes += Number(a.bytes);
    groups.set(key, g);
  }
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  const lines = ['Marca | almacén | imágenes | originales a descargar'];
  for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`${key} | ${g.n} | ${mb(g.bytes)}`);
  lines.push(
    `TOTAL | ${plan.todo.length} miniaturas | ${mb(plan.todo.reduce((s, a) => s + Number(a.bytes), 0))} de descarga ` +
      `(las miniaturas pesarán ~20-40 KB cada una)`,
  );
  if (Object.keys(plan.skipped).length) {
    lines.push('', 'Se saltan:');
    for (const [why, n] of Object.entries(plan.skipped).sort()) lines.push(`  ${n} · ${why}`);
  }
  return lines.join('\n');
}

/** Lo que el script necesita de la base de datos (clave de servicio). */
export interface ThumbDb {
  /** Imágenes de Storage sin miniatura, ordenadas por id, a partir de `after`. */
  page(after: string | null, size: number, brandId: string | null): Promise<AssetToThumb[]>;
  /** Apunta la ruta como objeto de R2 (sin persona). */
  registerR2(path: string): Promise<void>;
  /** Guarda la miniatura solo si el recurso seguía sin ella; devuelve si se guardó. */
  setThumb(id: string, thumbPath: string): Promise<boolean>;
}

export function restThumbDb(url: string, serviceKey: string, fetchImpl: typeof fetch = fetch): ThumbDb {
  const base = `${url.replace(/\/+$/, '')}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  return {
    async page(after, size, brandId) {
      const filters = [
        'select=id,organization_id,brand_id,storage_path,mime_type,bytes,storage_backend',
        'source=eq.storage',
        'kind=eq.image',
        'thumb_path=is.null',
        'order=id',
        `limit=${size}`,
      ];
      if (after) filters.push(`id=gt.${after}`);
      if (brandId) filters.push(`brand_id=eq.${brandId}`);
      const response = await fetchImpl(`${base}/media_assets?${filters.join('&')}`, { headers });
      if (!response.ok) throw new Error(`No se pudo leer la biblioteca (HTTP ${response.status})`);
      return (await response.json()) as AssetToThumb[];
    },
    async registerR2(path) {
      const response = await fetchImpl(`${base}/rpc/media_storage_register_upload`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_user_id: null, p_path: path }),
      });
      if (!response.ok) throw new Error(`No se pudo apuntar en R2 (HTTP ${response.status})`);
    },
    async setThumb(id, thumbPath) {
      const response = await fetchImpl(`${base}/media_assets?id=eq.${id}&thumb_path=is.null&select=id`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ thumb_path: thumbPath }),
      });
      if (!response.ok) throw new Error(`No se pudo guardar la miniatura (HTTP ${response.status})`);
      return ((await response.json()) as unknown[]).length > 0;
    },
  };
}

export interface RunThumbsOptions {
  db: ThumbDb;
  /** Almacén de cada recurso; el de R2 solo se pide si hace falta. */
  storeFor: (backend: StorageBackend) => ObjectStorage;
  /** Reduce los bytes de un original a una miniatura WebP; null si no se puede leer. */
  makeThumb: (original: Uint8Array) => Promise<Uint8Array | null>;
  download?: (url: string) => Promise<Uint8Array>;
  brandId?: string | null;
  concurrency?: number;
  limit?: number;
  log?: (line: string) => void;
}

export interface RunThumbsResult {
  created: number;
  skipped: Record<string, number>;
  failed: Array<{ id: string; error: string }>;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo descargar el original (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Genera y sube las miniaturas que faltan. Idempotente. */
export async function runThumbs(o: RunThumbsOptions): Promise<RunThumbsResult> {
  const download = o.download ?? fetchBytes;
  const result: RunThumbsResult = { created: 0, skipped: {}, failed: [] };
  const skip = (why: string) => (result.skipped[why] = (result.skipped[why] ?? 0) + 1);
  const limit = o.limit ?? Infinity;
  let after: string | null = null;
  let started = 0;
  for (;;) {
    const rows = await o.db.page(after, 200, o.brandId ?? null);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    const plan = planThumbs(rows);
    for (const [why, n] of Object.entries(plan.skipped)) result.skipped[why] = (result.skipped[why] ?? 0) + n;
    const queue = plan.todo.slice(0, Math.max(0, limit - started));
    started += queue.length;
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(8, o.concurrency ?? 4)) }, async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            const store = o.storeFor(a.storage_backend);
            const original = await download(await store.signGet(a.storage_path, 300));
            const thumb = await o.makeThumb(original);
            if (!thumb || thumb.byteLength === 0 || thumb.byteLength >= original.byteLength) {
              skip('no se pudo reducir (ilegible o no pesaría menos)');
              continue;
            }
            const key = thumbKey(a);
            if (a.storage_backend === 'r2') await o.db.registerR2(key);
            await store.put(key, thumb, 'image/webp', thumb.byteLength);
            if (await o.db.setThumb(a.id, key)) result.created++;
            else skip('ya tenía miniatura (otra pasada)');
          } catch (e) {
            result.failed.push({ id: a.id, error: (e as Error).message });
          }
        }
      }),
    );
    o.log?.(`Hechas ${result.created}; fallidas ${result.failed.length}…`);
    if (started >= limit) break;
  }
  return result;
}

/** Miniatura con `sharp` (se carga al usarla: no es dependencia del proyecto). */
async function sharpThumbnailer(): Promise<(original: Uint8Array) => Promise<Uint8Array | null>> {
  type Sharp = (input: Uint8Array) => {
    rotate(): ReturnType<Sharp>;
    resize(options: Record<string, unknown>): ReturnType<Sharp>;
    webp(options: Record<string, unknown>): ReturnType<Sharp>;
    toBuffer(): Promise<Uint8Array>;
  };
  let sharp: Sharp;
  try {
    const name = 'sharp'; // por variable: TypeScript no busca el módulo
    sharp = ((await import(name)) as { default: Sharp }).default;
  } catch {
    throw new Error('Falta `sharp`: ejecuta `npm install --no-save sharp` y vuelve a lanzar el script.');
  }
  return async (original) => {
    try {
      const out = await sharp(original)
        .rotate()
        .resize({ width: THUMB_MAX_SIDE, height: THUMB_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      return new Uint8Array(out);
    } catch {
      return null;
    }
  };
}

/** Pide un valor en el terminal sin mostrarlo. */
async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
    if (s.includes(question)) write.call(this, s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function secret(name: string): Promise<string> {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (process.stdin.isTTY) {
    const typed = await askHidden(`${name}: `);
    if (typed) return typed;
  }
  throw new Error(`Falta ${name}`);
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  const apply = a.apply === true;
  const url = process.env.SUPABASE_URL?.trim() || (await secret('SUPABASE_URL'));
  const serviceKey = await secret('SUPABASE_SERVICE_ROLE_KEY');
  const db = restThumbDb(url, serviceKey);
  const brandId = typeof a.marca === 'string' ? a.marca : null;
  const limit = typeof a.limit === 'string' ? Math.max(1, Number(a.limit) || 0) : undefined;

  if (!apply) {
    console.log('EN SECO: solo se lee la base de datos; no se descarga, sube ni escribe nada.');
    const all: AssetToThumb[] = [];
    for (let after: string | null = null; ;) {
      const rows = await db.page(after, 1000, brandId);
      if (rows.length === 0) break;
      all.push(...rows);
      after = rows[rows.length - 1]!.id;
    }
    const plan = planThumbs(all);
    if (limit) plan.todo.length = Math.min(plan.todo.length, limit);
    console.log(formatThumbSummary(plan));
    console.log('\nPara hacerlo de verdad: node scripts/miniaturas-biblioteca.ts --apply');
    return 0;
  }

  const supabaseStore = createSupabaseObjectStorage({ url, serviceKey });
  let r2: ObjectStorage | null = null;
  const result = await runThumbs({
    db,
    storeFor: (backend) => {
      if (backend === 'supabase') return supabaseStore;
      r2 ??= r2FromEnv();
      return r2;
    },
    makeThumb: await sharpThumbnailer(),
    brandId,
    ...(typeof a.concurrency === 'string' ? { concurrency: Number(a.concurrency) || 4 } : {}),
    ...(limit ? { limit } : {}),
    log: (line) => console.log(line),
  });
  console.log(`Miniaturas creadas: ${result.created}`);
  for (const [why, n] of Object.entries(result.skipped).sort()) console.log(`  ${n} · ${why}`);
  if (result.failed.length) {
    console.log(`Fallidas (${result.failed.length}; se reintentan al relanzar):`);
    for (const f of result.failed.slice(0, 20)) console.log(`  ${f.id}: ${f.error}`);
  }
  return result.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
