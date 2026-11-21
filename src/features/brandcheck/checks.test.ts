import { checkAltText, checkHashtagCount, checkLength, checkMentionCount } from './limits';
import { checkEmojis, checkReadability, countSyllables, fernandezHuerta, readabilityBand } from './style';
import { checkBrandHashtags, checkCallToAction, checkForbiddenPhrases } from './vocabulary';
import { checkContrast, checkPalette } from './visual';

const codes = (f: { code: string }[]) => f.map((x) => x.code);

describe('límites de la red', () => {
  it('longitud: pasa justo en el límite y bloquea al pasarse', () => {
    expect(checkLength({ caption: 'a'.repeat(10) }, { maxCaptionLength: 10 })).toEqual([]);
    const [f] = checkLength({ caption: 'a'.repeat(12) }, { maxCaptionLength: 10, label: 'Instagram' });
    expect(f).toMatchObject({ code: 'LENGTH_EXCEEDED', severity: 'block', measured: 12, threshold: 10 });
    expect(f!.message).toContain('Instagram');
  });
  it('longitud: cuenta los hashtags añadidos aparte y respeta la unidad', () => {
    expect(codes(checkLength({ caption: 'hola', hashtags: ['mucho'] }, { maxCaptionLength: 8 }))).toEqual([
      'LENGTH_EXCEEDED',
    ]);
    expect(checkLength({ caption: '😀😀😀' }, { maxCaptionLength: 3, lengthUnit: 'graphemes' })).toEqual([]);
    expect(codes(checkLength({ caption: '😀😀😀' }, { maxCaptionLength: 3 }))).toEqual(['LENGTH_EXCEEDED']);
  });
  it('sin límite conocido: informa y no inventa', () => {
    const [f] = checkLength({ caption: 'x' }, {});
    expect(f).toMatchObject({ code: 'NETWORK_LIMIT_UNKNOWN', severity: 'info', omitted: true });
  });
  it('hashtags: cuenta únicos entre pie y lista', () => {
    const text = { caption: '#a #b #A', hashtags: ['b', 'c'] };
    expect(checkHashtagCount(text, { maxHashtags: 3 })).toEqual([]);
    const [f] = checkHashtagCount(text, { maxHashtags: 2 });
    expect(f).toMatchObject({ code: 'HASHTAGS_EXCEEDED', measured: 3, threshold: 2, severity: 'block' });
    expect(codes(checkHashtagCount(text, {}))).toEqual(['NETWORK_LIMIT_UNKNOWN']);
  });
  it('menciones: bloquea al pasarse', () => {
    const text = { caption: '@a @b', mentions: ['c'] };
    expect(checkMentionCount(text, { maxMentions: 3 })).toEqual([]);
    expect(checkMentionCount(text, { maxMentions: 2 })[0]).toMatchObject({ code: 'MENTIONS_EXCEEDED', measured: 3 });
  });
  it('texto alternativo: falta con imagen, no hace falta sin imagen, y longitud', () => {
    expect(checkAltText({ caption: '' }, false, {})).toEqual([]);
    expect(codes(checkAltText({ caption: '', altText: '  ' }, true, {}))).toEqual(['ALT_TEXT_MISSING']);
    expect(checkAltText({ caption: '', altText: 'Plato de arroz' }, true, {})).toEqual([]);
    expect(codes(checkAltText({ caption: '', altText: 'abcdef' }, true, { maxAltTextLength: 5 }))).toEqual([
      'ALT_TEXT_TOO_LONG',
    ]);
  });
});

describe('palabras vetadas', () => {
  const brand = { forbiddenPhrases: ['Barato', 'mejor precio'] };
  it('encuentra cada aparición con su posición y bloquea', () => {
    const fs = checkForbiddenPhrases({ caption: 'Todo BARATO, el mejor precio y barato' }, undefined, brand);
    expect(fs).toHaveLength(3);
    expect(fs.every((f) => f.severity === 'block' && f.code === 'FORBIDDEN_PHRASE')).toBe(true);
    expect(fs[0]!.target.range).toEqual({ start: 5, end: 11 });
  });
  it('revisa texto alternativo, hashtags añadidos y capas de texto', () => {
    const fs = checkForbiddenPhrases(
      { caption: 'ok', altText: 'cartel barato', hashtags: ['#barato'] },
      [{ id: 'l1', text: 'Barato!', color: '#000', background: '#fff' }],
      brand,
    );
    expect(fs.map((f) => f.target.part).sort()).toEqual(['altText', 'hashtags', 'textLayer']);
    expect(fs.find((f) => f.target.part === 'textLayer')!.target.layerId).toBe('l1');
  });
  it('sin palabras vetadas en el perfil: omite con aviso informativo', () => {
    const [f] = checkForbiddenPhrases({ caption: 'x' }, undefined, { forbiddenPhrases: [] });
    expect(f).toMatchObject({ code: 'PROFILE_DATA_MISSING', severity: 'info', omitted: true });
  });
  it('texto limpio: sin hallazgos', () => {
    expect(checkForbiddenPhrases({ caption: 'Menú del día' }, undefined, brand)).toEqual([]);
  });
});

