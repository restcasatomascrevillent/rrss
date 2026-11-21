import { describe, expect, it } from 'vitest';
import { hasPublishingRules, profileCompleteness } from './completeness';
import {
  brandProfileSchema,
  emptyProfile,
  nextProvenance,
  normalizeHashtags,
  normalizeProfile,
  parseProfile,
  parseProvenance,
} from './profile';

describe('esquema del perfil de marca', () => {
  it('un objeto vacío produce un perfil completo con valores por defecto', () => {
    const profile = emptyProfile();
    expect(profile.business).toEqual({ description: '', products: [], locations: [], valueProps: [] });
    expect(profile.languages.primary).toBe('es');
    expect(profile.visual.logoAssetIds).toEqual([]);
    expect(brandProfileSchema.parse(profile)).toEqual(profile);
  });

  it('recorta espacios y descarta textos vacíos de las listas', () => {
    const profile = brandProfileSchema.parse({ goals: ['  Más reservas ', '', '   '], voice: { tone: [' cercano '] } });
    expect(profile.goals).toEqual(['Más reservas']);
    expect(profile.voice.tone).toEqual(['cercano']);
  });

  it('rechaza colores que no son #RRGGBB', () => {
    expect(brandProfileSchema.safeParse({ visual: { colors: [{ name: 'x', hex: 'rojo', role: '' }] } }).success).toBe(
      false,
    );
    expect(
      brandProfileSchema.safeParse({ visual: { colors: [{ name: 'x', hex: '#A1b2C3', role: '' }] } }).success,
    ).toBe(true);
  });

  it('parseProfile recupera las secciones válidas aunque otra esté corrupta', () => {
    const profile = parseProfile({
      goals: ['Vender más'],
      visual: { colors: 'no-es-una-lista' },
      business: { description: 'Hola' },
    });
    expect(profile.goals).toEqual(['Vender más']);
    expect(profile.business.description).toBe('Hola');
    expect(profile.visual.colors).toEqual([]);
  });

  it('parseProfile tolera null y basura', () => {
    expect(parseProfile(null)).toEqual(emptyProfile());
    expect(parseProfile('texto')).toEqual(emptyProfile());
    expect(parseProfile(42)).toEqual(emptyProfile());
  });

  it('normalizeProfile quita las filas a medias antes de guardar', () => {
    const draft = emptyProfile();
    draft.business.products = [
      { name: '', description: 'sin nombre' },
      { name: 'Menú', description: '' },
    ];
    draft.visual.colors = [
      { name: 'Malo', hex: '#12', role: '' },
      { name: 'Bueno', hex: '#112233', role: '' },
    ];
    draft.visual.fonts = [{ family: ' ', usage: '', license: '' }];
    draft.channels = [{ platform: '', handle: '@x', url: '' }];
    const clean = normalizeProfile(draft);
    expect(clean.business.products).toEqual([{ name: 'Menú', description: '' }]);
    expect(clean.visual.colors.map((c) => c.name)).toEqual(['Bueno']);
    expect(clean.visual.fonts).toEqual([]);
    expect(clean.channels).toEqual([]);
  });
});

describe('procedencia', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('en el alta marca solo las secciones con contenido', () => {
    const profile = brandProfileSchema.parse({ goals: ['A'], voice: { tone: ['cercano'] } });
    const provenance = nextProvenance({}, null, profile, 'import', now);
    expect(Object.keys(provenance).sort()).toEqual(['goals', 'languages', 'voice']);
    expect(provenance.goals).toEqual({ source: 'import', verified: true, at: now });
  });

  it('conserva la procedencia de lo que no cambia y actualiza lo que cambia', () => {
    const before = brandProfileSchema.parse({ goals: ['A'], voice: { tone: ['cercano'] } });
    const previous = nextProvenance({}, null, before, 'import', '2025-01-01T00:00:00.000Z');
    const after = { ...before, goals: ['A', 'B'] };
    const provenance = nextProvenance(previous, before, after, 'user', now);
    expect(provenance.goals).toEqual({ source: 'user', verified: true, at: now });
    expect(provenance.voice?.source).toBe('import');
  });

  it('lo que propone la IA nace sin verificar', () => {
    const profile = brandProfileSchema.parse({ goals: ['A'] });
    expect(nextProvenance({}, null, profile, 'ai', now).goals?.verified).toBe(false);
  });

  it('parseProvenance descarta datos con forma incorrecta', () => {
    expect(parseProvenance({ goals: { source: 'marciano', verified: true, at: now } })).toEqual({});
    expect(parseProvenance(null)).toEqual({});
  });
});

