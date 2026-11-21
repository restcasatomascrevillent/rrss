// Planes (Fase 6) en la interfaz: «Configuración → Plan» para los
// administradores de la organización y el panel de margen y de planes de
// Plataforma. Sin `VITE_BILLING_ENABLED` no aparece nada de pago.
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingOverviewRow, OrganizationPlanUsage, PlanRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BASE, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

const M = 1_000_000;
const GB = 1024 ** 3;

function plan(overrides: Partial<PlanRow>): PlanRow {
  return {
    id: `plan-${overrides.code ?? 'x'}`,
    code: 'x',
    name: 'X',
    description: '',
    price_micros: 0,
    billing_interval: 'month',
    max_brands: null,
    max_members: null,
    max_storage_bytes: null,
    ai_monthly_micros: 0,
    features: [],
    is_public: false,
    is_default: false,
    active: true,
    stripe_price_id: null,
    sort_order: 0,
    updated_by: null,
    created_at: '2026-11-19T00:00:00Z',
    updated_at: '2026-11-19T00:00:00Z',
    ...overrides,
  };
}

const PLANS = [
  plan({ code: 'trial', name: 'Prueba', is_default: true, max_brands: 1, max_members: 2, max_storage_bytes: GB / 2 }),
  plan({
    code: 'professional',
    name: 'Profesional',
    price_micros: 79 * M,
    max_brands: 5,
    max_members: 10,
    ai_monthly_micros: 25 * M,
    features: ['ai_text', 'ai_image', 'reels', 'publishing'],
    is_public: true,
    stripe_price_id: 'price_pro',
    sort_order: 20,
  }),
];

