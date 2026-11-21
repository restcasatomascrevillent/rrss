// El publicador: atiende un trabajo `social.publish` de la cola y publica la
// publicación programada en Instagram (imagen, carrusel o reel).
//
// Cómo se garantiza que NO se publica dos veces:
//   1. Cola: un trabajo por publicación, generación y hora (clave de
//      idempotencia), reclamado con FOR UPDATE SKIP LOCKED y una reserva.
//   2. Cerrojo: `social_publication_begin` deja la publicación «publishing» a
//      nombre de ESE trabajo; otro trabajo la encuentra ocupada.
//   3. El contenedor de Instagram se guarda en la base de datos ANTES de llamar
//      a media_publish. En cualquier reintento se mira primero: si ya está
//      PUBLISHED no se publica otra vez, se recupera la publicación.
//   4. media_publish nunca se repite por su cuenta: si falla con una respuesta
//      dudosa (tiempo agotado, red, 5xx), se mira el contenedor.
//   5. Lo publicado no cambia de estado (lo impone la base de datos).
// Y cómo se garantiza que no se publica sin aprobar: la base de datos lo
// comprueba al tomar la publicación y otra vez justo antes de media_publish
// (`social_publication_container`), en la misma transacción que el cerrojo.
import type { RpcClient } from '../ai/contract.ts';
import { composeCaption, INSTAGRAM_ALT_TEXT_MAX, INSTAGRAM_CAPTION_MAX, readCopy } from './caption.ts';
import { SocialApiError, type ClaimedSocialJob, type ContainerInfo, type InstagramApi } from './contract.ts';
import { decryptToken, tokenBinding, TokenKeyError, type TokenKeyRing } from './crypto.ts';

export interface PublisherDeps {
  rpc: RpcClient;
  api: InstagramApi;
  keyRing: TokenKeyRing;
  /** URL firmada (pública y temporal) de un archivo del almacenamiento, para que Meta lo descargue. */
  signedUrl(storagePath: string, expiresInSeconds: number): Promise<string>;
  /** Nombre del trabajador en la cola (el mismo con el que reclamó). */
  workerName: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Espera entre consultas del estado del contenedor (ms). Por defecto, 2 s. */
  pollIntervalMs?: number;
  /** Consultas del contenedor antes de aplazar. Por defecto, 5. */
  pollAttempts?: number;
}

export type PublishOutcome =
  | 'published'
  | 'recovered'
  | 'already_published'
  | 'not_ready'
  | 'not_due'
  | 'busy'
  | 'gone'
  | 'waiting'
  | 'deferred'
  | 'retrying'
  | 'failed'
  | 'error';

export interface PublishResult {
  outcome: PublishOutcome;
  publicationId: string | null;
  externalId?: string;
  errorCode?: string;
}

/** Cuánto se espera antes de volver a mirar un vídeo que Instagram aún procesa. */
export const CONTAINER_WAIT_SECONDS = 60;
/** Un contenedor que sigue procesándose al cabo de esto se da por perdido (caducan a las 24 h). */
export const CONTAINER_MAX_AGE_MS = 30 * 60_000;
/** Cupo agotado: se vuelve a mirar al cabo de una hora. */
export const PUBLISH_LIMIT_WAIT_SECONDS = 3600;
/** Límite de llamadas de la API: se vuelve a intentar al cabo de 15 minutos. */
export const RATE_LIMIT_WAIT_SECONDS = 900;
/** A partir de esta fracción del cupo se avisa. */
export const QUOTA_WARNING_RATIO = 0.8;
const SIGNED_URL_SECONDS = 3600;

