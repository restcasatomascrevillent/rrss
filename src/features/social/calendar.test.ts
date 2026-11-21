import { describe, expect, it } from 'vitest';
import {
  displayState,
  fromLocalInput,
  moveToDay,
  moveToHour,
  quotaWarning,
  shiftAnchor,
  startOfWeek,
  toLocalInput,
  tokenExpiresSoon,
  viewRange,
} from './calendar';

describe('fechas del calendario', () => {
  it('la semana empieza en lunes y el mes se ve en 6 semanas completas', () => {
    expect(startOfWeek(new Date(2026, 10, 19)).getDate()).toBe(16); // miércoles 19 → lunes 16
    expect(startOfWeek(new Date(2026, 10, 22)).getDate()).toBe(16); // domingo 22 → lunes 16
    const mes = viewRange('month', new Date(2026, 10, 19));
    expect(mes.days).toHaveLength(42);
    expect(mes.from.getDay()).toBe(1);
    expect(mes.days.some((d) => d.getMonth() === 10 && d.getDate() === 1)).toBe(true);
    expect(mes.days.some((d) => d.getMonth() === 10 && d.getDate() === 30)).toBe(true);
    expect(viewRange('week', new Date(2026, 10, 19)).days).toHaveLength(7);
    const dia = viewRange('day', new Date(2026, 10, 19, 15));
    expect(dia.to.getTime() - dia.from.getTime()).toBe(86_400_000);
  });

  it('avanza por mes, semana o día', () => {
    expect(shiftAnchor('month', new Date(2026, 0, 31), 1).getMonth()).toBe(1);
    expect(shiftAnchor('week', new Date(2026, 10, 19), -1).getDate()).toBe(12);
    expect(shiftAnchor('day', new Date(2026, 10, 30), 1).getDate()).toBe(1);
  });

  it('arrastrar a otro día conserva la hora; a una hora del día, cambia la hora', () => {
    const original = new Date(2026, 10, 19, 9, 30);
    expect(moveToDay(original, new Date(2026, 10, 25))).toEqual(new Date(2026, 10, 25, 9, 30));
    expect(moveToHour(original, new Date(2026, 10, 19), 18)).toEqual(new Date(2026, 10, 19, 18, 30));
  });

  it('ida y vuelta con datetime-local, y rechaza lo que no es una fecha', () => {
    const local = toLocalInput(new Date(2026, 10, 19, 8, 5));
    expect(local).toBe('2026-11-19T08:05');
    expect(new Date(fromLocalInput(local)!).getTime()).toBe(new Date(2026, 10, 19, 8, 5).getTime());
    expect(fromLocalInput('mañana')).toBeNull();
  });
});

describe('estado que se enseña', () => {
  const base = { hold_reason: null, external_id: null } as const;

  it('«Programada» solo si la base de datos la tiene armada; «Publicada» solo con identificador', () => {
    expect(displayState({ ...base, status: 'scheduled' }, 'approved')).toBe('scheduled');
    expect(displayState({ ...base, status: 'published', external_id: '1789' }, 'approved')).toBe('published');
    expect(displayState({ ...base, status: 'published' }, 'approved')).toBe('publishing');
    expect(displayState({ ...base, status: 'failed' }, 'approved')).toBe('failed');
  });

  it('en espera se ve en qué punto está la pieza, o «Detenida» con su motivo', () => {
    expect(displayState({ ...base, status: 'planned', hold_reason: 'not_approved' }, 'idea')).toBe('idea');
    expect(displayState({ ...base, status: 'planned', hold_reason: 'not_approved' }, 'in_review')).toBe('in_review');
    expect(displayState({ ...base, status: 'planned', hold_reason: 'content_changed' }, 'approved')).toBe('held');
    expect(displayState({ ...base, status: 'planned', hold_reason: 'no_media' }, 'approved')).toBe('held');
  });

  it('avisos de cupo y de caducidad del acceso', () => {
    expect(quotaWarning(null, 50)).toBeNull();
    expect(quotaWarning(10, 50)).toBeNull();
    expect(quotaWarning(40, 50)).toBe('near');
    expect(quotaWarning(50, 50)).toBe('reached');
    const now = Date.parse('2026-11-19T10:00:00Z');
    expect(tokenExpiresSoon(null, now)).toBe(false);
    expect(tokenExpiresSoon('2026-11-22T10:00:00Z', now)).toBe(true);
    expect(tokenExpiresSoon('2027-01-22T10:00:00Z', now)).toBe(false);
  });
});
