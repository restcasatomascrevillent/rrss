import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageStore } from './imageStore';

/** Imagen de mentira: carga al asignar `src` (o falla si la dirección lo pide). */
class FakeImage {
  static created: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  decoding = '';
  naturalWidth = 10;
  private source = '';
  constructor() {
    FakeImage.created.push(this);
  }
  set src(value: string) {
    this.source = value;
    queueMicrotask(() => (value.includes('rota') ? this.onerror?.() : this.onload?.()));
  }
  get src() {
    return this.source;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('imágenes del lienzo', () => {
  const revoked: string[] = [];

  beforeEach(() => {
    FakeImage.created = [];
    revoked.length = 0;
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:abc', revokeObjectURL: (u: string) => revoked.push(u) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('se piden con fetch sin caché y por CORS, no con crossOrigin directo, y se libera la dirección blob', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    const store = new ImageStore(changed);

    expect(store.get('https://r2.example/foto.jpg?firma=1')).toBeUndefined();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://r2.example/foto.jpg?firma=1',
      expect.objectContaining({ mode: 'cors', cache: 'no-store' }),
    );
    expect(store.get('https://r2.example/foto.jpg?firma=1')).toBeInstanceOf(FakeImage);
    expect(FakeImage.created[0]!.src).toBe('blob:abc');
    expect(FakeImage.created[0]!.crossOrigin).toBeNull();
    expect(revoked).toEqual(['blob:abc']);
    expect(store.isReadable('https://r2.example/foto.jpg?firma=1')).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('no pide dos veces la misma imagen', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    vi.stubGlobal('fetch', fetchMock);
    const store = new ImageStore(() => undefined);
    store.get('https://r2.example/a.jpg');
    store.get('https://r2.example/a.jpg');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si fetch falla, prueba con crossOrigin y la foto no se podrá leer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const store = new ImageStore(() => undefined);
    store.get('https://r2.example/b.jpg');
    await flush();
    const image = store.get('https://r2.example/b.jpg');
    expect(image).toBeInstanceOf(FakeImage);
    expect((image as unknown as FakeImage).crossOrigin).toBe('anonymous');
    expect(store.isReadable('https://r2.example/b.jpg')).toBe(false);
  });

  it('si tampoco carga así, queda en error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const store = new ImageStore(() => undefined);
    store.get('https://r2.example/rota.jpg');
    await flush();
    expect(store.get('https://r2.example/rota.jpg')).toBe('error');
  });

  it('al cerrar el editor se cancela lo pendiente y no se avisa', async () => {
    let resolveFetch: (value: unknown) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve))));
    const changed = vi.fn();
    const store = new ImageStore(changed);
    store.get('https://r2.example/c.jpg');
    store.destroy();
    resolveFetch({ ok: true, blob: async () => new Blob(['x']) });
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });
});
