import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { parseProfile } from '@/features/brand/profile';
import { lastPeriods, periodStartOf, summarizeLedger, toAiError } from './api';
import { formatMicros, moneyEstimateNote, moneyUnitLabel, parseUnitsToMicros, resolveMoneyDisplay } from './money';
import { captionLimits, DOCUMENT_CAPTION_MAX, variantFits, variantLength, variantToPostCopy } from './networkLimits';
import { applyProposal, compareProfiles, defaultSelection } from './profileProposal';

const neutral = resolveMoneyDisplay(undefined);
const euro = resolveMoneyDisplay('eur');

describe('importes de IA', () => {
  it('sin moneda configurada usa una unidad neutra y no pinta símbolos', () => {
    expect(neutral.currency).toBeNull();
    const text = formatMicros(12_500_000, neutral);
    expect(text).toBe('12,50 créditos');
    expect(text).not.toMatch(/[€$]/);
    expect(formatMicros(1_000_000, neutral)).toBe('1,00 crédito');
    expect(moneyUnitLabel(neutral)).toBe('créditos');
    expect(moneyEstimateNote(neutral)).toMatch(/aún no tiene una moneda fijada/);
  });

  it('los importes diminutos no se redondean a cero', () => {
    expect(formatMicros(12, neutral)).toBe('< 0,0001 créditos');
    expect(formatMicros(0, neutral)).toBe('0,00 créditos');
    expect(formatMicros(1234, neutral)).toBe('0,0012 créditos');
  });

  it('con una moneda ISO válida la usa; con un valor raro, la ignora', () => {
    expect(euro.currency).toBe('EUR');
    expect(formatMicros(12_500_000, euro)).toMatch(/12,50\s€/);
    expect(moneyEstimateNote(euro)).toMatch(/EUR/);
    expect(resolveMoneyDisplay('euros').currency).toBeNull();
    expect(resolveMoneyDisplay('').currency).toBeNull();
  });

  it('convierte lo que escribe una persona en micros', () => {
    expect(parseUnitsToMicros('50')).toBe(50_000_000);
    expect(parseUnitsToMicros('12,5')).toBe(12_500_000);
    expect(parseUnitsToMicros('1.000,25')).toBe(1_000_250_000);
    expect(parseUnitsToMicros('1.000')).toBe(1_000_000_000);
    expect(parseUnitsToMicros('0,000001')).toBe(1);
    expect(parseUnitsToMicros('0')).toBe(0);
    expect(parseUnitsToMicros('-3')).toBeNull();
    expect(parseUnitsToMicros('1,0000001')).toBeNull();
    expect(parseUnitsToMicros('abc')).toBeNull();
    expect(parseUnitsToMicros('  ')).toBeNull();
  });
});

describe('errores de ai-generate', () => {
  const http = (status: number, body: unknown) =>
    new FunctionsHttpError(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );

  it('traduce cada código a un mensaje propio en español', async () => {
    const exhausted = await toAiError(
      http(402, { error: { code: 'quota_exhausted', message: 'x', retryable: false } }),
    );
    expect(exhausted.code).toBe('quota_exhausted');
    expect(exhausted.message).toMatch(/cupo de IA de este mes está agotado/);
    expect((await toAiError(http(402, { error: { code: 'quota_missing' } }))).message).toMatch(/no tiene cupo/);
    expect((await toAiError(http(503, { error: { code: 'not_configured' } }))).message).toMatch(/falta configurarla/);
    expect((await toAiError(http(422, { error: { code: 'refused' } }))).message).toMatch(/se ha negado/);
    const agency = await toAiError(http(409, { error: { code: 'agency_mode', message: 'del servidor' } }));
    expect(agency.code).toBe('agency_mode');
    expect(agency.message).toMatch(/redacta por encargo a la agencia.*Encargos/);
    expect((await toAiError(http(504, { error: { code: 'provider_timeout' } }))).message).toMatch(/tardado demasiado/);
    const failed = await toAiError(
      http(502, { error: { code: 'provider_failed', retryable: true, generationId: 'g-1' } }),
    );
    expect(failed.retryable).toBe(true);
    expect(failed.generationId).toBe('g-1');
    expect(failed.message).toMatch(/no se ha descontado nada/);
  });

  it('en una petición inválida usa el mensaje del servidor, que dice qué falta', async () => {
    const error = await toAiError(
      http(400, { error: { code: 'invalid_request', message: 'El número de variantes debe estar entre 1 y 5.' } }),
    );
    expect(error.message).toBe('El número de variantes debe estar entre 1 y 5.');
  });

  it('códigos desconocidos, cuerpos ilegibles y fallos de red', async () => {
    expect((await toAiError(http(500, { error: { code: 'otro' } }))).code).toBe('internal');
    expect((await toAiError(new FunctionsHttpError(new Response('<html>', { status: 401 })))).code).toBe(
      'unauthenticated',
    );
    expect((await toAiError(new FunctionsFetchError(new TypeError('Failed to fetch')))).code).toBe('network');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect((await toAiError(new FunctionsFetchError(abort))).code).toBe('client_timeout');
    expect((await toAiError(new Error('raro'))).code).toBe('internal');
  });
});

