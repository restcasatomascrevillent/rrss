import { describe, expect, it } from 'vitest';
import type { MediaAssetRow } from '@/lib/database.types';
import { exportPageOf, publishableExportsOf } from './api';

const CONTENT = '11111111-1111-4111-8111-111111111111';

let n = 0;
function asset(provenance: Record<string, unknown>, createdAt: string, mime = 'image/jpeg'): MediaAssetRow {
  n += 1;
  return {
    id: `a${n}`,
    mime_type: mime,
    created_at: createdAt,
    provenance: { type: 'export', content_id: CONTENT, version: 2, unsaved_changes: false, ...provenance },
  } as unknown as MediaAssetRow;
}

describe('exportaciones para publicar', () => {
  it('en un carrusel, la más reciente de cada página de la última tanda, en el orden de las páginas', () => {
    const vieja = asset({ page: 1, page_count: 2 }, '2026-11-20T09:00:00Z');
    const p3 = asset({ page: 3, page_count: 3 }, '2026-11-20T10:00:03Z');
    const p1 = asset({ page: 1, page_count: 3 }, '2026-11-20T10:00:01Z');
    const p2 = asset({ page: 2, page_count: 3 }, '2026-11-20T10:00:02Z');
    const p2antes = asset({ page: 2, page_count: 3 }, '2026-11-20T09:30:00Z');
    const otraVersion = asset({ page: 1, page_count: 3, version: 1 }, '2026-11-20T11:00:00Z');
    const ordered = publishableExportsOf([vieja, p3, otraVersion, p2antes, p1, p2], CONTENT, 2, 'carousel');
    expect(ordered?.map((a) => a.id)).toEqual([p1.id, p2.id, p3.id]);
    expect(exportPageOf(p2)).toEqual({ page: 2, count: 3 });
  });

  it('si falta una página, no hay tanda que publicar; un post usa la de una sola imagen', () => {
    const p1 = asset({ page: 1, page_count: 3 }, '2026-11-20T10:00:01Z');
    const p3 = asset({ page: 3, page_count: 3 }, '2026-11-20T10:00:03Z');
    expect(publishableExportsOf([p1, p3], CONTENT, 2, 'carousel')).toBeNull();
    const single = asset({}, '2026-11-20T08:00:00Z');
    expect(publishableExportsOf([p1, p3, single], CONTENT, 2, 'post')?.map((a) => a.id)).toEqual([single.id]);
    expect(exportPageOf(single)).toBeNull();
    expect(publishableExportsOf([single], CONTENT, 2, 'carousel')).toBeNull();
  });
});
