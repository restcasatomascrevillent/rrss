// Token de acceso de Google Cloud para una cuenta de servicio, sin SDK: se
// firma un JWT (RS256) con WebCrypto y se cambia por un token OAuth.
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL. Fuente (consultada el 17/11/2026):
//   https://developers.google.com/identity/protocols/oauth2/service-account
//   · cabecera `{ "alg": "RS256", "typ": "JWT" }`
//   · contenido: `iss` (correo de la cuenta), `scope`, `aud` (la URL del
//     token), `iat` y `exp` (como mucho una hora después)
//   · `POST https://oauth2.googleapis.com/token`, formulario con
//     `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` y `assertion`
//   · respuesta `{ access_token, expires_in, token_type }`; errores con
//     `error` y `error_description`.
//
// Alternativa si no se quiere guardar una clave de cuenta de servicio: Google
// recomienda la federación de identidades de carga de trabajo para entornos
// fuera de Google Cloud (https://docs.cloud.google.com/vertex-ai/docs/authentication).
// No está implementada: exige un proveedor de identidad que emita tokens para
// la función.
//
// La clave privada es la del archivo JSON de la cuenta de servicio (PEM
// PKCS#8, «-----BEGIN PRIVATE KEY-----»). Vive solo en la configuración del
// servidor y nunca aparece en un mensaje de error.
import { AiProviderFailure } from '../contract.ts';
import { field, type FetchLike } from './http.ts';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/**
 * Ámbito general de Google Cloud. ⚠ Las páginas consultadas no nombran el
 * ámbito que exige Vertex AI: es el habitual de sus API, pendiente de confirmar
 * con la primera llamada real.
 */
export const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface ServiceAccountKey {
  clientEmail: string;
  privateKeyPem: string;
}

/** Lee el JSON de la cuenta de servicio. Devuelve `null` si no tiene lo necesario. */
export function parseServiceAccountKey(raw: string): ServiceAccountKey | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const clientEmail = field(parsed, 'client_email');
    const privateKeyPem = field(parsed, 'private_key');
    if (typeof clientEmail !== 'string' || typeof privateKeyPem !== 'string') return null;
    if (!clientEmail || !privateKeyPem.includes('PRIVATE KEY')) return null;
    return { clientEmail, privateKeyPem };
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** JWT firmado que se presenta en el punto de tokens. */
export async function signServiceAccountJwt(key: ServiceAccountKey, scope: string, now: Date): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: key.clientEmail, scope, aud: GOOGLE_TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 };
  const unsigned = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(claims)))}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export interface GoogleTokenSourceOptions {
  key: ServiceAccountKey;
  fetch: FetchLike;
  scope?: string;
  now?: () => Date;
}

/** Margen antes de la caducidad a partir del cual se pide un token nuevo. */
const RENEW_MARGIN_MS = 60_000;

/**
 * Devuelve un token válido, pidiéndolo solo cuando hace falta: se guarda en
 * memoria (por instancia de la función) hasta poco antes de caducar.
 */
export function createGoogleTokenSource(options: GoogleTokenSourceOptions): (signal: AbortSignal) => Promise<string> {
  const now = options.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;

  return async (signal) => {
    if (cached && cached.expiresAt - RENEW_MARGIN_MS > now().getTime()) return cached.token;

    let assertion: string;
    try {
      assertion = await signServiceAccountJwt(options.key, options.scope ?? GOOGLE_CLOUD_SCOPE, now());
    } catch {
      // Sin detalle: el error de importar la clave puede citar su contenido.
      throw new AiProviderFailure('auth', 'La clave de la cuenta de servicio de Google no se puede usar para firmar');
    }

    let response: Response;
    try {
      response = await options.fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal,
      });
    } catch {
      if (signal.aborted) throw new AiProviderFailure('timeout', 'Google no respondió a tiempo al pedir el token', { retryable: true });
      throw new AiProviderFailure('network', 'No se pudo conectar con Google para pedir el token', { retryable: true });
    }

    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const code = field(body, 'error');
      const reason = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : '';
      if (response.status >= 500 || response.status === 429) {
        throw new AiProviderFailure('provider_error', `Google no ha podido emitir el token (${response.status})`, {
          retryable: true,
        });
      }
      throw new AiProviderFailure('auth', `Google ha rechazado la cuenta de servicio${reason}`);
    }
    const token = field(body, 'access_token');
    const expiresIn = field(body, 'expires_in');
    if (typeof token !== 'string' || !token) {
      throw new AiProviderFailure('bad_response', 'Google ha devuelto una respuesta de token sin `access_token`');
    }
    const lifetime = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 300;
    cached = { token, expiresAt: now().getTime() + lifetime * 1000 };
    return token;
  };
}
