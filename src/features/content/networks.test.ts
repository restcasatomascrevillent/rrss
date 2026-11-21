import { describe, expect, it } from 'vitest';
import {
  FORMAT_SPECS,
  NETWORKS,
  NETWORK_SPECS_REVIEWED_ON,
  allowedCanvasRatios,
  formatsOf,
  getFormatSpec,
  isKnownTarget,
  recommendedCanvasRatio,
  type Sourced,
} from './networks';

/** Todos los datos con procedencia de una especificación, con la ruta de cada uno. */
function sourcedValues(node: unknown, path: string, found: [string, Sourced<unknown>][] = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => sourcedValues(item, `${path}.${index}`, found));
  } else if (typeof node === 'object' && node !== null) {
    if ('value' in node) found.push([path, node as Sourced<unknown>]);
    else for (const [key, value] of Object.entries(node)) sourcedValues(value, `${path}.${key}`, found);
  }
  return found;
}

const spec = (network: string, format: string) => {
  const found = getFormatSpec(network, format);
  if (!found) throw new Error(`No existe ${network}/${format}`);
  return found;
};

describe('catálogo de redes y formatos', () => {
  it('cada dato lleva su procedencia y la página de la que sale', () => {
    let total = 0;
    for (const item of FORMAT_SPECS) {
      const { network, format, label, media, ...data } = item;
      expect(label, `${network}/${format}`).not.toBe('');
      expect(media.length, `${network}/${format}`).toBeGreaterThan(0);
      for (const [path, sourced] of sourcedValues(data, `${network}/${format}`)) {
        total += 1;
        expect(['official', 'unverified'], path).toContain(sourced.provenance);
        expect(sourced.source, path).toMatch(/^https:\/\/\S+$/);
        expect(sourced.value, path).not.toBeUndefined();
      }
    }
    expect(total).toBeGreaterThan(60);
  });

  it('no hay cifras sueltas: todo número está dentro de un dato con procedencia', () => {
    const loose: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'number') loose.push(path);
      else if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${path}.${index}`));
      else if (typeof node === 'object' && node !== null && !('value' in node)) {
        for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
      }
    };
    for (const item of FORMAT_SPECS) walk(item, `${item.network}/${item.format}`);
    expect(loose).toEqual([]);
  });

  it('los identificadores valen para la base de datos y no se repiten', () => {
    const id = /^[a-z][a-z0-9_]{0,31}$/;
    const keys = FORMAT_SPECS.map((s) => `${s.network}/${s.format}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of FORMAT_SPECS) {
      expect(s.network).toMatch(id);
      expect(s.format).toMatch(id);
    }
    // Toda red del catálogo tiene nombre y al menos un formato, y al revés.
    expect([...new Set(FORMAT_SPECS.map((s) => s.network))].sort()).toEqual(NETWORKS.map((n) => n.id).sort());
    expect(NETWORK_SPECS_REVIEWED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recoge las cifras oficiales de Instagram tal como están en el informe', () => {
    const post = spec('instagram', 'post');
    expect(post.text.caption).toMatchObject({ value: { maxLength: 2200, unit: 'characters' }, provenance: 'official' });
    expect(post.text.maxHashtags).toMatchObject({ value: 30, provenance: 'official' });
    expect(post.text.maxMentions).toMatchObject({ value: 20, provenance: 'official' });
    expect(post.text.altText).toMatchObject({ value: { maxLength: 1000 }, provenance: 'official' });
    expect(post.image?.widthPx?.value).toEqual({ min: 320, max: 1440 });
    expect(post.image?.aspectRatio?.value).toEqual({ min: 0.8, max: 1.91 });
    expect(post.image?.maxFileSize?.value).toEqual({ amount: 8, unit: 'MB' });

    const reel = spec('instagram', 'reel');
    expect(reel.video?.durationSeconds?.value).toEqual({ min: 3, max: 900 });
    expect(reel.video?.maxFileSize?.value).toEqual({ amount: 300, unit: 'MB' });
    expect(reel.text.caption?.value.maxLength).toBe(2200);
    expect(reel.text.altTextSupported?.value).toBe(false);
    expect(spec('instagram', 'carousel').maxItems).toMatchObject({ value: 20, provenance: 'official' });
    expect(spec('instagram', 'story').video?.durationSeconds?.value).toEqual({ min: 3, max: 60 });
  });

  it('lo que solo sale en fuentes secundarias queda marcado como sin verificar', () => {
    expect(spec('instagram', 'post').text.truncation).toEqual([
      expect.objectContaining({ value: { characters: 125 }, provenance: 'unverified' }),
    ]);
    const linkedin = spec('linkedin', 'page_post');
    expect(linkedin.text.caption).toMatchObject({ value: { maxLength: 3000 }, provenance: 'unverified' });
    expect(linkedin.text.truncation?.map((t) => [t.value.context, t.value.characters, t.provenance])).toEqual([
      ['desktop', 210, 'unverified'],
      ['mobile', 140, 'unverified'],
    ]);
    // Pinterest: la página oficial es la de anuncios; para pines orgánicos no está verificado.
    const pin = spec('pinterest', 'pin');
    for (const [path, sourced] of sourcedValues({ image: pin.image, video: pin.video, text: pin.text }, 'pin')) {
      expect(sourced.provenance, path).toBe('unverified');
    }
    const gbp = spec('google_business', 'post');
    expect(gbp.text.caption?.provenance).toBe('unverified');
    expect(gbp.text.callToActions).toMatchObject({ provenance: 'official' });
    expect(gbp.text.callToActions?.value).toContain('BOOK');
  });

  it('no inventa límites que el informe no tiene', () => {
    // El informe no encontró el límite de texto de X, Facebook ni la descripción de YouTube.
    expect(spec('x', 'post').text).toEqual({});
    expect(spec('facebook', 'page_post').text).toEqual({});
    expect(spec('facebook', 'reel').text).toEqual({});
    expect(spec('youtube', 'short').text.caption).toBeUndefined();
    expect(spec('tiktok', 'photo').text).toEqual({});
    // TikTok cuenta en unidades UTF-16.
    expect(spec('tiktok', 'video').text.caption?.value).toEqual({ maxLength: 2200, unit: 'utf16' });
    expect(spec('tiktok', 'video').text.maxHashtags).toBeUndefined();
  });
});

