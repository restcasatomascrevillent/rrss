// Da de alta en la biblioteca (`media_assets`) las fotos y vídeos que
// scripts/migrar-a-r2.ts copió a R2 desde Drive y desde la carpeta local de
// JPEG convertidos (docs/almacenamiento-r2.md, §4). Cada objeto queda en la
// marca que dice la columna «marca» del inventario, con su categoría como
// carpeta y etiquetas, un nombre legible, tipo, tamaño, dimensiones (si se
// pueden leer), procedencia (id y ruta de Drive) y almacén `r2`.
//
//   node scripts/alta-biblioteca.ts [--dry-run | --apply | --comprobar] [opciones]
//
// Por defecto es EN SECO: no escribe nada; con el mismo inventario que la copia
// cuenta qué se daría de alta por marca y categoría. Con --apply:
//   * lee de la base de datos lo que ya hay en la biblioteca de cada marca y
//     de R2 lo que hay copiado bajo <org>/<marca>/import/google-drive/;
//   * da de alta solo lo copiado que aún no tiene recurso (también lo que se
//     subió a R2 sin anotarse en --state: «huérfanos»), y se salta lo que ya
//     está (por ruta, o por huella si es la misma foto). Se puede relanzar:
//     no duplica nada;
//   * antes de cada alta apunta el objeto como de R2
//     (`media_storage_register_upload`), igual que hace `media-storage`.
// Con --comprobar (solo lectura): recursos sin objeto en R2, tamaños que no
// cuadran y objetos sin recurso.
//
// Opciones:
//   --marcas <json>       mapeo que da quien lo ejecuta (obligatorio):
//                         {"marcas": {"<marca del inventario>": "<brand_id>"},
//                          "categorias": {"<categoría del inventario>":
//                             {"etiquetas": ["…"], "carpeta": "…"} | ["…"]}}
//   --drive-csv <csv>     inventario de Drive (el mismo de la copia)
//   --estado <texto>      estado del inventario que se copió (por defecto «incluida»)
//   --jpeg-dir <carpeta>  JPEG convertidos: <carpeta>/<id del HEIC>.jpg
//   --jpeg-jsonl <jsonl>  lista de esos JPEG ({id, title})
//   --state <jsonl>       registro de la copia (por defecto ./migrar-a-r2.estado.jsonl)
//   --concurrency <n>     altas a la vez (por defecto 4)
//   --limit <n>           da de alta como mucho n recursos en esta pasada
//
// Variables (solo con --apply y --comprobar; nunca se imprimen): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, las de R2 de scripts/migrar-a-r2.ts y, opcional,
// DRIVE_ACCESS_TOKEN (drive.readonly) para leer las dimensiones y la duración
// de los vídeos de Drive.
//
// Se ejecuta con Node ≥ 23.6 (TypeScript sin compilar).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStorage } from '../supabase/functions/_shared/storage/contract.ts';
import {
  args,
  brandOrganizationsFromRest,
  buildPlan,
  IMPORT_FOLDER,
  normalizeLabel,
  parseBrandTargets,
  parseCsv,
  r2FromEnv,
  readJsonl,
  required,
  resolveBrandOrganizations,
  type BrandTarget,
  type InventoryMeta,
  type PlanItem,
} from './migrar-a-r2.ts';

// ─────────────────────────────── Mapeo ───────────────────────────────

export interface CategoryRule {
  tags: string[];
  /** Carpeta de la biblioteca. */
  folder: string;
}

export interface AltaMapping {
  /** Clave: normalizeLabel de la marca del inventario. */
  brands: Map<string, BrandTarget>;
  /** Clave: normalizeLabel de la categoría del inventario. */
  categories: Map<string, CategoryRule>;
}

const MAX_TAGS = 20;

