// Conectar una cuenta de Instagram pegando un token, en lugar de por OAuth.
//
// Para cuentas que ya tienen su propia aplicación de Meta y un token de página
// de larga duración (por ejemplo, un negocio que ya publica con su aplicación).
// Quien gestiona la marca pega el token y el identificador de la cuenta de
// Instagram (IG User ID); el servidor:
//   1. comprueba el permiso y el plan con SU sesión, igual que al empezar el
//      OAuth (`social_oauth_begin`, que además frena los intentos seguidos) y
//      gasta en el acto ese estado (`social_oauth_consume`);
//   2. valida el token contra la Graph API: que vale (debug_token consigo
//      mismo, sirve aunque sea de otra aplicación), sus permisos y su
//      caducidad, y que da acceso a ESA cuenta de Instagram;
//   3. lo cifra igual que los de OAuth (crypto.ts) y da de alta la cuenta con
//      `social_account_connect_token` (queda como «conectada con token»).
// A partir de ahí publica y mide igual que una cuenta de OAuth. El token
// caduca cuando lo diga Meta: renovarlo es pegar uno nuevo.
//
// Solo tokens de «Instagram API con inicio de sesión de Facebook» (graph.facebook.com).
// Los de «inicio de sesión de Instagram» (empiezan por IG…) usan otro host y
// otros permisos: se rechazan con un mensaje claro.
import type { RpcClient } from '../ai/contract.ts';
import type { SocialConfig } from './config.ts';
import { SocialApiError } from './contract.ts';
import { encryptToken, tokenBinding } from './crypto.ts';
import { ConnectError } from './oauth.ts';

/** Permisos sin los que no se puede publicar. */
export const REQUIRED_TOKEN_SCOPES = ['instagram_basic', 'instagram_content_publish'];
/** Permisos sin los que se publica pero no se mide. */
export const ANALYTICS_TOKEN_SCOPES = ['instagram_manage_insights'];

export interface TokenConnectInput {
  brandId: unknown;
  network: unknown;
  igUserId: unknown;
  accessToken: unknown;
}

export interface TokenConnectResult {
  accountId: string;
  username: string;
  /** Caducidad del token (ISO) o null si Meta no da ninguna. */
  expiresAt: string | null;
  /** Caducidad del acceso a los datos (ISO), si Meta la da. */
  dataAccessExpiresAt: string | null;
  tokenType: string | null;
  /** Avisos para la persona (permisos que faltan para medir, token de usuario…). */
  warnings: string[];
}