describe('hashtags de marca y llamada a la acción', () => {
  it('obligatorio ausente bloquea; recomendado ausente informa', () => {
    const fs = checkBrandHashtags(
      { caption: 'Hola #Menú' },
      { requiredHashtags: ['#menu', '#Reservas'], recommendedHashtags: ['vino'] },
    );
    expect(fs.map((f) => [f.code, f.severity])).toEqual([
      ['BRAND_HASHTAG_MISSING', 'block'],
      ['BRAND_HASHTAG_RECOMMENDED_MISSING', 'info'],
    ]);
    expect(fs[0]!.message).toContain('#Reservas');
  });
  it('todo presente (también en la lista aparte): sin hallazgos', () => {
    expect(
      checkBrandHashtags({ caption: '#a', hashtags: ['b'] }, { requiredHashtags: ['a'], recommendedHashtags: ['B'] }),
    ).toEqual([]);
  });
  it('perfil sin hashtags: omite', () => {
    expect(checkBrandHashtags({ caption: '' }, {})[0]).toMatchObject({ code: 'PROFILE_DATA_MISSING', omitted: true });
  });
  it('llamada a la acción presente, ausente y sin datos', () => {
    const brand = { callsToAction: ['reserva tu mesa', 'llámanos'] };
    expect(checkCallToAction({ caption: '¡Reserva tu MESA hoy!' }, brand)).toEqual([]);
    expect(checkCallToAction({ caption: 'Hola' }, brand)[0]).toMatchObject({
      code: 'CALL_TO_ACTION_MISSING',
      severity: 'warn',
    });
    expect(checkCallToAction({ caption: 'Hola' }, {})[0]).toMatchObject({
      code: 'PROFILE_DATA_MISSING',
      omitted: true,
    });
  });
});

describe('contraste', () => {
  it('pasa con negro sobre blanco', () => {
    expect(checkContrast([{ id: 'a', color: '#000', background: '#fff' }])).toEqual([]);
  });
  it('gris claro sobre blanco: ratio muy bajo bloquea', () => {
    const [f] = checkContrast([{ id: 'a', color: '#cccccc', background: '#ffffff' }]);
    expect(f).toMatchObject({ code: 'CONTRAST_TOO_LOW', severity: 'block', threshold: 4.5 });
    expect(f!.measured).toBeLessThan(3);
    expect(f!.target).toEqual({ part: 'textLayer', layerId: 'a' });
  });
  it('entre 3 y 4,5 en texto normal avisa; el mismo par en texto grande pasa', () => {
    const base = { id: 'a', color: '#888888', background: '#ffffff' };
    const [f] = checkContrast([base]);
    expect(f).toMatchObject({ severity: 'warn', measured: 3.54 });
    expect(checkContrast([{ ...base, fontSizePt: 20 }])).toEqual([]);
    expect(checkContrast([{ ...base, fontSizePt: 14, bold: true }])).toEqual([]);
  });
  it('texto grande exige 3:1', () => {
    const [f] = checkContrast([{ id: 'a', color: '#aaaaaa', background: '#ffffff', fontSizePt: 24 }]);
    expect(f).toMatchObject({ severity: 'block', threshold: 3 });
  });
  it('fondo desconocido o color inválido: omite con informativo; exento: ni eso', () => {
    expect(checkContrast([{ id: 'a', color: '#000' }])[0]).toMatchObject({
      code: 'CONTRAST_UNKNOWN_BACKGROUND',
      omitted: true,
    });
    expect(checkContrast([{ id: 'a', color: 'rojo', background: '#fff' }])[0]!.code).toBe(
      'CONTRAST_UNKNOWN_BACKGROUND',
    );
    expect(checkContrast([{ id: 'a', color: '#fff', background: '#fff', exempt: true }])).toEqual([]);
  });
  it('mezcla el alfa del texto con el fondo', () => {
    expect(checkContrast([{ id: 'a', color: '#00000020', background: '#ffffff' }])[0]!.code).toBe('CONTRAST_TOO_LOW');
  });
});

