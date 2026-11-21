import { describe, expect, it } from 'vitest';
import { describeAudit } from './describe';

describe('describeAudit · planes', () => {
  it('redacta los cambios de plan sin enseñar importes', () => {
    const names = () => '';
    const row = (source: string, status = 'active') => ({
      action: 'update',
      entity_type: 'subscriptions',
      data: { organization_id: 'o1', source, status, custom_price_micros: 950_000_000 },
    });
    expect(describeAudit(row('manual'), names)).toBe('cambió el plan de la organización');
    expect(describeAudit(row('default'), names)).toBe('devolvió la organización al plan por defecto');
    expect(describeAudit(row('stripe', 'past_due'), names)).toBe('actualizó la suscripción de pago (past_due)');
    expect(describeAudit({ action: 'insert', entity_type: 'subscriptions', data: { source: 'default' } }, names)).toBe(
      'dio de alta la suscripción de la organización',
    );
  });
});