/** Etiqueta limpia: minúsculas, sin numeración delante («03 Entrantes» → «entrantes»), ≤ 60 caracteres. */
export function normalizeTag(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('es')
    .replace(/^[\s_]*\d{2}[.)-]?\s+/, '')
    .replace(/^_+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

const capitalize = (value: string) => (value ? value.charAt(0).toLocaleUpperCase('es') + value.slice(1) : value);

/** Sin mapeo para una categoría: «vinos/botellas» → etiquetas vinos y botellas, carpeta «Vinos». */
export function defaultCategoryRule(category: string): CategoryRule {
  const tags = [...new Set(category.split('/').map(normalizeTag).filter(Boolean))];
  return { tags, folder: capitalize(tags[0] ?? '').slice(0, 200) };
}

/** Lee el archivo de mapeo completo (marcas y, opcional, categorías). */
export function parseAltaMapping(raw: unknown): AltaMapping {
  const brands = parseBrandTargets(raw);
  const categories = new Map<string, CategoryRule>();
  const source = (raw as Record<string, unknown>).categorias;
  if (source !== undefined) {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new Error('«categorias» tiene que ser un objeto {"<categoría>": {"etiquetas": [...], "carpeta": "..."}}');
    }
    for (const [label, value] of Object.entries(source as Record<string, unknown>)) {
      const obj = Array.isArray(value) ? { etiquetas: value } : (value as Record<string, unknown> | null);
      const tags = obj?.etiquetas;
      if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
        throw new Error(`Categoría «${label}»: «etiquetas» tiene que ser una lista de textos`);
      }
      const clean = [...new Set((tags as string[]).map(normalizeTag).filter(Boolean))];
      const folder = obj?.carpeta;
      if (folder !== undefined && typeof folder !== 'string') {
        throw new Error(`Categoría «${label}»: «carpeta» tiene que ser un texto`);
      }
      categories.set(normalizeLabel(label), {
        tags: clean,
        folder: (folder ?? capitalize(clean[0] ?? '')).trim().slice(0, 200),
      });
    }
  }
  return { brands, categories };
}

export function categoryRule(meta: InventoryMeta, mapping: AltaMapping): CategoryRule {
  return mapping.categories.get(normalizeLabel(meta.category)) ?? defaultCategoryRule(meta.category);
}

// ─────────────────────────── Nombre y etiquetas ───────────────────────────

/** Nombres que pone la cámara o el móvil: no dicen nada de la foto. */
export function isCameraName(value: string): boolean {
  const v = value.trim();
  return (
    v === '' ||
    /^(?:img|dscn?|dscf|pxl|vid|video|mvi|gopr|gh|c|p|photo|foto|imagen|image|screenshot)[-_ ]?\d[\d_ -]*$/i.test(v) ||
    /^fullsizerender/i.test(v) ||
    /^[\d_ -]+$/.test(v)
  );
}

/** «setas-de-temporada-con-verduras-366a1ac5-fc92-…» → «setas de temporada con verduras». */
function humanize(value: string): string {
  let v = value.trim();
  v = v.replace(/^\d{4}-\d{2}-\d{2}(?:[-_ ]\d{2}(?:[-_.]\d{2}){1,2})?[-_ ]*/, '');
  v = v.replace(/[-_ ]?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, '');
  v = v.replace(/[-_ ][0-9a-f]{6,}$/i, '');
  if (!/\s/.test(v)) v = v.replace(/[-_]+/g, ' ');
  return v.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Carpeta de Drive sin numeración ni guion bajo delante («03 Entrantes», «_Sin revisar»). */
const cleanFolder = (segment: string) =>
  segment
    .replace(/^\d{2}[.)-]?\s+/, '')
    .replace(/^_+/, '')
    .trim();

/**
 * Nombre legible del recurso, sin reglas de ningún cliente:
 *   1. si la ruta tiene una carpeta por debajo de la subcategoría, es el
 *      nombre del plato, del vino…: «Vinos/Espumosos/Collet Rosé» → «Collet Rosé»;
 *   2. si no, lo que va antes de « - » en el nombre del archivo, salvo que sea
 *      el de la cámara: «Jameson - IMG_0454.HEIC» → «Jameson» (y si es la
 *      carpeta escrita de otra manera, la carpeta: «clover club - IMG…» en
 *      «Clover Club» → «Clover Club»);
 *   3. si no, la última carpeta.
 */
