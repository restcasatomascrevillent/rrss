// Un paso de «Importar publicaciones de la cuenta» (docs/importar-publicaciones.md).
//
// La interfaz llama a `social-import` una y otra vez mientras haya trabajo; cada
// llamada hace UN paso acotado (unas pocas páginas de /media, o unas pocas
// publicaciones copiadas a la biblioteca) y devuelve el avance. Todo lo que se
// avanza queda guardado en la base de datos en el mismo instante (página y
// cursor en una transacción), así que se puede parar en cualquier momento —cerrar
// la pestaña, un fallo, el botón «Detener»— y reanudar sin perder ni repetir.
//
//   * Respeta los límites de la API: si Meta declara un uso alto del límite de
//     llamadas (X-Business-Use-Case-Usage) o responde con un error de límite, se
//     guarda lo hecho y se pide esperar (`retry_after`).
//   * Token caducado: la cuenta pasa a «hay que volver a conectarla».
//   * El token se descifra aquí y no sale: ni a la respuesta ni al registro.
//   * Copiar imágenes: solo desde la CDN de Meta (lista de dominios), solo
//     JPEG, PNG o WebP, con tope de tamaño, comprobando antes el espacio del
//     plan, en el almacén activo (R2 o Supabase) y dando de alta el recurso en
//     la carpeta «Instagram / Publicadas» con su procedencia.
import type { RpcClient } from '../ai/contract.ts';
import { USAGE_STOP_PERCENT, RATE_LIMIT_WAIT_SECONDS } from '../analytics/capture.ts';
import type { ApiUsage } from '../analytics/insights-graph.ts';
import type { FetchLike, ObjectStorage } from '../storage/contract.ts';
import { SocialApiError } from './contract.ts';
import { decryptToken, tokenBinding, type TokenKeyRing } from './crypto.ts';
import { IMPORT_PAGE_SIZE, type ImportedChild, type ImportedPost, type MediaHistoryApi } from './import-graph.ts';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const IMPORT_FOLDER = 'Instagram / Publicadas';
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface ImportRun {
  id: string;
  status: 'running' | 'paused' | 'completed';
  phase: 'listing' | 'copying' | 'done';
  copy_images: boolean;
  after_cursor: string | null;
  pages: number;
  items_seen: number;
  items_new: number;
  copied: number;
  copy_failed: number;
  retry_after: string | null;
  last_error: string | null;
  organization_id: string;
  brand_id: string;
}

export type StepOutcome = 'progress' | 'completed' | 'waiting' | 'paused' | 'busy' | 'error';

export interface StepResult {
  outcome: StepOutcome;
  run: ImportRun | null;
  /** Mensaje para la persona (error o espera). */
  message?: string;
  retryAfterSeconds?: number;
}

export interface ImportDeps {
  rpc: RpcClient;
  api: MediaHistoryApi;
  keyRing: TokenKeyRing;
  userId: string;
  /** Descarga de imágenes (la CDN de Meta). */
  fetch: FetchLike;
  /** Dominios desde los que se aceptan imágenes. */
  allowedImageHost(host: string): boolean;
  /** Almacén al que va un archivo nuevo (R2 o Supabase) y lo deja apuntado. */
  uploadStore(path: string): Promise<ObjectStorage>;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Tiempo máximo de un paso (ms). Por defecto, 20 s. */
  budgetMs?: number;
  /** Páginas de /media como mucho por paso. Por defecto, 4. */
  maxPages?: number;
  /** Publicaciones copiadas como mucho por paso. Por defecto, 5. */
  maxCopies?: number;
  pageSize?: number;
}

/** Dominios de la CDN de Meta (Instagram y Facebook). */
export const META_CDN_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

class SpaceError extends Error {}

class CopyError extends Error {}

interface PendingPost {
  id: string;
  external_id: string;
  media_type: string;
  media_url: string | null;
  thumbnail_url: string | null;
  children: ImportedChild[];
}

/** Ancho y alto de un PNG o un JPEG por su cabecera; null si no se sabe. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
      }
      i += 2 + length;
    }
  }
  return null;
}

/** Imágenes que se copian de una publicación: (url, tipo) en orden. */
export function imageSources(post: {
  media_type: string;
  media_url: string | null;
  thumbnail_url: string | null;
  children: Array<{ media_type?: string; media_url?: string | null; thumbnail_url?: string | null }>;
}): Array<{ url: string; kind: 'image' | 'video_thumbnail' }> {
  const out: Array<{ url: string; kind: 'image' | 'video_thumbnail' }> = [];
  const one = (m: { media_type?: string; media_url?: string | null; thumbnail_url?: string | null }) => {
    if (m.media_type === 'VIDEO') {
      if (m.thumbnail_url) out.push({ url: m.thumbnail_url, kind: 'video_thumbnail' });
    } else if (m.media_url) out.push({ url: m.media_url, kind: 'image' });
  };
  if (post.media_type === 'CAROUSEL_ALBUM' && post.children.length > 0) post.children.forEach(one);
  else one(post);
  return out;
}

