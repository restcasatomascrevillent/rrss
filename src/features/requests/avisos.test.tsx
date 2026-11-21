import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ContentRequestRow, RequestNotificationRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, brandRow, renderApp, seedWorkspace } from '@/test/fixtures';

// Avisos de encargos dentro de la aplicación: insignia en el menú, marca en la
// lista y «leído» al abrir el encargo.

const request = (id: string, title: string): ContentRequestRow => ({
  id,
  brand_id: BRAND_ID,
  organization_id: ORG_ID,
  title,
  brief: 'Texto del encargo.',
  network: 'instagram',
  format: 'post',
  media_kind: null,
  reference_asset_ids: [],
  desired_date: null,
  status: 'requested',
  content_id: null,
  delivered_version: null,
  requested_by: 'otra-persona',
  claimed_by: null,
  claim_token: null,
  claimed_until: null,
  delivered_by: null,
  delivered_at: null,
  accepted_by: null,
  accepted_at: null,
  created_at: '2026-11-18T09:00:00Z',
  updated_at: '2026-11-18T09:00:00Z',
});

const notification = (id: string, requestId: string, kind: RequestNotificationRow['kind']): RequestNotificationRow => ({
  id,
  user_id: ME.id,
  request_id: requestId,
  brand_id: BRAND_ID,
  organization_id: ORG_ID,
  kind,
  created_at: '2026-11-18T10:00:00Z',
  read_at: null,
});

function seed(aiMode: 'agency' | 'api' = 'agency') {
  seedWorkspace({ orgRole: 'member', brandRole: 'editor', brands: [brandRow({ ai_mode: aiMode })] });
  fake.tables.content_requests = [request('req-1', 'Post de otoño'), request('req-2', 'Reel de Navidad')];
  fake.tables.content_request_comments = [];
  fake.tables.request_notifications = [
    notification('n-1', 'req-1', 'request_created'),
    notification('n-2', 'req-2', 'request_delivered'),
  ];
  fake.rpc('mark_request_notifications_read', (args) => {
    let n = 0;
    for (const row of fake.rows('request_notifications')) {
      if (row.read_at === null && (!args.p_request_id || row.request_id === args.p_request_id)) {
        row.read_at = '2026-11-18T11:00:00Z';
        n += 1;
      }
    }
    return n;
  });
}

describe('avisos de encargos', () => {
  it('el menú «Encargos» lleva una insignia con los avisos sin leer', async () => {
    seed();
    renderApp(`${BRAND_BASE}/inicio`);
    const nav = await screen.findByTestId('nav-encargos');
    await waitFor(() => expect(within(nav).getByTestId('nav-badge')).toHaveTextContent('2'));
  });

  it('sin modo agencia no hay menú de encargos ni insignia', async () => {
    seed('api');
    renderApp(`${BRAND_BASE}/inicio`);
    await screen.findByTestId('nav-contenidos');
    expect(screen.queryByTestId('nav-encargos')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-badge')).not.toBeInTheDocument();
  });

  it('la lista marca los encargos con aviso; abrir uno lo da por leído', async () => {
    seed();
    const { user } = renderApp(`${BRAND_BASE}/encargos`);
    const marks = await screen.findAllByTestId('request-unread');
    expect(marks.map((m) => m.textContent).sort()).toEqual(['Entregado: revísalo', 'Nuevo']);

    await user.click(screen.getByText('Post de otoño'));
    await screen.findByTestId('request-detail-title');
    await waitFor(() =>
      expect(fake.callsTo('mark_request_notifications_read', 'rpc')[0]!.payload).toEqual({
        p_brand_id: BRAND_ID,
        p_request_id: 'req-1',
      }),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('nav-encargos')).getByTestId('nav-badge')).toHaveTextContent('1'),
    );
  });

  it('se pueden marcar todos como leídos', async () => {
    seed();
    const { user } = renderApp(`${BRAND_BASE}/encargos`);
    await user.click(await screen.findByTestId('request-mark-all-read'));
    await waitFor(() => expect(screen.queryByTestId('request-unread')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('nav-encargos')).queryByTestId('nav-badge')).not.toBeInTheDocument();
    expect(fake.callsTo('mark_request_notifications_read', 'rpc')[0]!.payload).toEqual({
      p_brand_id: BRAND_ID,
      p_request_id: null,
    });
  });
});