function usage(overrides: Partial<OrganizationPlanUsage> = {}): OrganizationPlanUsage {
  return {
    plan: {
      code: 'trial',
      name: 'Prueba',
      description: 'Para conocer la plataforma.',
      price_micros: 0,
      billing_interval: 'month',
      max_brands: 1,
      max_members: 2,
      max_storage_bytes: GB / 2,
      ai_monthly_micros: 0,
      features: ['ai_text'],
    },
    subscription: {
      source: 'default',
      status: 'active',
      assigned_plan_code: null,
      custom_price_micros: null,
      current_period_end: null,
      cancel_at_period_end: false,
      has_billing_account: false,
    },
    usage: { brands: 1, members: 2, pending_invitations: 0, storage_bytes: 256 * 1024 * 1024, ai_committed_micros: 0 },
    ai_limit_micros: 0,
    ai_limit_overridden: false,
    period_start: '2026-11-01',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Configuración → Plan', () => {
  it('el propietario ve su plan y el uso frente a los límites, sin nada de pago', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.rpc('organization_plan_usage', () => usage());
    renderApp(`${BASE}/ajustes/plan`);

    expect(await screen.findByTestId('plan-name')).toHaveTextContent('Prueba');
    expect(screen.getByRole('link', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByTestId('plan-usage-brands')).toHaveTextContent('1 de 1');
    expect(screen.getByTestId('plan-usage-members')).toHaveTextContent('2 de 2');
    expect(screen.getByTestId('plan-usage-storage')).toHaveTextContent('256 MB de 512 MB');
    expect(screen.getByTestId('plan-usage-ai')).toHaveTextContent('Tu plan no incluye IA');
    expect(screen.getByRole('progressbar', { name: 'Marcas activas' })).toHaveAttribute('aria-valuenow', '100');
    const features = screen.getByRole('list', { name: 'Funciones del plan' });
    // Sin cupo de IA (límite 0) el texto con IA no figura como incluido.
    expect(within(features).getByText('Texto con IA').closest('li')).toHaveTextContent('(no incluido)');
    expect(within(features).getByText('Reels').closest('li')).toHaveTextContent('(no incluido)');
    // Sin facturación activa: ni cambiar de plan ni planes a la venta.
    expect(screen.queryByText('Cambiar de plan')).not.toBeInTheDocument();
    expect(fake.callsTo('billing-checkout', 'function')).toHaveLength(0);
  });

  it('con cupo de IA, el texto con IA sí figura como incluido', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.rpc('organization_plan_usage', () => usage({ ai_limit_micros: 5 * M }));
    renderApp(`${BASE}/ajustes/plan`);
    const features = await screen.findByRole('list', { name: 'Funciones del plan' });
    expect(within(features).getByText('Texto con IA').closest('li')).toHaveTextContent('(incluido)');
  });

  it('una suscripción cancelada avisa de que rigen los límites del plan por defecto', async () => {
    seedWorkspace({ orgRole: 'admin' });
    fake.rpc('organization_plan_usage', () =>
      usage({
        subscription: {
          ...usage().subscription,
          source: 'stripe',
          status: 'canceled',
          assigned_plan_code: 'professional',
        },
      }),
    );
    renderApp(`${BASE}/ajustes/plan`);
    expect(await screen.findByTestId('plan-lapsed')).toHaveTextContent(
      'La suscripción está cancelada: mientras no se reactive, la organización tiene los límites del plan Prueba.',
    );
  });

  it('con facturación, ofrece los planes en línea y el error de Stripe llega en español', async () => {
    vi.stubEnv('VITE_BILLING_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.rpc('organization_plan_usage', () => usage());
    fake.tables.plans = PLANS;
    fake.fn('billing-checkout', () => ({
      status: 503,
      body: { error: { code: 'not_configured', message: 'El pago en línea no está disponible en este entorno.' } },
    }));
    const { user } = renderApp(`${BASE}/ajustes/plan`);

    const options = await screen.findByTestId('plan-options');
    expect(options).toHaveTextContent('Profesional');
    expect(options).toHaveTextContent('79,00 créditos al mes');
    // El plan por defecto no se vende.
    expect(options).not.toHaveTextContent('Prueba');
    await user.click(screen.getByTestId('checkout-professional'));
    expect(await screen.findByText('El pago en línea no está disponible en este entorno.')).toBeInTheDocument();
    expect(fake.callsTo('billing-checkout', 'function')[0]!.payload).toEqual({
      organizationId: ORG_ID,
      planCode: 'professional',
    });
  });

  it('quien ya paga con Stripe va al portal de cliente; una URL que no es de Stripe no se abre', async () => {
    vi.stubEnv('VITE_BILLING_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.rpc('organization_plan_usage', () =>
      usage({
        subscription: {
          ...usage().subscription,
          source: 'stripe',
          status: 'past_due',
          assigned_plan_code: 'professional',
          has_billing_account: true,
          current_period_end: '2026-12-19T00:00:00Z',
        },
        plan: { ...usage().plan, code: 'professional', name: 'Profesional' },
      }),
    );
    fake.tables.plans = PLANS;
    fake.fn('billing-portal', () => ({ status: 200, body: { url: 'https://phishing.example/portal' } }));
    const { user } = renderApp(`${BASE}/ajustes/plan`);

    expect(await screen.findByText(/no ha podido cobrar la última cuota/)).toBeInTheDocument();
    expect(screen.getByTestId('plan-status')).toHaveTextContent('Pago pendiente');
    expect(screen.queryByTestId('plan-options')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('billing-portal'));
    expect(await screen.findByText(/No se ha podido abrir la página de pago/)).toBeInTheDocument();
    expect(fake.callsTo('billing-portal', 'function')[0]!.payload).toEqual({ organizationId: ORG_ID });
  });

  it('quien no administra no ve la pestaña ni pide el plan', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
    renderApp(`${BASE}/ajustes/plan`);
    expect(await screen.findByText('Solo los administradores pueden ver el plan.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Plan' })).not.toBeInTheDocument();
    expect(fake.callsTo('organization_plan_usage', 'rpc')).toHaveLength(0);
  });
});

function overviewRow(overrides: Partial<BillingOverviewRow>): BillingOverviewRow {
  return {
    organization_id: ORG_ID,
    organization_name: 'Grupo Demo',
    kind: 'business',
    plan_code: 'professional',
    plan_name: 'Profesional',
    assigned_plan_code: 'professional',
    source: 'manual',
    status: 'active',
    custom_price_micros: null,
    monthly_revenue_micros: 79 * M,
    ai_cost_micros: 4 * M,
    margin_micros: 75 * M,
    ai_limit_micros: 25 * M,
    ai_limit_overridden: false,
    brands: 3,
    members: 4,
    storage_bytes: GB,
    current_period_end: null,
    cancel_at_period_end: false,
    ...overrides,
  };
}

function seedPlatform(rows: BillingOverviewRow[]) {
  seedWorkspace({ orgRole: 'owner', platformAdmin: true });
  fake.rpc('admin_list_organizations', () => []);
  fake.rpc('ai_cost_by_organization', () => []);
  fake.rpc('admin_billing_overview', () => rows);
  fake.tables.plans = PLANS;
}

