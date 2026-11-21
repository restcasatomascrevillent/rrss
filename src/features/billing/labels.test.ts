import { describe, expect, it } from 'vitest';
import { GIB, parseGigabytes, parseLimit, resolveBillingEnabled, storageText, usageRatio, usageText } from './labels';

describe('planes · textos y formularios', () => {
  it('la facturación solo se enciende con «true»', () => {
    expect(resolveBillingEnabled('true')).toBe(true);
    expect(resolveBillingEnabled(' TRUE ')).toBe(true);
    for (const raw of [undefined, '', 'false', '1', 'sí']) expect(resolveBillingEnabled(raw)).toBe(false);
  });

  it('uso frente a límite, con y sin límite', () => {
    expect(usageText(3, 5)).toBe('3 de 5');
    expect(usageText(1200, null)).toBe('1200 (sin límite)'.replace('1200', (1200).toLocaleString('es-ES')));
    expect(storageText(512 * 1024 * 1024, GIB)).toBe('512 MB de 1 GB');
    expect(usageRatio(3, 5)).toBe(0.6);
    expect(usageRatio(9, 5)).toBe(1);
    expect(usageRatio(1, null)).toBeNull();
    expect(usageRatio(0, 0)).toBe(1);
  });

  it('límites y gigabytes escritos a mano', () => {
    expect(parseLimit('')).toBeNull();
    expect(parseLimit(' 12 ')).toBe(12);
    for (const bad of ['0', '-1', '1,5', 'diez']) expect(parseLimit(bad)).toBeUndefined();
    expect(parseGigabytes('')).toBeNull();
    expect(parseGigabytes('25')).toBe(25 * GIB);
    expect(parseGigabytes('0,5')).toBe(GIB / 2);
    expect(parseGigabytes('mucho')).toBeUndefined();
  });
});
