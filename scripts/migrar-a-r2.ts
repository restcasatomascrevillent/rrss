// Copia a Cloudflare R2 los archivos que hoy están en Supabase Storage
// (`brand-media`), en Google Drive y en la carpeta local de JPEG convertidos
// (docs/almacenamiento-r2.md, §4). Sin borrar nada en el origen.
//
//   node scripts/migrar-a-r2.ts [--dry-run | --apply] [opciones]
//
// Por defecto es EN SECO: no escribe nada en ningún sitio; cuenta archivos y
// bytes por origen y dice lo que falta. Con --apply copia, de forma
// reanudable: cada objeto copiado y comprobado (tamaño en R2) se anota en
// --state, y lo anotado se salta en la siguiente pasada.
//
// Opciones:
//   --marcas <json>               destino de cada fila del inventario según su columna
//                                 «marca»: {"marcas": {"<marca del inventario>": "<brand_id>"}}
//                                 (el mismo archivo que usa scripts/alta-biblioteca.ts). Las
//                                 filas de una marca que no está en el mapeo no se copian.
//   --org <uuid> --brand <uuid>   sin --marcas: todo lo de Drive y los JPEG locales a esa marca
//   Claves en R2: <org>/<marca>/import/google-drive/<id>-<nombre> (no «/drive/»: esa carpeta
//   está reservada para las referencias de Drive y la biblioteca no admite recursos en ella)
//   --brand-media-list <json>     lista de objetos de brand-media ({path, bytes, mime}),
//                                 p. ej. exportada con SQL; sin ella, con --apply se lista
//                                 con la clave de servicio
//   --drive-csv <csv>             inventario de Drive (separado por «;»)
//   --estado <texto>              estado del inventario que se copia (por defecto «incluida»)
//   --jpeg-dir <carpeta>          JPEG convertidos: <carpeta>/<id del HEIC>.jpg
//   --jpeg-jsonl <jsonl>          lista de esos JPEG ({id, title, ref})
//   --drive-dir <carpeta>         archivos de Drive ya bajados a mano (p. ej. con el conector de Drive):
//                                 <carpeta>/<id de Drive>.<ext>. Una fila de origen Drive se lee de ahí
//                                 si el archivo existe; si no existe y no hay DRIVE_ACCESS_TOKEN, el
//                                 recuento la marca «falta descargar»
//   --state <jsonl>               registro de lo copiado (por defecto ./migrar-a-r2.estado.jsonl)
//   --switch                      tras copiar, pasa a R2 los recursos de brand-media copiados
//   --concurrency <n>             copias a la vez (por defecto 4)
//   --limit <n>                   copia como mucho n archivos en esta pasada (para probar)
//
// Variables (solo con --apply; nunca se imprimen): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_JURISDICTION (eu por defecto) y, para
// bajar de Drive, DRIVE_ACCESS_TOKEN (OAuth con drive.readonly). Para un S3
// local en pruebas: MEDIA_STORAGE_S3_ENDPOINT en lugar de R2_ACCOUNT_ID.
//
// Se ejecuta con Node ≥ 23.6 (TypeScript sin compilar).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { ObjectStorage } from '../supabase/functions/_shared/storage/contract.ts';
import { createS3Storage } from '../supabase/functions/_shared/storage/s3.ts';
import { createSupabaseObjectStorage } from '../supabase/functions/_shared/storage/supabase.ts';

export type Source = 'brand-media' | 'drive' | 'local';

export interface PlanItem {
  source: Source;
  /** Ruta en R2. */
  key: string;
  bytes: number;
  mime: string;
  /** brand-media: ruta en Supabase; drive: id de Drive; local: archivo. */
  from: string;
  /** Qué representa (para el recuento): foto, vídeo, JPEG de un HEIC… */
  kind: 'foto' | 'vídeo' | 'otro';
  /** Marca de destino (de --marcas o de --brand); null si aún no se sabe. */
  brandId?: string | null;
  /** Fila del inventario de la que sale (Drive y JPEG locales): para darla de alta en la biblioteca. */
  meta?: InventoryMeta;
  /** Origen Drive ya bajado a disco (--drive-dir): se lee de ahí, no de la API. */
  localFrom?: string;
  /** Origen Drive que no está en --drive-dir y no se puede bajar (sin DRIVE_ACCESS_TOKEN). */
  missing?: boolean;
}

