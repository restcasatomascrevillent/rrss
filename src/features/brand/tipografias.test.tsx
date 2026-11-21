import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDocument } from '@/features/content/document';
import type { CanvasViewProps } from '@/features/content/editor/canvas/types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

// Tipografías de la marca: subirlas (con la declaración de licencia) en la
// pestaña «Identidad visual» y cargarlas con FontFace en el editor antes de
// dibujar. FontFace y document.fonts son dobles (jsdom no los tiene).

vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => <div data-testid="canvas-stub" data-layers={props.document.layers.length} />,
}));

const FONT_PATH = `${ORG_ID}/${BRAND_ID}/fonts/f-1-marca-bold.woff2`;

function fontRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'font-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    family: 'Marca Propia',
    weight: 700,
    style: 'normal',
    format: 'woff2',
    storage_path: FONT_PATH,
    file_name: 'Marca-Bold.woff2',
    mime_type: 'font/woff2',
    bytes: 20480,
    license_confirmed: true,
    license_note: null,
    created_by: ME.id,
    created_at: '2026-11-18T09:00:00Z',
    ...extra,
  };
}

/** Doble de FontFace: la carga se resuelve cuando la prueba lo dice. */
function stubFontFace() {
  const created: Array<{ family: string; descriptors: unknown }> = [];
  const added: string[] = [];
  let release: () => void = () => undefined;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  class FakeFontFace {
    constructor(
      public family: string,
      _source: ArrayBuffer,
      descriptors?: unknown,
    ) {
      created.push({ family, descriptors });
    }
    load() {
      return loaded.then(() => this);
    }
  }
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: FakeFontFace) => added.push(face.family), load: async () => [], ready: Promise.resolve() },
  });
  return { created, added, release: () => release() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(document, 'fonts');
});

describe('subir tipografías de la marca', () => {
  it('pide familia, peso y la declaración de licencia; la ruta va a la carpeta fonts de la marca', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.brand_fonts = [];
    const { user } = renderApp(`${BRAND_BASE}/marca?seccion=visual`);
    await screen.findByText('Tipografías de la marca');
    expect(screen.getByText(/Quien la sube lo declara/)).toBeInTheDocument();

    await user.upload(
      screen.getByTestId('font-file-input'),
      new File(['fuente'], 'Marca-BoldItalic.ttf', { type: '' }),
    );
    const form = await screen.findByTestId('font-form');
    expect(within(form).getByLabelText('Familia')).toHaveValue('Marca');
    expect(within(form).getByLabelText('Peso')).toHaveValue('700');
    expect(within(form).getByLabelText('Estilo')).toHaveValue('italic');
    // Sin declarar la licencia no se puede añadir.
    expect(within(form).getByTestId('font-upload')).toBeDisabled();
    await user.click(within(form).getByTestId('font-license'));
    await user.click(within(form).getByTestId('font-upload'));

    await screen.findByText('Tipografía «Marca» añadida');
    const inserted = fake.callsTo('brand_fonts', 'insert')[0]!.payload as Record<string, unknown>;
    expect(inserted).toMatchObject({
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      family: 'Marca',
      weight: 700,
      style: 'italic',
      format: 'ttf',
      mime_type: 'font/ttf',
      license_confirmed: true,
    });
    expect(String(inserted.storage_path)).toMatch(
      new RegExp(`^${ORG_ID}/${BRAND_ID}/fonts/.+-marca-bolditalic\\.ttf$`),
    );
  });

  it('rechaza lo que no es una fuente', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.brand_fonts = [];
    renderApp(`${BRAND_BASE}/marca?seccion=visual`);
    await screen.findByText('Tipografías de la marca');
    // Sin pasar por el filtro `accept` del selector de archivos (se puede saltar arrastrando).
    fireEvent.change(screen.getByTestId('font-file-input'), {
      target: { files: [new File(['x'], 'marca.zip', { type: 'application/zip' })] },
    });
    expect(await screen.findByText(/no es una fuente \.woff2/)).toBeInTheDocument();
    expect(screen.queryByTestId('font-form')).not.toBeInTheDocument();
  });

  it('con el trabajador de medios activo dice qué tipografía usarán los reels', async () => {
    vi.stubEnv('VITE_MEDIA_WORKER_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.brand_fonts = [fontRow()];
    fake.rpc('brand_reel_font_info', () => []);
    stubFontFace().release();
    renderApp(`${BRAND_BASE}/marca?seccion=visual`);
    expect(await screen.findByTestId('reel-font')).toHaveTextContent(/hace falta un archivo \.ttf u \.otf/);
  });
});

describe('el editor carga las tipografías de la marca', () => {
  function seedEditor() {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.brand_fonts = [fontRow()];
    fake.files[FONT_PATH] = 'datos de la fuente';
    fake.tables.content_items = [
      {
        id: 'content-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        title: 'Cartel',
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
        data: createEmptyDocument({ aspectRatio: '4:5' }),
        change_note: '',
        restored_from: null,
        created_by: ME.id,
        created_at: '2026-11-11T09:00:00Z',
      },
    ];
  }

  it('no dibuja hasta tenerlas cargadas con FontFace, y las ofrece primero', async () => {
    seedEditor();
    const fonts = stubFontFace();
    const { user } = renderApp(`${BRAND_BASE}/contenidos/content-1`);
    expect(await screen.findByText('Cargando las tipografías de la marca…')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-stub')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fonts.created).toEqual([
        { family: 'Marca Propia', descriptors: { weight: '700', style: 'normal', display: 'block' } },
      ]),
    );

    fonts.release();
    expect(await screen.findByTestId('canvas-stub')).toBeInTheDocument();
    expect(fonts.added).toEqual(['Marca Propia']);

    // Un texto nuevo nace con la tipografía de la marca, la primera del selector.
    await user.click(screen.getByTestId('add-text'));
    const select = await screen.findByLabelText('Tipografía');
    const options = within(select as HTMLElement).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Marca Propia (marca)');
    expect(select).toHaveValue('Marca Propia');
  });

  it('si un archivo no carga, el editor dibuja igualmente con la de reserva', async () => {
    seedEditor();
    fake.files = {};
    stubFontFace();
    renderApp(`${BRAND_BASE}/contenidos/content-1`);
    expect(await screen.findByTestId('canvas-stub')).toBeInTheDocument();
  });
});
