import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, DOCUMENT_SCHEMA_VERSION } from '@/features/content/document';
import type { BrandRole, ContentRequestRow, OrgRole } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, brandRow, renderApp, seedWorkspace } from '@/test/fixtures';
import { prepareState } from './prepare';

// Preparar y entregar un encargo desde la pantalla del encargo (además de con
// la herramienta `agency/`): las mismas funciones y el mismo verificador.

const CLIENT = 'user-cliente';
const FUTURE = '2999-01-01T00:00:00Z';

function requestRow(patch: Partial<ContentRequestRow> = {}): ContentRequestRow {
  return {
    id: 'req-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Post del menú de otoño',
    brief: 'Anunciar el menú de otoño.',
    network: 'instagram',
    format: 'post',
    media_kind: 'image',
    reference_asset_ids: [],
    desired_date: null,
    status: 'requested',
    content_id: null,
    delivered_version: null,
    requested_by: CLIENT,
    claimed_by: null,
    claim_token: null,
    claimed_until: null,
    delivered_by: null,
    delivered_at: null,
    accepted_by: null,
    accepted_at: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  };
}

const piece = (id: string, title: string, caption: string, format = 'post') => ({
  item: {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title,
    network: 'instagram',
    format,
    status: 'draft',
    current_version: 1,
    archived_at: null,
    created_by: ME.id,
    created_at: '2026-11-10T09:00:00Z',
    updated_at: '2026-11-10T09:00:00Z',
  },
  version: {
    id: `${id}-v1`,
    content_id: id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    version: 1,
    schema_version: DOCUMENT_SCHEMA_VERSION,
    data: { ...createEmptyDocument(), copy: { ...createEmptyDocument().copy, caption } },
    change_note: '',
    restored_from: null,
    created_by: ME.id,
    created_at: '2026-11-11T09:00:00Z',
  },
});

function seed(request: ContentRequestRow, role: { orgRole?: OrgRole; brandRole?: BrandRole } = {}) {
  seedWorkspace({
    orgRole: role.orgRole ?? 'member',
    brandRole: role.brandRole ?? 'editor',
    brands: [brandRow({ ai_mode: 'agency' })],
  });
  const pieces = [
    piece('content-1', 'Menú de otoño', 'Ya llega el otoño.'),
    piece('content-2', 'Prohibido', 'Somos el mejor de la ciudad.'),
    piece('content-3', 'Historia', 'Otra cosa.', 'story'),
  ];
  fake.tables.content_items = pieces.map((p) => p.item);
  fake.tables.content_versions = pieces.map((p) => p.version);
  fake.tables.brand_profiles = [
    {
      id: 'perfil-1',
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      version: 1,
      status: 'active',
      data: { voice: { forbiddenPhrases: ['el mejor de la ciudad'] } },
      provenance: {},
      change_note: '',
      created_by: ME.id,
      created_at: '2026-11-01T09:00:00Z',
    },
  ];
  fake.tables.content_requests = [request];
  fake.tables.content_request_comments = [];
  fake.tables.request_notifications = [];
  fake.tables.media_assets = [];
  fake.rpc('take_content_request', (args) => {
    const row = fake.rows('content_requests').find((r) => r.id === args.p_request_id)!;
    Object.assign(row, { status: 'in_progress', claimed_by: ME.id, claim_token: null, claimed_until: FUTURE });
    return row;
  });
  fake.rpc('release_content_request', (args) => {
    const row = fake.rows('content_requests').find((r) => r.id === args.p_request_id)!;
    Object.assign(row, { status: 'requested', claimed_by: null, claim_token: null, claimed_until: null });
    return row;
  });
  fake.rpc('deliver_content_request', (args) => {
    const row = fake.rows('content_requests').find((r) => r.id === args.p_request_id)!;
    Object.assign(row, {
      status: 'delivered',
      content_id: 'content-nueva',
      delivered_version: 1,
      claimed_by: null,
      claimed_until: null,
    });
    return row;
  });
}