/** Lo que el paso de alta necesita saber de la fila del inventario. */
export interface InventoryMeta {
  /** Id de Drive del archivo original (el HEIC si se copia su JPEG). */
  driveId: string;
  /** Id de Drive del JPEG convertido, si lo hay. */
  jpegDriveId: string | null;
  /** Nombre del archivo original en Drive. */
  name: string;
  /** Ruta de carpetas en Drive. */
  path: string;
  /** Columna «marca» del inventario. */
  brand: string;
  category: string;
  subcategory: string;
  /** Mime del original (image/heic si se copia su JPEG). */
  originalMime: string;
  /** Se copia el JPEG de un HEIC. */
  fromHeic: boolean;
}

/** Destino de una marca del inventario. */
export interface BrandTarget {
  brandId: string;
  /** Si no se sabe (en seco, sin base de datos), las claves salen con <org>. */
  organizationId: string | null;
}

/** Comparación tolerante de nombres de marca y de categoría: sin tildes, mayúsculas ni espacios de más. */
export function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Carpeta de las claves en R2 de lo importado de Drive (fuera de la carpeta reservada `drive/`). */
export const IMPORT_FOLDER = 'import/google-drive';

export interface PlanSummary {
  items: PlanItem[];
  skipped: Record<string, number>;
  /** Datos del recuento que no son omisiones (p. ej. JPEG que también están en Drive). */
  notes: Record<string, number>;
  warnings: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** CSV separado por «;» con comillas dobles (y «""» dentro), con o sin BOM. */
export function parseCsv(text: string, separator = ';'): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === separator) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.some((v) => v !== ''));
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** Nombre seguro para una clave: ASCII, sin barras, como mucho 120 caracteres. */
export function safeName(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  return (cleaned || 'archivo').slice(0, 120);
}

const kindOf = (mime: string): PlanItem['kind'] =>
  mime.startsWith('image/') ? 'foto' : mime.startsWith('video/') ? 'vídeo' : 'otro';
const isHeic = (row: Record<string, string>) =>
  /^image\/hei[cf]/i.test(row.mimeType ?? '') || /^hei[cf]$/i.test(row.formato ?? '');

export interface PlanInput {
  org: string | null;
  brand: string | null;
  brandMedia: Array<{ path: string; bytes: number; mime: string }> | null;
  driveRows: Array<Record<string, string>> | null;
  estado: string;
  jpegDir: string | null;
  /** {id del HEIC, título} de los JPEG convertidos. */
  jpegList: Array<{ id: string; title?: string }> | null;
  /** Tamaño de un archivo local, o null si no existe. */
  localSize(file: string): number | null;
  /**
   * Destino según la columna «marca» del inventario (clave: normalizeLabel de
   * la marca). Con él no se usan `org` y `brand`.
   */
  brands?: Map<string, BrandTarget> | null;
  /** Carpeta con los archivos de Drive ya bajados: <carpeta>/<id>.<ext>. */
  driveDir?: string | null;
  /** Hay DRIVE_ACCESS_TOKEN: lo que falte en driveDir se podrá bajar de la API. */
  driveToken?: boolean;
}

