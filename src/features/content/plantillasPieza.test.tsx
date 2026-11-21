import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrandRole, BrandDesignTemplateRow, ContentItemRow, OrgRole } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { createEmptyDocument, type ContentDocument, type Layer } from './document';
import type { CanvasViewProps } from './editor/canvas/types';
import { chooseEditorAction, openMoreMenu } from '@/test/moreMenu';

// Crear una pieza a partir de una plantilla de la marca: desde «Nueva idea» y
// desde el editor. El lienzo de Konva se sustituye por un doble que cuenta capas.
vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => (
    <div
      data-testid="canvas-stub"
      data-layers={props.document.layers.length}
      data-ids={props.document.layers.map((l) => l.id).join(',')}
    />
  ),
}));

const CONTENT = `${BRAND_BASE}/contenidos`;
const ASSET = '33333333-3333-4333-8333-333333333333';

function layerBase(id: string) {
  return {
    id,
    name: '',
    x: 0,
    y: 0,
    width: 540,
    height: 540,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    anchor: { x: 'center' as const, y: 'center' as const },
  };
}

const PHOTO: Layer = {
  ...layerBase('foto-plato'),
  type: 'image',
  source: { kind: 'asset', assetId: ASSET },
  fit: 'cover',
  focus: { x: 0.5, y: 0.5 },
} as Layer;
const HEADLINE: Layer = {
  ...layerBase('titular-plantilla'),
  type: 'text',
  text: 'Plato del día',
  fontFamily: 'sans-serif',
  fontSize: 80,
  fontWeight: 700,
  italic: false,
  color: '#111111',
  align: 'center',
  lineHeight: 1.2,
} as Layer;

function templateDocument(): ContentDocument {
  const base = createEmptyDocument({ aspectRatio: '1:1' });
  return {
    ...base,
    pages: [{ id: 'p1', name: '', layers: [PHOTO, HEADLINE] }],
    copy: { ...base.copy, caption: 'Hoy en la carta: …', hashtags: ['platodeldia'] },
  };
}

function templateRow(overrides: Partial<BrandDesignTemplateRow> = {}): BrandDesignTemplateRow {
  return {
    id: 'tpl-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    template_key: 'plato-del-dia',
    name: 'Plato del día',
    network: 'instagram',
    format: 'post',
    document: templateDocument() as unknown as BrandDesignTemplateRow['document'],
    analysis: {
      summary: 'Foto del plato a sangre con el titular centrado.',
      layers: [{ role: 'photo', position: 'fondo', description: '' }],
      typography: [],
      colors: [{ hex: '#111111', role: 'text', note: '' }],
      logo: { position: 'none' },
      photo: { type: 'plato', treatment: '' },
      tone: { description: 'Cercano', samples: [] },
      recurrence: { count: 12, reviewed: 30 },
      examples: [{ permalink: 'https://instagram.com/p/a' }, { permalink: 'https://instagram.com/p/b' }],
    },
    source: 'instagram_import',
    created_by: null,
    created_at: '2026-11-20T09:00:00Z',
    updated_at: '2026-11-20T09:00:00Z',
    ...overrides,
  };
}

function saveRpc() {
  const saved: { contentId: string; data: ContentDocument; note: string }[] = [];
  fake.rpc('save_content_version', (args) => {
    saved.push({
      contentId: args.p_content_id as string,
      data: args.p_data as ContentDocument,
      note: args.p_change_note as string,
    });
    const items = fake.rows('content_items');
    const row = items.find((i) => i.id === args.p_content_id)!;
    Object.assign(row, { current_version: (row.current_version as number) + 1, status: 'draft' });
    return {
      id: 'v-new',
      content_id: args.p_content_id,
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      version: row.current_version,
      schema_version: 4,
      data: args.p_data,
      change_note: args.p_change_note,
      restored_from: null,
      created_by: ME.id,
      created_at: '2026-11-21T09:00:00Z',
    };
  });
  return saved;
}

function idea(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id: 'content-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Idea sin diseño',
    network: 'instagram',
    format: 'post',
    status: 'idea',
    current_version: 0,
    archived_at: null,
    created_by: ME.id,
    created_at: '2026-11-10T09:00:00Z',
    updated_at: '2026-11-10T09:00:00Z',
    ...overrides,
  };
}

function seed(
  role: { orgRole: OrgRole; brandRole?: BrandRole },
  templates: BrandDesignTemplateRow[] = [templateRow()],
) {
  seedWorkspace(role);
  fake.tables.brand_design_templates = templates;
  fake.tables.content_items = [];
  fake.tables.content_versions = [];
  fake.tables.media_assets = [];
}

