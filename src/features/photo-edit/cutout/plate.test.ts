// El plato en las ediciones con IA: máscara que se manda a OpenAI (convenio y
// medidas) y vuelta a pegar el plato original sobre el resultado.
import { describe, expect, it } from 'vitest';
import type { Pixels } from '../pixels';
import { alphaOf, restorePlate, sameAspect, subjectMaskPixels } from './plate';

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

/** Alfa de un recorte de 20×10: el plato ocupa la mitad izquierda. */
const leftHalf = () => alphaOf(image(20, 10, (x) => [10, 10, 10, x < 10 ? 255 : 0]));

describe('máscara del plato para OpenAI', () => {
  it('tiene las medidas de la foto original, aunque el recorte se hiciera más pequeño', () => {
    const mask = subjectMaskPixels(leftHalf(), 20, 10, 4000, 3000);
    expect([mask.width, mask.height]).toEqual([4000, 3000]);
    expect(mask.data).toHaveLength(4000 * 3000 * 4);
  });

  it('convenio: el plato es opaco (alfa 255) y el fondo transparente (alfa 0), sin grises', () => {
    const mask = subjectMaskPixels(leftHalf(), 20, 10, 200, 100);
    expect(px(mask, 20, 50)[3]).toBe(255);
    expect(px(mask, 180, 50)[3]).toBe(0);
    const values = new Set<number>();
    for (let i = 3; i < mask.data.length; i += 4) values.add(mask.data[i]!);
    expect([...values].sort()).toEqual([0, 255]);
  });

  it('un alfa a medias se endurece: por debajo de 128 es fondo, desde 128 es plato', () => {
    const mask = subjectMaskPixels([127, 128], 2, 1, 2, 1);
    expect(mask.data[3]).toBe(0);
    expect(mask.data[7]).toBe(255);
  });

  it('no toca el alfa de entrada', () => {
    const alpha = leftHalf();
    const copy = new Uint8Array(alpha);
    subjectMaskPixels(alpha, 20, 10, 40, 20);
    expect(alpha).toEqual(copy);
  });
});

describe('volver a pegar el plato original', () => {
  const original = image(20, 10, () => [200, 30, 30]);
  const generated = image(40, 20, () => [10, 200, 10]); // la IA lo ha pintado todo de verde, plato incluido

  it('el plato queda como el original y el fondo como la IA, con el tamaño del resultado', () => {
    const out = restorePlate(generated, original, leftHalf(), { feather: 0.01 });
    expect([out.width, out.height]).toEqual([40, 20]);
    expect(px(out, 3, 10)).toEqual([200, 30, 30, 255]);
    expect(px(out, 37, 10)).toEqual([10, 200, 10, 255]);
  });

  it('el borde es suave: entre plato y fondo hay mezcla, no un corte', () => {
    const out = restorePlate(generated, original, leftHalf(), { feather: 0.1 });
    const edge = px(out, 20, 10);
    expect(edge[0]).toBeGreaterThan(10);
    expect(edge[0]).toBeLessThan(200);
  });

  it('sin plato (alfa a cero) el resultado de la IA queda tal cual', () => {
    const out = restorePlate(generated, original, new Uint8Array(200));
    expect(Array.from(out.data)).toEqual(Array.from(generated.data));
  });

  it('no modifica ninguna entrada', () => {
    const g = new Uint8ClampedArray(generated.data);
    const o = new Uint8ClampedArray(original.data);
    restorePlate(generated, original, leftHalf());
    expect(generated.data).toEqual(g);
    expect(original.data).toEqual(o);
  });

  it('si la IA devuelve otra proporción, se niega en vez de deformar el plato', () => {
    expect(sameAspect(generated, original)).toBe(true);
    const wide = image(40, 10, () => [0, 0, 0]);
    expect(sameAspect(wide, original)).toBe(false);
    expect(() => restorePlate(wide, original, leftHalf())).toThrow(/proporción/);
  });

  it('acepta el redondeo normal de la IA (1456×1088 desde 4000×3000)', () => {
    expect(sameAspect({ width: 1456, height: 1088 }, { width: 4000, height: 3000 })).toBe(true);
  });
});