describe('paleta frente a la marca', () => {
  const brandColors = [{ hex: '#8a1c2b' }, { hex: '#f5efe6' }];
  it('imagen gráfica con colores de marca: sin hallazgos', () => {
    const palette = [
      { hex: '#8b1d2c', weight: 0.6 },
      { hex: '#222222', weight: 0.4 },
    ];
    expect(checkPalette(palette, brandColors, 'graphic')).toEqual([]);
  });
  it('gráfica sin ningún color de marca: avisa; fotografía: informa', () => {
    const palette = [{ hex: '#0000ff', weight: 1 }];
    const g = checkPalette(palette, brandColors, 'graphic')[0]!;
    expect(g).toMatchObject({ code: 'PALETTE_OFF_BRAND', severity: 'warn', measured: 0 });
    expect(checkPalette(palette, brandColors, 'photo')[0]!.severity).toBe('info');
    expect(checkPalette(palette, brandColors, undefined)[0]!.severity).toBe('info');
  });
  it('cobertura baja pero no nula', () => {
    const palette = [
      { hex: '#8a1c2b', weight: 0.1 },
      { hex: '#0000ff', weight: 0.9 },
    ];
    const [f] = checkPalette(palette, brandColors, 'graphic');
    expect(f).toMatchObject({ measured: 0.1, threshold: 0.2 });
  });
  it('ignora colores casi inexistentes y respeta un umbral propio', () => {
    const palette = [
      { hex: '#8a1c2b', weight: 0.5 },
      { hex: '#0000ff', weight: 0.01 },
    ];
    expect(checkPalette(palette, brandColors, 'graphic')).toEqual([]);
    const near = [{ hex: '#a02a3a', weight: 1 }];
    expect(checkPalette(near, brandColors, 'graphic', { paletteMatchDeltaE: 1 })).toHaveLength(1);
  });
  it('sin pesos todos pesan igual', () => {
    const [f] = checkPalette(
      [
        { hex: '#8a1c2b' },
        { hex: '#0000ff' },
        { hex: '#00ff00' },
        { hex: '#ffff00' },
        { hex: '#00ffff' },
        { hex: '#ff00ff' },
      ],
      brandColors,
      'graphic',
    );
    expect(f).toMatchObject({ measured: 0.17 });
  });
  it('omite si el perfil no tiene colores o no hay paleta', () => {
    expect(checkPalette([{ hex: '#fff' }], [], 'graphic')[0]).toMatchObject({
      code: 'PROFILE_DATA_MISSING',
      omitted: true,
    });
    expect(checkPalette([], brandColors, 'graphic')[0]).toMatchObject({ omitted: true });
  });
});

describe('emojis', () => {
  it('sin política: omite', () => {
    expect(checkEmojis({ caption: '😀' }, undefined)[0]).toMatchObject({ code: 'PROFILE_DATA_MISSING', omitted: true });
    expect(checkEmojis({ caption: '😀' }, {})[0]!.omitted).toBe(true);
  });
  it('marca sin emojis', () => {
    expect(codes(checkEmojis({ caption: 'Hola 😀' }, { allowed: false }))).toEqual(['EMOJIS_NOT_ALLOWED']);
    expect(checkEmojis({ caption: 'Hola' }, { allowed: false })).toEqual([]);
  });
  it('máximo de emojis', () => {
    const [f] = checkEmojis({ caption: '😀😀😀' }, { max: 2 });
    expect(f).toMatchObject({ code: 'EMOJIS_EXCEEDED', measured: 3, threshold: 2 });
    expect(checkEmojis({ caption: '😀😀' }, { max: 2 })).toEqual([]);
  });
});

describe('legibilidad Fernández-Huerta', () => {
  it('cuenta sílabas en español', () => {
    const cases: [string, number][] = [
      ['casa', 2],
      ['queso', 2],
      ['guerra', 2],
      ['pingüino', 3],
      ['agua', 2],
      ['aire', 2],
      ['leer', 2],
      ['país', 2],
      ['día', 2],
      ['camión', 2],
      ['murciélago', 4],
      ['hoy', 1],
      ['buey', 1],
      ['y', 1],
      ['chuletón', 3],
      ['restaurante', 4],
    ];
    for (const [word, n] of cases) expect([word, countSyllables(word)]).toEqual([word, n]);
  });
  it('aplica la fórmula 206,84 − 0,60·P − 1,02·F', () => {
    // 4 palabras, 8 sílabas, 1 frase: P = 200, F = 4 → 206,84 − 120 − 4,08 = 82,76
    const s = fernandezHuerta('Mesa casa piso toro.')!;
    expect(s).toMatchObject({ words: 4, syllables: 8, sentences: 1 });
    expect(s.score).toBeCloseTo(82.8, 1);
  });
  it('ignora enlaces, hashtags, menciones y emojis', () => {
    expect(fernandezHuerta('Mesa casa 😀 #menu @casa https://x.es')!.words).toBe(2);
  });
  it('texto sin palabras: null; acota a 0-100', () => {
    expect(fernandezHuerta('😀 123')).toBeNull();
    expect(fernandezHuerta('Sí.')!.score).toBeLessThanOrEqual(100);
  });
  it('bandas orientativas', () => {
    expect(readabilityBand(20)).toBe('muy difícil');
    expect(readabilityBand(65)).toBe('normal');
    expect(readabilityBand(95)).toBe('muy fácil');
  });
  it('texto corto: informa que no se mide; texto largo: puntuación informativa', () => {
    expect(checkReadability({ caption: 'Hola mundo' })[0]).toMatchObject({
      code: 'READABILITY_TOO_SHORT',
      omitted: true,
    });
    const long = 'Esta semana abrimos la terraza para comer con calma. '.repeat(4);
    const [f] = checkReadability({ caption: long });
    expect(f).toMatchObject({ code: 'READABILITY_SCORE', severity: 'info' });
    expect(typeof f!.measured).toBe('number');
  });
});
