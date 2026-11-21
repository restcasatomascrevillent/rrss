// Token de acceso de Google Cloud a partir de una cuenta de servicio, sin SDK.
//
// SIN PROBAR CONTRA EL SERVICIO REAL. Escrito contra la documentación oficial
// (consultada el 17/11/2026):
//   https://developers.google.com/identity/protocols/oauth2/service-account
//
//   JWT firmado con RS256 { iss, scope, aud, iat, exp ≤ 1 h }
//     → POST https://oauth2.googleapis.com/token
//        grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT>
//     → { access_token, expires_in, token_type: "Bearer" }
import { MediaProviderFailure } from './contract.ts';
import { fromBase64, requestJson, stringAt, numberAt, toBase64Url, type FetchLike } from './http.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Se renueva un minuto antes de caducar. */
const RENEW_MARGIN_MS = 60_000;

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
}

/** Lee el JSON de la clave de una cuenta de servicio. `null` si no tiene la forma esperada. */
export function parseServiceAccount(json: string | undefined): GoogleServiceAccount | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (typeof value.client_email !== 'string' || typeof value.private_key !== 'string') return null;
    if (!value.private_key.includes('PRIVATE KEY')) return null;
    return { client_email: value.client_email, private_key: value.private_key };
  } catch {
    return null;
  }
}

const encode = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

async function signJwt(account: GoogleServiceAccount, nowSeconds: number): Promise<string> {
  const der = fromBase64(account.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
  let key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    // Sin copiar el motivo: podría citar la clave.
    throw new MediaProviderFailure('auth', 'La clave de la cuenta de servicio de Google no es válida');
  }
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Devuelve una función que entrega un token vigente, pidiéndolo solo cuando hace falta. */
export function createGoogleTokenSource(
  account: GoogleServiceAccount,
  options: { fetch: FetchLike; now?: () => number; timeoutMs?: number },
): (signal?: AbortSignal) => Promise<string> {
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;

  return async (signal) => {
    if (cached && cached.expiresAt - RENEW_MARGIN_MS > now()) return cached.token;
    const assertion = await signJwt(account, Math.floor(now() / 1000));
    const body = await requestJson(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      { fetch: options.fetch, provider: 'Google (autenticación)', timeoutMs: options.timeoutMs ?? 15_000, signal },
    );
    const token = stringAt(body, 'access_token');
    if (!token) throw new MediaProviderFailure('auth', 'Google no ha devuelto un token de acceso');
    cached = { token, expiresAt: now() + (numberAt(body, 'expires_in') ?? 3600) * 1000 };
    return token;
  };
}
