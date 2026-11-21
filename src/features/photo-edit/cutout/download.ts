// Descarga del modelo con progreso y caché del navegador (Cache Storage).
// Lógica sin onnxruntime ni DOM (la caché y `fetch` se pasan) para probarla.
// La primera vez baja el archivo entero; las siguientes lo lee de la caché sin red.

/** Falló la descarga del modelo (sin red, el servidor no lo sirve, llegó incompleto). */
export class ModelDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface LoadedModel {
  bytes: Uint8Array;
  fromCache: boolean;
}

export async function loadModelBytes(options: {
  url: string;
  /** Tamaño a falta de `Content-Length` (solo para el progreso). */
  expectedBytes: number;
  openCache?: () => Promise<CacheLike>;
  fetchFn?: typeof fetch;
  onProgress?: (received: number, total: number) => void;
}): Promise<LoadedModel> {
  const { url, expectedBytes, openCache, onProgress } = options;
  const fetchFn = options.fetchFn ?? fetch;

  let cache: CacheLike | null = null;
  try {
    cache = openCache ? await openCache() : null;
    const hit = await cache?.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), fromCache: true };
  } catch {
    cache = null; // sin caché (navegación privada, permisos): se descarga cada vez
  }

  let response: Response;
  try {
    response = await fetchFn(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    throw new ModelDownloadError('No se ha podido descargar el modelo: revisa la conexión a internet.');
  }
  if (!response.ok || !response.body) {
    throw new ModelDownloadError(`No se ha podido descargar el modelo (el servidor respondió ${response.status}).`);
  }
  const declared = Number(response.headers.get('Content-Length'));
  const encoded = (response.headers.get('Content-Encoding') ?? 'identity').trim().toLowerCase() !== 'identity';
  const known = !encoded && Number.isSafeInteger(declared) && declared > 0 ? declared : null;
  const total = known ?? expectedBytes;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, Math.max(total, received));
    }
  } catch {
    throw new ModelDownloadError('Se ha cortado la descarga del modelo. Vuelve a intentarlo.');
  }
  if (known !== null && received !== known) {
    throw new ModelDownloadError('El modelo ha llegado incompleto. Vuelve a intentarlo.');
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch {
    /* sin sitio en la caché: se usa igual esta vez */
  }
  onProgress?.(received, received);
  return { bytes, fromCache: false };
}