/** Qué se copiaría, sin tocar nada. */
export function buildPlan(input: PlanInput): PlanSummary {
  const items = new Map<string, PlanItem>();
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];
  const notes: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const note = (what: string) => (notes[what] = (notes[what] ?? 0) + 1);
  const add = (item: PlanItem) => {
    if (!items.has(item.key)) items.set(item.key, item);
    else skip('repetido (misma clave)');
  };
  const byBrand = input.brands ?? null;
  const legacyPrefix =
    input.org && input.brand ? `${input.org}/${input.brand}/${IMPORT_FOLDER}` : `<org>/<marca>/${IMPORT_FOLDER}`;
  if (!byBrand && !(input.org && input.brand) && (input.driveRows || input.jpegList)) {
    warnings.push(
      'Faltan --marcas (o --org y --brand): las claves de Drive salen con <org>/<marca> (solo vale en seco).',
    );
  }
  if ((input.org && !UUID.test(input.org)) || (input.brand && !UUID.test(input.brand))) {
    warnings.push('--org y --brand tienen que ser identificadores (uuid).');
  }
  if (byBrand && [...byBrand.values()].some((t) => !t.organizationId)) {
    warnings.push('Hay marcas sin organización resuelta: sus claves salen con <org> (solo vale en seco).');
  }
  /** Destino de una fila: prefijo de la clave y marca, o null si su marca no tiene destino. */
  const targetOf = (brandLabel: string | null): { prefix: string; brandId: string | null } | null => {
    if (!byBrand) return { prefix: legacyPrefix, brandId: input.brand };
    if (brandLabel === null) return null;
    const t = byBrand.get(normalizeLabel(brandLabel));
    if (!t) return null;
    return { prefix: `${t.organizationId ?? '<org>'}/${t.brandId}/${IMPORT_FOLDER}`, brandId: t.brandId };
  };
  /** Resuelve un origen Drive contra --drive-dir: archivo local, o «falta descargar» si no hay token. */
  const driveLocal = (item: PlanItem, ext: string): PlanItem => {
    if (!input.driveDir) return item;
    const file = path.join(input.driveDir, `${item.from}${ext ? `.${ext}` : ''}`);
    const size = input.localSize(file);
    if (size !== null && size > 0 && (item.bytes === 0 || item.bytes === size)) {
      return { ...item, localFrom: file, bytes: size };
    }
    if (size !== null && item.bytes > 0 && size !== item.bytes) {
      warnings.push(`${item.from}: el archivo bajado tiene ${size} bytes y el inventario dice ${item.bytes}.`);
    }
    return input.driveToken ? item : { ...item, missing: true };
  };
  const metaOf = (row: Record<string, string>, fromHeic: boolean): InventoryMeta => ({
    driveId: row.id ?? '',
    jpegDriveId: row.jpeg_id || null,
    name: row.nombre ?? '',
    path: row.ruta ?? '',
    brand: row.marca ?? '',
    category: row.categoria ?? '',
    subcategory: row.subcategoria ?? '',
    originalMime: row.mimeType ?? '',
    fromHeic,
  });

  for (const object of input.brandMedia ?? []) {
    add({
      source: 'brand-media',
      key: object.path,
      bytes: object.bytes,
      mime: object.mime || 'application/octet-stream',
      from: object.path,
      kind: kindOf(object.mime ?? ''),
    });
  }

  const jpegFor = (heicId: string) => {
    if (!input.jpegDir) return null;
    const file = path.join(input.jpegDir, `${heicId}.jpg`);
    const size = input.localSize(file);
    return size === null ? null : { file, size };
  };
  const heicDone = new Set<string>();

  for (const row of input.driveRows ?? []) {
    const id = row.id ?? '';
    if (!id) continue;
    if ((row.estado ?? '') !== input.estado) {
      skip(`inventario: ${(row.estado ?? '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'sin estado'}`);
      continue;
    }
    const baseName = (row.nombre ?? id).replace(/\.[^.]+$/, '');
    const target = targetOf(row.marca ?? '');
    if (!target) {
      skip(`marca sin destino en --marcas: ${(row.marca ?? '').trim() || 'sin marca'}`);
      continue;
    }
    const { prefix, brandId } = target;
    if (isHeic(row)) {
      const jpegState = row.jpeg_estado ?? '';
      if (/^ya exist/i.test(jpegState)) {
        skip('HEIC con su JPEG original ya en el inventario');
        continue;
      }
      const local = jpegFor(id);
      if (local) {
        heicDone.add(id);
        if (row.jpeg_id) note('JPEG que también están ya en Drive (se copia la copia local, idéntica)');
        add({
          source: 'local',
          key: `${prefix}/${id}-${safeName(baseName)}.jpg`,
          bytes: local.size,
          mime: 'image/jpeg',
          from: local.file,
          kind: 'foto',
          brandId,
          meta: metaOf(row, true),
        });
      } else if (row.jpeg_id) {
        heicDone.add(id);
        add(
          driveLocal(
            {
              source: 'drive',
              key: `${prefix}/${id}-${safeName(baseName)}.jpg`,
              bytes: 0,
              mime: 'image/jpeg',
              from: row.jpeg_id,
              kind: 'foto',
              brandId,
              meta: metaOf(row, true),
            },
            'jpg',
          ),
        );
        warnings.push(`JPEG de ${id} solo en Drive: su tamaño se sabrá al copiarlo.`);
      } else {
        skip('HEIC sin JPEG (no se puede usar en el navegador)');
      }
      continue;
    }
    const mime = row.mimeType || 'application/octet-stream';
    const ext = (row.nombre ?? '').match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase() ?? '';
    add(
      driveLocal(
        {
          source: 'drive',
          key: `${prefix}/${id}-${safeName(baseName)}${ext ? `.${ext}` : ''}`,
          bytes: Number(row.bytes) || 0,
          mime,
          from: id,
          kind: kindOf(mime),
          brandId,
          meta: metaOf(row, false),
        },
        ext,
      ),
    );
  }

  // JPEG convertidos que no salen como «incluida» en el inventario.
  const excluded = new Set((input.driveRows ?? []).filter((r) => (r.estado ?? '') !== input.estado).map((r) => r.id));
  const included = new Set((input.driveRows ?? []).filter((r) => (r.estado ?? '') === input.estado).map((r) => r.id));
  for (const entry of input.jpegList ?? []) {
    if (heicDone.has(entry.id)) continue;
    if (excluded.has(entry.id)) {
      skip('JPEG de un HEIC excluido en el inventario');
      continue;
    }
    // Fila incluida ya contada arriba (su marca sin destino, o la HEIC con su JPEG original).
    if (included.has(entry.id)) continue;
    const target = targetOf(null);
    if (!target) {
      skip('JPEG sin fila en el inventario (no se sabe su marca)');
      continue;
    }
    const local = jpegFor(entry.id);
    if (!local) {
      skip('JPEG de la lista sin archivo local');
      continue;
    }
    heicDone.add(entry.id);
    const title = (entry.title ?? entry.id).replace(/\.[^.]+$/, '');
    add({
      source: 'local',
      key: `${target.prefix}/${entry.id}-${safeName(title)}.jpg`,
      bytes: local.size,
      mime: 'image/jpeg',
      from: local.file,
      kind: 'foto',
      brandId: target.brandId,
    });
  }
  return { items: [...items.values()], skipped, notes, warnings: [...new Set(warnings)] };
}

