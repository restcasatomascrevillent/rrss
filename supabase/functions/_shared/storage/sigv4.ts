// Firma AWS Signature Version 4 para la API S3 (Cloudflare R2, MinIO), con
// WebCrypto (Deno y Node ≥ 20). Sin SDK de AWS.
//
//   * `presignS3Url`: URL prefirmada (la firma va en la consulta). Es lo que
//     reciben el navegador, el trabajador e Instagram: no llevan credenciales.
//   * `signS3Request`: cabeceras firmadas para las llamadas del servidor
//     (HeadBucket, HeadObject, PutObject, DeleteObject, ListObjectsV2).
//
// El cuerpo no se firma (`UNSIGNED-PAYLOAD`, admitido por S3 y R2 sobre HTTPS).
// Probada contra el ejemplo público de URL prefirmada de la documentación de
// Amazon S3 y contra MinIO (e2e); ⚠ sin probar contra R2 real.

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const encoder = new TextEncoder();
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text));
}

/** Codificación de URI de AWS: todo salvo letras, dígitos y `-_.~`. */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Ruta de un objeto en estilo «ruta» (`/<cubo>/<clave>`), cada tramo codificado una vez. */
export function objectPath(bucket: string, key = ''): string {
  return '/' + [bucket, ...(key ? key.split('/') : [])].map(awsEncode).join('/');
}

function stampOf(now: Date): { stamp: string; date: string } {
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, ''); // 20261120T101500Z
  return { stamp, date: stamp.slice(0, 8) };
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .sort()
    .join('&');
}

/** La ruta ya viene codificada en la URL: se normaliza a la codificación de AWS. */
function canonicalPath(url: URL): string {
  return (
    url.pathname
      .split('/')
      .map((segment) => awsEncode(decodeURIComponent(segment)))
      .join('/') || '/'
  );
}

async function signingKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
  let key = await hmac(encoder.encode(`AWS4${secret}`), date);
  for (const part of [region, 's3', 'aws4_request']) key = await hmac(key, part);
  return key;
}

export interface PresignOptions {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** URL del objeto (sin firma). */
  url: string;
  region: string;
  credentials: S3Credentials;
  /** Segundos de validez (1 s – 7 días). */
  expiresSeconds: number;
  /** Cabeceras que también se firman: quien use la URL debe enviarlas iguales (p. ej. content-type). */
  headers?: Record<string, string>;
  now?: Date;
}

export async function presignS3Url(options: PresignOptions): Promise<string> {
  const url = new URL(options.url);
  const { stamp, date } = stampOf(options.now ?? new Date());
  const expires = Math.max(1, Math.min(604_800, Math.floor(options.expiresSeconds)));
  const scope = `${date}/${options.region}/s3/aws4_request`;

  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = String(value).trim();
  const names = Object.keys(headers).sort();

  const params = new URLSearchParams(url.search);
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', `${options.credentials.accessKeyId}/${scope}`);
  params.set('X-Amz-Date', stamp);
  params.set('X-Amz-Expires', String(expires));
  params.set('X-Amz-SignedHeaders', names.join(';'));

  const canonicalRequest = [
    options.method,
    canonicalPath(url),
    canonicalQuery(params),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(
    await hmac(await signingKey(options.credentials.secretAccessKey, date, options.region), stringToSign),
  );
  params.set('X-Amz-Signature', signature);
  // La consulta se escribe con la misma codificación que se firmó.
  url.search = canonicalQuery(params);
  return url.toString();
}

export interface SignRequestOptions {
  method: string;
  url: string;
  region: string;
  credentials: S3Credentials;
  headers?: Record<string, string>;
  /** SHA-256 en hexadecimal del cuerpo, o UNSIGNED-PAYLOAD (por defecto). */
  payloadHash?: string;
  now?: Date;
}

/** Cabeceras que hay que enviar (sin `host`, que lo pone `fetch`). */
export async function signS3Request(options: SignRequestOptions): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const { stamp, date } = stampOf(options.now ?? new Date());
  const payloadHash = options.payloadHash ?? UNSIGNED_PAYLOAD;
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = String(value).trim();
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${options.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(
    await hmac(await signingKey(options.credentials.secretAccessKey, date, options.region), stringToSign),
  );
  const out = { ...headers };
  delete out.host;
  return {
    ...out,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export { sha256Hex };