describe('Plataforma → margen y planes', () => {
  it('enseña ingresos, coste de IA y margen por organización, con el total', async () => {
    seedPlatform([
      overviewRow({}),
      overviewRow({
        organization_id: 'org-2',
        organization_name: 'Agencia Pérdidas',
        plan_name: 'Prueba',
        source: 'default',
        monthly_revenue_micros: 0,
        ai_cost_micros: 2 * M,
        margin_micros: -2 * M,
        ai_limit_micros: 5 * M,
        ai_limit_overridden: true,
      }),
    ]);
    fake.rpc('admin_clear_ai_quota', () => null);
    const { user } = renderApp('/plataforma');

    const table = await screen.findByTestId('billing-overview');
    expect(screen.getByTestId(`margin-${ORG_ID}`)).toHaveTextContent('75,00 créditos');
    expect(screen.getByTestId('margin-org-2')).toHaveTextContent('-2,00 créditos');
    expect(screen.getByTestId('margin-org-2')).toHaveClass('text-danger');
    expect(screen.getByTestId('margin-total')).toHaveTextContent('73,00 créditos');
    expect(within(table).getByText('Asignado por la plataforma')).toBeInTheDocument();
    expect(fake.callsTo('admin_billing_overview', 'rpc')[0]!.payload).toEqual({
      p_period_start: expect.stringMatching(/^\d{4}-\d{2}-01$/),
    });

    await user.click(within(table).getByRole('button', { name: 'Volver al del plan' }));
    expect(await screen.findByText('Cupo de IA devuelto al del plan')).toBeInTheDocument();
    expect(fake.callsTo('admin_clear_ai_quota', 'rpc')[0]!.payload).toEqual({ p_organization_id: 'org-2' });
  });

  it('asigna un plan a mano con precio pactado', async () => {
    seedPlatform([overviewRow({ plan_name: 'Prueba', source: 'default' })]);
    fake.rpc('admin_set_organization_plan', (args) => ({ organization_id: args.p_organization_id }));
    const { user } = renderApp('/plataforma');

    await user.click(await screen.findByTestId(`assign-plan-${ORG_ID}`));
    await user.selectOptions(await screen.findByTestId('assign-plan-select'), 'plan-professional');
    await user.type(screen.getByTestId('assign-plan-price'), '60,5');
    await user.click(screen.getByTestId('assign-plan-save'));

    expect(await screen.findByText('Plan asignado')).toBeInTheDocument();
    expect(fake.callsTo('admin_set_organization_plan', 'rpc')[0]!.payload).toEqual({
      p_organization_id: ORG_ID,
      p_plan_id: 'plan-professional',
      p_custom_price_micros: 60_500_000,
      p_note: '',
    });
  });

  it('a quien paga con Stripe no se le asigna un plan a mano', async () => {
    seedPlatform([overviewRow({ source: 'stripe', status: 'active' })]);
    const { user } = renderApp('/plataforma');
    await user.click(await screen.findByTestId(`assign-plan-${ORG_ID}`));
    expect(await screen.findByText(/Esta organización paga con Stripe/)).toBeInTheDocument();
    expect(screen.queryByTestId('assign-plan-save')).not.toBeInTheDocument();
  });

  it('editar un plan guarda sus límites y funciones', async () => {
    seedPlatform([]);
    const { user } = renderApp('/plataforma');

    const table = await screen.findByTestId('plans-table');
    expect(within(table).getByText('Por defecto')).toBeInTheDocument();
    await user.click(screen.getByTestId('plan-edit-professional'));
    const brands = await screen.findByTestId('plan-brands');
    await user.clear(brands);
    await user.type(brands, 'cero');
    expect(screen.getByText('Un número entero, o vacío para sin límite.')).toBeInTheDocument();
    expect(screen.getByTestId('plan-save')).toBeDisabled();
    await user.clear(brands);
    await user.type(brands, '8');
    await user.click(screen.getByTestId('plan-feature-ai_video'));
    await user.click(screen.getByTestId('plan-save'));

    expect(await screen.findByText('Plan guardado: los límites ya están en vigor')).toBeInTheDocument();
    const [call] = fake.callsTo('plans', 'update');
    expect(call!.payload).toMatchObject({
      max_brands: 8,
      max_members: 10,
      max_storage_bytes: null,
      price_micros: 79 * M,
      ai_monthly_micros: 25 * M,
      features: ['ai_text', 'ai_image', 'ai_video', 'reels', 'publishing'],
      stripe_price_id: 'price_pro',
    });
  });
});
