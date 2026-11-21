import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentItemRow, ContentVersionRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { createEmptyDocument, DOCUMENT_SCHEMA_VERSION, type ContentDocument, type Layer } from './document';
import type { CanvasViewProps } from './editor/canvas/types';
import * as libraryApi from '@/features/library/api';
import { chooseEditorAction } from '@/test/moreMenu';

// Carruseles en el editor: tira de páginas (elegir, añadir, duplicar, borrar,
// reordenar arrastrando o con los botones), deshacer por página y en general,
// vista previa con flechas y exportación de todas las páginas. El lienzo de
// Konva se sustituye por un doble que enseña las capas de la página que recibe.
vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => (
    <div data-testid="canvas-stub" data-label={props.label}>
      {props.document.layers.map((layer) => (
        <button key={layer.id} type="button" data-testid={`stub-${layer.id}`} onClick={() => props.onSelect(layer.id)}>
          {layer.id}
        </button>
      ))}
    </div>
  ),
}));

const mocks = vi.hoisted(() => ({ renderDocument: vi.fn(), uploadAsset: vi.fn() }));
const renderDocument = mocks.renderDocument;
vi.mock('@/features/content/editor/canvas/exporter', () => ({ renderDocument: mocks.renderDocument }));

const EDITOR = `${BRAND_BASE}/contenidos/content-1`;

function shape(id: string): Layer {
  return {
    id,
    type: 'shape',
    name: '',
    x: 100,
    y: 100,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    anchor: { x: 'center', y: 'center' },
    shape: 'rectangle',
    fill: '#E5E7EB',
    stroke: null,
    cornerRadius: 0,
  };
}

function seed(format = 'carousel', pages: Layer[][] = [[shape('a')], [shape('b')], [shape('c')]]) {
  seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
  const base = createEmptyDocument({ aspectRatio: '4:5' });
  const document: ContentDocument = {
    ...base,
    pages: pages.map((layers, i) => ({ id: `p${i + 1}`, name: '', layers })),
    copy: { ...base.copy, caption: 'Tres platos' },
  };
  const item: ContentItemRow = {
    id: 'content-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Menú de otoño',
    network: 'instagram',
    format,
    status: 'draft',
    current_version: 1,
    archived_at: null,
    created_by: ME.id,
    created_at: '2026-11-10T09:00:00Z',
    updated_at: '2026-11-10T09:00:00Z',
  };
  const version: ContentVersionRow = {
    id: 'v-1',
    content_id: 'content-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    version: 1,
    schema_version: DOCUMENT_SCHEMA_VERSION,
    data: document as unknown as ContentVersionRow['data'],
    change_note: '',
    restored_from: null,
    created_by: ME.id,
    created_at: '2026-11-11T09:00:00Z',
  };
  fake.tables.content_items = [item];
  fake.tables.content_versions = [version];
}

async function openEditor(format?: string, pages?: Layer[][]) {
  seed(format, pages);
  const app = renderApp(EDITOR);
  await screen.findByTestId('canvas-stub');
  return app;
}

const thumbs = () => screen.getAllByTestId('page-thumb');
const order = () => thumbs().map((t) => t.getAttribute('data-page-id'));
const canvasLayers = () =>
  within(screen.getByTestId('canvas-stub'))
    .queryAllByRole('button')
    .map((b) => b.textContent);

beforeEach(() => {
  vi.spyOn(libraryApi, 'uploadAsset').mockImplementation(mocks.uploadAsset);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  renderDocument.mockReset();
  renderDocument.mockResolvedValue({ blob: new Blob(['x'], { type: 'image/jpeg' }), width: 1080, height: 1350 });
  mocks.uploadAsset.mockReset();
  mocks.uploadAsset.mockResolvedValue({ id: 'asset-1' });
  URL.createObjectURL = vi.fn(() => 'blob:vista-previa');
  URL.revokeObjectURL = vi.fn();
});

