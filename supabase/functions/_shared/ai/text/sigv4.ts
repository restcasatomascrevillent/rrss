// Firma AWS Signature Version 4 para una petición POST con cuerpo JSON, con
// WebCrypto (disponible en Deno y en Node ≥ 20). Sin SDK de AWS.
//
// Probada contra el vector público «get-vanilla» de la batería de pruebas de
// SigV4 de AWS (tests/db/ia-texto-adaptadores.test.ts); ⚠ sin probar contra AWS.

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequest {
  method: string;
  url: string;
  /** Cabeceras que se firman, además de `host` y `x-amz-date`. */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Instante de la firma; se puede fijar en las pruebas. */
  now?: Date;
}

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text));
}

/** Codificación de URI de AWS: todo salvo letras, dígitos y `-_.~`. */
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Devuelve las cabeceras que hay que enviar: las dadas más la fecha, el token y `authorization`. */
export async function signAwsRequest(request: SignRequest): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const stamp = (request.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, ''); // 20261117T101500Z
  const date = stamp.slice(0, 8);

  const headers: Record<string, string> = { host: url.host, 'x-amz-date': stamp };
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value.trim();
  if (request.credentials.sessionToken) headers['x-amz-security-token'] = request.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalPath = url.pathname
    .split('/')
    .map((segment) => awsEncode(decodeURIComponent(segment)))
    .join('/');
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    await sha256(request.body),
  ].join('\n');

  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256(canonicalRequest)].join('\n');

  let key = await hmac(encoder.encode(`AWS4${request.credentials.secretAccessKey}`), date);
  for (const part of [request.region, request.service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  // `host` se firma pero no se envía a mano: lo pone `fetch`.
  const toSend = { ...headers };
  delete toSend.host;
  return {
    ...toSend,
    authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
