import { brandRulesFromProfile } from './profile';
import { verifyPiece } from './verify';
import type { BrandCheckInput } from './types';

const limits = { label: 'Instagram', maxCaptionLength: 2200, maxHashtags: 30, maxMentions: 20 };

const base = (over: Partial<BrandCheckInput> = {}): BrandCheckInput => ({
  text: { caption: 'Menú del día de hoy' },
  limits,
  brand: {
    forbiddenPhrases: ['barato'],
    brandColors: [{ hex: '#8a1c2b' }],
    requiredHashtags: ['menu'],
    callsToAction: ['reserva'],
    emojiPolicy: { max: 3 },
  },
  ...over,
});

describe('verifyPiece', () => {
  it('apto cuando no hay avisos ni bloqueos (los informativos no cuentan)', () => {
    const r = verifyPiece(base({ text: { caption: 'Reserva ya #menu' } }));
    expect(r.verdict).toBe('pass');
    expect(r.counts.block + r.counts.warn).toBe(0);
  });
  it('apto con avisos: falta la llamada a la acción', () => {
    const r = verifyPiece(base({ text: { caption: 'Hola #menu' } }));
    expect(r.verdict).toBe('pass_with_warnings');
    expect(r.findings[0]!.code).toBe('CALL_TO_ACTION_MISSING');
  });
  it('no apto: palabra vetada; los bloqueos van primero, luego avisos, luego informativos', () => {
    const r = verifyPiece(base({ text: { caption: 'Muy barato' }, hasImage: true }));
    expect(r.verdict).toBe('fail');
    const rank = { block: 0, warn: 1, info: 2 } as const;
    const ranks = r.findings.map((f) => rank[f.severity]);
    expect([...ranks].sort()).toEqual(ranks);
    expect(r.findings[0]!.severity).toBe('block');
    expect(r.counts).toEqual({
      block: r.findings.filter((f) => f.severity === 'block').length,
      warn: r.findings.filter((f) => f.severity === 'warn').length,
      info: r.findings.filter((f) => f.severity === 'info').length,
    });
  });
  it('resumen por comprobación: pasada, fallida u omitida', () => {
    const r = verifyPiece(base({ text: { caption: 'Muy barato' }, brand: { forbiddenPhrases: ['barato'] } }));
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(status['forbidden-phrases']).toBe('failed');
    expect(status['length']).toBe('passed');
    expect(status['brand-hashtags']).toBe('skipped');
    expect(status['emojis']).toBe('skipped');
    expect(r.checks).toHaveLength(13);
  });
  it('no inventa reglas: con un perfil vacío solo hay informativos omitidos', () => {
    const r = verifyPiece({ text: { caption: 'Hola' }, limits: {}, brand: {} });
    expect(r.verdict).toBe('pass');
    expect(r.findings.every((f) => f.severity === 'info')).toBe(true);
    expect(r.findings.some((f) => f.code === 'PROFILE_DATA_MISSING')).toBe(true);
  });
  it('junta hallazgos de varias comprobaciones', () => {
    const r = verifyPiece(
      base({
        text: { caption: 'x'.repeat(2300) },
        limits: { ...limits, maxHashtags: 1 },
        textLayers: [{ id: 't', color: '#ccc', background: '#fff' }],
        hasImage: true,
      }),
    );
    const codes = r.findings.map((f) => f.code);
    expect(codes).toEqual(
      expect.arrayContaining(['LENGTH_EXCEEDED', 'CONTRAST_TOO_LOW', 'ALT_TEXT_MISSING', 'BRAND_HASHTAG_MISSING']),
    );
    expect(r.verdict).toBe('fail');
  });
  it('el resultado es serializable (JSON) y no modifica la entrada', () => {
    const input = base({ text: { caption: 'Reserva #menu', hashtags: ['x'] } });
    const copy = JSON.parse(JSON.stringify(input));
    const r = verifyPiece(input);
    expect(input).toEqual(copy);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe('brandRulesFromProfile', () => {
  it('toma palabras vetadas y colores del perfil y admite el resto como extra', () => {
    const rules = brandRulesFromProfile(
      {
        voice: { forbiddenPhrases: ['gratis'] },
        visual: { colors: [{ name: 'Granate', hex: '#8a1c2b' }] },
      },
      { requiredHashtags: ['a'] },
    );
    expect(rules).toEqual({
      forbiddenPhrases: ['gratis'],
      brandColors: [{ name: 'Granate', hex: '#8a1c2b' }],
      requiredHashtags: ['a'],
      recommendedHashtags: [],
      callsToAction: [],
    });
  });
  it('lee hashtags, llamadas a la acción y política de emojis del perfil', () => {
    const rules = brandRulesFromProfile({
      voice: {
        hashtags: { required: ['Marca'], recommended: ['Tapas'] },
        callsToAction: ['Reserva'],
        emojis: { allowed: true, max: 2 },
      },
    });
    expect(rules).toMatchObject({
      requiredHashtags: ['Marca'],
      recommendedHashtags: ['Tapas'],
      callsToAction: ['Reserva'],
      emojiPolicy: { allowed: true, max: 2 },
    });
  });
  it('política de emojis sin definir (null): no hay regla', () => {
    expect(brandRulesFromProfile({ voice: { emojis: { allowed: null, max: null } } }).emojiPolicy).toBeUndefined();
    expect(brandRulesFromProfile({ voice: { emojis: { allowed: null, max: 3 } } }).emojiPolicy).toEqual({ max: 3 });
  });
  it('perfil nulo: reglas vacías', () => {
    expect(brandRulesFromProfile(null)).toEqual({
      forbiddenPhrases: [],
      brandColors: [],
      requiredHashtags: [],
      recommendedHashtags: [],
      callsToAction: [],
    });
  });
});
