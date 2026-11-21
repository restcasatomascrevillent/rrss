import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

// Estado de la extracción de texto de cada fuente, el texto revisable y
// volver a extraer (pestaña «Fuentes» del perfil de marca).

const SOURCES_URL = `${BRAND_BASE}/marca?seccion=fuentes`;

function row(id: string, title: string, extra: Record<string, unknown>) {
  return {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    kind: 'pdf',
    title,
    storage_path: `${ORG_ID}/${BRAND_ID}/sources/${id}.pdf`,
    url: null,
    mime_type: 'application/pdf',
    bytes: 2048,
    status: 'pending',
    error: null,
    created_by: ME.id,
    created_at: '2026-11-10T09:00:00Z',
    updated_at: '2026-11-10T09:00:00Z',
    extracted_text: null,
    extracted_chars: null,
    extraction: null,
    extracted_at: null,
    extraction_job_id: null,
    ...extra,
  };
}

function seed(orgRole: 'owner' | 'member' = 'owner') {
  seedWorkspace({ orgRole });
  fake.tables.brand_knowledge_sources = [
    row('lista', 'Manual.pdf', {
      status: 'ready',
      extracted_text: 'Somos una panadería de barrio.\n\nDesde 1987.',
      extracted_chars: 42,
      extraction: { format: 'pdf', pages: 12, pagesRead: 12, truncated: false },
      extracted_at: '2026-11-10T09:01:00Z',
    }),
    row('web', 'marca.test', {
      kind: 'website',
      storage_path: null,
      url: 'https://marca.test/',
      status: 'ready',
      extracted_text: 'Inicio',
      extracted_chars: 6,
      extraction: {
        format: 'website',
        pages: [{ url: 'https://marca.test/', title: 'Inicio', chars: 6 }],
        skipped: [{ url: 'https://marca.test/privado', reason: 'robots.txt no permite leerla' }],
        truncated: true,
      },
      extracted_at: '2026-11-10T09:01:00Z',
    }),
    row('fallida', 'Escaneo.pdf', {
      status: 'failed',
      error: 'El PDF no tiene texto que leer (¿es un escaneo? No se hace reconocimiento de caracteres).',
    }),
    row('curso', 'Catalogo.pdf', { status: 'processing' }),
    row('reintento', 'Lenta.pdf', { status: 'pending', error: 'Se reintentará: Tiempo agotado' }),
  ];
}

describe('fuentes: extracción de texto', () => {
  it('cada fuente dice su estado, el resumen o el motivo del fallo', async () => {
    seed();
    renderApp(SOURCES_URL);
    const items = await screen.findAllByTestId('source-item');
    const byTitle = (title: string) => items.find((item) => within(item).queryByText(title))!;

    expect(within(byTitle('Manual.pdf')).getByText('Texto listo')).toBeInTheDocument();
    expect(within(byTitle('Manual.pdf')).getByText(/42 caracteres · 12 páginas/)).toBeInTheDocument();
    expect(
      within(byTitle('marca.test')).getByText(/1 página web · 1 omitidas · recortado al máximo/),
    ).toBeInTheDocument();
    expect(within(byTitle('Escaneo.pdf')).getByText('No se pudo extraer')).toBeInTheDocument();
    expect(within(byTitle('Escaneo.pdf')).getByTestId('source-error')).toHaveTextContent(/es un escaneo/);
    expect(within(byTitle('Catalogo.pdf')).getByText('Extrayendo texto')).toBeInTheDocument();
    expect(within(byTitle('Lenta.pdf')).getByText('Pendiente')).toBeInTheDocument();
    expect(within(byTitle('Lenta.pdf')).getByTestId('source-error')).toHaveTextContent(
      'Se reintentará: Tiempo agotado',
    );
  });

  it('el texto extraído se puede revisar, con las páginas leídas y omitidas', async () => {
    seed();
    const { user } = renderApp(SOURCES_URL);
    await user.click(await screen.findByRole('button', { name: 'Ver el texto extraído de marca.test' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('source-text')).toHaveTextContent('Inicio');
    expect(within(dialog).getByText(/se ha recortado/)).toBeInTheDocument();
    expect(within(dialog).getByText('Páginas omitidas (1)')).toBeInTheDocument();
    expect(within(dialog).getByText(/robots\.txt no permite leerla/)).toBeInTheDocument();
  });

  it('quien gestiona la marca puede volver a extraer una fuente fallida', async () => {
    seed();
    fake.rpc('request_source_extraction', (args) => {
      const target = fake.rows('brand_knowledge_sources').find((r) => r.id === args.p_source_id)!;
      Object.assign(target, { status: 'pending', error: null });
      return target;
    });
    const { user } = renderApp(SOURCES_URL);
    await user.click(await screen.findByRole('button', { name: 'Volver a extraer el texto de Escaneo.pdf' }));
    await screen.findByText('Se volverá a extraer el texto');
    expect(fake.callsTo('request_source_extraction', 'rpc')[0]!.payload).toEqual({ p_source_id: 'fallida' });
  });
});
