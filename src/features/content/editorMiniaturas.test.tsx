import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDocument, type Layer } from './document';

// Miniaturas de la tira de páginas: las fotos se dibujan de verdad (cargadas
// con loadCorsImage, para no romper CORS con R2) y se cachean reducidas.
const mocks = vi.hoisted(() => ({ loadCorsImage: vi.fn() }));

// La preparación de las pruebas ya importa el editor (y con él la caché de
// miniaturas) antes de registrar el doble: se reimportan los módulos tras él.
type ThumbCache = typeof import('./editor/thumbCache');
let PageThumb: typeof import('./editor/panels/PageThumb').PageThumb;
let loadThumbSource: ThumbCache['loadThumbSource'];
let thumbCacheSize: ThumbCache['thumbCacheSize'];
let THUMB_CACHE_SIZE: number;

function fakeImage(width = 1000, height = 500) {
  return { naturalWidth: width, naturalHeight: height } as unknown as HTMLImageElement;
}

function photo(id: string, assetId: string): Layer {
  return {
    id,
    type: 'image',
    name: '',
    x: 0,
    y: 0,
    width: 540,
    height: 540,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    anchor: { x: 'center', y: 'center' },
    source: { kind: 'asset', assetId },
    fit: 'cover',
    focus: { x: 0.5, y: 0.5 },
  } as Layer;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('@/lib/corsImage', () => ({ loadCorsImage: mocks.loadCorsImage }));
  ({ PageThumb } = await import('./editor/panels/PageThumb'));
  ({ loadThumbSource, thumbCacheSize, THUMB_CACHE_SIZE } = await import('./editor/thumbCache'));
  // jsdom no tiene lienzo 2D: sin contexto las miniaturas siguen su camino sin dibujar.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.loadCorsImage.mockReset();
  mocks.loadCorsImage.mockImplementation(async () => fakeImage());
});
afterEach(() => vi.restoreAllMocks());

describe('Miniaturas de página con fotos', () => {
  it('dibuja la foto de verdad, pidiéndola con loadCorsImage, y sigue en gris sin dirección', async () => {
    const canvas = createEmptyDocument().canvas;
    render(
      <PageThumb
        canvas={canvas}
        layers={[photo('f1', A), photo('f2', B)]}
        images={new Map([[A, 'https://r2.example/a.jpg?firma=1']])}
      />,
    );
    // Solo la que tiene dirección carga; la otra es la caja gris de siempre.
    const images = screen.getAllByTestId('page-thumb-image');
    expect(images).toHaveLength(1);
    await waitFor(() => expect(images[0]).toHaveAttribute('data-state', 'ready'));
    expect(mocks.loadCorsImage).toHaveBeenCalledWith('https://r2.example/a.jpg?firma=1');
  });

  it('si la carga falla deja la caja gris y no rompe', async () => {
    mocks.loadCorsImage.mockRejectedValue(new Error('CORS'));
    render(
      <PageThumb
        canvas={createEmptyDocument().canvas}
        layers={[photo('f1', A)]}
        images={new Map([[A, 'https://r2.example/a.jpg']])}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('page-thumb-image')).toHaveAttribute('data-state', 'error'));
    // El fallo no se queda en la caché: se podrá reintentar.
    expect(thumbCacheSize()).toBe(0);
  });
});

describe('Caché de miniaturas', () => {
  it('comparte la descarga entre páginas con la misma foto', async () => {
    const [one, two] = await Promise.all([loadThumbSource('u1'), loadThumbSource('u1')]);
    expect(one).toBe(two);
    await loadThumbSource('u1');
    expect(mocks.loadCorsImage).toHaveBeenCalledTimes(1);
  });

  it('reduce las fotos grandes a una miniatura', async () => {
    const drawImage = vi.fn();
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const source = (await loadThumbSource('grande')) as HTMLCanvasElement;
    expect(source.width).toBe(192);
    expect(source.height).toBe(96);
    expect(drawImage).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('está acotada: al llenarse suelta las menos usadas', async () => {
    for (let i = 0; i < THUMB_CACHE_SIZE + 5; i++) await loadThumbSource(`u${i}`);
    expect(thumbCacheSize()).toBe(THUMB_CACHE_SIZE);
    mocks.loadCorsImage.mockClear();
    await loadThumbSource(`u${THUMB_CACHE_SIZE + 4}`); // reciente: sigue ahí
    expect(mocks.loadCorsImage).not.toHaveBeenCalled();
    await loadThumbSource('u0'); // antigua: se vuelve a pedir
    expect(mocks.loadCorsImage).toHaveBeenCalledTimes(1);
  });
});
