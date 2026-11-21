import { describe, expect, it } from 'vitest';
import {
  buildThumbPath,
  createThumbnail,
  needsThumbnail,
  THUMB_SKIP_BYTES,
  thumbSize,
  type ThumbnailDeps,
} from './thumbnail';

const file = (type: string, size: number) => new File([new Uint8Array(size)], 'a', { type });
const decodeTo =
  (width: number, height: number): ThumbnailDeps['decode'] =>
  async () => ({ width, height, draw: () => undefined });

describe('thumbSize', () => {
  it('lleva el lado largo a 400 y conserva la proporción', () => {
    expect(thumbSize(1080, 1350)).toEqual({ width: 320, height: 400 });
    expect(thumbSize(4000, 3000)).toEqual({ width: 400, height: 300 });
  });
  it('no agranda lo pequeño', () => {
    expect(thumbSize(200, 100)).toEqual({ width: 200, height: 100 });
  });
  it('medidas no válidas dan 0', () => {
    expect(thumbSize(0, 10)).toEqual({ width: 0, height: 0 });
  });
});

describe('needsThumbnail', () => {
  it('solo imágenes que pesan algo', () => {
    expect(needsThumbnail(file('image/jpeg', THUMB_SKIP_BYTES + 1))).toBe(true);
    expect(needsThumbnail(file('image/jpeg', 100))).toBe(false);
    expect(needsThumbnail(file('video/mp4', 5_000_000))).toBe(false);
    expect(needsThumbnail(file('image/svg+xml', 5_000_000))).toBe(false);
  });
});

describe('buildThumbPath', () => {
  it('queda en la carpeta thumbs de la marca', () => {
    expect(buildThumbPath('o', 'b', 'i')).toBe('o/b/thumbs/i.webp');
  });
});

describe('createThumbnail', () => {
  const big = file('image/jpeg', 900_000);
  it('genera WebP con las medidas reducidas', async () => {
    const seen: number[][] = [];
    const t = await createThumbnail(big, {
      decode: decodeTo(1080, 1350),
      encode: async (_s, w, h, type) => {
        seen.push([w, h]);
        return new Blob([new Uint8Array(20_000)], { type });
      },
    });
    expect(t).toMatchObject({ width: 320, height: 400, type: 'image/webp', extension: 'webp' });
    expect(seen).toEqual([[320, 400]]);
  });
  it('si el navegador no codifica WebP, usa JPEG', async () => {
    const t = await createThumbnail(big, {
      decode: decodeTo(1000, 1000),
      encode: async (_s, _w, _h, type) =>
        type === 'image/webp'
          ? new Blob([new Uint8Array(10)], { type: 'image/png' })
          : new Blob([new Uint8Array(9000)], { type }),
    });
    expect(t).toMatchObject({ type: 'image/jpeg', extension: 'jpg' });
  });
  it('devuelve null si no hace falta, si falla o si no pesa menos', async () => {
    const enc: ThumbnailDeps['encode'] = async (_s, _w, _h, type) => new Blob([new Uint8Array(5000)], { type });
    expect(await createThumbnail(file('image/png', 100), { decode: decodeTo(10, 10), encode: enc })).toBeNull();
    expect(
      await createThumbnail(big, {
        decode: async () => {
          throw new Error('x');
        },
        encode: enc,
      }),
    ).toBeNull();
    expect(
      await createThumbnail(big, {
        decode: decodeTo(500, 500),
        encode: async (_s, _w, _h, type) => new Blob([new Uint8Array(950_000)], { type }),
      }),
    ).toBeNull();
  });
  it('sin canvas ni createImageBitmap (jsdom) no lanza', async () => {
    expect(await createThumbnail(big)).toBeNull();
  });
});
