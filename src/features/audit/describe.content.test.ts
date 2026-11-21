import { describe, expect, it } from 'vitest';
import { describeAudit } from './describe';

describe('describeAudit · contenidos', () => {
  const names = () => '';
  const item = { id: 'c1', title: 'Menú de otoño', network: 'instagram', format: 'post', status: 'idea' };

  it('redacta el alta, los cambios y el archivado de una pieza', () => {
    expect(describeAudit({ action: 'insert', entity_type: 'content_items', data: item }, names)).toBe(
      'creó el contenido «Menú de otoño»',
    );
    expect(
      describeAudit({ action: 'update', entity_type: 'content_items', data: { ...item, status: 'in_review' } }, names),
    ).toBe('actualizó el contenido «Menú de otoño» (en revisión)');
    expect(
      describeAudit({ action: 'update', entity_type: 'content_items', data: { ...item, status: 'approved' } }, names),
    ).toBe('actualizó el contenido «Menú de otoño» (aprobado)');
    expect(
      describeAudit(
        { action: 'update', entity_type: 'content_items', data: { ...item, archived_at: '2026-11-17T10:00:00Z' } },
        names,
      ),
    ).toBe('archivó el contenido «Menú de otoño»');
    expect(describeAudit({ action: 'delete', entity_type: 'content_items', data: item }, names)).toBe(
      'eliminó el contenido «Menú de otoño»',
    );
  });

  it('distingue guardar una versión de restaurar otra', () => {
    const version = { id: 'v1', content_id: 'c1', version: 3, restored_from: null };
    expect(describeAudit({ action: 'insert', entity_type: 'content_versions', data: version }, names)).toBe(
      'guardó la versión 3 de un contenido',
    );
    expect(
      describeAudit(
        { action: 'insert', entity_type: 'content_versions', data: { ...version, restored_from: 1 } },
        names,
      ),
    ).toBe('restauró la versión 1 de un contenido (ahora es la 3)');
  });
});