/**
 * Lee la parte «marcas» del archivo de mapeo que da quien ejecuta:
 * `{"marcas": {"<marca del inventario>": "<brand_id>" | {"brand_id": "…", "organization_id": "…"}}}`.
 */
export function parseBrandTargets(raw: unknown): Map<string, BrandTarget> {
  const root = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const marcas = root?.marcas;
  if (typeof marcas !== 'object' || marcas === null || Array.isArray(marcas)) {
    throw new Error('El mapeo tiene que llevar {"marcas": {"<marca del inventario>": "<brand_id>"}}');
  }
  const out = new Map<string, BrandTarget>();
  for (const [label, value] of Object.entries(marcas as Record<string, unknown>)) {
    const obj = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
    const brandId = typeof value === 'string' ? value : obj?.brand_id;
    const organizationId = obj?.organization_id ?? null;
    if (typeof brandId !== 'string' || !UUID.test(brandId)) {
      throw new Error(`Marca «${label}»: falta su brand_id (uuid)`);
    }
    if (organizationId !== null && (typeof organizationId !== 'string' || !UUID.test(organizationId))) {
      throw new Error(`Marca «${label}»: organization_id no es un uuid`);
    }
    const key = normalizeLabel(label);
    if (!key) throw new Error('Hay una marca sin nombre en el mapeo');
    if (out.has(key)) throw new Error(`La marca «${label}» está dos veces en el mapeo`);
    out.set(key, { brandId: brandId.toLowerCase(), organizationId: organizationId?.toLowerCase() ?? null });
  }
  if (out.size === 0) throw new Error('El mapeo no tiene ninguna marca');
  return out;
}

