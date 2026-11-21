import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignedUrlCache, signWithCache } from './signedUrlCache';

const signer = () => vi.fn(async (paths: string[]) => new Map(paths.map((p) => [p, `https://x/${p}?s=1`] as const)));

describe('signWithCache', () => {
  beforeEach(() => clearSignedUrlCache());

  it('pide solo lo que falta y reutiliza el resto', async () => {
    const sign = signer();
    await signWithCache('full', ['a', 'b'], 1000, sign);
    const second = await signWithCache('full', ['b', 'c'], 1000, sign);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[1]![0]).toEqual(['c']);
    expect([...second.keys()].sort()).toEqual(['b', 'c']);
  });

  it('vuelve a pedir cuando la URL ha caducado', async () => {
    const sign = signer();
    let t = 0;
    await signWithCache('full', ['a'], 1000, sign, () => t);
    t = 1001;
    await signWithCache('full', ['a'], 1000, sign, () => t);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('las variantes no se mezclan', async () => {
    const sign = signer();
    await signWithCache('full', ['a'], 1000, sign);
    await signWithCache('thumb', ['a'], 1000, sign);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('comparte la petición en vuelo', async () => {
    const sign = signer();
    const [x, y] = await Promise.all([
      signWithCache('full', ['a'], 1000, sign),
      signWithCache('full', ['a'], 1000, sign),
    ]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(x.get('a')).toBe(y.get('a'));
  });

  it('un fallo se propaga y no se queda en caché', async () => {
    const bad = vi.fn(async () => {
      throw new Error('no');
    });
    await expect(signWithCache('full', ['a'], 1000, bad)).rejects.toThrow('no');
    const sign = signer();
    const out = await signWithCache('full', ['a'], 1000, sign);
    expect(out.get('a')).toBeDefined();
    expect(sign).toHaveBeenCalledTimes(1);
  });
});
