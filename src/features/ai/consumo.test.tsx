import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { BASE, BRAND_ID, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { periodStartOf } from './api';

const PERIOD = periodStartOf(new Date());
const M = 1_000_000;

function ledgerRow(id: number, brandId: string | null, entry: string, reserved: number, cost = 0, period = PERIOD) {
  return {
    id,
    organization_id: ORG_ID,
    brand_id: brandId,
    generation_id: `g-${id}`,
    period_start: period,
    entry,
    reserved_delta_micros: reserved,
    cost_delta_micros: cost,
    created_at: `${period}T10:00:00Z`,
  };
}

function seedUsage({ limit }: { limit: number | null }) {
  fake.tables.usage_quotas =
    limit === null
      ? []
      : [{ organization_id: ORG_ID, metric: 'ai_cost_micros', period: 'month', limit_value: limit, updated_by: null }];
  fake.tables.ai_usage = [
    ledgerRow(1, BRAND_ID, 'reserve', 2 * M),
    ledgerRow(2, BRAND_ID, 'settle', -2 * M, 1_500_000),
    ledgerRow(3, BRAND_ID, 'reserve', 3 * M),
    ledgerRow(4, null, 'reserve', M),
    ledgerRow(5, null, 'settle', -M, 500_000),
  ];
  // Sin cupo sobrescrito, el cupo sale del plan (Fase 6): aquí, uno sin IA.
  fake.rpc('organization_plan_usage', () => ({ plan: { name: 'Prueba' }, ai_limit_micros: 0 }));
  fake.rpc('ai_cost_by_organization', (args) =>
    String(args.p_from).startsWith(PERIOD)
      ? [{ organization_id: ORG_ID, organization_name: 'Grupo Demo', generations: 2, cost_micros: 2 * M }]
      : [],
  );
}

describe('Ajustes → Consumo de IA', () => {
  it('un administrador ve cupo, consumido, reservado, disponible y el coste por marca y por mes', async () => {
    seedWorkspace({ orgRole: 'admin' });
    seedUsage({ limit: 10 * M });
    renderApp(`${BASE}/ajustes/ia`);

    expect(await screen.findByTestId('ai-quota-limit')).toHaveTextContent('10,00 créditos');
    expect(screen.getByTestId('ai-quota-consumed')).toHaveTextContent('2,00 créditos');
    expect(screen.getByTestId('ai-quota-reserved')).toHaveTextContent('3,00 créditos');
    expect(screen.getByTestId('ai-quota-available')).toHaveTextContent('5,00 créditos');
    expect(screen.getByRole('progressbar', { name: 'Cupo comprometido' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('link', { name: 'Consumo de IA' })).toBeInTheDocument();

    const brands = await screen.findByTestId('ai-usage-brands');
    expect(within(brands).getByRole('rowheader', { name: 'Casa Demo' }).closest('tr')).toHaveTextContent(
      '1,50 créditos',
    );
    expect(within(brands).getByRole('rowheader', { name: 'Marca borrada o sin acceso' })).toBeInTheDocument();

    const months = await screen.findByTestId('ai-usage-months');
    expect(within(months).getAllByRole('row')).toHaveLength(7);
    expect(within(months).getByText('2,00 créditos')).toBeInTheDocument();
    expect(fake.callsTo('ai_cost_by_organization', 'rpc')).toHaveLength(6);

    // Sin moneda configurada: ni «€» ni «$», y el aviso de que es una estimación.
    expect(screen.getByTestId('ai-usage-page')).not.toHaveTextContent(/[€$]/);
    expect(screen.getByTestId('ai-money-note')).toHaveTextContent(/estimados/);
  });

  it('sin cupo asignado lo avisa', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedUsage({ limit: null });
    renderApp(`${BASE}/ajustes/ia`);
    expect(await screen.findByTestId('ai-no-quota')).toHaveTextContent(/no tiene cupo de IA asignado/);
    expect(screen.queryByTestId('ai-quota-available')).not.toBeInTheDocument();
  });

  it('sin cupo sobrescrito, enseña el cupo incluido en el plan', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedUsage({ limit: null });
    fake.rpc('organization_plan_usage', () => ({ plan: { name: 'Profesional' }, ai_limit_micros: 10 * M }));
    renderApp(`${BASE}/ajustes/ia`);
    expect(await screen.findByTestId('ai-quota-limit')).toHaveTextContent('10,00 créditos');
    expect(screen.getByTestId('ai-quota-source')).toHaveTextContent('Cupo incluido en el plan «Profesional».');
    expect(screen.queryByTestId('ai-no-quota')).not.toBeInTheDocument();
  });

  it('con el cupo comprometido entero, avisa de que está agotado', async () => {
    seedWorkspace({ orgRole: 'admin' });
    seedUsage({ limit: 5 * M });
    renderApp(`${BASE}/ajustes/ia`);
    expect(await screen.findByTestId('ai-quota-exhausted')).toHaveTextContent(/está agotado/);
    expect(screen.getByTestId('ai-quota-available')).toHaveTextContent('0,00 créditos');
  });

  it('un error al leer el cupo se puede reintentar', async () => {
    seedWorkspace({ orgRole: 'admin' });
    seedUsage({ limit: 10 * M });
    // La aplicación reintenta una vez cada consulta: fallan las dos.
    fake.failNext('usage_quotas', 'select', { message: 'Failed to fetch' });
    fake.failNext('usage_quotas', 'select', { message: 'Failed to fetch' });
    const { user } = renderApp(`${BASE}/ajustes/ia`);
    expect(await screen.findByText('No hay conexión con el servidor. Comprueba tu red.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Reintentar' })[0]!);
    expect(await screen.findByTestId('ai-quota-limit')).toHaveTextContent('10,00');
  });

  it('quien no administra no ve la pestaña ni los datos', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
    seedUsage({ limit: 10 * M });
    renderApp(`${BASE}/ajustes/ia`);
    expect(await screen.findByText('Solo los administradores pueden ver el consumo de IA.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Consumo de IA' })).not.toBeInTheDocument();
    expect(fake.callsTo('ai_cost_by_organization', 'rpc')).toHaveLength(0);
  });
});