class RpcFailure extends Error {
  override name = 'RpcFailure';
  constructor(
    readonly fn: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

interface BeginReady {
  outcome: 'ready';
  attempt_no: number;
  publication: {
    id: string;
    brand_id: string;
    format: string;
    container_id: string | null;
    container_created_at: string | null;
  };
  account: { id: string; network: string; external_id: string; token_expires_at: string | null };
  copy: unknown;
  assets: Array<{ id: string; storage_path: string; mime_type: string; kind: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function processPublishJob(job: ClaimedSocialJob, deps: PublisherDeps): Promise<PublishResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => undefined);
  const publicationId = typeof job.payload.publication_id === 'string' ? job.payload.publication_id : '';

  async function rpcOk<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await deps.rpc(fn, args);
    if (error) throw new RpcFailure(fn, error.code, error.message);
    return data as T;
  }
  /** Cierra el trabajo; si la reserva se perdió, no hay nada más que hacer. */
  async function completeJob(result: Record<string, unknown>) {
    await rpcOk('complete_job', { p_job_id: job.id, p_worker: deps.workerName, p_result: result }).catch((e) =>
      log('complete_job_failed', { jobId: job.id, message: (e as Error).message }),
    );
  }
  async function failJob(message: string, retry: boolean) {
    await rpcOk('fail_job', { p_job_id: job.id, p_worker: deps.workerName, p_error: message, p_retry: retry }).catch(
      (e) => log('fail_job_failed', { jobId: job.id, message: (e as Error).message }),
    );
  }

  if (!UUID.test(publicationId)) {
    await failJob('Trabajo sin publicación', false);
    return { outcome: 'error', publicationId: null };
  }

  let begin: { outcome: string } & Partial<BeginReady>;
  try {
    begin = await rpcOk('social_publication_begin', {
      p_publication_id: publicationId,
      p_job_id: job.id,
      p_lease_seconds: 300,
    });
  } catch (e) {
    log('begin_failed', { publicationId, message: (e as Error).message });
    await failJob('No se pudo tomar la publicación', true);
    return { outcome: 'error', publicationId };
  }
  if (begin.outcome !== 'ready') {
    // Ya publicada, cancelada, sin aprobar, movida de fecha u ocupada: nada que publicar.
    await completeJob({ outcome: begin.outcome });
    return { outcome: begin.outcome as PublishOutcome, publicationId };
  }
  const ready = begin as BeginReady;
  const pub = ready.publication;
  const account = ready.account;
  const copy = readCopy(ready.copy);
  const caption = composeCaption(copy);
  const ig = account.external_id;

  async function defer(seconds: number, keepLock: boolean, code: string, message: string): Promise<PublishResult> {
    await rpcOk('social_publication_defer', {
      p_publication_id: pub.id,
      p_job_id: job.id,
      p_worker: deps.workerName,
      p_seconds: seconds,
      p_keep_lock: keepLock,
      p_code: code,
      p_message: message,
    });
    return { outcome: keepLock ? 'waiting' : 'deferred', publicationId: pub.id, errorCode: code };
  }

  async function fail(code: string, message: string, final: boolean): Promise<PublishResult> {
    await rpcOk('social_publication_fail', {
      p_publication_id: pub.id,
      p_job_id: job.id,
      p_code: code,
      p_message: message,
      p_final: final,
    });
    await failJob(message, !final);
    return { outcome: final ? 'failed' : 'retrying', publicationId: pub.id, errorCode: code };
  }

  async function succeed(mediaId: string, permalink: string | null, recovered: boolean): Promise<PublishResult> {
    await rpcOk('social_publication_succeed', {
      p_publication_id: pub.id,
      p_job_id: job.id,
      p_external_id: mediaId,
      p_external_url: permalink,
      p_recovered: recovered,
    });
    await completeJob({ outcome: recovered ? 'recovered' : 'published', external_id: mediaId });
    return { outcome: recovered ? 'recovered' : 'published', publicationId: pub.id, externalId: mediaId };
  }

  async function saveContainer(containerId: string | null) {
    await rpcOk('social_publication_container', {
      p_publication_id: pub.id,
      p_job_id: job.id,
      p_container_id: containerId,
    });
  }

  /** El contenedor ya estaba publicado: se busca la publicación en vez de repetirla. */
  async function recover(token: string, containerCreatedAt: string | null): Promise<PublishResult> {
    log('recover', { publicationId: pub.id });
    const since = (Date.parse(containerCreatedAt ?? '') || now() - 25 * 3_600_000) - 10 * 60_000;
    const media = await deps.api.recentMedia(ig, token).catch(() => []);
    const match = media
      .filter((m) => (Date.parse(m.timestamp ?? '') || 0) >= since && (m.caption ?? '').trim() === caption.trim())
      .sort((a, b) => (Date.parse(b.timestamp ?? '') || 0) - (Date.parse(a.timestamp ?? '') || 0))[0];
    if (match) {
      const permalink = match.permalink ?? (await deps.api.permalink(match.id, token).catch(() => null));
      return succeed(match.id, permalink, true);
    }
    // No se repite: lo que diga la red manda. Reintentar a mano vuelve a mirar el contenedor.
    return fail(
      'published_unconfirmed',
      'Instagram indica que esta publicación ya salió, pero no se encontró en la cuenta: compruébala allí. No se ha vuelto a publicar.',
      true,
    );
  }

  async function waitForContainer(containerId: string, token: string): Promise<ContainerInfo> {
    let info = await deps.api.containerStatus(containerId, token);
    for (let i = 1; i < (deps.pollAttempts ?? 5) && info.status === 'IN_PROGRESS'; i++) {
      await sleep(deps.pollIntervalMs ?? 2000);
      info = await deps.api.containerStatus(containerId, token);
    }
    return info;
  }

  async function stillProcessing(containerCreatedAt: string | null): Promise<PublishResult> {
    const age = now() - (Date.parse(containerCreatedAt ?? '') || now());
    if (age > CONTAINER_MAX_AGE_MS) {
      await saveContainer(null);
      return fail(
        'container_timeout',
        'Instagram no terminó de procesar el medio a tiempo; se volverá a intentar.',
        false,
      );
    }
    return defer(CONTAINER_WAIT_SECONDS, true, 'container_in_progress', 'Instagram está procesando el medio.');
  }

  try {
    if (account.network !== 'instagram') {
      return await fail('unsupported_network', 'Esta red todavía no se publica automáticamente.', true);
    }
    if (account.token_expires_at && Date.parse(account.token_expires_at) <= now()) {
      throw new SocialApiError({ kind: 'token', message: 'El token de la cuenta ha caducado' });
    }
    const secret = await rpcOk<{ key_id: string; access_token_ciphertext: string } | null>('social_account_token', {
      p_account_id: account.id,
    });
    if (!secret) throw new SocialApiError({ kind: 'token', message: 'La cuenta no tiene token' });
    const token = await decryptToken(
      deps.keyRing,
      secret.key_id,
      secret.access_token_ciphertext,
      tokenBinding({ brandId: pub.brand_id, network: account.network, externalId: account.external_id }),
    );

    // 1. ¿Hay ya un contenedor de un intento anterior? Se mira antes de nada.
    let containerId = pub.container_id;
    let containerCreatedAt = pub.container_created_at;
    if (containerId) {
      const info = await waitForContainer(containerId, token);
      if (info.status === 'PUBLISHED') return await recover(token, containerCreatedAt);
      if (info.status === 'IN_PROGRESS') return await stillProcessing(containerCreatedAt);
      if (info.status !== 'FINISHED') {
        // Caducado o con error: no se publicó; se crea otro.
        await saveContainer(null);
        containerId = null;
      }
    }

    if (!containerId) {
      if (caption.length > INSTAGRAM_CAPTION_MAX) {
        return await fail('caption_too_long', `El texto pasa de ${INSTAGRAM_CAPTION_MAX} caracteres.`, true);
      }
      // 2. Cupo de publicación de la cuenta (lo da la red; no se supone).
      const limit = await deps.api.publishingLimit(ig, token);
      await rpcOk('social_account_report', {
        p_account_id: account.id,
        p_quota_usage: limit.usage,
        p_quota_total: limit.total,
      }).catch((e) => log('quota_report_failed', { message: (e as Error).message }));
      if (limit.total !== null && limit.usage >= limit.total) {
        return await defer(
          PUBLISH_LIMIT_WAIT_SECONDS,
          false,
          'publish_limit',
          `La cuenta ha llegado a su límite de publicaciones (${limit.usage} de ${limit.total} en 24 h). Se volverá a intentar.`,
        );
      }
      if (limit.total !== null && limit.usage >= limit.total * QUOTA_WARNING_RATIO) {
        log('quota_warning', { accountId: account.id, usage: limit.usage, total: limit.total });
      }

      // 3. Contenedor nuevo, guardado ANTES de publicar.
      const urls = await Promise.all(ready.assets.map((a) => deps.signedUrl(a.storage_path, SIGNED_URL_SECONDS)));
      const altText = copy.altText.trim().slice(0, INSTAGRAM_ALT_TEXT_MAX) || undefined;
      if (pub.format === 'post') {
        containerId = await deps.api.createImageContainer(ig, token, { imageUrl: urls[0]!, caption, altText });
      } else if (pub.format === 'carousel') {
        const children: string[] = [];
        for (const url of urls) children.push(await deps.api.createCarouselItem(ig, token, { imageUrl: url }));
        for (const child of children) {
          const info = await waitForContainer(child, token);
          if (info.status !== 'FINISHED') {
            throw new SocialApiError({
              kind: info.status === 'IN_PROGRESS' ? 'transient' : 'rejected',
              message: `Instagram no aceptó una imagen del carrusel (${info.status}${info.detail ? `: ${info.detail}` : ''})`,
            });
          }
        }
        containerId = await deps.api.createCarouselContainer(ig, token, { children, caption });
      } else if (pub.format === 'reel') {
        containerId = await deps.api.createReelContainer(ig, token, { videoUrl: urls[0]!, caption, shareToFeed: true });
      } else {
        return await fail('unsupported_format', 'Este formato todavía no se publica automáticamente.', true);
      }
      await saveContainer(containerId);
      containerCreatedAt = new Date(now()).toISOString();

      const info = await waitForContainer(containerId, token);
      if (info.status === 'IN_PROGRESS') return await stillProcessing(containerCreatedAt);
      if (info.status === 'PUBLISHED') return await recover(token, containerCreatedAt);
      if (info.status !== 'FINISHED') {
        await saveContainer(null);
        throw new SocialApiError({
          kind: 'rejected',
          message: `Instagram no aceptó el medio (${info.status}${info.detail ? `: ${info.detail}` : ''})`,
        });
      }
    }

    // 4. Publicar. La base de datos vuelve a comprobar la aprobación justo antes.
    await saveContainer(containerId);
    let mediaId: string;
    try {
      mediaId = await deps.api.mediaPublish(ig, token, containerId);
    } catch (e) {
      if (e instanceof SocialApiError && (e.dubious || e.kind === 'transient' || e.kind === 'unexpected')) {
        // ¿Salió de todos modos? Se mira el contenedor (dos veces: Meta puede tardar en marcarlo).
        for (let i = 0; i < 2; i++) {
          if (i > 0) await sleep(3000);
          const info = await deps.api.containerStatus(containerId, token).catch(() => null);
          if (info?.status === 'PUBLISHED') return await recover(token, containerCreatedAt);
          if (!info || (info.status !== 'FINISHED' && info.status !== 'IN_PROGRESS')) break;
        }
      }
      throw e;
    }
    const permalink = await deps.api.permalink(mediaId, token).catch(() => null);
    return await succeed(mediaId, permalink, false);
  } catch (e) {
    return handleFailure(e);
  }

  async function handleFailure(e: unknown): Promise<PublishResult> {
    try {
      if (e instanceof RpcFailure && e.code === 'PB001') {
        // La pieza cambió mientras se preparaba: no se publica y vuelve al calendario detenida.
        await rpcOk('social_publication_fail', {
          p_publication_id: pub.id,
          p_job_id: job.id,
          p_code: 'not_approved',
          p_message: 'La pieza cambió o dejó de estar aprobada antes de publicarse: no se ha publicado.',
          p_final: false,
        });
        await completeJob({ outcome: 'not_ready' });
        return { outcome: 'not_ready', publicationId: pub.id, errorCode: 'not_approved' };
      }
      if (e instanceof TokenKeyError) {
        return await fail('token_unreadable', `No se puede leer el token de la cuenta: ${e.message}`, true);
      }
      if (e instanceof SocialApiError) {
        log('graph_error', { publicationId: pub.id, kind: e.kind, code: e.code, subcode: e.subcode });
        switch (e.kind) {
          case 'token':
            await rpcOk('social_account_report', {
              p_account_id: account.id,
              p_status: 'needs_reauth',
              p_last_error: e.message,
            }).catch(() => undefined);
            return await fail(
              'token_expired',
              'El acceso a la cuenta ha caducado o se ha retirado: vuelve a conectarla en Marca → Cuentas conectadas y reintenta.',
              true,
            );
          case 'publish_limit':
            return await defer(
              PUBLISH_LIMIT_WAIT_SECONDS,
              false,
              'publish_limit',
              'La cuenta ha llegado a su límite de publicaciones en 24 h. Se volverá a intentar.',
            );
          case 'rate_limited':
            return await defer(
              RATE_LIMIT_WAIT_SECONDS,
              false,
              'rate_limited',
              'Meta pide esperar (límite de llamadas). Se volverá a intentar.',
            );
          case 'rejected':
            return await fail('rejected', `Instagram lo rechazó: ${e.message}`, true);
          default:
            return await fail(e.kind, `No se pudo publicar: ${e.message}`, job.attempts >= job.max_attempts);
        }
      }
      if (e instanceof RpcFailure) {
        log('rpc_failed', { publicationId: pub.id, fn: e.fn, code: e.code });
        // La reserva o la base de datos fallaron: la cola lo reintentará.
        await failJob(`Fallo de la base de datos en ${e.fn}`, true);
        return { outcome: 'error', publicationId: pub.id };
      }
      log('unexpected', { publicationId: pub.id, message: (e as Error)?.message });
      return await fail('unexpected', 'Error inesperado al publicar.', job.attempts >= job.max_attempts);
    } catch (inner) {
      log('failure_handling_failed', { publicationId: pub.id, message: (inner as Error)?.message });
      await failJob('No se pudo registrar el fallo', true);
      return { outcome: 'error', publicationId: pub.id };
    }
  }
}