describe('libro de consumo', () => {
  it('suma consumido, reservado en curso y coste por marca', () => {
    const ledger = summarizeLedger('2026-11-01', [
      { brand_id: 'a', entry: 'reserve', reserved_delta_micros: 500, cost_delta_micros: 0 },
      { brand_id: 'a', entry: 'settle', reserved_delta_micros: -500, cost_delta_micros: 120 },
      { brand_id: 'b', entry: 'reserve', reserved_delta_micros: 800, cost_delta_micros: 0 },
      { brand_id: 'b', entry: 'reserve', reserved_delta_micros: 300, cost_delta_micros: 0 },
      { brand_id: 'b', entry: 'release', reserved_delta_micros: -300, cost_delta_micros: 0 },
      { brand_id: null, entry: 'reserve', reserved_delta_micros: 100, cost_delta_micros: 0 },
      { brand_id: null, entry: 'settle', reserved_delta_micros: -100, cost_delta_micros: 400 },
    ]);
    expect(ledger.consumedMicros).toBe(520);
    expect(ledger.reservedMicros).toBe(800);
    expect(ledger.generations).toBe(2);
    expect(ledger.byBrand).toEqual([
      { brandId: null, generations: 1, costMicros: 400 },
      { brandId: 'a', generations: 1, costMicros: 120 },
    ]);
  });

  it('periodos en UTC', () => {
    expect(periodStartOf(new Date('2026-11-30T23:30:00Z'))).toBe('2026-11-01');
    expect(lastPeriods(new Date('2026-02-10T00:00:00Z'), 3)).toEqual(['2026-02-01', '2026-01-01', '2025-12-01']);
  });
});

describe('límites de la red para la IA', () => {
  it('salen del catálogo de formatos', () => {
    const ig = captionLimits('instagram', 'post');
    expect(ig.request).toMatchObject({ id: 'instagram', name: 'Instagram', maxChars: 2200, maxHashtags: 30 });
    expect(ig.maxChars).toBe(2200);
    expect(ig.unit).toBe('utf16');
    expect(captionLimits('tiktok', 'video').unit).toBe('utf16');
  });

  it('sin límite conocido lo dice y usa el techo del documento', () => {
    const fb = captionLimits('facebook', 'page_post');
    expect(fb.maxChars).toBeNull();
    expect(fb.request.maxChars).toBe(DOCUMENT_CAPTION_MAX);
    expect(variantFits({ text: 'hola', hashtags: [] }, fb)).toBeNull();
  });

  it('mide la variante como el verificador y la convierte en PostCopy', () => {
    const ig = captionLimits('instagram', 'post');
    const variant = { text: 'Hola', hashtags: ['#otoño', '#menú-del-día'] };
    expect(variantLength(variant, ig)).toBe('Hola\n\n#otoño #menúdeldía'.length);
    expect(variantFits({ text: 'x'.repeat(2201), hashtags: [] }, ig)).toBe(false);
    const copy = variantToPostCopy(variant, {
      caption: 'viejo',
      hashtags: ['viejo'],
      mentions: ['casa'],
      altText: 'Foto',
      callToAction: { label: '', url: '' },
    });
    expect(copy).toEqual({
      caption: 'Hola',
      hashtags: ['otoño', 'menúdeldía'],
      mentions: ['casa'],
      altText: 'Foto',
      callToAction: { label: '', url: '' },
    });
  });
});

describe('propuesta de perfil', () => {
  const current = parseProfile({
    business: { description: 'Restaurante de cocina de mercado' },
    voice: { tone: ['cercano'] },
    visual: { fonts: [{ family: 'Lora', usage: 'títulos', license: 'OFL' }], logoAssetIds: [] },
  });
  const proposal = {
    business: {
      description: 'Casa de comidas de cocina de mercado',
      products: [{ name: '', description: 'x' }],
      locations: [],
      valueProps: [],
    },
    audience: { segments: [{ name: 'Familias', description: '' }] },
    goals: [],
    voice: {
      tone: ['cercano'],
      personality: '',
      values: [],
      keyMessages: [],
      allowedPhrases: [],
      forbiddenPhrases: [],
    },
    visual: {
      colors: [
        { name: 'Teja', hex: '#B5532D', role: 'principal' },
        { name: 'Mal', hex: 'rojo', role: '' },
      ],
      fonts: [{ family: 'lora', usage: 'títulos y cartas' }],
      styleNotes: '',
    },
    channels: [],
    languages: { primary: 'es', others: [] },
    restrictions: { legal: [], advertising: [] },
  };

  it('compara campo a campo y marca solo lo que rellena huecos', () => {
    const comparisons = compareProfiles(current, proposal);
    const status = Object.fromEntries(comparisons.map((c) => [c.field.id, c.status]));
    expect(status['business.description']).toBe('changed');
    expect(status['business.products']).toBe('empty');
    expect(status['voice.tone']).toBe('same');
    expect(status['audience.segments']).toBe('changed');
    expect(status['visual.colors']).toBe('changed');
    expect(status['goals']).toBe('empty');
    expect([...defaultSelection(comparisons)].sort()).toEqual(['audience.segments', 'visual.colors']);
  });

  it('aplica solo lo aceptado y conserva licencias y logotipos', () => {
    const comparisons = compareProfiles(current, proposal);
    const result = applyProposal(current, comparisons, new Set(['visual.colors', 'visual.fonts', 'voice.tone']));
    expect(result.business.description).toBe('Restaurante de cocina de mercado');
    expect(result.visual.colors).toEqual([{ name: 'Teja', hex: '#B5532D', role: 'principal' }]);
    expect(result.visual.fonts).toEqual([{ family: 'lora', usage: 'títulos y cartas', license: 'OFL' }]);
    expect(result.audience.segments).toEqual([]);
  });

  it('un valor que no encaja en el perfil se ignora', () => {
    const comparisons = compareProfiles(current, { ...proposal, goals: 'no es una lista' });
    expect(comparisons.find((c) => c.field.id === 'goals')?.status).toBe('invalid');
  });
});
