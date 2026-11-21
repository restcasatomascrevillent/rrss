import { describe, expect, it } from 'vitest';
import type { KnowledgeSourceListRow } from '@/lib/database.types';
import { describeExtraction, pickProposalSources, sourcesWithText } from './sourceText';

const row = (id: string, chars: number | null, status: KnowledgeSourceListRow['status'] = 'ready') =>
  ({ id, title: id, status, extracted_chars: chars, extraction: null }) as unknown as KnowledgeSourceListRow;

describe('fuentes para la propuesta de perfil', () => {
  it('solo las que tienen texto listo', () => {
    expect(sourcesWithText([row('a', 10), row('b', 0), row('c', null, 'pending'), row('d', 5, 'failed')])).toEqual([
      row('a', 10),
    ]);
  });

  it('las más recientes mientras quepan; las demás se dicen', () => {
    const { chosen, left } = pickProposalSources([row('a', 60), row('b', 50), row('c', 30), row('d', 10)], 3, 100);
    expect(chosen.map((s) => s.id)).toEqual(['a', 'c', 'd']);
    expect(left.map((s) => s.id)).toEqual(['b']);
    expect(pickProposalSources([row('a', 1), row('b', 1)], 1, 100).left.map((s) => s.id)).toEqual(['b']);
  });
});

describe('resumen de la extracción', () => {
  it('PDF con páginas leídas y recorte', () => {
    expect(
      describeExtraction({ extracted_chars: 1200, extraction: { pages: 400, pagesRead: 300, truncated: true } }),
    ).toBe(`${(1200).toLocaleString('es-ES')} caracteres · 300 de 400 páginas · recortado al máximo`);
    expect(describeExtraction({ extracted_chars: 5, extraction: { pages: 1 } })).toBe('5 caracteres · 1 página');
  });

  it('web con páginas omitidas; y sin detalle', () => {
    expect(
      describeExtraction({
        extracted_chars: 9,
        extraction: { pages: [{ url: 'a' }, { url: 'b' }], skipped: [{ url: 'c', reason: 'x' }] },
      }),
    ).toBe('9 caracteres · 2 páginas web · 1 omitidas');
    expect(describeExtraction({ extracted_chars: null, extraction: null })).toBe('');
  });
});