export function readableName(meta: InventoryMeta): string {
  const segments = meta.path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  const sub = normalizeLabel(meta.subcategory);
  const at = sub ? segments.findIndex((s) => normalizeLabel(s) === sub) : -1;
  const last = cleanFolder(segments.at(-1) ?? '');
  let name = '';
  if (at >= 0 && at < segments.length - 1) {
    name = last;
  } else {
    const stem = meta.name.replace(/\.[A-Za-z0-9]{2,5}$/, '');
    const first = stem.split(' - ')[0]?.trim() ?? '';
    // «clover club 1»: el número de la toma no forma parte del nombre.
    const label = isCameraName(first) ? '' : humanize(first).replace(/\s+\d{1,3}$/, '');
    if (label && last && normalizeLabel(last).includes(normalizeLabel(label))) name = last;
    else name = label || last || humanize(stem) || meta.driveId;
  }
  return capitalize(name.replace(/\s+/g, ' ').trim()).slice(0, 200);
}

/** Etiquetas: las de la categoría y la subcategoría (si no es una ruta ni la propia marca). */
export function tagsFor(meta: InventoryMeta, rule: CategoryRule): string[] {
  const tags = [...rule.tags];
  const sub = meta.subcategory.trim();
  const subTag = normalizeTag(sub);
  // «carta/casa-tomas», «Marca/_Sin revisar»: es la ruta de carpetas, no una subcategoría.
  const isPath = sub.includes('/') && normalizeLabel(meta.path).endsWith(normalizeLabel(sub));
  // «(raíz)» y similares: marcas del inventario, no subcategorías.
  const isMarker = /^\(.*\)$/.test(sub);
  if (subTag && !isPath && !isMarker && normalizeLabel(subTag) !== normalizeLabel(meta.brand)) {
    tags.push(subTag);
  }
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

// ─────────────────────────── Recurso a dar de alta ───────────────────────────

export interface Dims {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** Fila de `media_assets` tal como la da de alta el servidor. */
export interface AssetRow {
  brand_id: string;
  organization_id: string;
  kind: 'image' | 'video' | 'document';
  origin: 'import';
  source: 'storage';
  storage_backend: 'r2';
  storage_path: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  sha256: string | null;
  folder: string;
  tags: string[];
  provenance: Record<string, unknown>;
}

export interface AssetDraft {
  row: AssetRow;
  item: PlanItem;
  /** Para el recuento. */
  brandLabel: string;
  category: string;
}

const kindOf = (mime: string): AssetRow['kind'] =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document';

/** Procedencia (≤ 2048 bytes en la base de datos): de qué archivo de Drive sale. */
export function provenanceFor(meta: InventoryMeta, importedAt: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'import',
    source: 'google_drive',
    drive_file_id: meta.driveId,
    drive_path: meta.path.slice(0, 500),
    original_name: meta.name.slice(0, 200),
    imported_at: importedAt,
  };
  if (meta.fromHeic) out.converted_from = meta.originalMime || 'image/heic';
  if (meta.jpegDriveId) out.drive_jpeg_id = meta.jpegDriveId;
  if (meta.category) out.inventory_category = meta.category.slice(0, 120);
  // Margen: la base de datos rechaza más de 2048 bytes.
  while (Buffer.byteLength(JSON.stringify(out)) > 1900 && String(out.drive_path).length > 40) {
    out.drive_path = String(out.drive_path).slice(0, Math.floor(String(out.drive_path).length * 0.8));
  }
  return out;
}

export function draftAsset(
  item: PlanItem,
  mapping: AltaMapping,
  copied: { bytes: number; sha256: string | null } | null,
  importedAt: string,
  dims: Dims | null = null,
): AssetDraft {
  const meta = item.meta!;
  const [organizationId = '', brandId = ''] = item.key.split('/');
  const rule = categoryRule(meta, mapping);
  const name = readableName(meta);
  const ext = item.key.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase();
  return {
    item,
    brandLabel: meta.brand,
    category: meta.category,
    row: {
      brand_id: brandId,
      organization_id: organizationId,
      kind: kindOf(item.mime),
      origin: 'import',
      source: 'storage',
      storage_backend: 'r2',
      storage_path: item.key,
      file_name: `${name}${ext ? `.${ext}` : ''}`.slice(0, 255),
      mime_type: item.mime,
      bytes: copied?.bytes ?? item.bytes,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      duration_ms: dims?.durationMs ?? null,
      sha256: copied?.sha256 ?? null,
      folder: rule.folder,
      tags: tagsFor(meta, rule),
      provenance: provenanceFor(meta, importedAt),
    },
  };
}

// ─────────────────────────────── Plan del alta ───────────────────────────────

export interface LibraryState {
  paths: Set<string>;
  hashes: Set<string>;
}

export interface AltaInput {
  items: PlanItem[];
  mapping: AltaMapping;
  /** Lo copiado según --state: clave → bytes y huella. */
  copied: Map<string, { bytes: number; sha256: string | null }>;
  /**
   * Objetos que hay en R2 (clave → bytes). null: no se ha mirado (en seco); se
   * cuenta lo anotado en --state o, si `assumeCopied`, todo el plan.
   */
  inR2: Map<string, number> | null;
  /** Lo que ya hay en la biblioteca de cada marca. null: no se ha mirado (en seco). */
  library: Map<string, LibraryState> | null;
  /** En seco y sin --state: contar como si todo estuviera copiado. */
  assumeCopied: boolean;
  importedAt: string;
}

export interface AltaPlan {
  create: AssetDraft[];
  /** Objetos en R2 sin anotar en --state (la copia se cortó tras subirlos): se dan de alta igual. */
  orphans: string[];
  /** Objetos en R2 bajo la carpeta de importación que no salen del inventario: no se tocan. */
  unknownInR2: string[];
  skipped: Record<string, number>;
}

export function planAlta(input: AltaInput): AltaPlan {
  const create: AssetDraft[] = [];
  const orphans: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const seenHashes = new Map<string, Set<string>>();
  const planned = new Set<string>();

  for (const item of input.items) {
    if (item.source === 'brand-media') continue; // ya tienen recurso: los pasa a R2 --switch
    planned.add(item.key);
    if (!item.meta || !item.brandId) {
      skip('sin fila del inventario o sin marca (no se sabe dónde darlo de alta)');
      continue;
    }
    const library = input.library?.get(item.brandId);
    if (library?.paths.has(item.key)) {
      skip('ya en la biblioteca');
      continue;
    }
    const copied = input.copied.get(item.key) ?? null;
    let bytes: number | null;
    if (input.inR2) bytes = input.inR2.get(item.key) ?? null;
    else bytes = copied ? copied.bytes : input.assumeCopied ? item.bytes : null;
    if (bytes === null) {
      skip('sin copiar a R2 todavía');
      continue;
    }
    const sha = copied?.sha256 ?? null;
    if (sha) {
      if (library?.hashes.has(sha)) {
        skip('la misma foto ya está en la biblioteca de la marca (misma huella)');
        continue;
      }
      const seen = seenHashes.get(item.brandId) ?? new Set<string>();
      if (seen.has(sha)) {
        skip('repetida en esta pasada (misma huella)');
        continue;
      }
      seen.add(sha);
      seenHashes.set(item.brandId, seen);
    }
    if (input.inR2 && !copied) orphans.push(item.key);
    create.push(draftAsset(item, input.mapping, { bytes, sha256: sha }, input.importedAt));
  }
  const unknownInR2 = input.inR2 ? [...input.inR2.keys()].filter((k) => !planned.has(k)).sort() : [];
  return { create, orphans, unknownInR2, skipped };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Recuento por marca y categoría. */
export function formatAltaSummary(plan: AltaPlan): string {
  type Group = { images: number; videos: number; other: number; bytes: number; folder: string; tags: Set<string> };
  const groups = new Map<string, Group>();
  const totals = new Map<string, { images: number; videos: number; bytes: number }>();
  for (const d of plan.create) {
    const key = `${d.brandLabel} | ${d.category || 'sin categoría'}`;
    const g = groups.get(key) ?? { images: 0, videos: 0, other: 0, bytes: 0, folder: d.row.folder, tags: new Set() };
    if (d.row.kind === 'image') g.images++;
    else if (d.row.kind === 'video') g.videos++;
    else g.other++;
    g.bytes += d.row.bytes;
    for (const t of d.row.tags) g.tags.add(t);
    groups.set(key, g);
    const t = totals.get(d.brandLabel) ?? { images: 0, videos: 0, bytes: 0 };
    if (d.row.kind === 'video') t.videos++;
    else t.images++;
    t.bytes += d.row.bytes;
    totals.set(d.brandLabel, t);
  }
  const lines = ['Marca | categoría del inventario | fotos | vídeos | tamaño | carpeta | etiquetas distintas'];
  for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'es'))) {
    const other = g.other ? ` (+${g.other} otros)` : '';
    lines.push(`${key} | ${g.images} | ${g.videos}${other} | ${mb(g.bytes)} | ${g.folder} | ${g.tags.size}`);
  }
  lines.push('');
  for (const [brand, t] of [...totals].sort(([a], [b]) => a.localeCompare(b, 'es'))) {
    lines.push(`TOTAL ${brand} | ${t.images} | ${t.videos} | ${mb(t.bytes)}`);
  }
  lines.push(`TOTAL | ${plan.create.length} recursos | ${mb(plan.create.reduce((s, d) => s + d.row.bytes, 0))}`);
  if (Object.keys(plan.skipped).length) {
    lines.push('', 'No se dan de alta:');
    for (const [why, n] of Object.entries(plan.skipped).sort()) lines.push(`  ${n} · ${why}`);
  }
  if (plan.orphans.length)
    lines.push('', `${plan.orphans.length} · en R2 sin anotar en --state (huérfanos): se completan`);
  if (plan.unknownInR2.length) {
    lines.push('', `${plan.unknownInR2.length} · objetos en R2 que no salen del inventario (no se tocan):`);
    lines.push(...plan.unknownInR2.slice(0, 10).map((k) => `  ${k}`));
  }
  return lines.join('\n');
}