/**
 * Completa la organización de cada marca leyéndola de la base de datos (clave
 * de servicio). Falla si una marca no existe o si el mapeo dice otra organización.
 */
export async function resolveBrandOrganizations(
  targets: Map<string, BrandTarget>,
  lookup: (brandIds: string[]) => Promise<Map<string, string>>,
): Promise<Map<string, BrandTarget>> {
  const ids = [...new Set([...targets.values()].map((t) => t.brandId))];
  const orgs = await lookup(ids);
  const out = new Map<string, BrandTarget>();
  for (const [label, t] of targets) {
    const org = orgs.get(t.brandId);
    if (!org) throw new Error(`La marca ${t.brandId} no existe`);
    if (t.organizationId && t.organizationId !== org) {
      throw new Error(`La marca ${t.brandId} es de la organización ${org}, no de ${t.organizationId}`);
    }
    out.set(label, { brandId: t.brandId, organizationId: org });
  }
  return out;
}

/** Organización de cada marca, con la API de datos y la clave de servicio. */
export function brandOrganizationsFromRest(url: string, serviceKey: string, fetchImpl: typeof fetch = fetch) {
  return async (brandIds: string[]): Promise<Map<string, string>> => {
    const response = await fetchImpl(
      `${url.replace(/\/+$/, '')}/rest/v1/brands?select=id,organization_id&id=in.(${brandIds.join(',')})`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!response.ok) throw new Error(`No se pudieron leer las marcas (HTTP ${response.status})`);
    const rows = (await response.json()) as Array<{ id: string; organization_id: string }>;
    return new Map(rows.map((r) => [r.id, r.organization_id]));
  };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

export function formatSummary(plan: PlanSummary, done: Set<string> = new Set()): string {
  const lines: string[] = [];
  const groups = new Map<string, { n: number; bytes: number; pending: number }>();
  for (const item of plan.items) {
    const name =
      item.source === 'brand-media'
        ? 'brand-media (Supabase)'
        : item.source === 'local'
          ? `JPEG locales (${item.kind})`
          : `Google Drive (${item.kind})`;
    const g = groups.get(name) ?? { n: 0, bytes: 0, pending: 0 };
    g.n++;
    g.bytes += item.bytes;
    if (!done.has(item.key)) g.pending++;
    groups.set(name, g);
  }
  lines.push('Origen | archivos | tamaño | por copiar');
  let total = 0;
  for (const [name, g] of [...groups].sort()) {
    lines.push(`${name} | ${g.n} | ${mb(g.bytes)} | ${g.pending}`);
    total += g.bytes;
  }
  lines.push(`TOTAL | ${plan.items.length} | ${mb(total)} | ${plan.items.filter((i) => !done.has(i.key)).length}`);
  if (Object.keys(plan.skipped).length) {
    lines.push('', 'No se copian:');
    for (const [why, n] of Object.entries(plan.skipped).sort()) lines.push(`  ${n} · ${why}`);
  }
  for (const [what, n] of Object.entries(plan.notes)) lines.push('', `${n} · ${what}`);
  const missing = plan.items.filter((i) => i.missing).length;
  if (missing)
    lines.push(
      '',
      `${missing} archivos de Drive: falta descargar (no están en --drive-dir y no hay DRIVE_ACCESS_TOKEN).`,
    );
  const unknown = plan.items.filter((i) => i.bytes === 0 && !i.missing).length;
  if (unknown) lines.push('', `${unknown} archivos de Drive sin tamaño conocido (se sabrá al copiarlos).`);
  if (plan.warnings.length) lines.push('', ...plan.warnings.slice(0, 10).map((w) => `Aviso: ${w}`));
  if (plan.warnings.length > 10) lines.push(`(y ${plan.warnings.length - 10} avisos más)`);
  return lines.join('\n');
}

// ─────────────────────────────── Ejecución ───────────────────────────────

export function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else out[name] = true;
  }
  return out;
}

