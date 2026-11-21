import { extractPalette, quantizePalette } from './palette';

type Run = [number, number, number, number, number?];

function pixels(...runs: Run[]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [r, g, b, count, a = 255] of runs) for (let i = 0; i < count; i++) out.push(r, g, b, a);
  return new Uint8ClampedArray(out);
}

function stubCanvas(getContext: () => unknown) {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = create(tag);
    if (tag === 'canvas') (el as HTMLCanvasElement).getContext = getContext as never;
    return el;
  }) as typeof document.createElement);
}

describe('quantizePalette', () => {
  it('devuelve los colores dominantes con su peso, de mayor a menor', () => {
    const palette = quantizePalette(pixels([255, 0, 0, 60], [0, 0, 255, 30], [0, 255, 0, 10]));
    expect(palette).toEqual([
      { hex: '#FF0000', weight: 0.6 },
      { hex: '#0000FF', weight: 0.3 },
      { hex: '#00FF00', weight: 0.1 },
    ]);
  });
  it('funde tonos parecidos y conserva el color medio real', () => {
    const palette = quantizePalette(pixels([200, 30, 30, 50], [210, 30, 30, 50]));
    expect(palette).toEqual([{ hex: '#CD1E1E', weight: 1 }]);
  });
  it('ignora los píxeles transparentes', () => {
    const palette = quantizePalette(pixels([255, 0, 0, 10], [0, 0, 255, 90, 0]));
    expect(palette).toEqual([{ hex: '#FF0000', weight: 1 }]);
  });
  it('imagen vacía o toda transparente: sin colores', () => {
    expect(quantizePalette(new Uint8ClampedArray())).toEqual([]);
    expect(quantizePalette(pixels([1, 2, 3, 5, 0]))).toEqual([]);
  });
  it('limita el número de colores y es estable', () => {
    const runs = [0, 1, 2, 3, 4, 5].map((i): Run => [i * 50, 0, 255 - i * 50, 10]);
    const many = pixels(...runs);
    const palette = quantizePalette(many, { maxColors: 3, mergeDistance: 10 });
    expect(palette).toHaveLength(3);
    expect(quantizePalette(many, { maxColors: 3, mergeDistance: 10 })).toEqual(palette);
  });
});

describe('extractPalette', () => {
  it('reduce la imagen, lee los píxeles del canvas y los cuantiza', async () => {
    const data = pixels([10, 200, 10, 4]);
    const drawImage = vi.fn();
    stubCanvas(() => ({ drawImage, getImageData: () => ({ data }) }));
    const image = { naturalWidth: 640, naturalHeight: 320 } as HTMLImageElement;
    const palette = await extractPalette(image);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 64, 32);
    expect(palette).toEqual([{ hex: '#0AC80A', weight: 1 }]);
  });
  it('rechaza si el navegador no da contexto', async () => {
    stubCanvas(() => null);
    await expect(extractPalette({ naturalWidth: 10, naturalHeight: 10 } as HTMLImageElement)).rejects.toThrow();
  });
});
