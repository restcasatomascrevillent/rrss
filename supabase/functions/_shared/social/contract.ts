// Contrato de los conectores de redes sociales (Fase 3, docs/publicacion.md).
// Sin dependencias de Deno ni de Node: lo usan las Edge Functions y las pruebas.

/** Tipo de trabajo de la cola que publica una publicación programada. */
export const SOCIAL_PUBLISH_JOB_KIND = 'social.publish';

/**
 * Qué clase de fallo da la red, que decide qué se hace después:
 *   token          el token ya no vale (caducado, revocado): no se reintenta;
 *                  la cuenta pasa a «hay que volver a conectarla».
 *   publish_limit  cupo de publicaciones de la cuenta agotado: se aplaza.
 *   rate_limited   límite de llamadas de la API: se aplaza un rato.
 *   transient      error de red, tiempo agotado o 5xx: se reintenta.
 *   rejected       la red rechaza lo enviado (imagen, texto, permisos): no se
 *                  reintenta sin cambiar algo.
 *   unexpected     respuesta que no sigue la documentación.
 */
export type SocialErrorKind = 'token' | 'publish_limit' | 'rate_limited' | 'transient' | 'rejected' | 'unexpected';

export class SocialApiError extends Error {
  override name = 'SocialApiError';
  readonly kind: SocialErrorKind;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly httpStatus: number | null;
  /** Fallo tras el que la operación pudo haberse hecho igualmente (tiempo agotado, red). */
  readonly dubious: boolean;

  constructor(p: {
    kind: SocialErrorKind;
    message: string;
    code?: number | null;
    subcode?: number | null;
    httpStatus?: number | null;
    dubious?: boolean;
  }) {
    super(p.message);
    this.kind = p.kind;
    this.code = p.code ?? null;
    this.subcode = p.subcode ?? null;
    this.httpStatus = p.httpStatus ?? null;
    this.dubious = p.dubious ?? false;
  }

  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limited' || this.kind === 'publish_limit';
  }
}

/** Cupo de publicación de una cuenta (Instagram: content_publishing_limit). */
export interface PublishingLimit {
  usage: number;
  /** Lo que diga la red; nunca se supone (la documentación da 50 y 100 en sitios distintos). */
  total: number | null;
  durationSeconds: number | null;
}

/** Estado de un contenedor de Instagram (status_code). */
export type ContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED' | (string & {});

export interface ContainerInfo {
  id: string;
  status: ContainerStatus;
  detail: string | null;
}

export interface PublishedMedia {
  id: string;
  caption: string | null;
  timestamp: string | null;
  permalink: string | null;
}

export interface PageWithInstagram {
  pageId: string;
  pageName: string | null;
  pageAccessToken: string;
  instagram: { id: string; username: string | null; name: string | null } | null;
}

export interface TokenInfo {
  isValid: boolean;
  /** Instante (ms) en que caduca; null si no caduca. */
  expiresAt: number | null;
  /** Instante (ms) en que caduca el acceso a los datos; null si no se sabe. */
  dataAccessExpiresAt: number | null;
  scopes: string[];
}

/** Lo que el publicador necesita de la Graph API de Instagram. */
export interface InstagramApi {
  publishingLimit(igUserId: string, token: string): Promise<PublishingLimit>;
  createImageContainer(
    igUserId: string,
    token: string,
    p: { imageUrl: string; caption?: string; altText?: string },
  ): Promise<string>;
  createCarouselItem(igUserId: string, token: string, p: { imageUrl: string; altText?: string }): Promise<string>;
  createCarouselContainer(
    igUserId: string,
    token: string,
    p: { children: string[]; caption?: string },
  ): Promise<string>;
  createReelContainer(
    igUserId: string,
    token: string,
    p: { videoUrl: string; caption?: string; shareToFeed?: boolean },
  ): Promise<string>;
  containerStatus(containerId: string, token: string): Promise<ContainerInfo>;
  /** SIN reintentos: un segundo intento tras un tiempo agotado puede publicar dos veces. */
  mediaPublish(igUserId: string, token: string, creationId: string): Promise<string>;
  recentMedia(igUserId: string, token: string): Promise<PublishedMedia[]>;
  permalink(mediaId: string, token: string): Promise<string | null>;
}

/** Lo que el flujo de conexión (OAuth) necesita de Meta. */
export interface MetaLoginApi {
  dialogUrl(p: { appId: string; redirectUri: string; state: string; configId?: string; scopes: string[] }): string;
  exchangeCode(p: { appId: string; appSecret: string; redirectUri: string; code: string }): Promise<{
    accessToken: string;
    expiresIn: number | null;
  }>;
  exchangeLongLived(p: { appId: string; appSecret: string; token: string }): Promise<{
    accessToken: string;
    expiresIn: number | null;
  }>;
  pagesWithInstagram(userToken: string): Promise<PageWithInstagram[]>;
  debugToken(p: { appId: string; appSecret: string; token: string }): Promise<TokenInfo>;
}

/** Lo que da Meta de un token inspeccionado consigo mismo (sin la aplicación del producto). */
export interface SelfTokenInfo extends TokenInfo {
  /** USER, PAGE… según Meta. */
  type: string | null;
  appId: string | null;
}

/**
 * Conectar con un token pegado (cuentas que ya tienen su aplicación de Meta y
 * su token de página de larga duración): validarlo y saber a qué cuenta da acceso.
 */
export interface TokenConnectApi {
  /** GET /debug_token con el propio token como access_token: vale aunque sea de otra aplicación. */
  inspectToken(token: string): Promise<SelfTokenInfo>;
  /** GET /me: la página (o el usuario) del token. */
  tokenOwner(token: string): Promise<{ id: string; name: string | null }>;
  /** GET /{ig-user-id}?fields=id,username,name con el token. */
  instagramAccount(
    igUserId: string,
    token: string,
  ): Promise<{ id: string; username: string | null; name: string | null }>;
}

/** Trabajo reclamado de la cola (lo que devuelve claim_jobs). */
export interface ClaimedSocialJob {
  id: string;
  organization_id: string;
  brand_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}
