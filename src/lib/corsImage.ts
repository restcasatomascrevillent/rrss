// Carga una imagen de otro origen (R2, Supabase Storage, Drive) de forma que su
// lienzo se pueda leer.
//
// Por qué no basta con `image.crossOrigin = 'anonymous'`: la biblioteca pinta
// las miniaturas con <img> sin `crossOrigin`, y el navegador guarda en caché esa
// respuesta sin las cabeceras CORS. Si después se pide la MISMA URL firmada con
// `crossOrigin`, el navegador puede servir la copia de la caché y la carga falla
// («No 'Access-Control-Allow-Origin' header»), aunque el almacén tenga bien su
// regla CORS. Pedirla con `fetch` en modo CORS y sin caché evita esa copia; la
// imagen se crea después desde un `blob:` del mismo origen, que nunca mancha el
// lienzo.

/** Descarga la imagen sin pasar por la caché y la devuelve como `blob:` URL (hay que liberarla con `URL.revokeObjectURL`). */
export async function fetchImageObjectUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  const response = await fetch(url, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

/** Carga una imagen legible por el lienzo. La `blob:` URL intermedia se libera al terminar de cargar. */
export async function loadCorsImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const objectUrl = await fetchImageObjectUrl(url, signal);
  const owned = objectUrl !== url;
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('No se ha podido descodificar la imagen'));
      image.src = objectUrl;
    });
  } finally {
    // La imagen ya está descodificada en memoria: la URL intermedia no hace falta.
    if (owned) URL.revokeObjectURL(objectUrl);
  }
}
