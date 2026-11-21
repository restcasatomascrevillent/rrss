// Adaptador de `ObjectStorage` sobre Supabase Storage (cubo privado
// `brand-media`, migración 20261115121000) con la CLAVE DE SERVICIO, por su API
// REST. Es el respaldo de R2 y lo que usan las pruebas. Solo en el servidor.
import { StorageError, type FetchLike, type ObjectStorage } from './contract.ts';

export const BRAND_MEDIA_BUCKET = 'brand-media';

export interface SupabaseStorageOptions {
  url: string;
  serviceKey: string;
  bucket?: string;
  fetch?: FetchLike;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export function createSupabaseObjectStorage(options: SupabaseStorageOptions): ObjectStorage {
  const base = `${options.url.replace(/\/+$/, '')}/storage/v1`;
  const bucket = options.bucket ?? BRAND_MEDIA_BUCKET;
  const doFetch: FetchLike = options.fetch ?? ((i, init) => fetch(i, init));
  const auth = { Authorization: `Bearer ${options.serviceKey}`, apikey: options.serviceKey };

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      throw new StorageError('No se pudo llegar a Supabase Storage');
    }
  }

  return {
    backend: 'supabase',

    async signGet(key, seconds, opts = {}) {
      const response = await call(`/object/sign/${bucket}/${encodeKey(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: Math.max(1, Math.floor(seconds)) }),
      });
      const body = (await response.json().catch(() => null)) as { signedURL?: string } | null;
      if (!response.ok || !body?.signedURL) {
        throw new StorageError('No se pudo firmar la dirección del recurso', response.status, response.status >= 500);
      }
      const url = `${base}${body.signedURL}`;
      return opts.download ? `${url}&download=${encodeURIComponent(opts.download)}` : url;
    },

    async signPut(key, contentType, _bytes, seconds) {
      // x-upsert: la firma admite sobrescribir (un trabajo reintentado vuelve a
      // subir el mismo resultado a la misma ruta).
      const response = await call(`/object/upload/sign/${bucket}/${encodeKey(key)}`, {
        method: 'POST',
        headers: { 'x-upsert': 'true' },
      });
      const body = (await response.json().catch(() => null)) as { url?: string } | null;
      if (!response.ok || !body?.url) {
        throw new StorageError('No se pudo firmar la subida', response.status, response.status >= 500);
      }
      return { url: `${base}${body.url}`, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn: seconds };
    },

    async head(key) {
      const response = await call(`/object/${bucket}/${encodeKey(key)}`, { method: 'HEAD' });
      if (response.status === 400 || response.status === 404) return null;
      if (!response.ok) throw new StorageError(`Supabase Storage respondió ${response.status}`, response.status);
      return { bytes: Number(response.headers.get('content-length') ?? '0') };
    },

    async put(key, body, contentType, bytes) {
      const response = await call(`/object/${bucket}/${encodeKey(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'Content-Length': String(bytes), 'x-upsert': 'true' },
        body: body as RequestInit['body'],
        duplex: 'half',
      } as RequestInit);
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) {
        throw new StorageError(`No se pudo guardar el archivo (${response.status})`, response.status);
      }
    },

    async remove(keys) {
      if (keys.length === 0) return { failed: [] };
      const response = await call(`/object/${bucket}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: keys }),
      });
      await response.arrayBuffer().catch(() => undefined);
      return { failed: response.ok ? [] : keys };
    },

    async list(prefix) {
      const out: Array<{ key: string; bytes: number }> = [];
      const walk = async (folder: string): Promise<void> => {
        for (let offset = 0; ; offset += 1000) {
          const response = await call(`/object/list/${bucket}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix: folder, limit: 1000, offset }),
          });
          const items = (await response.json().catch(() => null)) as Array<{
            name: string;
            id: string | null;
            metadata?: { size?: number } | null;
          }> | null;
          if (!response.ok || !Array.isArray(items)) throw new StorageError('No se pudo listar Supabase Storage');
          for (const item of items) {
            const path = folder ? `${folder.replace(/\/$/, '')}/${item.name}` : item.name;
            if (item.id === null) await walk(path);
            else out.push({ key: path, bytes: Number(item.metadata?.size ?? 0) });
          }
          if (items.length < 1000) break;
        }
      };
      await walk(prefix.replace(/\/$/, ''));
      return out;
    },
  };
}
