import {
  blendOver,
  contrastRatio,
  deltaE2000,
  deltaEHex,
  isLargeText,
  parseHex,
  relativeLuminance,
  rgbToLab,
} from './color';

describe('parseHex', () => {
  it('lee #RGB, #RRGGBB y #RRGGBBAA', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#336699')).toEqual({ r: 51, g: 102, b: 153, a: 1 });
    expect(parseHex('#00000080')?.a).toBeCloseTo(0.502, 2);
  });
  it('rechaza lo que no es un color', () => {
    expect(parseHex('rojo')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
  });
});

describe('contraste WCAG', () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  it('luminancia de blanco y negro', () => {
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(black)).toBe(0);
  });
  it('blanco sobre negro es 21:1 y es simétrico', () => {
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
  });
  it('mismo color es 1:1', () => {
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });
  it('gris #767676 sobre blanco es ≈4,54:1 (límite clásico de AA)', () => {
    const g = parseHex('#767676')!;
    expect(contrastRatio(g, white)).toBeCloseTo(4.54, 2);
  });
  it('mezcla el alfa con el fondo', () => {
    const mixed = blendOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(mixed).toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });
  it('texto grande: ≥18 pt, o ≥14 pt en negrita', () => {
    expect(isLargeText(18, false)).toBe(true);
    expect(isLargeText(14, true)).toBe(true);
    expect(isLargeText(14, false)).toBe(false);
    expect(isLargeText(undefined, true)).toBe(false);
  });
});

describe('CIEDE2000', () => {
  // Pares de referencia de Sharma, Wu y Dalal (2005), tabla de datos de prueba.
  const cases: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  it.each(cases)('par %j / %j = %f', (p, q, expected) => {
    const d = deltaE2000({ L: p[0]!, a: p[1]!, b: p[2]! }, { L: q[0]!, a: q[1]!, b: q[2]! });
    expect(d).toBeCloseTo(expected, 3);
  });
  it('colores idénticos: 0', () => {
    expect(deltaEHex('#8a1c2b', '#8A1C2B')).toBeCloseTo(0, 6);
  });
  it('blanco frente a negro es ≈100', () => {
    expect(deltaEHex('#ffffff', '#000000')).toBeCloseTo(100, 0);
  });
  it('rgbToLab: blanco = L 100', () => {
    expect(rgbToLab({ r: 255, g: 255, b: 255 }).L).toBeCloseTo(100, 2);
  });
  it('hex inválido: null', () => {
    expect(deltaEHex('xx', '#000')).toBeNull();
  });
});