describe('estado del cerrojo', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const base = { claimed_by: null, claim_token: null, claimed_until: null };
  it('distingue tomable, mío, otra sesión, otra persona y nada que hacer', () => {
    expect(prepareState({ ...base, status: 'requested' }, 'yo', now)).toBe('takeable');
    expect(prepareState({ ...base, status: 'changes_requested' }, 'yo', now)).toBe('takeable');
    const live = { status: 'in_progress' as const, claimed_until: '2026-11-18T13:00:00Z' };
    expect(prepareState({ ...live, claimed_by: 'yo', claim_token: null }, 'yo', now)).toBe('mine');
    expect(prepareState({ ...live, claimed_by: 'yo', claim_token: 'sesion-1234' }, 'yo', now)).toBe('other_session');
    expect(prepareState({ ...live, claimed_by: 'otra', claim_token: null }, 'yo', now)).toBe('taken_by_other');
    // Cerrojo caducado: se puede volver a tomar.
    expect(
      prepareState(
        { status: 'in_progress', claimed_by: 'otra', claim_token: null, claimed_until: '2026-11-18T11:00:00Z' },
        'yo',
        now,
      ),
    ).toBe('takeable');
    for (const status of ['delivered', 'accepted', 'cancelled'] as const) {
      expect(prepareState({ ...base, status }, 'yo', now)).toBe('none');
    }
  });
});

describe('Preparar el encargo desde la aplicación', () => {
  it('quien edita lo toma, elige una pieza del mismo destino, la verifica y la entrega', async () => {
    seed(requestRow());
    const { user } = renderApp(`${BRAND_BASE}/encargos/req-1`);
    const panel = await screen.findByTestId('request-prepare');
    await user.click(within(panel).getByTestId('request-take'));
    expect(fake.callsTo('take_content_request', 'rpc')[0]!.payload).toEqual({
      p_request_id: 'req-1',
      p_claim_token: null,
    });

    // Solo piezas de Instagram · post (la historia no sale).
    const select = await within(panel).findByTestId('request-deliver-piece');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Elige una pieza', 'Menú de otoño · versión 1', 'Prohibido · versión 1']);
    expect(within(panel).getByTestId('request-deliver')).toBeDisabled();

    await user.selectOptions(select, 'content-1');
    expect(await within(panel).findByTestId('request-deliver-check')).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByTestId('request-deliver')).toBeEnabled());
    await user.click(within(panel).getByTestId('request-deliver'));
    await user.click(await screen.findByTestId('confirm-action'));
    await screen.findByText(/Entregado: el cliente ya puede revisarlo/);

    const [call] = fake.callsTo('deliver_content_request', 'rpc');
    expect(call!.payload).toMatchObject({
      p_request_id: 'req-1',
      p_schema_version: DOCUMENT_SCHEMA_VERSION,
      p_claim_token: null,
      p_title: 'Menú de otoño',
      p_change_note: 'Entregado desde la aplicación',
      p_data: { copy: { caption: 'Ya llega el otoño.' } },
    });
    await waitFor(() => expect(screen.getByTestId('request-status')).toHaveTextContent('Entregado'));
    expect(screen.queryByTestId('request-prepare')).not.toBeInTheDocument();
  });

  it('con bloqueos del verificador de marca no deja entregar', async () => {
    seed(requestRow({ status: 'in_progress', claimed_by: ME.id, claimed_until: FUTURE }));
    const { user } = renderApp(`${BRAND_BASE}/encargos/req-1`);
    const panel = await screen.findByTestId('request-prepare');
    await user.selectOptions(await within(panel).findByTestId('request-deliver-piece'), 'content-2');
    expect(await within(panel).findByText(/encuentra bloqueos/)).toBeInTheDocument();
    expect(within(panel).getByTestId('request-deliver')).toBeDisabled();
  });

  it('se puede soltar', async () => {
    seed(requestRow({ status: 'in_progress', claimed_by: ME.id, claimed_until: FUTURE }));
    const { user } = renderApp(`${BRAND_BASE}/encargos/req-1`);
    await user.click(await screen.findByTestId('request-release'));
    await waitFor(() => expect(screen.getByTestId('request-take')).toBeInTheDocument());
    expect(fake.callsTo('release_content_request', 'rpc')).toHaveLength(1);
  });

  it('tomado por otra persona o desde la herramienta: lo dice y no deja entregar aquí', async () => {
    seed(requestRow({ status: 'in_progress', claimed_by: 'otra', claimed_until: FUTURE }));
    renderApp(`${BRAND_BASE}/encargos/req-1`);
    const panel = await screen.findByTestId('request-prepare');
    expect(panel).toHaveTextContent(/Lo está preparando otra persona/);
    expect(within(panel).queryByTestId('request-deliver')).not.toBeInTheDocument();
  });

  it('quien no edita la marca no ve el panel', async () => {
    seed(requestRow(), { brandRole: 'client' });
    renderApp(`${BRAND_BASE}/encargos/req-1`);
    await screen.findByTestId('request-detail-title');
    expect(screen.queryByTestId('request-prepare')).not.toBeInTheDocument();
  });
});
