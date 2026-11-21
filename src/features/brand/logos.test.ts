import { describe, expect, it } from 'vitest';
import { logosToDiscard, settleSaved } from './logos';

describe('logos pendientes del perfil', () => {
  it('descarta los pendientes que no se están guardando', () => {
    expect(logosToDiscard(new Set(['a', 'b', 'c']), new Set(['b']))).toEqual(['a', 'c']);
    expect(logosToDiscard(new Set(), new Set(['b']))).toEqual([]);
  });

  it('al guardar el perfil dejan de ser pendientes los que ya están en él', () => {
    const pending = new Set(['a', 'b']);
    settleSaved(pending, ['b', 'z']);
    expect([...pending]).toEqual(['a']);
  });
});
