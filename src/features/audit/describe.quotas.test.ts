import { describe, expect, it } from 'vitest';
import { describeAudit } from './describe';

describe('describeAudit · cupos', () => {
  it('redacta los cambios del cupo de IA sin enseñar importes', () => {
    const data = { organization_id: 'o1', metric: 'ai_cost_micros', limit_value: 5_000_000 };
    const names = () => '';
    expect(describeAudit({ action: 'insert', entity_type: 'usage_quotas', data }, names)).toBe(
      'asignó el cupo mensual de IA',
    );
    expect(describeAudit({ action: 'update', entity_type: 'usage_quotas', data }, names)).toBe(
      'cambió el cupo mensual de IA',
    );
    expect(describeAudit({ action: 'delete', entity_type: 'usage_quotas', data }, names)).toBe(
      'retiró el cupo mensual de IA',
    );
  });
});
