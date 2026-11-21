import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentItemRow, ScheduledPublicationRow, SocialAccountRow } from '@/lib/database.types';
import { ALL_AVAILABLE, fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { chooseMoreAction } from '@/test/moreMenu';

// Avisos que se pueden resolver: «Detenida» con su motivo en una frase y el
// botón que lo arregla, los estados vacíos que llevan al sitio y la conexión
// de Instagram con Meta o con token según lo que tenga la plataforma.

const soon = () => new Date(Date.now() + 2 * 3_600_000).toISOString();

function content(id: string, patch: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: `Pieza ${id}`,
    network: 'instagram',
    format: 'post',
    status: 'approved',
    current_version: 1,
    archived_at: null,
    created_by: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  } as ContentItemRow;
}

function held(id: string, contentId: string, patch: Partial<ScheduledPublicationRow>): ScheduledPublicationRow {
  return {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    content_id: contentId,
    content_version: 1,
    social_account_id: null,
    network: 'instagram',
    format: 'post',
    scheduled_at: soon(),
    media_asset_ids: ['asset-1'],
    status: 'planned',
    hold_reason: 'no_account',
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
  };
}

function account(patch: Partial<SocialAccountRow> = {}): SocialAccountRow {
  return {
    id: 'acc-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    network: 'instagram',
    provider: 'meta',
    external_id: '17841400000000001',
    username: 'casa_demo',
    display_name: 'Casa Demo',
    page_id: '1',
    status: 'active',
    scopes: [],
    token_expires_at: null,
    token_checked_at: null,
    quota_usage: null,
    quota_total: null,
    quota_checked_at: null,
    last_error: null,
    connected_by: null,
    connected_at: '2026-11-18T09:00:00Z',
    disconnected_at: null,
    connection_method: 'oauth',
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  };
}

function seed(publications: ScheduledPublicationRow[], accounts: SocialAccountRow[] = []) {
  seedWorkspace({ orgRole: 'owner' });
  fake.tables.content_items = [content('c-1'), content('c-2'), content('c-3', { status: 'in_review' })];
  fake.tables.scheduled_publications = publications;
  fake.tables.publication_attempts = [];
  fake.tables.content_comments = [];
  fake.tables.social_accounts = accounts;
  fake.tables.media_assets = [];
}

/** El servidor simulado responde esta disponibilidad de integraciones. */
function availability(patch: Partial<typeof ALL_AVAILABLE>) {
  fake.fn('platform-integrations', (body) =>
    (body as { action?: string } | undefined)?.action === 'availability'
      ? { status: 200, body: { ...ALL_AVAILABLE, ...patch } }
      : { status: 404, body: { error: { message: 'Sin simular en la prueba' } } },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Calendario: «Detenida» con su motivo y el botón que lo arregla', () => {
  it('sin cuenta conectada: un aviso por motivo con «Conectar cuenta» que lleva a Cuentas conectadas', async () => {
    seed([held('p-1', 'c-1', {}), held('p-2', 'c-2', {})]);
    renderApp(`${BRAND_BASE}/calendario`);
    const notice = await screen.findByTestId('calendar-held-no_account');
    expect(within(notice).getByTestId('calendar-held-no_account-text')).toHaveTextContent(
      '2 publicaciones detenidas: sin cuenta de Instagram conectada',
    );
    expect(within(notice).getByRole('link', { name: 'Conectar cuenta' })).toHaveAttribute(
      'href',
      `${BRAND_BASE}/marca?seccion=datos#cuentas-conectadas`,
    );
    // El detalle largo, plegado bajo «¿Por qué?».
    expect(within(notice).getByText('¿Por qué?').closest('details')).not.toHaveAttribute('open');
    // Y la propia etiqueta lleva el motivo.
    const chips = screen.getAllByTestId('calendar-entry');
    expect(chips[0]).toHaveAttribute('title', 'Detenida: Sin cuenta de Instagram conectada');
  });

  it('con la cuenta ya conectada: «Usar @cuenta» vuelve a guardarlas con ella', async () => {
    seed([held('p-1', 'c-1', {}), held('p-2', 'c-2', {})], [account()]);
    fake.rpc('save_publication', (args) =>
      held(String(args.p_publication_id), String(args.p_content_id), {
        status: 'scheduled',
        hold_reason: null,
        social_account_id: String(args.p_social_account_id),
      }),
    );
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    const notice = await screen.findByTestId('calendar-held-no_account');
    expect(notice).toHaveTextContent('falta elegir la cuenta en la que se publica');
    await user.click(within(notice).getByRole('button', { name: 'Usar @casa_demo' }));
    await waitFor(() => expect(fake.callsTo('save_publication', 'rpc')).toHaveLength(2));
    expect(fake.callsTo('save_publication', 'rpc')[0]!.payload).toMatchObject({
      p_publication_id: 'p-1',
      p_social_account_id: 'acc-1',
      p_media_asset_ids: ['asset-1'],
      p_content_version: 1,
    });
  });

  it('en la ficha: el motivo en una frase, «Exportar» lleva al editor con el diálogo abierto', async () => {
    seed(
      [held('p-1', 'c-1', { hold_reason: 'no_media', social_account_id: 'acc-1', media_asset_ids: [] })],
      [account()],
    );
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    await user.click(await screen.findByTestId('calendar-entry'));
    const notice = await screen.findByTestId('publication-hold-notice');
    expect(within(notice).getByTestId('publication-hold-notice-text')).toHaveTextContent('Falta la imagen exportada');
    expect(within(notice).getByTestId('publication-hold-fix')).toHaveAttribute(
      'href',
      `${BRAND_BASE}/contenidos/c-1?exportar=1`,
    );
    expect(within(notice).getByTestId('publication-hold')).toHaveTextContent(/Falta elegir la imagen/);
  });

  it('la pieza cambió: el aviso de la ficha lleva «Usar la versión aprobada»', async () => {
    seed([held('p-1', 'c-1', { hold_reason: 'content_changed', social_account_id: 'acc-1' })], [account()]);
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    const notice = await screen.findByTestId('calendar-held-content_changed');
    expect(notice).toHaveTextContent('1 publicación detenida: la pieza cambió después de programarla');
    await user.click(within(notice).getByRole('button', { name: 'Usar la versión aprobada' }));
    const fichaNotice = await screen.findByTestId('publication-hold-notice');
    expect(within(fichaNotice).getByTestId('publication-use-approved')).toBeInTheDocument();
  });

  it('sin nada en estas fechas, un aviso con «Programar»', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    seed([]);
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    const empty = await screen.findByTestId('calendar-empty');
    await user.click(within(empty).getByTestId('calendar-empty-action'));
    expect(await screen.findByTestId('schedule-content')).toBeInTheDocument();
  });

  it('«Aprobar varias» está en «⋯» y la barra solo cambia mientras se seleccionan', async () => {
    seed(
      [held('p-3', 'c-3', { hold_reason: 'not_approved', content_version: null, social_account_id: 'acc-1' })],
      [account()],
    );
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    await screen.findByTestId('calendar-entry');
    expect(screen.queryByTestId('calendar-approve-batch')).toBeNull();
    await chooseMoreAction(user, 'calendar-more', 'calendar-approve-start');
    expect(await screen.findByTestId('calendar-approve-batch')).toHaveTextContent('Aprobar seleccionadas (0)');
  });
});

