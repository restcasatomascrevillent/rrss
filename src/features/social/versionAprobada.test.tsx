import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ContentItemRow, MediaAssetRow, ScheduledPublicationRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { approvedVersionPlan, reelRenderOf } from './api';

// «Usar la versión aprobada» en la ficha de una publicación detenida porque la
// pieza cambió (hold_reason content_changed). Las reglas las impone la base de
// datos (tests/db/publicacion.test.ts); aquí, qué se elige y qué se envía.

const SCHEDULED = new Date(Date.now() + 5 * 3_600_000).toISOString();

const piece = (patch: Partial<ContentItemRow> = {}) =>
  ({
    id: 'c-car',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Pieza carrusel',
    network: 'instagram',
    format: 'carousel',
    status: 'approved',
    current_version: 2,
    archived_at: null,
    created_by: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  }) as ContentItemRow;

const publication = (patch: Partial<ScheduledPublicationRow> = {}): ScheduledPublicationRow =>
  ({
    id: 'p-car',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    content_id: 'c-car',
    content_version: 1,
    social_account_id: 'acc-1',
    network: 'instagram',
    format: 'carousel',
    scheduled_at: SCHEDULED,
    media_asset_ids: ['v1-1', 'v1-2'],
    status: 'planned',
    hold_reason: 'content_changed',
    generation: 1,
    attempt_count: 0,
    last_error_code: null,
    last_error: null,
    container_id: null,
    container_created_at: null,
    external_id: null,
    external_url: null,
    published_at: null,
    locked_by: null,
    locked_until: null,
    created_by: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  }) as ScheduledPublicationRow;

const exportada = (id: string, version: number, page: number, count: number, at: string) =>
  ({
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    kind: 'image',
    mime_type: 'image/jpeg',
    file_name: `${id}.jpg`,
    provenance: { type: 'export', content_id: 'c-car', version, page, page_count: count, unsaved_changes: false },
    created_at: at,
  }) as unknown as MediaAssetRow;

function seed(
  options: { status?: ContentItemRow['status']; exports?: MediaAssetRow[]; role?: 'owner' | 'viewer' } = {},
) {
  if (options.role === 'viewer') seedWorkspace({ orgRole: 'member', brandRole: 'viewer' });
  else seedWorkspace({ orgRole: 'owner' });
  fake.tables.content_items = [piece({ status: options.status ?? 'approved' })];
  fake.tables.scheduled_publications = [publication()];
  fake.tables.publication_attempts = [];
  fake.tables.content_comments = [];
  fake.tables.social_accounts = [];
  fake.tables.media_assets = [
    exportada('v1-1', 1, 1, 2, '2026-11-18T09:00:00Z'),
    exportada('v1-2', 1, 2, 2, '2026-11-18T09:00:01Z'),
    ...(options.exports ?? []),
  ];
}

const tresPaginas = [
  exportada('v2-3', 2, 3, 3, '2026-11-20T10:00:03Z'),
  exportada('v2-1', 2, 1, 3, '2026-11-20T10:00:01Z'),
  exportada('v2-2', 2, 2, 3, '2026-11-20T10:00:02Z'),
];

async function openFicha() {
  const view = renderApp(`${BRAND_BASE}/calendario`);
  await view.user.click((await screen.findAllByTestId('calendar-entry'))[0]!);
  return view;
}

