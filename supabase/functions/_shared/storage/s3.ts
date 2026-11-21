// Adaptador S3 de `ObjectStorage`: Cloudflare R2 y, en las pruebas locales,
// MinIO. Estilo «ruta» (`<punto de acceso>/<cubo>/<clave>`), región `auto` en
// R2. Las credenciales solo existen en el servidor: hacia fuera salen URL
// prefirmadas.
//
// ⚠ Escrito contra la documentación de la API S3 de R2 y probado contra MinIO
// (e2e) y un S3 simulado en memoria; sin probar contra R2 real.
import { StorageError, type FetchLike, type ObjectStorage, type SignedUpload } from './contract.ts';
import type { S3Settings } from './config.ts';
import { objectPath, presignS3Url, signS3Request } from './sigv4.ts';

/** Tope de una subida de una sola vez (R2 y S3 admiten hasta 5 GiB). */
export const S3_MAX_PUT_BYTES = 2 * 1024 * 1024 * 1024;
const REMOVE_CONCURRENCY = 8;

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

export interface S3Storage extends ObjectStorage {
  /** HeadBucket: ¿existe el cubo y la clave puede usarlo? Para «Probar conexión». */
  headBucket(): Promise<{ status: number }>;
}

export function createS3Storage(settings: S3Settings, fetchImpl: FetchLike = (i, init) => fetch(i, init)): S3Storage {
  const credentials = { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey };
  const serverUrl = (key = '', query = '') => `${settings.endpoint}${objectPath(settings.bucket, key)}${query}`;
  const publicUrl = (key: string) => `${settings.publicEndpoint}${objectPath(settings.bucket, key)}`;

  async function send(method: string, url: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
    const headers = await signS3Request({ method, url, region: settings.region, credentials, headers: init.headers });
    try {
      return await fetchImpl(url, {
        method,
        headers,
        ...(init.body !== undefined ? { body: init.body as RequestInit['body'], duplex: 'half' } : {}),
      } as RequestInit);
    } catch {
      throw new StorageError('No se pudo llegar al almacenamiento S3 (red o dirección).');
    }
  }

  return {
    backend: 'r2',

    async signGet(key, seconds, options = {}) {
      const url = new URL(publicUrl(key));
      if (options.download) {
        url.searchParams.set(
          'response-content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(options.download)}`,
        );
      }
      return presignS3Url({
        method: 'GET',
        url: url.toString(),
        region: settings.region,
        credentials,
        expiresSeconds: seconds,
      });
    },

    async signPut(key, contentType, bytes, seconds): Promise<SignedUpload> {
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > S3_MAX_PUT_BYTES) {
        throw new StorageError('Tamaño de archivo no admitido', 400, false);
      }
      const url = await presignS3Url({
        method: 'PUT',
        url: publicUrl(key),
        region: settings.region,
        credentials,
        expiresSeconds: seconds,
        // El navegador pone content-length solo; firmado, otro tamaño da 403.
        headers: { 'content-type': contentType, 'content-length': String(bytes) },
      });
      return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn: seconds };
    },

    async head(key) {
      const response = await send('HEAD', serverUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) throw new StorageError(`El almacenamiento S3 respondió ${response.status}`, response.status);
      return { bytes: Number(response.headers.get('content-length') ?? '0') };
    },

    async put(key, body, contentType, bytes) {
      const response = await send('PUT', serverUrl(key), {
        headers: { 'content-type': contentType, 'content-length': String(bytes) },
        body,
      });
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) {
        throw new StorageError(
          `No se pudo guardar el archivo (S3 ${response.status})`,
          response.status,
          response.status >= 500,
        );
      }
    },

    async remove(keys) {
      const failed: string[] = [];
      const queue = [...keys];
      const workers = Array.from({ length: Math.min(REMOVE_CONCURRENCY, queue.length) }, async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          try {
            const response = await send('DELETE', serverUrl(key));
            await response.arrayBuffer().catch(() => undefined);
            // 204 borrado, 404 ya no estaba: las dos valen.
            if (!response.ok && response.status !== 404) failed.push(key);
          } catch {
            failed.push(key);
          }
        }
      });
      await Promise.all(workers);
      return { failed };
    },

    async list(prefix) {
      const out: Array<{ key: string; bytes: number }> = [];
      let token: string | null = null;
      for (let page = 0; page < 10_000; page++) {
        const query = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
        if (token) query.set('continuation-token', token);
        const response = await send('GET', serverUrl('', `?${query.toString()}`));
        const text = await response.text();
        if (!response.ok) throw new StorageError(`No se pudo listar el cubo (S3 ${response.status})`, response.status);
        for (const block of text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
          const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
          if (key !== undefined) out.push({ key: unescapeXml(key), bytes: Number(size ?? 0) });
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
        const next = truncated ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)?.[1] : null;
        if (!next) break;
        token = unescapeXml(next);
      }
      return out;
    },

    async headBucket() {
      const response = await send('HEAD', serverUrl());
      await response.arrayBuffer().catch(() => undefined);
      return { status: response.status };
    },
  };
}
