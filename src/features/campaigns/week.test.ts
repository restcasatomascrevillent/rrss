import { describe, expect, it } from 'vitest';
import { campaignDays, dayParts, longDayLabel } from './week';

describe('días de la tira de una campaña', () => {
  it('cuenta los días de principio a fin, ambos incluidos, también al cambiar de mes', () => {
    expect(campaignDays('2026-11-23', '2026-11-29')).toHaveLength(7);
    expect(campaignDays('2026-11-30', '2026-12-02')).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
  });

  it('con fechas imposibles o al revés no inventa días', () => {
    expect(campaignDays('2026-11-29', '2026-11-23')).toEqual([]);
    expect(campaignDays('2026-02-30', '2026-03-02')).toEqual([]);
  });

  it('nombra el día sin moverlo por el huso horario', () => {
    expect(dayParts('2026-11-23')).toEqual({ weekday: 'lun', day: '23' });
    expect(longDayLabel('2026-11-23')).toBe('lunes, 23 de noviembre');
  });
});
