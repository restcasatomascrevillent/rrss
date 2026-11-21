import { describe, expect, it } from 'vitest';
import type { ReelPiece } from './plan';
import { estimateReelSize } from './size';
import { REEL_TEMPLATES, type ReelTemplateSummary } from './templates';

const MB = 1024 * 1024;
const template = (id: string) => REEL_TEMPLATES.find((t) => t.id === id)!;
let k = 0;
const piece = (
  type: 'photo' | 'video',
  seconds: number | null = null,
  clipSeconds: number | null = null,
): ReelPiece => ({
  key: `p${++k}`,
  assetId: `a${k}`,
  path: `org/marca/media/${k}`,
  fileName: `${k}`,
  type,
  seconds,
  clipSeconds,
});

describe('peso estimado del reel', () => {
  it('sin piezas no pesa nada', () => {
    expect(estimateReelSize(template('fundido-suave'), [])).toMatchObject({ low: 0, high: 0, verdict: 'fits' });
  });

  it('un reel corto de fotos cabe de sobra; la horquilla está ordenada', () => {
    const size = estimateReelSize(template('corte-ritmico'), [piece('photo'), piece('photo'), piece('photo')]);
    expect(size.low).toBeGreaterThan(0);
    expect(size.high).toBeGreaterThan(size.low);
    expect(size.high).toBeLessThan(5 * MB);
    expect(size.verdict).toBe('fits');
  });

  it('45 s de clips en 1080×1920 puede pasar de 50 MB: se avisa antes de montar', () => {
    const clips = Array.from({ length: 9 }, () => piece('video', 5, 10));
    const size = estimateReelSize(template('pase-lateral'), clips);
    expect(size.limit).toBe(50 * MB);
    expect(size.high).toBeGreaterThan(50 * MB);
    expect(size.low).toBeLessThan(50 * MB);
    expect(size.verdict).toBe('maybe');
  });

  it('los clips pesan más que las fotos a igual duración', () => {
    const t = template('corte-ritmico');
    const fotos = estimateReelSize(t, [piece('photo', 3), piece('photo', 3)]);
    const clips = estimateReelSize(t, [piece('video', 3, 10), piece('video', 3, 10)]);
    expect(clips.high).toBeGreaterThan(fotos.high);
  });

  it('depende de la configuración de la plantilla: resolución, CRF, preajuste y audio', () => {
    const base = template('corte-ritmico');
    const clips = [piece('video', 3, 10), piece('video', 3, 10)];
    const withExport = (
      patch: Partial<ReelTemplateSummary['export']>,
      canvas: Partial<ReelTemplateSummary['canvas']> = {},
    ) =>
      estimateReelSize({ ...base, canvas: { ...base.canvas, ...canvas }, export: { ...base.export, ...patch } }, clips)
        .high;
    const reference = withExport({});
    expect(withExport({ crf: base.export.crf - 6 })).toBeGreaterThan(reference * 1.8);
    expect(withExport({ preset: 'ultrafast' })).toBeGreaterThan(reference);
    expect(withExport({}, { width: 540, height: 960 })).toBeLessThan(reference / 3);
    expect(withExport({ audioBitrateKbps: 256 })).toBeGreaterThan(reference);
  });

  it('si pasa incluso en el caso favorable, el veredicto es «exceeds»', () => {
    const size = estimateReelSize(template('pase-lateral'), [piece('video', 5, 10)], 1 * MB);
    expect(size.verdict).toBe('exceeds');
  });
});