export async function connectWithToken(
  config: SocialConfig,
  rpc: RpcClient,
  userRpc: RpcClient,
  input: TokenConnectInput,
  log: (event: string, data: Record<string, unknown>) => void = () => undefined,
): Promise<TokenConnectResult> {
  if (!config.keyRing) {
    throw new ConnectError(503, 'not_configured', 'La publicación no está configurada en este entorno.');
  }
  if (typeof input.brandId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.brandId)) {
    throw new ConnectError(400, 'bad_request', 'Falta la marca.');
  }
  if (input.network !== 'instagram')
    throw new ConnectError(400, 'bad_request', 'Esa red todavía no se puede conectar.');
  const igUserId = typeof input.igUserId === 'string' ? input.igUserId.trim() : '';
  if (!/^\d{5,30}$/.test(igUserId)) {
    throw new ConnectError(400, 'bad_request', 'El identificador de la cuenta de Instagram son solo cifras.');
  }
  const token = typeof input.accessToken === 'string' ? input.accessToken.trim() : '';
  if (token.length < 20 || token.length > 2000 || /\s/.test(token)) {
    throw new ConnectError(400, 'bad_request', 'El token no tiene la forma de un token de acceso de Meta.');
  }
  if (/^IG/.test(token)) {
    throw new ConnectError(
      400,
      'unsupported_token',
      'Ese token es de «Instagram API con inicio de sesión de Instagram», que todavía no se admite. Hace falta un token de página de Facebook Login (empieza por EAA).',
    );
  }

  // 1. Permiso y plan con la sesión de quien conecta (como al empezar el OAuth).
  const begun = await userRpc('social_oauth_begin', { p_brand_id: input.brandId, p_network: 'instagram' });
  if (begun.error) {
    if (begun.error.code === '42501' || begun.error.code === '28000') {
      throw new ConnectError(403, 'forbidden', begun.error.message);
    }
    if (begun.error.code === 'PL002') throw new ConnectError(402, 'plan_feature', begun.error.message);
    throw new ConnectError(400, 'refused', begun.error.message);
  }
  const consumed = await rpc('social_oauth_consume', { p_state: String(begun.data) });
  if (consumed.error) {
    throw new ConnectError(consumed.error.code === '42501' ? 403 : 400, 'refused', consumed.error.message);
  }
  const ctx = consumed.data as { brand_id: string; organization_id: string; user_id: string; network: string };

  // 2. El token, contra la Graph API.
  const warnings: string[] = [];
  let info;
  let account;
  let owner: { id: string; name: string | null } | null = null;
  try {
    info = await config.graph.inspectToken(token);
    if (!info.isValid) {
      throw new ConnectError(400, 'invalid_token', 'Meta dice que ese token no es válido (caducado o revocado).');
    }
    const missing = REQUIRED_TOKEN_SCOPES.filter((s) => !info!.scopes.includes(s));
    if (missing.length > 0) {
      throw new ConnectError(
        400,
        'missing_scopes',
        `Al token le faltan permisos para publicar: ${missing.join(', ')}.`,
      );
    }
    if (ANALYTICS_TOKEN_SCOPES.some((s) => !info!.scopes.includes(s))) {
      warnings.push(
        'El token no tiene el permiso instagram_manage_insights: se publicará, pero no se podrán leer las métricas.',
      );
    }
    account = await config.graph.instagramAccount(igUserId, token);
    if (account.id !== igUserId) {
      throw new ConnectError(400, 'wrong_account', 'El token no da acceso a esa cuenta de Instagram.');
    }
    if (info.type === 'PAGE') {
      owner = await config.graph.tokenOwner(token).catch(() => null);
    } else {
      warnings.push(
        'Es un token de usuario, no de página: caduca antes (unos 60 días). Mejor un token de página de larga duración.',
      );
    }
  } catch (e) {
    if (e instanceof ConnectError) throw e;
    if (e instanceof SocialApiError) {
      log('token_rejected', { kind: e.kind, code: e.code });
      if (e.kind === 'token') throw new ConnectError(400, 'invalid_token', 'Meta dice que ese token no es válido.');
      if (e.kind === 'transient' || e.kind === 'rate_limited') {
        throw new ConnectError(502, 'meta_unavailable', 'Meta no responde ahora. Inténtalo de nuevo en un momento.');
      }
      throw new ConnectError(
        400,
        'wrong_account',
        'El token no da acceso a esa cuenta de Instagram o le faltan permisos.',
      );
    }
    log('token_check_failed', { name: (e as Error)?.name });
    throw new ConnectError(502, 'meta_unavailable', 'No se pudo comprobar el token con Meta.');
  }

  // 3. Cifrado y alta.
  const binding = tokenBinding({ brandId: ctx.brand_id, network: 'instagram', externalId: igUserId });
  const sealed = await encryptToken(config.keyRing, token, binding);
  const expiresAt = info.expiresAt ? new Date(info.expiresAt).toISOString() : null;
  const dataAccessExpiresAt = info.dataAccessExpiresAt ? new Date(info.dataAccessExpiresAt).toISOString() : null;
  const saved = await rpc('social_account_connect_token', {
    p_user_id: ctx.user_id,
    p_brand_id: ctx.brand_id,
    p_network: 'instagram',
    p_external_id: igUserId,
    p_username: account.username ?? '',
    p_display_name: account.name ?? owner?.name ?? '',
    p_page_id: owner?.id ?? null,
    p_scopes: info.scopes,
    p_token_expires_at: expiresAt ?? dataAccessExpiresAt,
    p_key_id: sealed.keyId,
    p_access_token_ciphertext: sealed.ciphertext,
  });
  if (saved.error) {
    log('connect_failed', { code: saved.error.code });
    if (saved.error.code === '42501') throw new ConnectError(403, 'forbidden', saved.error.message);
    if (saved.error.code === 'PL002') throw new ConnectError(402, 'plan_feature', saved.error.message);
    throw new ConnectError(400, 'refused', 'No se pudo guardar la cuenta.');
  }
  const row = saved.data as { id: string; username: string };
  return {
    accountId: row.id,
    username: row.username,
    expiresAt,
    dataAccessExpiresAt,
    tokenType: info.type,
    warnings,
  };
}