describe('Usar la versión aprobada', () => {
  it('elige las páginas de la versión aprobada en orden y rearma con la misma fecha y cuenta', async () => {
    seed({ exports: tresPaginas });
    fake.rpc('save_publication', (args) =>
      publication({ status: 'scheduled', hold_reason: null, content_version: Number(args.p_content_version) }),
    );
    const { user } = await openFicha();
    await user.click(await screen.findByTestId('publication-use-approved'));
    await waitFor(() => expect(fake.callsTo('save_publication', 'rpc')).toHaveLength(1));
    expect(fake.callsTo('save_publication', 'rpc')[0]!.payload).toEqual({
      p_publication_id: 'p-car',
      p_content_id: 'c-car',
      p_scheduled_at: SCHEDULED,
      p_social_account_id: 'acc-1',
      p_media_asset_ids: ['v2-1', 'v2-2', 'v2-3'],
      p_content_version: 2,
    });
  });

  it('si faltan páginas, lo dice, no deja rearmar y ofrece ir al editor', async () => {
    seed({ exports: tresPaginas.slice(0, 2) });
    const { user } = await openFicha();
    expect(await screen.findByTestId('publication-rearm-problem')).toHaveTextContent(
      'exportar todas las páginas de la versión 2',
    );
    expect(screen.getByTestId('publication-use-approved')).toBeDisabled();
    expect(screen.getByTestId('publication-rearm-editor')).toHaveAttribute(
      'href',
      expect.stringContaining('/contenidos/c-car?exportar=1'),
    );
    await user.click(screen.getByTestId('publication-use-approved'));
    expect(fake.callsTo('save_publication', 'rpc')).toHaveLength(0);
  });

  it('si la pieza no está aprobada, no hay versión aprobada que usar', async () => {
    seed({ status: 'in_review', exports: tresPaginas });
    await openFicha();
    expect(await screen.findByTestId('publication-rearm-problem')).toHaveTextContent('aprobar la pieza');
    expect(screen.getByTestId('publication-use-approved')).toBeDisabled();
    expect(screen.queryByTestId('publication-rearm-editor')).toBeNull();
  });

  it('quien solo ve no tiene el botón', async () => {
    seed({ exports: tresPaginas, role: 'viewer' });
    await openFicha();
    await screen.findByTestId('publication-dialog');
    expect(screen.queryByTestId('publication-use-approved')).toBeNull();
  });
});

describe('approvedVersionPlan', () => {
  const car = { id: 'c-car', status: 'approved', current_version: 2, format: 'carousel' } as const;

  it('un post toma su exportación; un reel conserva su vídeo', () => {
    const post = exportada('img', 2, 1, 1, '2026-11-20T10:00:00Z');
    delete (post.provenance as Record<string, unknown>).page;
    delete (post.provenance as Record<string, unknown>).page_count;
    expect(approvedVersionPlan({ ...car, format: 'post' }, [post], [])).toEqual({
      ok: true,
      version: 2,
      mediaAssetIds: ['img'],
    });
    expect(approvedVersionPlan({ ...car, format: 'reel' }, [], ['video-1'])).toEqual({
      ok: true,
      version: 2,
      mediaAssetIds: ['video-1'],
    });
    expect(approvedVersionPlan({ ...car, format: 'reel' }, [], [])).toMatchObject({ ok: false, reason: 'no_exports' });
  });
});

describe('reelRenderOf', () => {
  it('propone el montaje más reciente de esa pieza y esa versión, nunca el de otra', () => {
    const video = (id: string, provenance: Record<string, unknown> | null, createdAt: string) =>
      ({ id, kind: 'video', provenance, created_at: createdAt }) as unknown as MediaAssetRow;
    const assets = [
      video('subido', null, '2026-11-21T09:00:00Z'),
      video('v1', { type: 'media_job', content_id: 'reel-1', content_version: 1 }, '2026-11-21T10:00:00Z'),
      video('v2-viejo', { type: 'media_job', content_id: 'reel-1', content_version: 2 }, '2026-11-21T11:00:00Z'),
      video('v2', { type: 'media_job', content_id: 'reel-1', content_version: 2 }, '2026-11-21T12:00:00Z'),
      video('otro', { type: 'media_job', content_id: 'reel-2', content_version: 2 }, '2026-11-21T13:00:00Z'),
    ];
    expect(reelRenderOf(assets, 'reel-1', 2)?.id).toBe('v2');
    expect(reelRenderOf(assets, 'reel-1', 1)?.id).toBe('v1');
    expect(reelRenderOf(assets, 'reel-1', 3)).toBeNull();
  });
});
