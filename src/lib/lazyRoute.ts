import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Pantallas con carga diferida que sobreviven a un despliegue.
//
// Cada despliegue cambia el nombre de los trozos de JavaScript (llevan una
// huella). Una pestaña abierta desde antes sigue pidiendo los nombres viejos,
// que ya dan 404: sin esto, la sección se quedaba en negro. Ante ese fallo se
// recarga la página una sola vez (la página nueva ya conoce los nombres
// nuevos). La marca va en sessionStorage, así que si vuelve a fallar no hay
// bucle: el límite de errores enseña «Hay una versión nueva» con un botón.

export const CHUNK_RELOAD_KEY = 'rrss.recarga-por-version';
/** Una recarga automática como mucho en este margen. */
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

/** Recarga de la página (aparte para poder comprobarla en las pruebas: jsdom no recarga). */
export const pageReloader = {
  reload: () => window.location.reload(),
};

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed|ChunkLoadError/i;

/** ¿El error es de un trozo de código que no se ha podido descargar? */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && CHUNK_ERROR.test(message);
}

function readMark(): number | null {
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Recarga la página si no se ha hecho ya hace poco. Devuelve `true` si recarga
 * (quien llama debe esperar sin hacer nada) y `false` si ya se intentó: toca
 * enseñar el aviso de versión nueva.
 */
export function reloadOnceForNewVersion(): boolean {
  const last = readMark();
  if (last !== null && Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return false;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    // Sin sessionStorage no hay forma de evitar el bucle: mejor no recargar solos.
    return false;
  }
  pageReloader.reload();
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PreloadableComponent<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** Descarga el trozo de antemano (sin recargar si falla: ya se intentará al abrirla). */
  preload: () => Promise<void>;
};

/** Como `React.lazy`, pero recarga una vez si el trozo ya no existe y se puede precargar. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRoute<T extends ComponentType<any>>(load: () => Promise<T>): PreloadableComponent<T> {
  let cached: Promise<T> | null = null;
  const fetchOnce = () => {
    cached ??= load().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };
  const Component = lazy(() =>
    fetchOnce().then(
      (component) => ({ default: component }),
      (error: unknown) => {
        // Mientras la página se recarga no se pinta nada (ni un error a medias).
        if (isChunkLoadError(error) && reloadOnceForNewVersion()) return new Promise<never>(() => {});
        throw error;
      },
    ),
  );
  return Object.assign(Component, {
    preload: () =>
      fetchOnce().then(
        () => undefined,
        () => undefined,
      ),
  });
}