describe('consultas', () => {
  it('busca por red y formato', () => {
    expect(formatsOf('instagram').map((s) => s.format)).toEqual(['post', 'carousel', 'reel', 'story']);
    expect(formatsOf('myspace')).toEqual([]);
    expect(isKnownTarget('instagram', 'reel')).toBe(true);
    expect(isKnownTarget('instagram', 'short')).toBe(false);
    expect(isKnownTarget('', '')).toBe(false);
    expect(getFormatSpec('tiktok', 'video')?.label).toBe('Vídeo');
  });

  it('dice qué proporciones del lienzo caben en lo que admite la red', () => {
    // Instagram, publicación: de 4:5 a 1,91:1 → no cabe el vertical 9:16.
    expect(allowedCanvasRatios(spec('instagram', 'post'))).toEqual({
      ratios: ['1:1', '4:5', '16:9'],
      provenance: 'official',
    });
    expect(allowedCanvasRatios(spec('instagram', 'reel'))?.ratios).toEqual(['1:1', '4:5', '9:16', '16:9']);
    expect(allowedCanvasRatios(spec('facebook', 'reel'))).toEqual({ ratios: ['9:16'], provenance: 'official' });
    expect(allowedCanvasRatios(spec('pinterest', 'pin'), 'video')).toEqual({
      ratios: ['1:1', '4:5', '9:16', '16:9'],
      provenance: 'unverified',
    });
  });

  it('si no se conoce el margen de proporciones, lo dice en vez de suponerlo', () => {
    expect(allowedCanvasRatios(spec('instagram', 'story'))).toBeNull();
    expect(allowedCanvasRatios(spec('linkedin', 'page_post'))).toBeNull();
    expect(allowedCanvasRatios(spec('pinterest', 'pin'))).toBeNull(); // la imagen solo tiene proporción recomendada
    expect(allowedCanvasRatios(spec('instagram', 'post'), 'video')).toBeNull();
  });

  it('da la proporción recomendada solo si es una de las del lienzo', () => {
    expect(recommendedCanvasRatio(spec('instagram', 'story'))).toEqual({ ratio: '9:16', provenance: 'official' });
    expect(recommendedCanvasRatio(spec('instagram', 'reel'))).toEqual({ ratio: '9:16', provenance: 'official' });
    expect(recommendedCanvasRatio(spec('pinterest', 'pin'))).toBeNull(); // 2:3 no es una proporción del lienzo
    expect(recommendedCanvasRatio(spec('instagram', 'post'))).toBeNull();
  });
});