describe('Cuentas conectadas: Meta primero, el token como opción avanzada', () => {
  async function openCard() {
    const view = renderApp(`${BRAND_BASE}/marca`);
    await view.user.click(await screen.findByRole('tab', { name: /Datos/ }));
    return { ...view, card: await screen.findByTestId('social-accounts') };
  }

  it('con Meta configurada: «Conectar con Meta» es el botón principal y el token queda plegado', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    seed([]);
    const { card } = await openCard();
    const meta = await within(card).findByTestId('social-connect-instagram');
    expect(meta).toHaveTextContent('Conectar con Meta');
    const advanced = within(card).getByTestId('social-connect-advanced');
    expect(advanced.tagName).toBe('DETAILS');
    expect(advanced).not.toHaveAttribute('open');
    expect(within(advanced).getByTestId('social-connect-token')).toHaveTextContent('Conexión avanzada (agencia)');
    expect(within(card).queryByTestId('social-oauth-off')).toBeNull();
  });

  it('solo con token: lo explica en una frase y el token pasa a ser la acción', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    availability({ socialOAuth: false });
    seed([]);
    const { card } = await openCard();
    const notice = await within(card).findByTestId('social-oauth-off');
    expect(within(notice).getByTestId('social-oauth-off-text')).toHaveTextContent(
      'La conexión con Meta aún no está activada en la plataforma',
    );
    expect(within(notice).getByTestId('social-connect-token')).toBeInTheDocument();
    expect(within(card).queryByTestId('social-connect-instagram')).toBeNull();
    // Quien no administra la plataforma no ve cómo activarla.
    expect(within(notice).queryByTestId('social-oauth-setup')).toBeNull();
  });

  it('a quien administra la plataforma le lleva a Integraciones', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    availability({ socialOAuth: false });
    seed([]);
    fake.tables.platform_admins = [{ user_id: ME.id }];
    const { card } = await openCard();
    const notice = await within(card).findByTestId('social-oauth-off');
    expect(await within(notice).findByTestId('social-oauth-setup')).toHaveAttribute(
      'href',
      '/plataforma/integraciones',
    );
  });
});

describe('Estados vacíos que llevan al sitio', () => {
  it('Contenidos con filtros sin resultado: «Quitar filtros»', async () => {
    seed([]);
    const { user } = renderApp(`${BRAND_BASE}/contenidos`);
    await user.type(await screen.findByTestId('content-search'), 'no existe nada así');
    await user.click(await screen.findByTestId('content-clear-filters'));
    expect(screen.getByTestId('content-search')).toHaveValue('');
  });

  it('Encargos vacíos: «Nuevo encargo» abre el formulario', async () => {
    seed([]);
    fake.tables.content_requests = [];
    const { user } = renderApp(`${BRAND_BASE}/encargos`);
    await user.click(await screen.findByTestId('request-empty-new'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