export async function readJsonl(file: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(file, 'utf8'))
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}`);
  return value;
}

export function r2FromEnv(): ObjectStorage & { headBucket(): Promise<{ status: number }> } {
  const local = process.env.MEDIA_STORAGE_S3_ENDPOINT?.trim();
  const jurisdiction = (process.env.R2_JURISDICTION?.trim() || 'eu') === 'default' ? 'default' : 'eu';
  const endpoint =
    local || `https://${required('R2_ACCOUNT_ID')}.${jurisdiction === 'eu' ? 'eu.' : ''}r2.cloudflarestorage.com`;
  return createS3Storage({
    endpoint: endpoint.replace(/\/+$/, ''),
    publicEndpoint: endpoint.replace(/\/+$/, ''),
    bucket: required('R2_BUCKET'),
    region: local ? 'us-east-1' : 'auto',
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    jurisdiction: local ? 'local' : jurisdiction,
  });
}

async function openSource(
  item: PlanItem,
  supabase: ObjectStorage | null,
): Promise<{ stream: Readable; bytes: number }> {
  if (item.source === 'local' || item.localFrom) {
    const file = item.localFrom ?? item.from;
    return { stream: createReadStream(file), bytes: (await stat(file)).size };
  }
  let response: Response;
  if (item.source === 'drive') {
    const token = required('DRIVE_ACCESS_TOKEN');
    response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.from)}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } else {
    if (!supabase) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY');
    response = await fetch(await supabase.signGet(item.from, 600));
  }
  if (!response.ok || !response.body) throw new Error(`El origen respondió ${response.status}`);
  const bytes = Number(response.headers.get('content-length') ?? item.bytes);
  if (!bytes) throw new Error('El origen no dice el tamaño del archivo');
  return { stream: Readable.fromWeb(response.body as never), bytes };
}