export async function runImportStep(runId: string, deps: ImportDeps): Promise<StepResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const started = now();
  const budget = deps.budgetMs ?? 20_000;
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await deps.rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
    return data as T;
  };

  const claim = await rpc<{
    outcome: 'ready' | 'completed' | 'paused' | 'waiting' | 'busy';
    run: ImportRun;
    account?: { id: string; brand_id: string; network: string; external_id: string; token_expires_at: string | null };
  }>('social_import_claim', { p_run_id: runId, p_user_id: deps.userId });
  if (claim.outcome !== 'ready') {
    const retry =
      claim.outcome === 'waiting' && claim.run.retry_after
        ? Math.max(1, Math.ceil((Date.parse(claim.run.retry_after) - now()) / 1000))
        : undefined;
    return { outcome: claim.outcome, run: claim.run, retryAfterSeconds: retry };
  }
  let run = claim.run;
  const account = claim.account!;

  const end = async (p: { error?: string; retry?: number; pause?: boolean }): Promise<ImportRun> =>
    rpc<ImportRun>('social_import_end_step', {
      p_run_id: runId,
      p_error: p.error ?? null,
      p_retry_seconds: p.retry ?? null,
      p_pause: p.pause ?? false,
    });

  async function download(url: string): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CopyError('Dirección de imagen no válida');
    }
    if (parsed.protocol !== 'https:' || !deps.allowedImageHost(parsed.hostname)) {
      throw new CopyError('La imagen no está en la CDN de Meta');
    }
    let response: Response;
    try {
      response = await deps.fetch(parsed.toString(), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new CopyError('No se pudo descargar la imagen');
    }
    if (response.status === 403 || response.status === 404 || response.status === 410) {
      throw new CopyError('La dirección de la imagen ha caducado: vuelve a importar para renovarla');
    }
    if (!response.ok) throw new CopyError(`La CDN respondió ${response.status}`);
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = IMAGE_TYPES[mime];
    if (!ext) throw new CopyError('El archivo no es una imagen JPEG, PNG o WebP');
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new CopyError('La imagen pesa demasiado');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new CopyError('Imagen vacía o demasiado grande');
    return { bytes, mime, ext };
  }

  async function copyPost(post: PendingPost): Promise<void> {
    const sources = imageSources(post);
    if (sources.length === 0) {
      await rpc('social_import_mark_copy', {
        p_run_id: runId,
        p_imported_id: post.id,
        p_status: 'skipped',
        p_reason: 'Sin imagen que copiar',
      });
      return;
    }
    const files: Array<Record<string, unknown>> = [];
    for (const [index, source] of sources.entries()) {
      const image = await download(source.url);
      const path = `${run.organization_id}/${run.brand_id}/instagram/publicadas/${post.external_id.replace(/[^A-Za-z0-9_-]/g, '_')}-${index}.${image.ext}`;
      try {
        await rpc('social_import_check_space', { p_run_id: runId, p_bytes: image.bytes.length });
      } catch (e) {
        if ((e as { code?: string }).code === 'PL001') {
          throw new SpaceError(
            'No queda espacio en el plan para copiar más imágenes: libera espacio o cambia de plan.',
          );
        }
        throw e;
      }
      const store = await deps.uploadStore(path);
      await store.put(path, image.bytes, image.mime, image.bytes.length);
      const size = imageSize(image.bytes);
      files.push({
        path,
        file_name: `instagram-${post.external_id}-${index + 1}.${image.ext}`,
        mime_type: image.mime,
        bytes: image.bytes.length,
        width: size?.width ?? null,
        height: size?.height ?? null,
        index,
        kind: source.kind,
      });
    }
    await rpc('social_import_register_copy', {
      p_run_id: runId,
      p_user_id: deps.userId,
      p_imported_id: post.id,
      p_files: files,
    });
  }

  async function fail(e: unknown): Promise<StepResult> {
    if (e instanceof SocialApiError) {
      if (e.kind === 'token') {
        await rpc('social_account_report', {
          p_account_id: account.id,
          p_status: 'needs_reauth',
          p_last_error: e.message,
        }).catch(() => undefined);
        run = await end({ error: 'El acceso de la cuenta ha caducado: vuelve a conectarla.', pause: true });
        return { outcome: 'error', run, message: run.last_error ?? e.message };
      }
      if (e.kind === 'rate_limited' || e.kind === 'publish_limit') {
        run = await end({ error: e.message, retry: RATE_LIMIT_WAIT_SECONDS });
        return {
          outcome: 'waiting',
          run,
          retryAfterSeconds: RATE_LIMIT_WAIT_SECONDS,
          message: 'Meta pide ir más despacio: la importación sigue sola dentro de un rato.',
        };
      }
      run = await end({ error: `Meta respondió con un error: ${e.message}`, pause: true });
      return { outcome: 'error', run, message: run.last_error ?? e.message };
    }
    if (e instanceof SpaceError) {
      run = await end({ error: e.message, pause: true });
      return { outcome: 'error', run, message: e.message };
    }
    log('step_failed', { runId, message: e instanceof Error ? e.message.slice(0, 200) : 'desconocido' });
    const message = 'La importación se detuvo por un fallo inesperado. Puedes reanudarla.';
    run = await end({ error: message, pause: true }).catch(() => run);
    return { outcome: 'error', run, message };
  }

  try {
    if (account.token_expires_at && Date.parse(account.token_expires_at) <= now()) {
      throw new SocialApiError({ kind: 'token', message: 'El token de la cuenta ha caducado' });
    }
    const secret = await rpc<{ key_id: string; access_token_ciphertext: string } | null>('social_account_token', {
      p_account_id: account.id,
    });
    if (!secret) throw new SocialApiError({ kind: 'token', message: 'La cuenta no tiene token' });
    const token = await decryptToken(
      deps.keyRing,
      secret.key_id,
      secret.access_token_ciphertext,
      tokenBinding({ brandId: account.brand_id, network: account.network, externalId: account.external_id }),
    );

    const wait: { seconds: number | null } = { seconds: null };
    const checkUsage = (usage: ApiUsage | null) => {
      if (!usage) return;
      const top = Math.max(usage.callCount, usage.totalCputime, usage.totalTime);
      if (top >= USAGE_STOP_PERCENT) wait.seconds = Math.max(RATE_LIMIT_WAIT_SECONDS, usage.regainMinutes * 60);
    };

    // 1. Recorrer /media.
    if (run.phase === 'listing') {
      for (let n = 0; n < (deps.maxPages ?? 4) && now() - started < budget; n++) {
        const page = await deps.api.listMedia(account.external_id, token, {
          after: run.after_cursor,
          limit: deps.pageSize ?? IMPORT_PAGE_SIZE,
        });
        const saved = await rpc<{ stale: boolean; run: ImportRun }>('social_import_save_page', {
          p_run_id: runId,
          p_items: page.items satisfies ImportedPost[],
          p_from_cursor: run.after_cursor,
          p_next_cursor: page.nextCursor,
        });
        run = saved.run;
        checkUsage(page.usage);
        if (saved.stale || run.phase !== 'listing' || run.status !== 'running' || wait.seconds !== null) break;
      }
    }

    // 2. Copiar imágenes a la biblioteca.
    if (run.phase === 'copying' && run.status === 'running' && wait.seconds === null) {
      const pending = await rpc<PendingPost[]>('social_import_pending_copies', {
        p_run_id: runId,
        p_limit: deps.maxCopies ?? 5,
      });
      for (const post of pending) {
        if (now() - started >= budget) break;
        try {
          await copyPost(post);
        } catch (e) {
          if (!(e instanceof CopyError)) throw e;
          log('copy_failed', { importedId: post.id });
          await rpc('social_import_mark_copy', {
            p_run_id: runId,
            p_imported_id: post.id,
            p_status: 'failed',
            p_reason: e.message,
          });
        }
      }
    }

    run = await end(wait.seconds !== null ? { retry: wait.seconds } : {});
    if (run.status === 'completed') return { outcome: 'completed', run };
    if (wait.seconds !== null) {
      return {
        outcome: 'waiting',
        run,
        retryAfterSeconds: wait.seconds,
        message: 'Meta pide ir más despacio: la importación sigue sola dentro de un rato.',
      };
    }
    return { outcome: run.status === 'paused' ? 'paused' : 'progress', run };
  } catch (e) {
    return fail(e);
  }
}