describe('Plataforma → cupo mensual de IA', () => {
  it('el superadministrador asigna el cupo de una organización', async () => {
    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    fake.rpc('admin_list_organizations', () => [
      {
        id: ORG_ID,
        name: 'Grupo Demo',
        kind: 'business',
        created_at: '2026-10-01T09:00:00Z',
        members: 1,
        brands: 1,
        assets: 0,
        storage_bytes: 0,
      },
    ]);
    fake.rpc('ai_cost_by_organization', () => [
      { organization_id: ORG_ID, organization_name: 'Grupo Demo', generations: 3, cost_micros: 750_000 },
    ]);
    fake.rpc('admin_set_ai_quota', (args) => ({
      organization_id: args.p_organization_id,
      metric: 'ai_cost_micros',
      period: 'month',
      limit_value: args.p_monthly_limit_micros,
    }));
    const { user } = renderApp('/plataforma');

    const amount = await screen.findByTestId('ai-quota-amount');
    await user.selectOptions(screen.getByTestId('ai-quota-org'), ORG_ID);
    expect(await screen.findByTestId('ai-quota-org-cost')).toHaveTextContent('0,75 créditos');
    await user.type(amount, '-4');
    expect(screen.getByText(/Escribe un importe positivo/)).toBeInTheDocument();
    expect(screen.getByTestId('ai-quota-save')).toBeDisabled();
    await user.clear(amount);
    await user.type(amount, '25,5');
    await user.click(screen.getByTestId('ai-quota-save'));

    expect(await screen.findByTestId('ai-quota-saved')).toHaveTextContent('Cupo de Grupo Demo: 25,50 créditos al mes.');
    expect(fake.callsTo('admin_set_ai_quota', 'rpc')[0]!.payload).toEqual({
      p_organization_id: ORG_ID,
      p_monthly_limit_micros: 25_500_000,
    });
  });

  it('si la base lo rechaza, lo dice', async () => {
    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    fake.rpc('admin_list_organizations', () => [
      {
        id: ORG_ID,
        name: 'Grupo Demo',
        kind: 'business',
        created_at: '2026-10-01T09:00:00Z',
        members: 1,
        brands: 1,
        assets: 0,
        storage_bytes: 0,
      },
    ]);
    fake.rpc('ai_cost_by_organization', () => []);
    fake.rpc('admin_set_ai_quota', () => {
      throw { code: '42501', message: 'Solo para superadministradores' };
    });
    const { user } = renderApp('/plataforma');
    await user.selectOptions(await screen.findByTestId('ai-quota-org'), ORG_ID);
    await user.type(screen.getByTestId('ai-quota-amount'), '10');
    await user.click(screen.getByTestId('ai-quota-save'));
    expect(await screen.findByText('Solo para superadministradores')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-quota-saved')).not.toBeInTheDocument();
  });
});
