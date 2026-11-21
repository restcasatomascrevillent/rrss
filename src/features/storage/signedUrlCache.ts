// Caché de URL firmadas de lectura. Las firmas duran una hora; mientras no
// caducan se reutilizan en vez de pedir otra por imagen cada vez que cambia la
// lista de rutas (otra página de la biblioteca, otro selector, otro mes).
// Las peticiones que ya están en vuelo también se comparten.

/** Se reutiliza una URL de Storage/R2 (firmada 1 h) durante 40 minutos. */
export const STORAGE_URL_REUSE_MS = 40 * 60_000;
/** Los billetes de Drive caducan antes: 10 minutos. */
export const DRIVE_URL_REUSE_MS = 10 * 60_000;

interface Entry {
  url: string;
  until: number;
}

const resolved = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | undefined>>();

const keyOf = (scope: string, path: string) => `${scope}\u0000${path}`;

/** Vacía la caché (al cerrar sesión y en las pruebas). */
export function clearSignedUrlCache(): void {
  resolved.clear();
  inflight.clear();
}

/**
 * Devuelve las URL de `paths`, pidiendo a `sign` solo las que no están en
 * caché ni en vuelo. `scope` separa variantes de una misma ruta (completa o miniatura de Drive).
 */
export async function signWithCache(
  scope: string,
  paths: string[],
  reuseMs: number,
  sign: (missing: string[]) => Promise<Map<string, string>>,
  now: () => number = Date.now,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const waiting: Array<Promise<void>> = [];
  const missing: string[] = [];
  for (const path of new Set(paths)) {
    const key = keyOf(scope, path);
    const hit = resolved.get(key);
    if (hit && hit.until > now()) {
      out.set(path, hit.url);
      continue;
    }
    const pending = inflight.get(key);
    if (pending) {
      waiting.push(
        pending.then((url) => {
          if (url) out.set(path, url);
        }),
      );
      continue;
    }
    missing.push(path);
  }
  if (missing.length > 0) {
    const batch = sign(missing);
    // Que un fallo no deje colgadas las peticiones en vuelo de otros.
    const settled = batch.then(
      (m) => m,
      () => new Map<string, string>(),
    );
    for (const path of missing) {
      const key = keyOf(scope, path);
      const one = settled.then((m) => {
        const url = m.get(path);
        if (url) resolved.set(key, { url, until: now() + reuseMs });
        inflight.delete(key);
        return url;
      });
      inflight.set(key, one);
    }
    const result = await batch; // un fallo se propaga a quien lo pidió
    for (const path of missing) {
      const url = result.get(path);
      if (url) out.set(path, url);
    }
  }
  await Promise.all(waiting);
  return out;
}
