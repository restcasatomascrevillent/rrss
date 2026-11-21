import { describe, expect, it } from 'vitest';
import type { PublicationHoldReason } from '@/lib/database.types';
import { HOLD_REASON_TEXT } from './calendar';
import { activeAccountOf, heldCountText, holdAdvice } from './holdAdvice';

const account = {
  network: 'instagram' as const,
  status: 'active' as const,
  username: 'casa_demo',
  external_id: '1784',
};

describe('holdAdvice: «Detenida» en una frase y con un botón', () => {
  it('sin cuenta conectada lleva a conectarla; con una conectada, la usa', () => {
    expect(holdAdvice('no_account', null)).toEqual({
      short: 'Sin cuenta de Instagram conectada',
      fix: 'connect',
      label: 'Conectar cuenta',
    });
    expect(holdAdvice('no_account', account)).toMatchObject({ fix: 'use_account', label: 'Usar @casa_demo' });
  });

  it('la pieza cambió → usar la versión aprobada; falta la imagen → exportar', () => {
    expect(holdAdvice('content_changed', account)).toMatchObject({
      short: 'La pieza cambió después de programarla',
      fix: 'use_approved',
      label: 'Usar la versión aprobada',
    });
    expect(holdAdvice('no_media', account)).toMatchObject({ short: 'Falta la imagen exportada', label: 'Exportar' });
  });

  it('todos los motivos tienen frase corta (sin punto) y su explicación larga', () => {
    for (const reason of Object.keys(HOLD_REASON_TEXT) as PublicationHoldReason[]) {
      const advice = holdAdvice(reason, null);
      expect(advice.short.length).toBeGreaterThan(0);
      expect(advice.short.length).toBeLessThanOrEqual(50);
      expect(advice.short.endsWith('.')).toBe(false);
      expect(advice.fix === 'none' || advice.label.length > 0).toBe(true);
    }
  });

  it('solo cuenta la cuenta activa de la misma red', () => {
    expect(activeAccountOf([{ ...account, status: 'needs_reauth' }], 'instagram')).toBeNull();
    expect(activeAccountOf([account], 'tiktok')).toBeNull();
    expect(activeAccountOf([account], 'instagram')).toBe(account);
  });

  it('cuenta en singular y en plural', () => {
    expect(heldCountText(1)).toBe('1 publicación detenida');
    expect(heldCountText(3)).toBe('3 publicaciones detenidas');
  });
});
