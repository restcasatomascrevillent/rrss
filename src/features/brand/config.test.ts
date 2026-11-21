import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './api';
import { BRAND_CONFIG_FORMAT, configFileName, exportBrandConfig, parseBrandConfig } from './config';
import { brandProfileSchema } from './profile';

const brand = {
  name: 'Marca Uno',
  sector: 'Moda',
  website: 'https://uno.test',
  timezone: 'Europe/Madrid',
  default_locale: 'es',
};
const profile = brandProfileSchema.parse({
  business: { description: 'Tienda de ropa', products: [{ name: 'Camisetas', description: '' }] },
  goals: ['Vender más'],
  visual: {
    colors: [{ name: 'Azul', hex: '#0000FF', role: 'Principal' }],
    logoAssetIds: ['3f2b6c1e-8a4d-4c7b-9e2f-1a2b3c4d5e6f'],
  },
});

describe('exportar e importar la configuración de una marca', () => {
  it('ida y vuelta conserva la marca y el perfil', () => {
    const exported = exportBrandConfig(brand, profile, new Date('2026-01-02T03:04:05Z'));
    expect(exported.format).toBe(BRAND_CONFIG_FORMAT);
    expect(exported.exportedAt).toBe('2026-01-02T03:04:05.000Z');

    const result = parseBrandConfig(JSON.stringify(exported));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.brand).toEqual(brand);
    expect(result.config.profile).toEqual({ ...profile, visual: { ...profile.visual, logoAssetIds: [] } });
  });

  it('los identificadores de logotipo no viajan: son archivos de la marca de origen', () => {
    expect(exportBrandConfig(brand, profile).profile.visual.logoAssetIds).toEqual([]);
    const forged = { ...exportBrandConfig(brand, profile), profile };
    const result = parseBrandConfig(JSON.stringify(forged));
    expect(result.ok && result.config.profile.visual.logoAssetIds).toEqual([]);
  });

  it('acepta una configuración mínima escrita a mano', () => {
    const result = parseBrandConfig(
      JSON.stringify({ format: BRAND_CONFIG_FORMAT, version: 1, brand: { name: 'Solo nombre' }, profile: {} }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.brand.timezone).toBe('Europe/Madrid');
      expect(result.config.profile.goals).toEqual([]);
    }
  });

  it('explica por qué no vale un archivo', () => {
    expect(parseBrandConfig('{no es json')).toEqual({
      ok: false,
      errors: ['El archivo no es una configuración válida.'],
    });

    const otherFormat = parseBrandConfig(
      JSON.stringify({ format: 'otra-cosa', version: 1, brand: { name: 'X' }, profile: {} }),
    );
    expect(otherFormat.ok).toBe(false);
    if (!otherFormat.ok) expect(otherFormat.errors.join(' ')).toMatch(/No es una configuración de marca/);

    const newer = parseBrandConfig(
      JSON.stringify({ format: BRAND_CONFIG_FORMAT, version: 99, brand: { name: 'X' }, profile: {} }),
    );
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.errors.join(' ')).toMatch(/Versión de configuración no admitida/);

    const noName = parseBrandConfig(
      JSON.stringify({ format: BRAND_CONFIG_FORMAT, version: 1, brand: { name: '  ' }, profile: {} }),
    );
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.errors[0]).toMatch(/brand › name: Falta el nombre/);

    const badColor = parseBrandConfig(
      JSON.stringify({
        format: BRAND_CONFIG_FORMAT,
        version: 1,
        brand: { name: 'X' },
        profile: { visual: { colors: [{ hex: 'azul' }] } },
      }),
    );
    expect(badColor.ok).toBe(false);
    if (!badColor.ok) expect(badColor.errors[0]).toMatch(/profile › visual › colors › 0 › hex/);
  });

  it('acota la lista de errores', () => {
    const colors = Array.from({ length: 20 }, () => ({ hex: 'mal' }));
    const result = parseBrandConfig(
      JSON.stringify({
        format: BRAND_CONFIG_FORMAT,
        version: 1,
        brand: { name: 'X' },
        profile: { visual: { colors } },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(9);
      expect(result.errors.at(-1)).toMatch(/12 problemas más/);
    }
  });

  it('el nombre del archivo es seguro', () => {
    expect(configFileName('Café & Ñandú S.L.')).toBe('cafe-nandu-s-l.brand-config.json');
    expect(configFileName('///')).toBe('marca.brand-config.json');
  });
});

describe('normalizeUrl', () => {
  it('añade https y valida', () => {
    expect(normalizeUrl('ejemplo.com')).toBe('https://ejemplo.com/');
    expect(normalizeUrl(' http://ejemplo.com/a?b=1 ')).toBe('http://ejemplo.com/a?b=1');
  });
  it('rechaza lo que no es una web', () => {
    for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://x.com', 'localhost', 'hola mundo']) {
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
});

describe('reglas de publicación en la configuración', () => {
  const rules = brandProfileSchema.parse({
    voice: {
      hashtags: { required: ['MiMarca'], recommended: ['Tapas'] },
      callsToAction: ['Reserva tu mesa'],
      emojis: { allowed: true, max: 2 },
    },
  });

  it('viajan en la exportación y vuelven intactas', () => {
    const exported = exportBrandConfig(brand, rules);
    const result = parseBrandConfig(JSON.stringify(exported));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.profile.voice.hashtags).toEqual({ required: ['MiMarca'], recommended: ['Tapas'] });
    expect(result.config.profile.voice.callsToAction).toEqual(['Reserva tu mesa']);
    expect(result.config.profile.voice.emojis).toEqual({ allowed: true, max: 2 });
  });

  it('un archivo exportado antes de existir estos campos se importa con valores por defecto', () => {
    const old = {
      format: BRAND_CONFIG_FORMAT,
      version: 1,
      brand,
      profile: { voice: { tone: ['Cercano'], forbiddenPhrases: ['gratis'] } },
    };
    const result = parseBrandConfig(JSON.stringify(old));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.profile.voice.forbiddenPhrases).toEqual(['gratis']);
    expect(result.config.profile.voice.emojis).toEqual({ allowed: null, max: null });
    expect(result.config.profile.voice.hashtags.required).toEqual([]);
  });

  it('un máximo de emojis imposible se rechaza con un mensaje claro', () => {
    const bad = { format: BRAND_CONFIG_FORMAT, version: 1, brand, profile: { voice: { emojis: { max: -2 } } } };
    const result = parseBrandConfig(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });
});