// ─────────────────────────────── Dimensiones ───────────────────────────────

/** Ancho y alto de una imagen JPEG (con la orientación EXIF) o PNG, leyendo su cabecera. */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number, le = false) => (le ? buf[i]! | (buf[i + 1]! << 8) : (buf[i]! << 8) | buf[i + 1]!);
  const u32 = (i: number, le = false) =>
    le
      ? (buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16) | (buf[i + 3]! << 24)) >>> 0
      : ((buf[i]! << 24) | (buf[i + 1]! << 16) | (buf[i + 2]! << 8) | buf[i + 3]!) >>> 0;
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: u32(16), height: u32(20) };
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = u16(i + 2);
    if (marker === 0xe1 && String.fromCharCode(...buf.subarray(i + 4, i + 8)) === 'Exif') {
      const tiff = i + 10;
      const le = buf[tiff] === 0x49;
      const ifd = tiff + u32(tiff + 4, le);
      const count = ifd + 2 <= buf.length ? u16(ifd, le) : 0;
      for (let e = 0; e < count && ifd + 2 + e * 12 + 10 <= buf.length; e++) {
        const entry = ifd + 2 + e * 12;
        if (u16(entry, le) === 0x0112) orientation = u16(entry + 8, le);
      }
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16(i + 5);
      const width = u16(i + 7);
      if (!width || !height) return null;
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    i += 2 + len;
  }
  return null;
}