async function copyOne(
  item: PlanItem,
  r2: ObjectStorage,
  supabase: ObjectStorage | null,
): Promise<{ bytes: number; sha256: string }> {
  const { stream, bytes } = await openSource(item, supabase);
  const hash = createHash('sha256');
  const tap = new PassThrough();
  tap.on('data', (chunk: Buffer) => hash.update(chunk));
  stream.pipe(tap);
  await r2.put(item.key, Readable.toWeb(tap) as unknown as ReadableStream<Uint8Array>, item.mime, bytes);
  const head = await r2.head(item.key);
  if (!head || head.bytes !== bytes) throw new Error('El tamaño en R2 no coincide');
  return { bytes, sha256: hash.digest('hex') };
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  const apply = a.apply === true;
  const statePath = path.resolve(String(a.state ?? 'migrar-a-r2.estado.jsonl'));

  let brandMedia: PlanInput['brandMedia'] = null;
  if (typeof a['brand-media-list'] === 'string') {
    const raw = JSON.parse(await readFile(a['brand-media-list'], 'utf8')) as unknown;
    const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Array<
      Record<string, unknown>
    >;
    brandMedia = rows.map((r) => ({
      path: String(r.path ?? r.name),
      bytes: Number(r.bytes ?? r.size ?? 0),
      mime: String(r.mime ?? r.mimetype ?? ''),
    }));
  }
  const supabase =
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? createSupabaseObjectStorage({
          url: process.env.SUPABASE_URL,
          serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        })
      : null;
  if (!brandMedia && apply && supabase) {
    brandMedia = (await supabase.list('')).map((o) => ({ path: o.key, bytes: o.bytes, mime: '' }));
  }

  let driveRows: PlanInput['driveRows'] = null;
  if (typeof a['drive-csv'] === 'string') {
    if (!existsSync(a['drive-csv'])) {
      console.error(`No existe el inventario ${a['drive-csv']}: se omite Drive.`);
    } else driveRows = parseCsv(await readFile(a['drive-csv'], 'utf8'));
  }
  const jpegList =
    typeof a['jpeg-jsonl'] === 'string'
      ? (await readJsonl(a['jpeg-jsonl'])).map((e) => ({ id: String(e.id), title: String(e.title ?? '') }))
      : null;

  let brands: Map<string, BrandTarget> | null = null;
  if (typeof a.marcas === 'string') {
    brands = parseBrandTargets(JSON.parse(await readFile(a.marcas, 'utf8')) as unknown);
    if (apply) {
      brands = await resolveBrandOrganizations(
        brands,
        brandOrganizationsFromRest(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY')),
      );
    }
  }

  const plan = buildPlan({
    brands,
    org: typeof a.org === 'string' ? a.org : null,
    brand: typeof a.brand === 'string' ? a.brand : null,
    brandMedia,
    driveRows,
    estado: typeof a.estado === 'string' ? a.estado : 'incluida',
    jpegDir: typeof a['jpeg-dir'] === 'string' ? a['jpeg-dir'] : null,
    jpegList,
    driveDir: typeof a['drive-dir'] === 'string' ? a['drive-dir'] : null,
    driveToken: Boolean(process.env.DRIVE_ACCESS_TOKEN?.trim()),
    localSize(file) {
      try {
        return existsSync(file) ? statSync(file).size : null;
      } catch {
        return null;
      }
    },
  });

  const done = new Set<string>();
  if (existsSync(statePath)) for (const entry of await readJsonl(statePath)) done.add(String(entry.key));

  console.log(apply ? 'COPIA (sin borrar nada en el origen)' : 'EN SECO: no se escribe nada');
  if (!brandMedia) console.log('brand-media: sin lista (--brand-media-list) ni credenciales: no se cuenta.');
  console.log(formatSummary(plan, done));
  if (!apply) return 0;

  const r2 = r2FromEnv();
  const bucket = await r2.headBucket();
  if (bucket.status !== 200) throw new Error(`El cubo no responde (HTTP ${bucket.status})`);
  const limit = Number(a.limit) > 0 ? Number(a.limit) : Infinity;
  const pending = plan.items.filter((i) => !done.has(i.key) && !i.missing).slice(0, limit);
  if (plan.items.some((i) => i.key.startsWith('<org>'))) throw new Error('Faltan --marcas (o --org y --brand)');
  const concurrency = Math.max(1, Math.min(16, Number(a.concurrency) || 4));
  let ok = 0;
  let failed = 0;
  const queue = [...pending];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const result = await copyOne(item, r2, supabase);
          await appendFile(
            statePath,
            JSON.stringify({ key: item.key, source: item.source, ...result, at: new Date().toISOString() }) + '\n',
          );
          done.add(item.key);
          ok++;
        } catch (e) {
          failed++;
          console.error(`No se copió ${item.key}: ${(e as Error).message}`);
        }
      }
    }),
  );
  console.log(`Copiados ${ok}; fallidos ${failed} (se reintentan en la siguiente pasada).`);

  if (a.switch === true) {
    const url = required('SUPABASE_URL').replace(/\/+$/, '');
    const key = required('SUPABASE_SERVICE_ROLE_KEY');
    const copied = plan.items.filter((i) => i.source === 'brand-media' && done.has(i.key)).map((i) => i.key);
    for (let i = 0; i < copied.length; i += 50) {
      const batch = copied.slice(i, i + 50);
      const list = batch.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(',');
      const response = await fetch(
        `${url}/rest/v1/media_assets?source=eq.storage&storage_path=in.(${encodeURIComponent(list)})`,
        {
          method: 'PATCH',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ storage_backend: 'r2' }),
        },
      );
      if (!response.ok) throw new Error(`No se pudieron pasar a R2 (HTTP ${response.status})`);
    }
    console.log(`Pasados a R2 en la biblioteca: ${copied.length} recursos.`);
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