describe('reglas de publicación del perfil', () => {
  it('un perfil guardado antes de existir estos campos se lee con valores por defecto', () => {
    const old = parseProfile({ voice: { tone: ['cercano'], forbiddenPhrases: ['gratis'] }, goals: ['A'] });
    expect(old.voice.hashtags).toEqual({ required: [], recommended: [] });
    expect(old.voice.callsToAction).toEqual([]);
    expect(old.voice.emojis).toEqual({ allowed: null, max: null });
    expect(old.voice.forbiddenPhrases).toEqual(['gratis']);
  });
  it('limpia los hashtags: sin almohadilla ni espacios, sin repetidos ni símbolos', () => {
    const p = brandProfileSchema.parse({
      voice: { hashtags: { required: ['#Mi Marca', 'mimarca', '##Tapas', 'no-vale', '', 'Ñandú_1'] } },
    });
    expect(p.voice.hashtags.required).toEqual(['MiMarca', 'Tapas', 'Ñandú_1']);
    expect(normalizeHashtags(['#a', 'A', 'b'])).toEqual(['a', 'b']);
  });
  it('rechaza un máximo de emojis fuera de rango; la recuperación conserva el resto', () => {
    expect(brandProfileSchema.safeParse({ voice: { emojis: { max: -1 } } }).success).toBe(false);
    expect(brandProfileSchema.safeParse({ voice: { emojis: { max: 1.5 } } }).success).toBe(false);
    const recovered = parseProfile({ goals: ['A'], voice: { emojis: { max: 9999 } } });
    expect(recovered.goals).toEqual(['A']);
    expect(recovered.voice.emojis).toEqual({ allowed: null, max: null });
  });
  it('un perfil sin reglas no las tiene y la política de emojis vacía no cuenta como contenido', () => {
    expect(hasPublishingRules(emptyProfile())).toBe(false);
    expect(Object.keys(nextProvenance({}, null, emptyProfile(), 'user'))).toEqual(['languages']);
  });
  it('cuentan para la completitud cuando se define alguna', () => {
    const keys = (p: object) => profileCompleteness(brandProfileSchema.parse(p)).missing.map((m) => m.key);
    expect(keys({})).toContain('publishingRules');
    expect(keys({ voice: { emojis: { allowed: false } } })).not.toContain('publishingRules');
    expect(keys({ voice: { hashtags: { recommended: ['x'] } } })).not.toContain('publishingRules');
    expect(keys({ voice: { callsToAction: ['Reserva'] } })).not.toContain('publishingRules');
  });
});

describe('completitud', () => {
  it('un perfil vacío está al 0 % y lista todo lo que falta', () => {
    const result = profileCompleteness(emptyProfile());
    expect(result.percent).toBe(0);
    expect(result.missing).toHaveLength(result.checks.length);
  });

  it('sube al completar secciones y llega al 100 %', () => {
    const partial = brandProfileSchema.parse({ goals: ['A'], voice: { tone: ['cercano'] } });
    const some = profileCompleteness(partial);
    expect(some.percent).toBeGreaterThan(0);
    expect(some.missing.map((m) => m.key)).not.toContain('goals');

    const full = brandProfileSchema.parse({
      business: { description: 'Una descripción suficientemente larga.', products: [{ name: 'P' }], valueProps: ['V'] },
      audience: { segments: [{ name: 'Familias' }] },
      goals: ['A'],
      voice: { tone: ['cercano'], keyMessages: ['M'], callsToAction: ['Reserva'] },
      visual: {
        colors: [{ hex: '#112233' }],
        fonts: [{ family: 'Inter' }],
        logoAssetIds: ['3f2b6c1e-8a4d-4c7b-9e2f-1a2b3c4d5e6f'],
      },
      channels: [{ platform: 'Instagram' }],
    });
    expect(profileCompleteness(full)).toMatchObject({ percent: 100, missing: [] });
  });

  it('una descripción demasiado corta no cuenta', () => {
    const profile = brandProfileSchema.parse({ business: { description: 'Bar' } });
    expect(profileCompleteness(profile).missing.map((m) => m.key)).toContain('description');
  });
});
