import { loadCorsImage } from '@/lib/corsImage';

/**
 * Imágenes del lienzo del editor, cargadas igual que en la exportación: con
 * `fetch` sin caché (lib/corsImage) y no con `crossOrigin` directo. El selector
 * de imágenes pinta la misma dirección firmada con <img> sin CORS y el
 * navegador guarda esa respuesta sin cabeceras: pedirla después con
 * `crossOrigin` fallaba («Imagen no disponible») hasta recargar. La dirección
 * `blob:` intermedia se libera en cuanto la imagen está descodificada
 * (`loadCorsImage`) y, si la carga se cancela al cerrar el editor, no se guarda nada.
 *
 * Si `fetch` falla (el almacén no responde a CORS), se prueba con `crossOrigin`
 * como antes: la foto se ve, pero no se puede leer para luz y color.
 */
export class ImageStore {
  private readonly images = new Map<string, HTMLImageElement | 'error'>();
  /** Direcciones que se cargaron por `fetch`: sus píxeles se pueden leer. */
  private readonly readable = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly abort = new AbortController();

  constructor(private readonly onChange: () => void) {}

  /** La imagen cargada, 'error' si falló, o undefined si aún no ha llegado (la primera vez que se pide, empieza a cargarla). */
  get(url: string): HTMLImageElement | 'error' | undefined {
    if (!this.images.has(url) && !this.pending.has(url)) this.load(url);
    return this.images.get(url);
  }

  isReadable(url: string): boolean {
    return this.readable.has(url);
  }

  private load(url: string): void {
    this.pending.add(url);
    loadCorsImage(url, this.abort.signal).then(
      (image) => {
        this.pending.delete(url);
        if (this.abort.signal.aborted) return;
        this.readable.add(url);
        this.images.set(url, image);
        this.onChange();
      },
      () => {
        if (this.abort.signal.aborted) return;
        this.loadPlain(url);
      },
    );
  }

  private loadPlain(url: string): void {
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      this.pending.delete(url);
      this.images.set(url, image);
      this.onChange();
    };
    image.onerror = () => {
      this.pending.delete(url);
      this.images.set(url, 'error');
      this.onChange();
    };
    image.src = url;
  }

  /** Cancela lo que esté cargando (al cerrar el editor). */
  destroy(): void {
    this.abort.abort();
    this.images.clear();
    this.readable.clear();
    this.pending.clear();
  }
}