// ─────────────────────────────── Base de datos ───────────────────────────────

export interface LibraryAsset {
  storage_path: string;
  sha256: string | null;
  bytes: number;
  storage_backend: string;
}

/** Lo que el alta necesita de la base de datos (clave de servicio). */
export interface LibraryDb {
  brandAssets(brandId: string): Promise<LibraryAsset[]>;
  /** Apunta la ruta como objeto de R2 (`media_storage_register_upload`, sin persona). */
  registerR2(path: string): Promise<void>;
  /** Inserta sin duplicar (la ruta es única); devuelve cuántas filas entraron. */
  insertAssets(rows: AssetRow[]): Promise<number>;
}

export function restLibraryDb(url: string, serviceKey: string, fetchImpl: typeof fetch = fetch): LibraryDb {
  const base = `${url.replace(/\/+$/, '')}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  return {
    async brandAssets(brandId) {
      const out: LibraryAsset[] = [];
      for (let offset = 0; ; offset += 1000) {
        const response = await fetchImpl(
          `${base}/media_assets?select=storage_path,sha256,bytes,storage_backend&brand_id=eq.${brandId}` +
            `&order=storage_path&limit=1000&offset=${offset}`,
          { headers },
        );
        if (!response.ok) throw new Error(`No se pudo leer la biblioteca (HTTP ${response.status})`);
        const rows = (await response.json()) as LibraryAsset[];
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    },
    async registerR2(path) {
      const response = await fetchImpl(`${base}/rpc/media_storage_register_upload`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_user_id: null, p_path: path }),
      });
      if (!response.ok) throw new Error(`No se pudo apuntar en R2 (HTTP ${response.status}: ${await response.text()})`);
    },
    async insertAssets(rows) {
      const response = await fetchImpl(`${base}/media_assets?on_conflict=storage_path&select=id`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
      if (!response.ok) throw new Error(`No se pudo dar de alta (HTTP ${response.status}: ${await response.text()})`);
      return ((await response.json()) as unknown[]).length;
    },
  };
}

// ─────────────────────────────── Ejecución ───────────────────────────────

/** Organización y marca de cada marca del plan, para listar R2 y la biblioteca. */
function brandsOf(items: PlanItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    if (item.source === 'brand-media' || !item.brandId) continue;
    const org = item.key.split('/')[0] ?? '';
    if (!org.startsWith('<')) out.set(item.brandId, org);
  }
  return out;
}

/** Objetos en R2 bajo la carpeta de importación de cada marca. */
export async function listImported(r2: ObjectStorage, brands: Map<string, string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [brand, org] of brands) {
    for (const o of await r2.list(`${org}/${brand}/${IMPORT_FOLDER}/`)) out.set(o.key, o.bytes);
  }
  return out;
}

export async function libraryOf(db: LibraryDb, brandIds: Iterable<string>) {
  const library = new Map<string, LibraryState>();
  const assets = new Map<string, LibraryAsset[]>();
  for (const brand of brandIds) {
    const rows = await db.brandAssets(brand);
    assets.set(brand, rows);
    library.set(brand, {
      paths: new Set(rows.map((r) => r.storage_path)),
      hashes: new Set(rows.map((r) => r.sha256).filter((s): s is string => !!s)),
    });
  }
  return { library, assets };
}

export interface RunAltaOptions {
  items: PlanItem[];
  mapping: AltaMapping;
  copied: Map<string, { bytes: number; sha256: string | null }>;
  r2: ObjectStorage;
  db: LibraryDb;
  /** Huella de un archivo local (para los huérfanos sin anotar). */
  hashLocal?: (file: string) => Promise<string>;
  /** Dimensiones y duración, si se pueden leer. */
  dimsFor?: (item: PlanItem) => Promise<Dims | null>;
  concurrency?: number;
  limit?: number;
  now?: () => string;
  log?: (line: string) => void;
}

export interface RunAltaResult {
  plan: AltaPlan;
  created: number;
  failed: Array<{ key: string; error: string }>;
}

/** Da de alta lo copiado que falta. Idempotente: relanzarlo no duplica nada. */
export async function runAlta(o: RunAltaOptions): Promise<RunAltaResult> {
  const brands = brandsOf(o.items);
  if (o.items.some((i) => i.source !== 'brand-media' && i.key.startsWith('<'))) {
    throw new Error('Hay claves sin organización: resuelve las marcas del mapeo antes de dar de alta');
  }
  const { library } = await libraryOf(o.db, brands.keys());
  const inR2 = await listImported(o.r2, brands);
  const plan = planAlta({
    items: o.items,
    mapping: o.mapping,
    copied: o.copied,
    inR2,
    library,
    assumeCopied: false,
    importedAt: (o.now ?? (() => new Date().toISOString()))(),
  });
  const queue = plan.create.slice(0, o.limit ?? Infinity);
  const ready: AssetRow[] = [];
  const failed: RunAltaResult['failed'] = [];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(16, o.concurrency ?? 4)) }, async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        try {
          if (!d.row.sha256 && d.item.source === 'local' && o.hashLocal) d.row.sha256 = await o.hashLocal(d.item.from);
          const dims = o.dimsFor ? await o.dimsFor(d.item).catch(() => null) : null;
          if (dims) {
            d.row.width = dims.width;
            d.row.height = dims.height;
            d.row.duration_ms = dims.durationMs;
          }
          await o.db.registerR2(d.row.storage_path);
          ready.push(d.row);
        } catch (e) {
          failed.push({ key: d.row.storage_path, error: (e as Error).message });
        }
      }
    }),
  );
  let created = 0;
  for (let i = 0; i < ready.length; i += 50) {
    const batch = ready.slice(i, i + 50);
    try {
      created += await o.db.insertAssets(batch);
    } catch (e) {
      for (const row of batch) failed.push({ key: row.storage_path, error: (e as Error).message });
    }
  }
  o.log?.(`Dados de alta ${created}; fallidos ${failed.length} (se reintentan al relanzar).`);
  return { plan, created, failed };
}

export interface CheckResult {
  /** Recursos de R2 sin objeto en el cubo. */
  missing: string[];
  /** Recursos cuyo tamaño no coincide con el del objeto. */
  sizeMismatch: string[];
  /** Objetos importados sin recurso (relanzar --apply los completa). */
  orphans: string[];
  /** Recursos importados que aún se leen de Supabase. */
  notR2: string[];
  ok: number;
}

/** Comprobación de solo lectura de lo importado: biblioteca frente a R2. */
export function checkImported(assets: LibraryAsset[], inR2: Map<string, number>): CheckResult {
  const result: CheckResult = { missing: [], sizeMismatch: [], orphans: [], notR2: [], ok: 0 };
  const imported = assets.filter((a) => a.storage_path.split('/').slice(2, 4).join('/') === IMPORT_FOLDER);
  const paths = new Set(imported.map((a) => a.storage_path));
  for (const a of imported) {
    const bytes = inR2.get(a.storage_path);
    if (a.storage_backend !== 'r2') result.notR2.push(a.storage_path);
    else if (bytes === undefined) result.missing.push(a.storage_path);
    else if (Number(a.bytes) !== bytes) result.sizeMismatch.push(a.storage_path);
    else result.ok++;
  }
  for (const key of inR2.keys()) if (!paths.has(key)) result.orphans.push(key);
  return result;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readLocalHead(file: string, bytes = 256 * 1024): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function dimsReader(r2: ObjectStorage, driveToken: string | null) {
  return async (item: PlanItem): Promise<Dims | null> => {
    if (item.source === 'local') {
      const size = imageSize(await readLocalHead(item.from));
      return size ? { ...size, durationMs: null } : null;
    }
    if (driveToken && item.source === 'drive') {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.from)}` +
          '?supportsAllDrives=true&fields=imageMediaMetadata(width,height,rotation),videoMediaMetadata(width,height,durationMillis)',
        { headers: { Authorization: `Bearer ${driveToken}` } },
      );
      if (response.ok) {
        const m = (await response.json()) as {
          imageMediaMetadata?: { width?: number; height?: number; rotation?: number };
          videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
        };
        if (m.videoMediaMetadata) {
          const v = m.videoMediaMetadata;
          return { width: v.width ?? null, height: v.height ?? null, durationMs: Number(v.durationMillis) || null };
        }
        if (m.imageMediaMetadata?.width && m.imageMediaMetadata.height) {
          const { width, height, rotation } = m.imageMediaMetadata;
          return rotation === 1 || rotation === 3
            ? { width: height, height: width, durationMs: null }
            : { width, height, durationMs: null };
        }
      }
    }
    if (item.mime.startsWith('image/')) {
      const response = await fetch(await r2.signGet(item.key, 300), { headers: { Range: 'bytes=0-262143' } });
      if (!response.ok) return null;
      const size = imageSize(new Uint8Array(await response.arrayBuffer()));
      return size ? { ...size, durationMs: null } : null;
    }
    return null;
  };
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  const mode = a.apply === true ? 'apply' : a.comprobar === true ? 'check' : 'dry';
  if (typeof a.marcas !== 'string') throw new Error('Falta --marcas <json> (marca del inventario → brand_id)');
  if (typeof a['drive-csv'] !== 'string' || !existsSync(a['drive-csv'])) {
    throw new Error('Falta --drive-csv <inventario> (el mismo que en la copia)');
  }
  const statePath = path.resolve(String(a.state ?? 'migrar-a-r2.estado.jsonl'));
  const mapping = parseAltaMapping(JSON.parse(await readFile(a.marcas, 'utf8')) as unknown);
  if (mode !== 'dry') {
    mapping.brands = await resolveBrandOrganizations(
      mapping.brands,
      brandOrganizationsFromRest(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY')),
    );
  }
  const jpegList =
    typeof a['jpeg-jsonl'] === 'string'
      ? (await readJsonl(a['jpeg-jsonl'])).map((e) => ({ id: String(e.id), title: String(e.title ?? '') }))
      : null;
  const plan = buildPlan({
    brands: mapping.brands,
    org: null,
    brand: null,
    brandMedia: null,
    driveRows: parseCsv(await readFile(a['drive-csv'], 'utf8')),
    estado: typeof a.estado === 'string' ? a.estado : 'incluida',
    jpegDir: typeof a['jpeg-dir'] === 'string' ? a['jpeg-dir'] : null,
    jpegList,
    localSize(file) {
      try {
        return existsSync(file) ? statSync(file).size : null;
      } catch {
        return null;
      }
    },
  });
  const copied = new Map<string, { bytes: number; sha256: string | null }>();
  const hasState = existsSync(statePath);
  if (hasState) {
    for (const e of await readJsonl(statePath)) {
      copied.set(String(e.key), {
        bytes: Number(e.bytes) || 0,
        sha256: typeof e.sha256 === 'string' ? e.sha256 : null,
      });
    }
  }

  if (mode === 'dry') {
    console.log('EN SECO: no se escribe nada');
    console.log(
      hasState
        ? `Se cuenta lo anotado en ${statePath} (${copied.size} objetos copiados).`
        : 'Sin registro de la copia: se cuenta todo lo que la copia llevaría a R2.',
    );
    const altaPlan = planAlta({
      items: plan.items,
      mapping,
      copied,
      inR2: null,
      library: null,
      assumeCopied: !hasState,
      importedAt: new Date().toISOString(),
    });
    console.log(formatAltaSummary(altaPlan));
    if (Object.keys(plan.skipped).length) {
      console.log('\nFuera de la copia (no llegan a R2; detalle en scripts/migrar-a-r2.ts):');
      for (const [why, n] of Object.entries(plan.skipped).sort()) console.log(`  ${n} · ${why}`);
    }
    if (plan.warnings.length) console.log('', ...plan.warnings.slice(0, 5).map((w) => `Aviso: ${w}\n`));
    return 0;
  }

  const r2 = r2FromEnv();
  const db = restLibraryDb(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'));
  if (mode === 'check') {
    const brands = brandsOf(plan.items);
    const inR2 = await listImported(r2, brands);
    const { assets } = await libraryOf(db, brands.keys());
    const result = checkImported([...assets.values()].flat(), inR2);
    console.log(`Bien: ${result.ok}`);
    for (const [label, list] of [
      ['Recursos sin objeto en R2', result.missing],
      ['Tamaño distinto en R2', result.sizeMismatch],
      ['Objetos en R2 sin recurso (relanzar --apply)', result.orphans],
      ['Recursos importados que no están en R2', result.notR2],
    ] as const) {
      console.log(`${label}: ${list.length}`);
      for (const key of list.slice(0, 20)) console.log(`  ${key}`);
    }
    return result.missing.length + result.sizeMismatch.length + result.orphans.length + result.notR2.length > 0 ? 1 : 0;
  }

  console.log('ALTA EN LA BIBLIOTECA (sin tocar los archivos)');
  const result = await runAlta({
    items: plan.items,
    mapping,
    copied,
    r2,
    db,
    hashLocal: hashFile,
    dimsFor: dimsReader(r2, process.env.DRIVE_ACCESS_TOKEN?.trim() || null),
    concurrency: Number(a.concurrency) || 4,
    limit: Number(a.limit) > 0 ? Number(a.limit) : undefined,
    log: (line) => console.log(line),
  });
  console.log(formatAltaSummary(result.plan));
  for (const f of result.failed.slice(0, 20)) console.error(`No se dio de alta ${f.key}: ${f.error}`);
  return result.failed.length > 0 ? 1 : 0;
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
