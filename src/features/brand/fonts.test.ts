import { describe, expect, it, vi } from 'vitest';
import type { BrandFontRow } from '@/lib/database.types';
import {
  fontFormatFromName,
  guessFontFromFileName,
  MAX_FONT_BYTES,
  orderFontOptions,
  registerBrandFonts,
  validateFontFile,
  type FontEnvironment,
} from './fonts';

const font = (id: string, family: string, extra: Partial<BrandFontRow> = {}) =>
  ({ id, family, weight: 400, style: 'normal', format: 'woff2', storage_path: `x/${id}`, ...extra }) as BrandFontRow;

/** Doble de `FontFace` y `document.fonts`: registra lo que se crea y se añade. */
function fakeEnvironment(failFamilies: string[] = []) {
  const created: Array<{ family: string; bytes: number; descriptors: unknown }> = [];
  const added: string[] = [];
  class FakeFontFace {
    family: string;
    constructor(family: string, source: ArrayBuffer, descriptors?: unknown) {
      this.family = family;
      created.push({ family, bytes: source.byteLength, descriptors });
    }
    load() {
      return failFamilies.includes(this.family)
        ? Promise.reject(new Error('Archivo de fuente dañado'))
        : Promise.resolve(this);
    }
  }
  const env: FontEnvironment = {
    FontFace: FakeFontFace,
    fonts: { add: (face) => added.push((face as FakeFontFace).family) },
  };
  return { env, created, added };
}

describe('archivos de fuente', () => {
  it('formato por la extensión y validación', () => {
    expect(fontFormatFromName('Marca-Bold.TTF')).toBe('ttf');
    expect(fontFormatFromName('marca.woff2')).toBe('woff2');
    expect(fontFormatFromName('marca.exe')).toBeNull();
    expect(validateFontFile({ name: 'marca.otf', size: 1000 })).toBeNull();
    expect(validateFontFile({ name: 'marca.zip', size: 1000 })).toMatch(/no es una fuente/);
    expect(validateFontFile({ name: 'marca.ttf', size: 0 })).toMatch(/vacío/);
    expect(validateFontFile({ name: 'marca.ttf', size: MAX_FONT_BYTES + 1 })).toMatch(/máximo/);
  });

  it('deduce familia, peso y estilo del nombre del archivo', () => {
    expect(guessFontFromFileName('Lato-BoldItalic.ttf')).toEqual({ family: 'Lato', weight: 700, style: 'italic' });
    expect(guessFontFromFileName('OpenSans_SemiBold.woff2')).toEqual({
      family: 'Open Sans',
      weight: 600,
      style: 'normal',
    });
    expect(guessFontFromFileName('PlayfairDisplay-Regular.otf')).toEqual({
      family: 'Playfair Display',
      weight: 400,
      style: 'normal',
    });
    expect(guessFontFromFileName('Marca.woff')).toEqual({ family: 'Marca', weight: 400, style: 'normal' });
    expect(guessFontFromFileName('Mi-Marca-ExtraLight.ttf')).toMatchObject({ family: 'Mi Marca', weight: 200 });
  });

  it('el selector ofrece primero las de la marca, sin repetir', () => {
    expect(orderFontOptions(['Marca'], ['Marca', 'Titular'], ['sans-serif', 'serif'], 'Antigua')).toEqual([
      'Marca',
      'Titular',
      'sans-serif',
      'serif',
      'Antigua',
    ]);
  });
});

describe('cargar las tipografías con FontFace', () => {
  it('descarga, crea la FontFace con su peso y estilo, espera a que cargue y la añade', async () => {
    const { env, created, added } = fakeEnvironment();
    const download = vi.fn(async () => new ArrayBuffer(8));
    const report = await registerBrandFonts(
      [font('a', 'Marca', { weight: 700, style: 'italic' }), font('b', 'Titular')],
      download,
      env,
    );
    expect(report).toEqual({ loaded: ['a', 'b'], failed: [] });
    expect(created).toEqual([
      { family: 'Marca', bytes: 8, descriptors: { weight: '700', style: 'italic', display: 'block' } },
      { family: 'Titular', bytes: 8, descriptors: { weight: '400', style: 'normal', display: 'block' } },
    ]);
    expect(added).toEqual(['Marca', 'Titular']);
  });

  it('un archivo que falla no detiene a los demás y no se añade', async () => {
    const { env, added } = fakeEnvironment(['Rota']);
    const report = await registerBrandFonts(
      [font('a', 'Rota'), font('b', 'Buena'), font('c', 'Sin archivo')],
      async (f) => {
        if (f.id === 'c') throw new Error('Object not found');
        return new ArrayBuffer(4);
      },
      env,
    );
    expect(report.loaded).toEqual(['b']);
    expect(report.failed).toEqual([
      { id: 'a', family: 'Rota', reason: 'Archivo de fuente dañado' },
      { id: 'c', family: 'Sin archivo', reason: 'Object not found' },
    ]);
    expect(added).toEqual(['Buena']);
  });

  it('lo ya registrado no se vuelve a descargar', async () => {
    const { env } = fakeEnvironment();
    const download = vi.fn(async () => new ArrayBuffer(4));
    const registered = new Set<string>();
    await registerBrandFonts([font('a', 'Marca')], download, env, registered);
    await registerBrandFonts([font('a', 'Marca')], download, env, registered);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
