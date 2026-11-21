import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { contentDocumentSchema, DOCUMENT_SCHEMA_VERSION, type ContentDocument, type LayerInput } from '@/features/content/document';
import { fake } from '@/test/fakeSupabase';
import { BRAND_ID, ORG_ID, seedWorkspace } from '@/test/fixtures';
import { BrandCheckPanel } from './BrandCheckPanel';
import { describeMeasure } from './measure';

function doc(layers: LayerInput[] = [], copy: object = {}): ContentDocument {
  return contentDocumentSchema.parse({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
    pages: [{ id: 'p1', layers }],
    copy,
  });
}

const lowContrastText = {
  id: 'titulo',
  type: 'text',
  x: 100,
  y: 100,
  width: 600,
  height: 100,
  text: 'Hola',
  fontFamily: 'Inter',
  fontSize: 40,
  color: '#DDDDDD',
} as LayerInput;

function seedProfile(data: object | null) {
  fake.tables.brand_profiles = data
    ? [
        {
          id: 'perfil-1',
          brand_id: BRAND_ID,
          organization_id: ORG_ID,
          version: 1,
          status: 'active',
          schema_version: 1,
          data,
          provenance: {},
          change_note: '',
          created_by: null,
          created_at: '2026-11-01T10:00:00Z',
        },
      ]
    : [];
}

function renderPanel(props: Partial<React.ComponentProps<typeof BrandCheckPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrandCheckPanel document={doc()} network="instagram" format="post" brandId={BRAND_ID} {...props} />
    </QueryClientProvider>,
  );
}

describe('BrandCheckPanel', () => {
  it('muestra «No apto» con los bloqueos y su dato medido', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfile({ voice: { forbiddenPhrases: ['barato'], hashtags: { required: ['MiMarca'] } } });
    renderPanel({ document: doc([lowContrastText], { caption: 'Muy barato', altText: 'Un texto' }) });

    const verdict = await screen.findByTestId('brandcheck-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'fail');
    expect(within(verdict).getByText('No apto')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Hay que corregir/ })).toBeInTheDocument();
    expect(screen.getByTestId('brandcheck-finding-FORBIDDEN_PHRASE')).toHaveTextContent('Aparece «barato»');
    expect(screen.getByTestId('brandcheck-finding-BRAND_HASHTAG_MISSING')).toHaveTextContent('Falta #MiMarca.');
    expect(screen.getByTestId('brandcheck-finding-CONTRAST_TOO_LOW')).toHaveTextContent(/Contraste .*:1; se exige/);
  });

  it('«Apto con avisos» cuando solo hay avisos', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfile({ voice: { callsToAction: ['reserva'] } });
    renderPanel({ document: doc([], { caption: 'Hola a todos' }) });
    const verdict = await screen.findByTestId('brandcheck-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'pass_with_warnings');
    expect(screen.getByRole('heading', { name: /^Conviene revisar/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Hay que corregir/ })).not.toBeInTheDocument();
  });

  it('«Apto» y las comprobaciones sin datos van aparte, como omitidas', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfile({ voice: { emojis: { allowed: true } } });
    renderPanel({ document: doc([], { caption: 'Hola' }) });
    const verdict = await screen.findByTestId('brandcheck-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'pass');
    expect(within(verdict).getByText('Apto')).toBeInTheDocument();
    const omitted = screen.getByTestId('brandcheck-omitted');
    expect(omitted).toHaveTextContent('no define palabras o expresiones vetadas');
  });

  it('avisa si la marca no tiene perfil guardado o el formato no tiene especificación', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfile(null);
    renderPanel({ network: 'instagram', format: 'inventado' });
    expect(await screen.findByText(/todavía no tiene un perfil guardado/)).toBeInTheDocument();
    expect(screen.getByText(/No hay especificación para este formato/)).toBeInTheDocument();
  });

  it('al pulsar un hallazgo emite su destino; sin la propiedad no hay botones', async () => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfile({});
    const onSelectTarget = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderPanel({ document: doc([lowContrastText]), onSelectTarget });
    await user.click(await screen.findByRole('button', { name: /Contraste|contraste/ }));
    expect(onSelectTarget).toHaveBeenCalledTimes(1);
    expect(onSelectTarget.mock.calls[0]![0]).toEqual({ part: 'textLayer', layerId: 'titulo' });
    unmount();

    renderPanel({ document: doc([lowContrastText]) });
    await screen.findByTestId('brandcheck-verdict');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('muestra el error de carga del perfil y permite reintentar', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.failNext('brand_profiles', 'select', { code: '500', message: 'boom' });
    renderPanel();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
});

describe('describeMeasure', () => {
  it('redacta el dato y el umbral, y calla en lo omitido', () => {
    const base = { check: 'length', severity: 'block', message: '', target: { part: 'caption' } } as const;
    expect(describeMeasure({ ...base, code: 'LENGTH_EXCEEDED', measured: 2300, threshold: 2200 })).toBe(
      'Tiene 2300 caracteres; el máximo es 2200.',
    );
    expect(describeMeasure({ ...base, code: 'PALETTE_OFF_BRAND', measured: 0.1, threshold: 0.2 })).toContain('10 %');
    expect(describeMeasure({ ...base, code: 'CONTRAST_TOO_LOW', measured: 3.2, threshold: 4.5 })).toBe(
      'Contraste 3,2:1; se exige al menos 4,5:1.',
    );
    expect(describeMeasure({ ...base, code: 'ALT_TEXT_MISSING', measured: 0, threshold: 1 })).toBeNull();
    expect(describeMeasure({ ...base, code: 'NETWORK_LIMIT_UNKNOWN', omitted: true })).toBeNull();
  });
});
