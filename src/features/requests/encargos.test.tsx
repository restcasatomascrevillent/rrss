import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDocument } from '@/features/content/document';
import type { CanvasViewProps } from '@/features/content/editor/canvas/types';
import type { BrandRole, ContentRequestRow, OrgRole } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, addPerson, brandRow, renderApp, seedWorkspace } from '@/test/fixtures';

// Encargos (modo agencia): la sección de la marca, el detalle con la
// conversación y las decisiones del cliente, el ajuste de la marca y lo que
// cambia en el editor.

vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => <div data-testid="canvas-stub" data-layers={props.document.layers.length} />,
}));

const AGENCY = 'user-agencia';

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
    desired_date: '2026-12-01',
    status: 'requested',
    content_id: null,
    delivered_version: null,
    requested_by: ME.id,
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

function seed(
  { orgRole = 'member', brandRole = 'client' }: { orgRole?: OrgRole; brandRole?: BrandRole } = {},
  requests: ContentRequestRow[] = [],
) {
  seedWorkspace({ orgRole, brandRole, brands: [brandRow({ ai_mode: 'agency' })] });
  addPerson(AGENCY, 'Agencia Oficio', 'member', 'editor');
  fake.tables.content_requests = requests;
  fake.tables.content_request_comments = requests.flatMap((r) => [
    {
      id: `${r.id}-c1`,
      request_id: r.id,
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      kind: 'status',
      status: 'requested',
      body: '',
      author_id: ME.id,
      created_at: '2026-11-18T09:00:00Z',
    },
    ...(r.status === 'delivered'
      ? [
          {
            id: `${r.id}-c2`,
            request_id: r.id,
            brand_id: BRAND_ID,
            organization_id: ORG_ID,
            kind: 'status',
            status: 'delivered',
            body: 'Entregado por la agencia',
            author_id: AGENCY,
            created_at: '2026-11-18T11:00:00Z',
          },
        ]
      : []),
  ]);
  fake.tables.media_assets = [];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Menú y ajuste de la marca', () => {
  it('«Encargos» solo aparece con la marca en modo agencia', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp(`${BRAND_BASE}/inicio`);
    await screen.findAllByRole('link', { name: 'Contenidos' });
    expect(screen.queryAllByRole('link', { name: 'Encargos' })).toEqual([]);
  });

  it('con la marca en modo agencia, el menú lleva a la lista de encargos', async () => {
    seed({}, [requestRow()]);
    const { user } = renderApp(`${BRAND_BASE}/inicio`);
    await user.click((await screen.findAllByRole('link', { name: 'Encargos' }))[0]!);
    expect(await screen.findAllByTestId('request-row')).toHaveLength(1);
    expect(screen.getByTestId('request-row')).toHaveTextContent('Pedido');
  });

  it('quien gestiona la marca cambia el modo de IA', async () => {
    seedWorkspace({ orgRole: 'owner' });
    const { user } = renderApp(`${BRAND_BASE}/marca`);
    await user.click(await screen.findByRole('tab', { name: /Datos/ }));
    const select = await screen.findByTestId('brand-ai-mode');
    await user.selectOptions(select, 'agency');
    await waitFor(() => expect(fake.rows('brands')[0]!.ai_mode).toBe('agency'));
  });

  it('el resto lo ve sin poder cambiarlo', async () => {
    seed({ brandRole: 'editor' });
    const { user } = renderApp(`${BRAND_BASE}/marca`);
    await user.click(await screen.findByRole('tab', { name: /Datos/ }));
    expect(await screen.findByTestId('brand-ai-mode')).toBeDisabled();
  });
});

