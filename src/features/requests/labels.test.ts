import { describe, expect, it } from 'vitest';
import { describeAudit } from '@/features/audit/describe';
import { isClosed, requestActions, requestPaths } from './labels';

const can = { comment: true, approve: true, manage: false, userId: 'yo' };

describe('requestActions', () => {
  it('aceptar y pedir cambios solo sobre lo entregado y con permiso de aprobar', () => {
    expect(requestActions({ status: 'delivered', requested_by: 'otro' }, can)).toMatchObject({
      accept: true,
      requestChanges: true,
    });
    expect(requestActions({ status: 'in_progress', requested_by: 'otro' }, can)).toMatchObject({
      accept: false,
      requestChanges: false,
    });
    expect(requestActions({ status: 'delivered', requested_by: 'otro' }, { ...can, approve: false }).accept).toBe(
      false,
    );
  });

  it('cancela quien lo pidió o quien gestiona, mientras no esté cerrado', () => {
    expect(requestActions({ status: 'requested', requested_by: 'yo' }, can).cancel).toBe(true);
    expect(requestActions({ status: 'requested', requested_by: 'otro' }, can).cancel).toBe(false);
    expect(requestActions({ status: 'requested', requested_by: 'otro' }, { ...can, manage: true }).cancel).toBe(true);
    expect(requestActions({ status: 'accepted', requested_by: 'yo' }, { ...can, manage: true }).cancel).toBe(false);
    expect(isClosed('cancelled')).toBe(true);
  });

  it('rutas de la sección', () => {
    expect(requestPaths('o', 'm').item('r')).toBe('/o/o/m/m/encargos/r');
  });
});

describe('registro de actividad de los encargos', () => {
  it('describe el alta y el estado en que queda', () => {
    const nameOf = () => '';
    expect(
      describeAudit({ action: 'insert', entity_type: 'content_requests', data: { title: 'Navidad' } }, nameOf),
    ).toBe('pidió el encargo «Navidad»');
    expect(
      describeAudit(
        { action: 'update', entity_type: 'content_requests', data: { title: 'Navidad', status: 'delivered' } },
        nameOf,
      ),
    ).toBe('actualizó el encargo «Navidad» (entregado)');
    expect(
      describeAudit({ action: 'insert', entity_type: 'content_request_comments', data: { kind: 'comment' } }, nameOf),
    ).toBe('comentó un encargo');
  });
});
