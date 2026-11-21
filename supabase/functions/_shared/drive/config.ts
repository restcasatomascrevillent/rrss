// Configuración de la biblioteca con Google Drive (docs/biblioteca-drive.md).
// Nada de esto llega al navegador.
//
//   GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET   cliente OAuth «Aplicación web» del producto
//   DRIVE_CALLBACK_URL   …/functions/v1/drive-media/callback (registrada en Google);
//                        si no está y SUPABASE_URL es https, se deduce de ella
//   DRIVE_APP_URL        dirección de la aplicación para volver tras conectar
//                        (si no está, SOCIAL_APP_URL)
//   SOCIAL_TOKEN_KEYS, SOCIAL_TOKEN_KEY_ID   las mismas claves que cifran los
//                        tokens de Meta cifran el token de refresco de Google y
//                        firman las direcciones de las imágenes
//
// Las funciones pasan aquí la configuración efectiva de «Plataforma →
// Integraciones» (../integrations/settings.ts): en cuanto el catálogo incluya
// las claves de Google, mandan sobre las variables sin tocar este archivo.
//
// En la prueba LOCAL, con la guarda de local-test.ts, Drive es el simulado y la
// clave de cifrado es la fija de pruebas.
import { parseKeyRing, TokenKeyError, type TokenKeyRing } from '../social/crypto.ts';
import { DRIVE_SCOPES, type DriveApi, type FetchLike } from './contract.ts';
import { createGoogleDrive } from './google-drive.ts';
import { loadDriveLocalTest } from './local-test.ts';

export interface DriveConfig {
  drive: DriveApi;
  simulated: boolean;
  keyRing: TokenKeyRing | null;
  client: { clientId: string; clientSecret: string } | null;
  scopes: readonly string[];
  callbackUrl: string | null;
  appUrl: string | null;
  /** Lo que falta configurar (solo nombres de variables, nunca valores). */
  problems: string[];
}

const urlOrNull = (value: string | undefined) => {
  if (!value?.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().replace(/\/$/, '') : null;
  } catch {
    return null;
  }
};

export function loadDriveConfig(env: Record<string, string | undefined>, realFetch: FetchLike): DriveConfig {
  const problems: string[] = [];
  const local = loadDriveLocalTest(env);

  let keyRing: TokenKeyRing | null = null;
  try {
    keyRing =
      local && !env.SOCIAL_TOKEN_KEYS ? local.keyRing : parseKeyRing(env.SOCIAL_TOKEN_KEYS, env.SOCIAL_TOKEN_KEY_ID);
  } catch (e) {
    problems.push(e instanceof TokenKeyError ? e.message : 'SOCIAL_TOKEN_KEYS no es válida');
  }

  const clientId = local ? 'cliente-simulado' : env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = local ? 'secreto-simulado' : env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  if (!clientId) problems.push('Falta GOOGLE_DRIVE_CLIENT_ID');
  if (!clientSecret) problems.push('Falta GOOGLE_DRIVE_CLIENT_SECRET');
  const base = urlOrNull(env.SUPABASE_URL);
  const callbackUrl =
    urlOrNull(env.DRIVE_CALLBACK_URL) ??
    (base && base.startsWith('https://') ? `${base}/functions/v1/drive-media/callback` : null);
  if (!callbackUrl) problems.push('Falta DRIVE_CALLBACK_URL (o no es una URL)');
  const appUrl = urlOrNull(env.DRIVE_APP_URL) ?? urlOrNull(env.SOCIAL_APP_URL);
  if (!appUrl) problems.push('Falta DRIVE_APP_URL (o SOCIAL_APP_URL)');
  if (local) problems.push(...local.problems);

  return {
    drive: local ? local.drive : createGoogleDrive({ fetch: realFetch }),
    simulated: Boolean(local),
    keyRing,
    client: clientId && clientSecret ? { clientId, clientSecret } : null,
    scopes: DRIVE_SCOPES,
    callbackUrl,
    appUrl,
    problems,
  };
}
