import { describe, expect, it } from 'vitest';
import { editorPrimaryAction, statusActions } from './status';

// La acción principal del editor: una sola, según el estado y los permisos.

const all = { edit: true, approve: true };
const primaryFor = (
  status: 'idea' | 'draft' | 'in_review' | 'approved',
  opts: { approve?: boolean; edit?: boolean; publishNow?: boolean; schedule?: boolean; archived?: boolean } = {},
) => {
  const item = { status, archived_at: opts.archived ? '2026-11-20T00:00:00Z' : null };
  const can = { edit: opts.edit ?? true, approve: opts.approve ?? true };
  return editorPrimaryAction(item, statusActions(item, can), {
    edit: can.edit,
    publishNow: opts.publishNow ?? false,
    schedule: opts.schedule ?? false,
  });
};

describe('editorPrimaryAction', () => {
  it('idea: enviar a revisión (pasar a borrador y lo demás, al menú)', () => {
    expect(primaryFor('idea')).toEqual({ kind: 'status', action: expect.objectContaining({ to: 'in_review' }) });
  });

  it('borrador: aprobar si se puede; si no, enviar a revisión', () => {
    expect(primaryFor('draft')).toEqual({ kind: 'status', action: expect.objectContaining({ to: 'approved' }) });
    expect(primaryFor('draft', { approve: false })).toEqual({
      kind: 'status',
      action: expect.objectContaining({ to: 'in_review', label: 'Enviar a revisión' }),
    });
  });

  it('en revisión: aprobar; quien solo edita no tiene principal (devolver a borrador va al menú)', () => {
    expect(primaryFor('in_review')).toEqual({ kind: 'status', action: expect.objectContaining({ to: 'approved' }) });
    expect(primaryFor('in_review', { approve: false })).toBeNull();
  });

  it('aprobada: publicar ahora si se puede; si no, programar; si no, nada', () => {
    expect(primaryFor('approved', { publishNow: true, schedule: true })).toEqual({ kind: 'publishNow' });
    expect(primaryFor('approved', { schedule: true })).toEqual({ kind: 'schedule' });
    expect(primaryFor('approved')).toBeNull();
  });

  it('archivada: recuperar, solo para quien edita', () => {
    expect(primaryFor('draft', { archived: true })).toEqual({ kind: 'restore' });
    expect(primaryFor('draft', { archived: true, edit: false })).toBeNull();
  });

  it('nunca propone volver atrás como principal', () => {
    for (const status of ['idea', 'draft', 'in_review', 'approved'] as const) {
      const p = primaryFor(status, all);
      if (p?.kind === 'status') expect(['in_review', 'approved']).toContain(p.action.to);
    }
  });
});
