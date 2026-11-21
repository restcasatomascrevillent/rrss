import { describe, expect, it } from 'vitest';
import {
  availablePixelRatios,
  buildProvenance,
  clampQuality,
  exportSize,
  layerLabel,
  normalizeFileName,
  pageFileName,
  suggestFileName,
} from './options';

describe('tamaños', () => {
  it('a escala 1 conserva el tamaño lógico del lienzo', () => {
    for (const [width, height] of [
      [1080, 1080],
      [1080, 1350],
      [1080, 1920],
      [1920, 1080],
    ] as const) {
      expect(exportSize({ width, height }, 1)).toEqual({ width, height });
    }
  });

  it('la doble escala dobla ambos lados', () => {
    expect(exportSize({ width: 1080, height: 1350 }, 2)).toEqual({ width: 2160, height: 2700 });
  });

  it('solo ofrece la doble escala si no pasa del lado máximo', () => {
    expect(availablePixelRatios({ width: 1080, height: 1920 })).toEqual([1, 2]);
    expect(availablePixelRatios({ width: 1920, height: 1080 })).toEqual([1, 2]);
    expect(availablePixelRatios({ width: 3000, height: 3000 })).toEqual([1]);
  });
});

describe('calidad', () => {
  it('queda entre 0,5 y 1 y tolera valores raros', () => {
    expect(clampQuality(0.2)).toBe(0.5);
    expect(clampQuality(7)).toBe(1);
    expect(clampQuality(0.876)).toBe(0.88);
    expect(clampQuality(Number.NaN)).toBe(0.92);
  });
});

describe('nombre de archivo', () => {
  const base = {
    title: 'Menú de otoño: ¡estreno!',
    format: 'png',
    width: 1080,
    height: 1350,
    version: 3,
    unsaved: false,
  } as const;

  it('es legible y lleva tamaño y versión', () => {
    expect(suggestFileName(base)).toBe('menu-de-otono-estreno-1080x1350-v3.png');
  });

  it('marca el borrador cuando hay cambios sin guardar y omite la versión si no hay ninguna', () => {
    expect(suggestFileName({ ...base, unsaved: true })).toBe('menu-de-otono-estreno-1080x1350-v3-borrador.png');
    expect(suggestFileName({ ...base, version: null, unsaved: true, format: 'jpeg' })).toBe(
      'menu-de-otono-estreno-1080x1350-borrador.jpg',
    );
  });

  it('con un título sin letras usa un nombre de reserva', () => {
    expect(suggestFileName({ ...base, title: '¿¿??', version: null })).toBe('diseno-1080x1350.png');
  });

  it('acorta los títulos largos sin dejar guiones colgando', () => {
    const name = suggestFileName({ ...base, title: `${'a'.repeat(49)} bbbbbbbb` });
    expect(name.startsWith('a'.repeat(49))).toBe(true);
    expect(name).not.toMatch(/--/);
  });

  it('lo que escribe la persona se sanea y recibe la extensión del formato sin duplicarla', () => {
    expect(normalizeFileName('Mi diseño final', 'png')).toBe('Mi diseño final.png');
    expect(normalizeFileName('foto.PNG', 'png')).toBe('foto.png');
    expect(normalizeFileName('foto.png', 'jpeg')).toBe('foto.jpg');
    expect(normalizeFileName('../../etc/pass:wd*?.jpeg', 'jpeg')).toBe('passwd.jpg');
    expect(normalizeFileName('   ', 'png')).toBe('diseno.png');
  });
});

describe('capas en los avisos', () => {
  it('usa el nombre de la capa o su tipo y posición', () => {
    expect(layerLabel({ type: 'image', name: ' Foto plato ' }, 0)).toBe('«Foto plato»');
    expect(layerLabel({ type: 'logo', name: '' }, 2)).toBe('Logotipo (capa 3)');
  });
});

describe('procedencia', () => {
  it('guarda pieza, versión, formato, tamaño y momento', () => {
    expect(
      buildProvenance({
        contentId: 'c1',
        version: 3,
        unsavedChanges: false,
        format: 'jpeg',
        width: 1080,
        height: 1350,
        pixelRatio: 1,
        exportedAt: new Date('2026-11-18T10:00:00Z'),
      }),
    ).toEqual({
      type: 'export',
      content_id: 'c1',
      version: 3,
      unsaved_changes: false,
      format: 'jpeg',
      width: 1080,
      height: 1350,
      pixel_ratio: 1,
      exported_at: '2026-11-18T10:00:00.000Z',
    });
  });
});

describe('exportar un carrusel', () => {
  it('cada página lleva su número en el nombre y en la procedencia', () => {
    expect(
      suggestFileName({ title: 'Menú', format: 'jpeg', width: 1080, height: 1350, version: 3, unsaved: false, page: 2 }),
    ).toBe('menu-1080x1350-v3-p2.jpg');
    expect(pageFileName('mi-carrusel.jpg', 3, 'jpeg')).toBe('mi-carrusel-p3.jpg');
    expect(pageFileName('mi-carrusel-p1.jpg', 2, 'jpeg')).toBe('mi-carrusel-p2.jpg');
    const provenance = buildProvenance({
      contentId: 'c',
      version: 3,
      unsavedChanges: false,
      format: 'jpeg',
      width: 1080,
      height: 1350,
      pixelRatio: 1,
      exportedAt: new Date('2026-11-21T10:00:00Z'),
      page: { number: 2, count: 4 },
    });
    expect(provenance).toMatchObject({ page: 2, page_count: 4, version: 3 });
    // Un documento de una página no lleva número.
    const single = buildProvenance({
      contentId: 'c',
      version: 3,
      unsavedChanges: false,
      format: 'jpeg',
      width: 1080,
      height: 1080,
      pixelRatio: 1,
      exportedAt: new Date(),
    });
    expect(single).not.toHaveProperty('page');
    expect(single).not.toHaveProperty('page_count');
  });
});
