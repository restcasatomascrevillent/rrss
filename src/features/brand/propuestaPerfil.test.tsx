import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

// Propuesta de perfil con IA desde la pestaña «Fuentes»: con el texto que el
// trabajador ya ha extraído de las fuentes (PDF, Word, texto, web).

const SOURCES_URL = `${BRAND_BASE}/marca?seccion=fuentes`;

type Kind = 'text' | 'pdf' | 'website';

function source(id: string, kind: Kind, title: string, text: string | null, createdAt: string) {
  return {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    kind,
    title,
    storage_path: kind === 'website' ? null : `${ORG_ID}/${BRAND_ID}/sources/${id}`,
    url: kind === 'website' ? 'https://marca.test/' : null,
    mime_type: kind === 'text' ? 'text/plain' : kind === 'pdf' ? 'application/pdf' : null,
    bytes: 100,
    status: text === null ? 'processing' : 'ready',
    error: null,
    created_by: ME.id,
    created_at: createdAt,
    updated_at: createdAt,
    extracted_text: text,
    extracted_chars: text?.length ?? null,
    extraction: text === null ? null : { format: kind, truncated: false },
    extracted_at: text === null ? null : createdAt,
    extraction_job_id: `job-${id}`,
  };
}

function seed(rows: ReturnType<typeof source>[]) {
  seedWorkspace({ orgRole: 'owner' });
  fake.tables.brand_profiles = [
    {
      id: 'perfil-1',
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      version: 1,
      status: 'active',
      schema_version: 1,
      data: { business: { description: '' }, voice: { tone: ['Cercano'] } },
      provenance: {},
      change_note: '',
      created_by: ME.id,
      created_at: '2026-11-01T10:00:00Z',
    },
  ];
  fake.tables.brand_knowledge_sources = rows;
  fake.rpc('save_brand_profile', (args) => {
    for (const row of fake.rows('brand_profiles')) row.status = 'archived';
    const row = { ...fake.rows('brand_profiles')[0]!, id: 'perfil-2', version: 2, status: 'active', data: args.p_data };
    fake.rows('brand_profiles').push(row);
    return row;
  });
}

const MANUAL = source('s-pdf', 'pdf', 'Manual.pdf', 'Somos una casa de comidas de barrio.', '2026-11-10T09:00:00Z');
const WEB = source('s-web', 'website', 'marca.test', 'Menú del día y comida casera.', '2026-11-09T09:00:00Z');
const PENDING = source('s-txt', 'text', 'notas.txt', null, '2026-11-11T09:00:00Z');

const PROPOSAL = {
  action: 'profile.proposal',
  generationId: 'g-p',
  status: 'proposal',
  sources: ['Manual.pdf', 'marca.test'],
  notes: [],
  proposal: {
    business: { description: 'Casa de comidas de barrio', products: [], locations: [], valueProps: [] },
    voice: { tone: ['Cercano'] },
  },
};

describe('Propuesta de perfil con IA', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('envía el texto extraído de las fuentes listas (PDF y web), y lo aceptado se guarda como versión nueva de la IA', async () => {
    seed([PENDING, MANUAL, WEB]);
    fake.fn('ai-generate', () => ({ status: 200, body: PROPOSAL }));
    const { user } = renderApp(SOURCES_URL);
    expect(await screen.findByText('Hay 1 fuente extrayendo su texto todavía.')).toBeInTheDocument();
    await user.click(await screen.findByTestId('profile-ai-propose'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByTestId('ai-proposal-run'));
    await within(dialog).findByTestId('proposal-field-business.description');
    await user.click(within(dialog).getByTestId('ai-proposal-accept'));

    await screen.findByText('Perfil guardado (versión 2)');
    const sent = fake.callsTo('ai-generate', 'function')[0]!.payload;
    expect(sent).toEqual({
      action: 'profile.proposal',
      brandId: BRAND_ID,
      input: {
        sources: [
          { title: 'Manual.pdf', text: 'Somos una casa de comidas de barrio.' },
          { title: 'marca.test', text: 'Menú del día y comida casera.' },
        ],
      },
    });
    const saved = fake.callsTo('save_brand_profile', 'rpc')[0]!.payload as {
      p_data: { business: { description: string } };
      p_provenance: Record<string, { source: string; verified: boolean }>;
      p_change_note: string;
    };
    expect(saved.p_data.business.description).toBe('Casa de comidas de barrio');
    expect(saved.p_provenance.business).toMatchObject({ source: 'ai', verified: false });
    expect(saved.p_change_note).toBe('Propuesta de la IA: 1 campos aceptados');
  });

  it('sin fuentes con texto extraído no aparece', async () => {
    seed([PENDING]);
    renderApp(SOURCES_URL);
    await screen.findByText('notas.txt');
    expect(screen.queryByTestId('profile-ai-propose')).not.toBeInTheDocument();
  });

  it('sin IA configurada en el entorno no aparece', async () => {
    vi.unstubAllEnvs();
    seed([MANUAL]);
    renderApp(SOURCES_URL);
    await screen.findByText('Manual.pdf');
    await waitFor(() => expect(screen.queryByTestId('profile-ai-propose')).not.toBeInTheDocument());
  });
});
