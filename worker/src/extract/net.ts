// Descarga HTTP(S) protegida contra SSRF para leer las webs de las marcas.
//
// La dirección la escribe quien usa la aplicación, y el trabajador corre junto
// a servicios internos (la base de datos, metadatos de la nube…). Reglas:
//   * Solo http y https, sin usuario ni contraseña en la URL, y por defecto
//     solo los puertos 80 y 443.
//   * Toda dirección IP a la que se conecta tiene que ser pública (unicast
//     global): nada de privadas, locales, enlace-local (169.254.x: metadatos
//     de la nube), multidifusión, reservadas, NAT64, 6to4, Teredo… Se comprueba
//     en el momento de conectar (opción `lookup` de Node), así que un DNS que
//     cambia de respuesta entre la comprobación y la conexión no sirve de nada.
//     Una IP escrita tal cual en la URL se comprueba antes (Node no la resuelve).
//   * Las redirecciones se siguen a mano, como mucho 3, y cada salto pasa las
//     mismas comprobaciones.
//   * Tope de bytes (también tras descomprimir) y de tiempo por petición.
//   * Nunca se ejecuta JavaScript: solo se lee el HTML.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { PermanentError } from '../errors.ts';

export class BlockedUrlError extends PermanentError {
  override name = 'BlockedUrlError';
}

/** ¿Es una dirección pública a la que se puede conectar? (IPv4 o IPv6, incluido ::ffff:a.b.c.d). */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export interface NetPolicy {
  /** Qué direcciones IP se aceptan. Por defecto, solo públicas. */
  isAllowedAddress: (address: string) => boolean;
  /** Puertos admitidos; `any` solo para pruebas. */
  allowedPorts: readonly number[] | 'any';
}

export const DEFAULT_NET_POLICY: NetPolicy = { isAllowedAddress: isPublicAddress, allowedPorts: [80, 443] };

/** Comprueba la forma de la URL (protocolo, credenciales, puerto, IP literal). */
export function assertFetchableUrl(raw: string | URL, policy: NetPolicy = DEFAULT_NET_POLICY): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`La dirección «${String(raw).slice(0, 200)}» no es válida`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Solo se leen direcciones http y https (no ${url.protocol})`);
  }
  if (url.username || url.password) throw new BlockedUrlError('La dirección no puede llevar usuario ni contraseña');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (policy.allowedPorts !== 'any' && !policy.allowedPorts.includes(port)) {
    throw new BlockedUrlError(`No se leen webs en el puerto ${port}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !policy.isAllowedAddress(host)) {
    throw new BlockedUrlError(`La dirección ${host} no es pública: no se descarga`);
  }
  if (!net.isIP(host) && (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.'))) {
    throw new BlockedUrlError(`«${host}» no es un nombre de dominio público`);
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** `lookup` para http.request que solo deja conectar a direcciones permitidas. */
function guardedLookup(policy: NetPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { all: true, family: options.family ?? 0 }, (error, addresses) => {
      if (error) return callback(error, '');
      const blocked = addresses.find((a) => !policy.isAllowedAddress(a.address));
      if (blocked || addresses.length === 0) {
        return callback(
          new BlockedUrlError(
            `«${hostname}» apunta a una dirección que no es pública (${blocked?.address ?? 'ninguna'})`,
          ),
          '',
        );
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export interface FetchedResponse {
  /** URL final, tras las redirecciones. */
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

export interface SafeFetchOptions {
  policy?: NetPolicy;
  userAgent: string;
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

/** Errores de red y del servidor (5xx, tiempo agotado): pasajeros, se pueden reintentar. */
export class TransientFetchError extends Error {
  override name = 'TransientFetchError';
}

function requestOnce(
  url: URL,
  options: SafeFetchOptions,
  policy: NetPolicy,
): Promise<FetchedResponse & { location?: string }> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': options.userAgent,
          accept: options.accept,
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'es,en;q=0.8,*;q=0.5',
        },
        lookup: guardedLookup(policy) as unknown as typeof dns.lookup,
        signal,
        // Sin agente compartido: cada conexión pasa por el `lookup` de arriba.
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers['content-type'] ?? '');
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({
            url: url.toString(),
            status,
            contentType,
            body: new Uint8Array(),
            location: response.headers.location,
          });
          return;
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > options.maxBytes) {
          response.destroy();
          reject(new PermanentError(`La página pesa más de ${Math.round(options.maxBytes / 1024)} KB`));
          return;
        }
        const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
        const stream =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? response.pipe(zlib.createGunzip())
            : encoding === 'deflate'
              ? response.pipe(zlib.createInflate())
              : encoding === 'br'
                ? response.pipe(zlib.createBrotliDecompress())
                : response;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            stream.destroy();
            reject(new PermanentError(`La página pesa más de ${Math.round(options.maxBytes / 1024)} KB`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () =>
          resolve({ url: url.toString(), status, contentType, body: new Uint8Array(Buffer.concat(chunks)) }),
        );
        stream.on('error', (error) => reject(new TransientFetchError(`Respuesta incompleta: ${error.message}`)));
      },
    );
    request.on('error', (error) => {
      if (error instanceof PermanentError) return reject(error);
      // El `lookup` bloqueado llega envuelto según la versión de Node.
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof PermanentError) return reject(cause);
      if (signal.aborted && options.signal?.aborted) return reject(options.signal.reason ?? error);
      if (signal.aborted) return reject(new TransientFetchError(`Tiempo agotado leyendo ${url.hostname}`));
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND') return reject(new PermanentError(`No existe el dominio «${url.hostname}»`));
      reject(new TransientFetchError(`No se ha podido conectar con ${url.hostname}: ${code ?? error.message}`));
    });
    request.end();
  });
}

/** GET con las protecciones de arriba. Las redirecciones se siguen y se vuelven a comprobar. */
export async function safeFetch(rawUrl: string | URL, options: SafeFetchOptions): Promise<FetchedResponse> {
  const policy = options.policy ?? DEFAULT_NET_POLICY;
  let url = assertFetchableUrl(rawUrl, policy);
  const maxRedirects = options.maxRedirects ?? 3;
  for (let hop = 0; ; hop += 1) {
    const response = await requestOnce(url, options, policy);
    if (!response.location) return response;
    if (hop >= maxRedirects) throw new PermanentError(`Demasiadas redirecciones desde ${url.hostname}`);
    url = assertFetchableUrl(new URL(response.location, url), policy);
  }
}