describe('Pedir un encargo', () => {
  it('el cliente pide un encargo y llega a su detalle', async () => {
    seed();
    fake.rpc('create_content_request', (args) => {
      const row = requestRow({ id: 'req-nuevo', title: String(args.p_title), brief: String(args.p_brief) });
      fake.rows('content_requests').push(row);
      return row;
    });
    const { user } = renderApp(`${BRAND_BASE}/encargos`);
    // Con la lista vacía hay un solo botón para pedir (el de la cabecera).
    await screen.findByText('Todavía no hay encargos');
    expect(screen.getAllByTestId('request-new')).toHaveLength(1);
    await user.click(screen.getByTestId('request-new'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByTestId('request-title'), 'Navidad');
    await user.type(within(dialog).getByTestId('request-brief'), 'Felicitación con la foto del comedor');
    await user.selectOptions(within(dialog).getByTestId('request-media'), 'image');
    await user.click(within(dialog).getByTestId('request-submit'));

    expect(await screen.findByTestId('request-detail-title')).toHaveTextContent('Navidad');
    expect(fake.callsTo('create_content_request', 'rpc')[0]!.payload).toMatchObject({
      p_brand_id: BRAND_ID,
      p_title: 'Navidad',
      p_brief: 'Felicitación con la foto del comedor',
      p_network: 'instagram',
      p_format: 'post',
      p_media_kind: 'image',
      p_reference_asset_ids: [],
      p_desired_date: null,
      p_content_id: null,
    });
  });

  it('el lector ve los encargos pero no puede pedir ni comentar', async () => {
    seed({ brandRole: 'viewer' }, [requestRow()]);
    renderApp(`${BRAND_BASE}/encargos/req-1`);
    await screen.findByTestId('request-detail-title');
    expect(screen.queryByTestId('request-comment-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('request-cancel')).not.toBeInTheDocument();
    expect(screen.getByText(/no comentar/)).toBeInTheDocument();
  });
});

describe('Revisar una entrega', () => {
  const delivered = () => requestRow({ status: 'delivered', content_id: 'content-1', delivered_version: 2 });

  it('el cliente ve el borrador entregado, la conversación y lo acepta', async () => {
    seed({}, [delivered()]);
    fake.rpc('accept_content_request', () => {
      fake.rows('content_requests')[0]!.status = 'accepted';
      return fake.rows('content_requests')[0];
    });
    const { user } = renderApp(`${BRAND_BASE}/encargos/req-1`);
    expect(await screen.findByTestId('request-status')).toHaveTextContent('Entregado');
    expect(screen.getByTestId('request-open-content')).toHaveAttribute('href', `${BRAND_BASE}/contenidos/content-1`);
    const thread = await screen.findByTestId('request-thread');
    expect(within(thread).getByText(/Agencia Oficio/)).toBeInTheDocument();
    expect(within(thread).getByText('Entregado por la agencia')).toBeInTheDocument();

    await user.click(screen.getByTestId('request-accept'));
    await user.click(await screen.findByTestId('confirm-action'));
    await waitFor(() => expect(screen.getByTestId('request-status')).toHaveTextContent('Aceptado'));
    expect(fake.callsTo('accept_content_request', 'rpc')[0]!.payload).toEqual({ p_request_id: 'req-1' });
    expect(screen.queryByTestId('request-accept')).not.toBeInTheDocument();
  });

  it('pedir cambios exige explicar qué cambiar', async () => {
    seed({}, [delivered()]);
    fake.rpc('request_content_request_changes', () => {
      fake.rows('content_requests')[0]!.status = 'changes_requested';
      return fake.rows('content_requests')[0];
    });
    const { user } = renderApp(`${BRAND_BASE}/encargos/req-1`);
    await user.click(await screen.findByTestId('request-changes'));
    const send = await screen.findByTestId('request-changes-send');
    expect(send).toBeDisabled();
    await user.type(screen.getByTestId('request-changes-input'), 'Más corto, por favor');
    await user.click(send);
    await waitFor(() => expect(screen.getByTestId('request-status')).toHaveTextContent('Cambios pedidos'));
    expect(fake.callsTo('request_content_request_changes', 'rpc')[0]!.payload).toEqual({
      p_request_id: 'req-1',
      p_message: 'Más corto, por favor',
    });
  });

  it('el editor de la marca no acepta ni pide cambios: eso es de quien aprueba', async () => {
    seed({ brandRole: 'editor' }, [delivered()]);
    renderApp(`${BRAND_BASE}/encargos/req-1`);
    await screen.findByTestId('request-detail-title');
    expect(screen.queryByTestId('request-accept')).not.toBeInTheDocument();
    expect(screen.queryByTestId('request-changes')).not.toBeInTheDocument();
    expect(screen.getByTestId('request-comment-input')).toBeInTheDocument();
  });
});

describe('Editor con la marca en modo agencia', () => {
  function seedEditor(requests: ContentRequestRow[] = []) {
    seed({ orgRole: 'owner' }, requests);
    fake.tables.brand_profiles = [];
    fake.tables.content_items = [
      {
        id: 'content-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        title: 'Menú de otoño',
        network: 'instagram',
        format: 'post',
        status: 'draft',
        current_version: 1,
        archived_at: null,
        created_by: ME.id,
        created_at: '2026-11-10T09:00:00Z',
        updated_at: '2026-11-10T09:00:00Z',
      },
    ];
    fake.tables.content_versions = [
      {
        id: 'v-1',
        content_id: 'content-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        version: 1,
        schema_version: 1,
        data: createEmptyDocument(),
        change_note: '',
        restored_from: null,
        created_by: ME.id,
        created_at: '2026-11-11T09:00:00Z',
      },
    ];
  }

  it('no ofrece «Redactar con IA» aunque haya servicio: ofrece «Pedir a la agencia» enlazado a la pieza', async () => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
    seedEditor();
    fake.rpc('create_content_request', (args) => {
      const row = requestRow({ id: 'req-pieza', content_id: String(args.p_content_id) });
      fake.rows('content_requests').push(row);
      return row;
    });
    const { user } = renderApp(`${BRAND_BASE}/contenidos/content-1`);
    await screen.findByTestId('editor-title');
    await user.click(screen.getByRole('tab', { name: 'Publicación' }));
    expect(screen.queryByRole('button', { name: /Redactar con IA/ })).not.toBeInTheDocument();

    await user.click(await screen.findByTestId('ask-agency'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('request-target-fixed')).toHaveTextContent('Menú de otoño');
    await user.type(within(dialog).getByTestId('request-brief'), 'Texto para el menú');
    await user.click(within(dialog).getByTestId('request-submit'));
    await screen.findByTestId('request-detail-title');
    expect(fake.callsTo('create_content_request', 'rpc')[0]!.payload).toMatchObject({
      p_content_id: 'content-1',
      p_title: 'Menú de otoño',
    });
  });

  it('si la pieza viene de un encargo, la cabecera lo dice y enlaza a él; no se pide otro', async () => {
    seedEditor([requestRow({ status: 'delivered', content_id: 'content-1', delivered_version: 1 })]);
    const { user } = renderApp(`${BRAND_BASE}/contenidos/content-1`);
    const link = await screen.findByTestId('editor-request-link');
    expect(link).toHaveTextContent('Post del menú de otoño');
    expect(link).toHaveAttribute('href', `${BRAND_BASE}/encargos/req-1`);
    await user.click(screen.getByRole('tab', { name: 'Publicación' }));
    expect(screen.queryByTestId('ask-agency')).not.toBeInTheDocument();
  });
});
