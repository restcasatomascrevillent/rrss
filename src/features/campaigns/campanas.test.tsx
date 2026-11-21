import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrandRole, CampaignRow, OrgRole } from '@/lib/database.types';
import { createEmptyDocument } from '@/features/content/document';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, brandRow, renderApp, seedWorkspace } from '@/test/fixtures';
import { nextWeek } from './plan';

// Campañas: la sección aparece solo si hay forma de preparar un plan; se pide
// un plan, se revisa con sus explicaciones, se retoca y se acepta (el motor
// crea borradores); en modo agencia, el plan se pide a la agencia.

const GENERATION = '11111111-1111-4111-8111-111111111111';
const week = nextWeek(new Date());

function plan() {
  return {
    objective: 'Llenar las mesas de entre semana.',
    summary: 'Dos piezas.',
    reasoning: {
      observed: ['El tono de la marca es cercano.'],
      dataBacked: [],
      hypotheses: ['El jueves funciona para recordar las reservas.'],
      dataNote: 'Esta marca todavía no tiene datos de resultados en la plataforma.',
    },
    pieces: [
      {
        network: 'instagram',
        format: 'post',
        date: week.start,
        idea: 'Plato de la semana',
        caption: 'Arrancamos la semana con guiso de setas.',
        hashtags: ['CocinaDeMercado'],
        assetIds: [],
        why: 'Lunes: abrir la semana.',
      },
      {
        network: 'instagram',
        format: 'carousel',
        date: week.end,
        idea: 'Resumen de la semana',
        caption: 'Lo mejor de la semana en cinco fotos.',
        hashtags: [],
        assetIds: [],
        why: 'Domingo: repaso.',
      },
    ],
  };
}

function campaignRow(patch: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 'camp-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Semana que viene',
    instruction: 'Prepara la semana que viene',
    networks: ['instagram'],
    starts_on: week.start,
    ends_on: week.end,
    origin: 'ai',
    status: 'proposed',
    current_plan_version: 1,
    accepted_plan_version: null,
    created_by: ME.id,
    accepted_by: null,
    accepted_at: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  };
}

function seed(
  {
    orgRole = 'member',
    brandRole = 'editor',
    agency = false,
  }: { orgRole?: OrgRole; brandRole?: BrandRole; agency?: boolean } = {},
  campaigns: CampaignRow[] = [],
) {
  seedWorkspace({ orgRole, brandRole, brands: [brandRow({ ai_mode: agency ? 'agency' : 'api' })] });
  fake.tables.campaigns = campaigns;
  fake.tables.campaign_plans = campaigns
    .filter((c) => c.current_plan_version > 0)
    .map((c) => ({
      id: `${c.id}-v${c.current_plan_version}`,
      campaign_id: c.id,
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      version: c.current_plan_version,
      data: plan(),
      source: c.origin,
      generation_id: null,
      created_by: ME.id,
      created_at: '2026-11-18T09:00:00Z',
    }));
  fake.tables.campaign_contents = [];
  fake.tables.content_items = [];
  fake.tables.content_versions = [];
  fake.tables.content_requests = [];
  fake.tables.media_assets = [];
  fake.tables.brand_knowledge_sources = [];
}

