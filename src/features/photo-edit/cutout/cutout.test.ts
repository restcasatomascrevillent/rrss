// Quitar el fondo en el navegador: máscara, composición (fondo, sombra, tamaño),
// descarga con caché y procedencia. Sin modelo ni navegador: lo que devuelve el
// worker se sustituye por máscaras hechas a mano.
import { describe, expect, it, vi } from 'vitest';
import { editedFileName, photoEditProvenance } from '../provenance';
import type { Pixels } from '../pixels';
import { composeCutout, shadowAlpha } from './composition';
import { loadModelBytes, ModelDownloadError, type CacheLike } from './download';
import { applyMask, NoSubjectError, normalizeMask, resizeChannel, toModelInput } from './mask';
import { MODEL_SIDE } from './model';

function image(width: number, height: number, fill: (x: number, y: number) => number[]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = fill(x, y);
      data.set([r!, g!, b!, a], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}
const px = (img: Pixels, x: number, y: number) =>
  Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** Recorte de prueba: un cuadrado rojo opaco en el centro de un lienzo transparente. */
const subject = (size = 40) =>
  image(size, size, (x, y) =>
    x >= size / 4 && x < (size * 3) / 4 && y >= size / 4 && y < (size * 3) / 4 ? [200, 20, 20, 255] : [0, 0, 0, 0],
  );

describe('máscara del modelo', () => {
  it('la entrada del modelo es 1×3×1024×1024 y está normalizada (máximo→0,5, mínimo→-0,5)', () => {
    const src = image(8, 6, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const input = toModelInput(src);
    expect(input).toHaveLength(3 * MODEL_SIDE * MODEL_SIDE);
    expect(Math.max(...input.subarray(0, 5000))).toBeLessThanOrEqual(0.5);
    expect(input[0]).toBeCloseTo(-0.5, 5);
    expect(input[MODEL_SIDE - 1]).toBeCloseTo(0.5, 5);
    expect(src.data[0]).toBe(0); // la foto no se toca
  });

  it('normaliza la salida del modelo a 0–255 y un mapa plano queda en cero', () => {
    expect(Array.from(normalizeMask([0.2, 0.7, 1.2]))).toEqual([0, 127, 255]);
    expect(Array.from(normalizeMask([0.4, 0.4, 0.4]))).toEqual([0, 0, 0]);
  });

  it('escala la máscara al tamaño de la foto y la pone como alfa, sin tocar el color ni la entrada', () => {
    const src = image(20, 10, () => [10, 20, 30, 255]);
    const copy = new Uint8ClampedArray(src.data);
    // Mitad izquierda sujeto, mitad derecha fondo.
    const mask = new Uint8Array(MODEL_SIDE * MODEL_SIDE);
    for (let y = 0; y < MODEL_SIDE; y += 1) mask.fill(255, y * MODEL_SIDE, y * MODEL_SIDE + MODEL_SIDE / 2);
    const out = applyMask(src, mask);
    expect([out.width, out.height]).toEqual([20, 10]);
    expect(px(out, 2, 5)).toEqual([10, 20, 30, 255]);
    expect(px(out, 17, 5)).toEqual([10, 20, 30, 0]);
    expect(src.data).toEqual(copy);
  });

  it('si no se reconoce nada, lo dice en vez de entregar una foto vacía', () => {
    const src = image(10, 10, () => [1, 2, 3, 255]);
    expect(() => applyMask(src, new Uint8Array(MODEL_SIDE * MODEL_SIDE))).toThrow(NoSubjectError);
  });

  it('el reescalado bilinear conserva los valores constantes', () => {
    const out = resizeChannel(new Uint8Array(16).fill(200), 4, 4, 9, 7);
    expect(out).toHaveLength(63);
    expect(Math.min(...out)).toBeCloseTo(200, 3);
  });
});

describe('composición del recorte sobre un fondo', () => {
  it('sobre un color liso: el sujeto se queda, lo transparente toma el color y todo es opaco', () => {
    const out = composeCutout(subject(), { kind: 'color', hex: '#0000FF' });
    expect(px(out, 20, 20)).toEqual([200, 20, 20, 255]);
    expect(px(out, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('el tamaño del resultado es el del recorte (con o sin sombra), y la entrada no cambia', () => {
    const src = subject(48);
    const copy = new Uint8ClampedArray(src.data);
    for (const shadow of [false, true]) {
      const out = composeCutout(src, { kind: 'color', hex: '#FFFFFF' }, { shadow });
      expect([out.width, out.height]).toEqual([48, 48]);
      expect(out.data).toHaveLength(src.data.length);
    }
    expect(src.data).toEqual(copy);
  });

  it('sobre una imagen: toma sus píxeles y exige el mismo tamaño', () => {
    const marble = image(40, 40, () => [230, 230, 220]);
    expect(px(composeCutout(subject(), { kind: 'image', pixels: marble }), 1, 1)).toEqual([230, 230, 220, 255]);
    expect(() => composeCutout(subject(), { kind: 'image', pixels: image(10, 10, () => [0, 0, 0]) })).toThrow(
      /mismo tamaño|tamaño de la foto/,
    );
    expect(() => composeCutout(subject(), { kind: 'color', hex: 'rojo' })).toThrow(/no válido/);
  });

  it('sin sombra es idéntico al compuesto normal', () => {
    const marble = image(40, 40, () => [100, 120, 140]);
    const plain = composeCutout(subject(), { kind: 'image', pixels: marble });
    const same = composeCutout(subject(), { kind: 'image', pixels: marble }, { shadow: false });
    expect(Array.from(same.data)).toEqual(Array.from(plain.data));
  });

  it('la sombra cae debajo del sujeto, es suave y no oscurece lo de arriba ni lo lejano', () => {
    const size = 100;
    const src = image(size, size, (x, y) =>
      x >= 35 && x < 65 && y >= 30 && y < 60 ? [200, 20, 20, 255] : [0, 0, 0, 0],
    );
    const flat = composeCutout(src, { kind: 'color', hex: '#FFFFFF' });
    const shaded = composeCutout(src, { kind: 'color', hex: '#FFFFFF' }, { shadow: true });
    const lum = (img: Pixels, x: number, y: number) => px(img, x, y)[0]!;
    // Justo debajo del sujeto: más oscuro que sin sombra.
    expect(lum(shaded, 50, 64)).toBeLessThan(lum(flat, 50, 64));
    // Encima del sujeto y en una esquina: casi igual (la sombra va hacia abajo).
    expect(lum(shaded, 50, 8)).toBe(255);
    expect(lum(shaded, 2, 2)).toBe(255);
    // Suave: nunca negra (opacidad máxima del 35 % por defecto).
    expect(Math.min(...Array.from({ length: size }, (_, y) => lum(shaded, 50, y)))).toBeGreaterThan(255 * 0.6);
    // El sujeto sigue intacto encima de su sombra.
    expect(px(shaded, 50, 45)).toEqual([200, 20, 20, 255]);
  });

  it('la sombra respeta la opacidad pedida y sale a tamaño completo', () => {
    const src = subject(60);
    const strong = shadowAlpha(src, { opacity: 0.8 });
    const weak = shadowAlpha(src, { opacity: 0.2 });
    expect(strong).toHaveLength(60 * 60);
    expect(Math.max(...strong)).toBeGreaterThan(Math.max(...weak));
    expect(Math.max(...strong)).toBeLessThanOrEqual(0.8 + 1e-6);
  });
});

describe('descarga del modelo con caché', () => {
  const body = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    new Response(bytes as unknown as BodyInit, { headers: { 'Content-Length': String(bytes.length), ...headers } });
  const memoryCache = () => {
    const store = new Map<string, Uint8Array>();
    const cache: CacheLike = {
      match: async (url) => {
        const hit = store.get(url);
        return hit ? new Response(hit as unknown as BodyInit) : undefined;
      },
      put: async (url, response) => void store.set(url, new Uint8Array(await response.arrayBuffer())),
    };
    return { cache, store };
  };

  it('la primera vez descarga con progreso y la guarda; la segunda sale de la caché sin red', async () => {
    const model = new Uint8Array(3_000_000).map((_, i) => i % 251);
    const { cache, store } = memoryCache();
    const fetchFn = vi.fn(async () => body(model)) as unknown as typeof fetch;
    const steps: number[] = [];
    const first = await loadModelBytes({
      url: 'https://modelos.test/m.onnx',
      expectedBytes: 1,
      openCache: async () => cache,
      fetchFn,
      onProgress: (received, total) => steps.push(Math.round((received / total) * 100)),
    });
    expect(first.fromCache).toBe(false);
    expect(first.bytes).toHaveLength(model.length);
    expect(steps.at(-1)).toBe(100);
    expect(store.has('https://modelos.test/m.onnx')).toBe(true);

    const second = await loadModelBytes({
      url: 'https://modelos.test/m.onnx',
      expectedBytes: 1,
      openCache: async () => cache,
      fetchFn,
    });
    expect(second.fromCache).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('avisa si el servidor falla, no hay red o el modelo llega incompleto', async () => {
    const url = 'https://modelos.test/m.onnx';
    const run = (fetchFn: typeof fetch) => loadModelBytes({ url, expectedBytes: 10, fetchFn });
    await expect(run((async () => new Response('no', { status: 404 })) as typeof fetch)).rejects.toThrow(/404/);
    await expect(
      run((async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch),
    ).rejects.toThrow(ModelDownloadError);
    await expect(
      run((async () => new Response(new Uint8Array(5), { headers: { 'Content-Length': '10' } })) as typeof fetch),
    ).rejects.toThrow(/incompleto/);
  });

  it('sin Cache Storage descarga igualmente', async () => {
    const out = await loadModelBytes({
      url: 'https://modelos.test/m.onnx',
      expectedBytes: 4,
      openCache: async () => {
        throw new Error('sin caché');
      },
      fetchFn: (async () => body(new Uint8Array([1, 2, 3, 4]))) as unknown as typeof fetch,
    });
    expect(Array.from(out.bytes)).toEqual([1, 2, 3, 4]);
  });
});

describe('procedencia del recorte en el navegador', () => {
  it('guarda el recorte y el fondo (con sombra) como pasos, y el nombre dice «Fondo nuevo»', () => {
    const steps = [
      { kind: 'remove_background', engine: 'browser', model: 'isnet-general-use' },
      { kind: 'background', background: { type: 'color', hex: '#aa5500' }, shadow: true },
    ] as const;
    const json = photoEditProvenance({ sourceAssetId: 'a1', steps: [...steps], width: 100, height: 80 }) as {
      type: string;
      source_asset_id: string;
      steps: unknown[];
    };
    expect(json).toMatchObject({ type: 'photo_edit', source_asset_id: 'a1' });
    expect(json.steps).toEqual([
      { kind: 'remove_background', engine: 'browser', model: 'isnet-general-use' },
      { kind: 'background', shadow: true, color: '#AA5500' },
    ]);
    expect(editedFileName('Plato.jpg', [...steps], 'png')).toBe('Fondo nuevo · Plato.png');
    expect(editedFileName('Plato.jpg', [steps[0]], 'png')).toBe('Sin fondo · Plato.png');
  });
});