describe('Editor de carruseles: páginas', () => {
  it('la tira enseña las páginas; la activa es la que se ve y se edita en el lienzo', async () => {
    const { user } = await openEditor();
    expect(order()).toEqual(['p1', 'p2', 'p3']);
    expect(thumbs()[0]).toHaveAttribute('aria-current', 'true');
    expect(canvasLayers()).toEqual(['a']);
    expect(screen.getByTestId('page-status')).toHaveTextContent('3 de 10 páginas como máximo');

    await user.click(thumbs()[1]!);
    expect(canvasLayers()).toEqual(['b']);
    expect(screen.getByTestId('canvas-stub')).toHaveAttribute('data-label', expect.stringMatching(/página 2 de 3/));
    // Una capa nueva va a la página activa.
    await user.click(screen.getByTestId('add-rectangle'));
    expect(canvasLayers()).toHaveLength(2);
    await user.click(thumbs()[0]!);
    expect(canvasLayers()).toEqual(['a']);
    expect(screen.getByTestId('editor-dirty')).toBeInTheDocument();
  });

  it('añadir, duplicar y borrar páginas; deshacer lo devuelve todo', async () => {
    const { user } = await openEditor();
    await user.click(thumbs()[0]!);
    await user.click(screen.getByTestId('page-duplicate'));
    expect(thumbs()).toHaveLength(4);
    // La copia queda detrás del original y elegida, con una capa nueva (otro identificador).
    expect(thumbs()[1]).toHaveAttribute('aria-current', 'true');
    expect(canvasLayers()).toHaveLength(1);
    expect(canvasLayers()[0]).not.toBe('a');

    await user.click(screen.getByTestId('page-add'));
    expect(thumbs()).toHaveLength(5);
    expect(canvasLayers()).toEqual([]);

    await user.click(screen.getByTestId('page-remove'));
    expect(thumbs()).toHaveLength(4);

    await user.click(screen.getByTestId('undo'));
    expect(thumbs()).toHaveLength(5);
    await user.click(screen.getByTestId('undo'));
    await user.click(screen.getByTestId('undo'));
    expect(order()).toEqual(['p1', 'p2', 'p3']);
    expect(screen.queryByTestId('editor-dirty')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('redo'));
    expect(thumbs()).toHaveLength(4);
  });

  it('deshacer un cambio de otra página vuelve a esa página', async () => {
    const { user } = await openEditor();
    await user.click(thumbs()[2]!);
    await user.click(screen.getByTestId('stub-c'));
    await user.keyboard('{Delete}');
    expect(canvasLayers()).toEqual([]);
    await user.click(thumbs()[0]!);
    expect(canvasLayers()).toEqual(['a']);
    await user.click(screen.getByTestId('undo'));
    expect(thumbs()[2]).toHaveAttribute('aria-current', 'true');
    expect(canvasLayers()).toEqual(['c']);
  });

  it('reordena con los botones y arrastrando una miniatura sobre otra', async () => {
    const { user } = await openEditor();
    await user.click(thumbs()[0]!);
    await user.click(screen.getByTestId('page-move-right'));
    expect(order()).toEqual(['p2', 'p1', 'p3']);
    expect(screen.getByTestId('page-move-left')).not.toBeDisabled();

    // Arrastrar la página 3 sobre la primera posición.
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: 'move',
    };
    const source = thumbs()[2]!;
    const target = thumbs()[0]!.closest('li')!;
    fireEvent(source, Object.assign(createEvent.dragStart(source), { dataTransfer }));
    fireEvent(target, Object.assign(createEvent.dragOver(target), { dataTransfer }));
    fireEvent(target, Object.assign(createEvent.drop(target), { dataTransfer }));
    expect(order()).toEqual(['p3', 'p2', 'p1']);

    await user.click(screen.getByTestId('undo'));
    expect(order()).toEqual(['p2', 'p1', 'p3']);
  });

  it('un post de una página no enseña la tira; uno de varias sí, para poder quitarlas', async () => {
    await openEditor('post', [[shape('a')]]);
    expect(screen.queryByTestId('page-strip')).not.toBeInTheDocument();
  });

  it('un post con varias páginas avisa de que sobran y no deja añadir más', async () => {
    await openEditor('post', [[shape('a')], [shape('b')]]);
    expect(screen.getByTestId('page-status')).toHaveTextContent('Sobran páginas');
    expect(screen.getByTestId('page-add')).toBeDisabled();
  });

  it('vista previa de carrusel con flechas, como en Instagram', async () => {
    const { user } = await openEditor();
    await chooseEditorAction(user, 'editor-preview');
    const preview = await screen.findByTestId('network-preview');
    await waitFor(() => expect(renderDocument).toHaveBeenCalledTimes(3));
    expect(within(preview).getByTestId('preview-counter')).toHaveTextContent('1/3');
    expect(within(preview).queryByTestId('preview-prev')).not.toBeInTheDocument();
    await user.click(within(preview).getByTestId('preview-next'));
    await user.click(within(preview).getByTestId('preview-next'));
    expect(within(preview).getByTestId('preview-counter')).toHaveTextContent('3/3');
    expect(within(preview).queryByTestId('preview-next')).not.toBeInTheDocument();
    expect(within(preview).getByTestId('preview-image')).toHaveAttribute('alt', expect.stringMatching(/Página 3 de 3/));
    await user.click(within(preview).getByTestId('preview-prev'));
    expect(within(preview).getByTestId('preview-counter')).toHaveTextContent('2/3');
  });

  it('«Exportar» un carrusel dibuja todas las páginas en JPEG y las guarda con su número de página', async () => {
    const { user } = await openEditor();
    await chooseEditorAction(user, 'editor-export');
    expect(await screen.findByTestId('export-pages-notice')).toHaveTextContent('3 páginas');
    expect(screen.queryByTestId('export-format-png')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('export-download'));
    await user.click(screen.getByTestId('export-confirm'));
    await screen.findByTestId('export-done');
    expect(renderDocument).toHaveBeenCalledTimes(3);
    // Cada llamada recibe la página que toca, en orden.
    const drawn = renderDocument.mock.calls.map((call) => (call as unknown as [{ layers: Layer[] }])[0].layers[0]!.id);
    expect(drawn).toEqual(['a', 'b', 'c']);
    const inserts = mocks.uploadAsset.mock.calls.map(
      (c) => c[0] as { file: File; provenance: { page: number; page_count: number; format: string } },
    );
    expect(inserts).toHaveLength(3);
    expect(inserts.map((r) => r.file.type)).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
    expect(inserts.map((r) => r.provenance.page)).toEqual([1, 2, 3]);
    expect(inserts.every((r) => r.provenance.page_count === 3 && r.provenance.format === 'jpeg')).toBe(true);
    expect(inserts.map((r) => r.file.name)).toEqual([
      'menu-de-otono-1080x1350-v1-p1.jpg',
      'menu-de-otono-1080x1350-v1-p2.jpg',
      'menu-de-otono-1080x1350-v1-p3.jpg',
    ]);
  });
});