describe('Nueva idea desde una plantilla', () => {
  it('muestra las plantillas con su análisis y crea la pieza con su documento', async () => {
    seed({ orgRole: 'member', brandRole: 'editor' });
    const saved = saveRpc();
    const { user } = renderApp(CONTENT);
    await user.click(await screen.findByTestId('content-new'));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByTestId('create-content-title'), 'Menú de la semana');
    await user.click(dialog.getByTestId('create-content-from-template'));

    const option = await dialog.findByTestId('template-option');
    expect(option).toHaveTextContent('Plato del día');
    expect(option).toHaveTextContent('Instagram · Publicación');
    expect(option).toHaveTextContent('Foto del plato a sangre con el titular centrado.');
    expect(option).toHaveTextContent('1 foto para sustituir');
    expect(option).toHaveTextContent('en 12 de 30 publicaciones');

    // Sin elegir ninguna, no se crea.
    await user.click(dialog.getByTestId('create-content-submit'));
    expect(await dialog.findByText(/Elige una plantilla/)).toBeInTheDocument();
    expect(fake.rows('content_items')).toHaveLength(0);

    await user.click(option);
    expect(dialog.getByTestId('create-content-network')).toBeDisabled();
    await user.click(dialog.getByTestId('create-content-submit'));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(fake.rows('content_items')[0]).toMatchObject({
      title: 'Menú de la semana',
      network: 'instagram',
      format: 'post',
    });
    expect(saved[0]!.note).toContain('Plato del día');
    // La foto queda como marcador y el texto y el pie vienen como guía.
    expect(saved[0]!.data.pages[0]!.layers.map((l) => l.id)).toEqual(['foto-plato', 'titular-plantilla']);
    expect(saved[0]!.data.copy.caption).toBe('Hoy en la carta: …');
  });

  it('una plantilla manual se ve igual en el selector, con la etiqueta «Manual»', async () => {
    const base = templateRow();
    seed({ orgRole: 'member', brandRole: 'editor' }, [
      templateRow({
        id: 'tpl-m',
        template_key: 'manual',
        name: 'Cartel manual',
        source: 'manual',
        analysis: {
          ...(base.analysis as object),
          examples: [],
          references: [{ url: 'https://www.instagram.com/p/x/', note: 'Pública' }],
        },
      }),
      templateRow({ id: 'tpl-i', template_key: 'importada', name: 'Importada' }),
    ]);
    const { user } = renderApp(CONTENT);
    await user.click(await screen.findByTestId('content-new'));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByTestId('create-content-from-template'));
    const options = await dialog.findAllByTestId('template-option');
    expect(options).toHaveLength(2);
    const manual = options.find((o) => o.getAttribute('data-template-key') === 'manual')!;
    expect(manual).toHaveTextContent('Cartel manual');
    expect(manual).toHaveTextContent('Manual');
    expect(manual).toHaveTextContent('Foto del plato a sangre');
    const importada = options.find((o) => o.getAttribute('data-template-key') === 'importada')!;
    expect(importada).not.toHaveTextContent('Manual');
  });

  it('sin plantillas lo dice y explica cómo conseguirlas', async () => {
    seed({ orgRole: 'member', brandRole: 'editor' }, []);
    const { user } = renderApp(CONTENT);
    await user.click(await screen.findByTestId('content-new'));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByTestId('create-content-from-template'));
    const empty = await dialog.findByTestId('template-empty');
    expect(empty).toHaveTextContent('todavía no tiene plantillas');
    expect(empty).toHaveTextContent('importa las publicaciones');
    expect(empty).toHaveTextContent('agencia');
  });

  it('quien solo lee no puede crear piezas, y por tanto tampoco desde una plantilla', async () => {
    seed({ orgRole: 'member', brandRole: 'viewer' });
    renderApp(CONTENT);
    await screen.findByRole('heading', { name: 'Contenidos' });
    expect(screen.queryByTestId('content-new')).not.toBeInTheDocument();
  });
});

describe('Empezar desde una plantilla en el editor', () => {
  it('sustituye el diseño de una idea vacía por el de la plantilla en un paso que se puede deshacer', async () => {
    seed({ orgRole: 'member', brandRole: 'editor' }, [
      templateRow(),
      // Otra proporción que Instagram no admite para una publicación: no se ofrece.
      templateRow({
        id: 'tpl-2',
        template_key: 'historia',
        name: 'Historia vertical',
        document: {
          ...templateDocument(),
          canvas: { ...templateDocument().canvas, aspectRatio: '9:16', width: 1080, height: 1920 },
        } as unknown as BrandDesignTemplateRow['document'],
      }),
    ]);
    fake.tables.content_items = [idea()];
    const { user } = renderApp(`${CONTENT}/content-1`);
    await screen.findByTestId('editor-title');
    expect(await screen.findByTestId('canvas-stub')).toHaveAttribute('data-layers', '0');

    await chooseEditorAction(user, 'editor-from-template');
    const dialog = within(await screen.findByRole('dialog'));
    const options = await dialog.findAllByTestId('template-option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Plato del día');
    expect(dialog.queryByTestId('template-replace-warning')).not.toBeInTheDocument();
    expect(dialog.getByTestId('template-apply')).toBeDisabled();

    await user.click(options[0]!);
    await user.click(dialog.getByTestId('template-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('canvas-stub')).toHaveAttribute('data-ids', 'foto-plato,titular-plantilla'),
    );
    expect(screen.getByTestId('editor-dirty')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Deshacer/ }));
    await waitFor(() => expect(screen.getByTestId('canvas-stub')).toHaveAttribute('data-layers', '0'));
  });

  it('con la marca sin plantillas lo explica, y el solo lectura no ve el botón', async () => {
    seed({ orgRole: 'member', brandRole: 'editor' }, []);
    fake.tables.content_items = [idea()];
    const first = renderApp(`${CONTENT}/content-1`);
    await screen.findByTestId('editor-title');
    await chooseEditorAction(first.user, 'editor-from-template');
    expect(await screen.findByTestId('template-empty')).toBeInTheDocument();
    first.unmount();

    seed({ orgRole: 'member', brandRole: 'viewer' }, []);
    fake.tables.content_items = [idea()];
    const viewer = renderApp(`${CONTENT}/content-1`);
    await screen.findByTestId('editor-title');
    await openMoreMenu(viewer.user, 'editor-more');
    expect(screen.queryByTestId('editor-from-template')).not.toBeInTheDocument();
  });
});
