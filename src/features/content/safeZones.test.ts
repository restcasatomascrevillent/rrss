import { describe, expect, it } from 'vitest';
import { buildBrandCheckInput, checkSafeZone, verifyPiece } from '@/features/brandcheck';
import { contentDocumentSchema, DOCUMENT_SCHEMA_VERSION, type ContentDocument } from './document';
import { FORMAT_SPECS, getFormatSpec } from './networks';
import { safeZoneFor, shareOutside } from './safeZones';

const STORY = { aspectRatio: '9:16', width: 1080, height: 1920 };

function storyWithText(y: number, height = 150): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    canvas: { ...STORY, backgroundColor: '#FFFFFF' },
    pages: [{ id: 'p1', name: '', layers: [
      {
        id: 't',
        type: 'text',
        x: 140,
        y,
        width: 800,
        height,
        text: 'Hoy, menú de otoño',
        fontFamily: 'sans-serif',
        fontSize: 80,
        color: '#111111',
      },
    ] }],
  });
}

describe('zonas seguras del catálogo', () => {
  it('solo los formatos verticales las tienen, y ninguna es oficial', () => {
    const withZone = FORMAT_SPECS.filter((spec) => spec.safeZone).map((spec) => `${spec.network}/${spec.format}`);
    expect(withZone).toEqual(['instagram/reel', 'instagram/story', 'facebook/reel', 'tiktok/video', 'youtube/short']);
    for (const spec of FORMAT_SPECS.filter((s) => s.safeZone)) {
      expect(spec.safeZone!.provenance).toBe('unverified');
      expect(spec.safeZone!.source).toMatch(/^https:\/\//);
      expect(spec.safeZone!.note).toMatch(/orientativa/);
    }
  });

  it('una historia 9:16 deja libres el 14 % de arriba, el 35 % de abajo y el 6 % por lado', () => {
    const zone = safeZoneFor(getFormatSpec('instagram', 'story'), STORY)!;
    expect(zone.safe.left).toBeCloseTo(64.8);
    expect(zone.safe.right).toBeCloseTo(1015.2);
    expect(zone.safe.top).toBeCloseTo(268.8);
    expect(zone.safe.bottom).toBeCloseTo(1248);
    expect(zone.unsafe).toHaveLength(4);
    expect(zone.provenance).toBe('unverified');
  });

  it('no hay zona si el formato no la tiene o el lienzo no es de su proporción', () => {
    expect(
      safeZoneFor(getFormatSpec('instagram', 'post'), { aspectRatio: '1:1', width: 1080, height: 1080 }),
    ).toBeNull();
    expect(
      safeZoneFor(getFormatSpec('instagram', 'story'), { aspectRatio: '4:5', width: 1080, height: 1350 }),
    ).toBeNull();
    expect(safeZoneFor(undefined, STORY)).toBeNull();
  });

  it('shareOutside mide qué parte de una caja queda fuera', () => {
    const safe = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(shareOutside({ left: 10, top: 10, right: 50, bottom: 50 }, safe)).toBe(0);
    expect(shareOutside({ left: 50, top: 0, right: 150, bottom: 100 }, safe)).toBeCloseTo(0.5);
    expect(shareOutside({ left: 200, top: 200, right: 300, bottom: 300 }, safe)).toBe(1);
  });
});

describe('verificador: texto en zona insegura', () => {
  const story = getFormatSpec('instagram', 'story');

  it('avisa (sin bloquear) si un texto cae donde la interfaz lo puede tapar, y dice que es orientativo', () => {
    const result = verifyPiece(buildBrandCheckInput(storyWithText(1700), story, null));
    const finding = result.findings.find((f) => f.code === 'TEXT_IN_UNSAFE_ZONE');
    expect(finding).toMatchObject({
      check: 'safe-zone',
      severity: 'warn',
      measured: '100 %',
      target: { part: 'textLayer', layerId: 't' },
    });
    expect(finding!.message).toMatch(/Instagram/);
    expect(finding!.message).toMatch(/orientativa/);
    expect(result.checks.find((c) => c.id === 'safe-zone')?.status).toBe('failed');
  });

  it('un texto dentro de la zona segura pasa; en un formato sin zona no se comprueba', () => {
    const inside = verifyPiece(buildBrandCheckInput(storyWithText(600), story, null));
    expect(inside.findings.some((f) => f.code === 'TEXT_IN_UNSAFE_ZONE')).toBe(false);
    expect(inside.checks.find((c) => c.id === 'safe-zone')?.status).toBe('passed');
    const post = buildBrandCheckInput(storyWithText(1700), getFormatSpec('instagram', 'post'), null);
    expect(post.safeArea).toBeUndefined();
  });

  it('mide la parte de la caja que queda fuera', () => {
    const safe = { left: 0, top: 0, right: 1000, bottom: 1000, provenance: 'official' as const };
    const findings = checkSafeZone(
      [{ id: 'a', color: '#000000', bounds: { left: 0, top: 900, right: 100, bottom: 1100 } }],
      safe,
      'TikTok',
    );
    expect(findings[0]?.measured).toBe('50 %');
    expect(findings[0]?.message).not.toMatch(/orientativa/);
    expect(checkSafeZone([{ id: 'b', color: '#000000' }], safe)).toEqual([]);
  });
});