describe('la sección Campañas', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sin IA de texto y fuera del modo agencia no aparece, y la ruta vuelve al inicio', async () => {
    seed();
    renderApp(`${BRAND_BASE}/campanas`);
    await waitFor(() => expect(window.location.pathname).toBe(`${BRAND_BASE}/inicio`));
    expect(screen.queryByRole('link', { name: /Campañas/ })).not.toBeInTheDocument();
  });

  it('con IA: «prepara la semana que viene» → plan explicado → quitar una pieza → aceptar crea borradores', async () => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
    seed();
    fake.fn('ai-generate', () => ({
      status: 200,
      body: { action: 'campaign.plan', generationId: GENERATION, status: 'proposal', plan: plan(), discarded: [] },
    }));
    fake.rpc('create_campaign', (args) => {
      const row = campaignRow({ title: args.p_title as string });
      seed({}, [row]);
      return row;
    });
    fake.rpc('accept_campaign_plan', () => ({ ...campaignRow(), status: 'accepted', accepted_plan_version: 2 }));

    const { user } = renderApp(`${BRAND_BASE}/campanas`);
    expect(await screen.findAllByRole('link', { name: /Campañas/ })).not.toHaveLength(0);
    // Con la lista vacía hay un solo botón para pedir (el de la cabecera).
    await screen.findByText('Todavía no hay campañas');
    expect(screen.getAllByTestId('campaign-new')).toHaveLength(1);
    await user.click(screen.getByTestId('campaign-new'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByTestId('campaign-instruction'), 'Prepara la semana que viene');
    await user.click(within(dialog).getByTestId('campaign-submit'));

    // Arriba, el objetivo en una línea; el porqué, plegado y con su resumen.
    expect(await screen.findByTestId('campaign-objective')).toHaveTextContent('Llenar las mesas de entre semana.');
    const why = screen.getByTestId('campaign-why');
    expect(why).not.toHaveAttribute('open');
    expect(why).toHaveTextContent('1 cosa observada, sin datos de resultados, 1 suposición.');
    expect(screen.getByTestId('campaign-instruction')).not.toHaveAttribute('open');
    // Dentro, observado, sin datos (y lo dice) e hipótesis, siempre por separado.
    expect(screen.getByTestId('reason-observed')).toHaveTextContent('El tono de la marca es cercano.');
    expect(screen.getByTestId('reason-data')).toHaveTextContent('todavía no tiene datos de resultados');
    expect(screen.getByTestId('reason-hypotheses')).toHaveTextContent('El jueves funciona');
    // La semana: una columna por día; cada pieza, su formato y nada de texto largo.
    expect(screen.getAllByTestId('campaign-day')).toHaveLength(7);
    expect(screen.getAllByTestId('campaign-plan-piece')).toHaveLength(2);
    expect(screen.getByTestId('campaign-plan-pieces')).not.toHaveTextContent('Arrancamos la semana');
    expect(screen.queryByTestId('campaign-piece-panel')).not.toBeInTheDocument();

    const sent = fake.callsTo('ai-generate', 'function')[0]!.payload as {
      action: string;
      input: { instruction: string; startDate: string; endDate: string; targets: { network: string }[] };
    };
    expect(sent.action).toBe('campaign.plan');
    expect(sent.input).toMatchObject({
      instruction: 'Prepara la semana que viene',
      startDate: week.start,
      endDate: week.end,
    });
    expect(new Set(sent.input.targets.map((t) => t.network))).toEqual(new Set(['instagram']));
    expect(fake.callsTo('create_campaign', 'rpc')[0]!.payload).toMatchObject({ p_generation_id: GENERATION });

    // Retocar y quitar antes de aceptar, desde la ficha de cada pieza.
    const pieces = screen.getAllByTestId('campaign-plan-piece');
    await user.click(pieces[0]!);
    expect(pieces[0]).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByTestId('campaign-piece-panel');
    expect(panel).toHaveTextContent('Lunes: abrir la semana.');
    const caption = within(panel).getByTestId('campaign-piece-caption');
    await user.clear(caption);
    await user.type(caption, 'Texto retocado.');
    await user.click(pieces[1]!);
    await user.click(within(screen.getByTestId('campaign-piece-panel')).getByTestId('campaign-piece-remove'));
    expect(screen.getAllByTestId('campaign-plan-piece')).toHaveLength(1);
    expect(screen.queryByTestId('campaign-piece-panel')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('campaign-accept'));
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(confirm).getByRole('button', { name: 'Aceptar y crear borradores' }));

    await waitFor(() => expect(fake.callsTo('accept_campaign_plan', 'rpc')).toHaveLength(1));
    const accepted = fake.callsTo('accept_campaign_plan', 'rpc')[0]!.payload as {
      p_expected_version: number;
      p_plan: { pieces: { caption: string }[] };
      p_drafts: { title: string; data: { copy: { caption: string } } }[];
    };
    expect(accepted.p_expected_version).toBe(1);
    expect(accepted.p_plan.pieces.map((p) => p.caption)).toEqual(['Texto retocado.']);
    expect(accepted.p_drafts).toHaveLength(1);
    expect(accepted.p_drafts[0]!.data.copy.caption).toBe('Texto retocado.');
    expect(accepted.p_drafts[0]!.title).toContain('Plato de la semana');
  });

  it('una campaña aceptada enseña sus piezas como borradores, con su vista previa y el enlace al editor', async () => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
    seed({}, [campaignRow({ status: 'accepted', accepted_plan_version: 1 })]);
    fake.tables.campaign_contents = [
      {
        campaign_id: 'camp-1',
        content_id: 'c-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        plan_version: 1,
        piece_index: 0,
        created_at: '2026-11-18T10:00:00Z',
      },
    ];
    fake.tables.content_items = [
      {
        id: 'c-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        title: '23/11 · Instagram · Publicación · Plato',
        network: 'instagram',
        format: 'post',
        status: 'draft',
        current_version: 1,
      },
    ];
    // Sin exportación: la miniatura es el esbozo de la primera página del documento.
    fake.tables.content_versions = [
      {
        id: 'v-1',
        content_id: 'c-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        version: 1,
        schema_version: 1,
        data: createEmptyDocument({ aspectRatio: '4:5', backgroundColor: '#123456' }),
      },
    ];
    const { user } = renderApp(`${BRAND_BASE}/campanas/camp-1`);
    const list = await screen.findByTestId('campaign-piece-list');
    expect(within(list).getByTestId('campaign-piece-status')).toHaveTextContent('Borrador');
    expect(screen.queryByTestId('campaign-accept')).not.toBeInTheDocument();
    const tile = within(list).getByTestId('campaign-piece-row');
    await waitFor(() =>
      expect(within(tile).getByTestId('campaign-piece-thumb')).toHaveAttribute('data-preview', 'document'),
    );
    // La acción principal lleva a la siguiente pieza por terminar.
    expect(screen.getByTestId('campaign-open-next')).toHaveAttribute('href', `${BRAND_BASE}/contenidos/c-1`);
    await user.click(tile);
    const panel = screen.getByTestId('campaign-piece-panel');
    expect(within(panel).getByTestId('campaign-piece-caption-text')).toHaveTextContent('guiso de setas');
    expect(within(panel).getByRole('img', { name: /Vista previa de «Plato de la semana»/ })).toBeInTheDocument();
    expect(within(panel).getByTestId('campaign-piece-open')).toHaveAttribute('href', `${BRAND_BASE}/contenidos/c-1`);
  });

  it('la lista enseña cada campaña como tarjeta: fechas, estado, número de piezas y miniaturas', async () => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
    seed({}, [
      campaignRow(),
      campaignRow({ id: 'camp-2', title: 'Otoño', status: 'requested', current_plan_version: 0 }),
    ]);
    renderApp(`${BRAND_BASE}/campanas`);
    const cards = await screen.findAllByTestId('campaign-row');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Plan por revisar');
    expect(cards[0]).toHaveAttribute('href', `${BRAND_BASE}/campanas/camp-1`);
    await waitFor(() => expect(within(cards[0]!).getByTestId('campaign-row-count')).toHaveTextContent('2 piezas'));
    expect(within(cards[0]!).getAllByTestId('campaign-piece-thumb')).toHaveLength(2);
    expect(within(cards[1]!).getByTestId('campaign-row-count')).toHaveTextContent('Sin plan todavía');
  });

  it('el lector ve el plan pero no lo puede aceptar ni descartar', async () => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
    seed({ brandRole: 'viewer' }, [campaignRow()]);
    const { user } = renderApp(`${BRAND_BASE}/campanas/camp-1`);
    await screen.findByTestId('campaign-objective');
    expect(screen.queryByTestId('campaign-accept')).not.toBeInTheDocument();
    expect(screen.queryByTestId('campaign-discard')).not.toBeInTheDocument();
    await user.click(screen.getAllByTestId('campaign-plan-piece')[0]!);
    const panel = screen.getByTestId('campaign-piece-panel');
    expect(within(panel).getByTestId('campaign-piece-caption-text')).toHaveTextContent('guiso de setas');
    expect(screen.queryByTestId('campaign-piece-caption')).not.toBeInTheDocument();
    expect(screen.queryByTestId('campaign-piece-remove')).not.toBeInTheDocument();
  });

  it('modo agencia (sin IA en el entorno): se pide el plan a la agencia', async () => {
    seed({ brandRole: 'client', agency: true });
    fake.rpc('request_campaign_plan', () => {
      const row = campaignRow({ origin: 'agency', status: 'requested', current_plan_version: 0 });
      seed({ brandRole: 'client', agency: true }, [row]);
      fake.tables.content_requests = [
        {
          id: 'req-9',
          brand_id: BRAND_ID,
          organization_id: ORG_ID,
          campaign_id: 'camp-1',
          kind: 'plan',
          status: 'requested',
          title: 'Plan: Semana',
          network: 'instagram',
          format: 'plan',
        },
      ];
      return row;
    });
    const { user } = renderApp(`${BRAND_BASE}/campanas`);
    await user.click(await screen.findByTestId('campaign-new'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('campaign-use-sources')).not.toBeInTheDocument();
    await user.type(within(dialog).getByTestId('campaign-instruction'), 'Campaña de 3 semanas para el menú de otoño');
    await user.click(within(dialog).getByTestId('campaign-submit'));
    expect(await screen.findByTestId('campaign-agency-notice')).toHaveTextContent('La agencia está preparando el plan');
    expect(fake.callsTo('ai-generate', 'function')).toHaveLength(0);
    expect(fake.callsTo('request_campaign_plan', 'rpc')[0]!.payload).toMatchObject({
      p_instruction: 'Campaña de 3 semanas para el menú de otoño',
      p_networks: ['instagram'],
    });
  });
});
