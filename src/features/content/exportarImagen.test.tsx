import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentVersionRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { createEmptyDocument, type ContentDocument } from './document';
import type { CanvasViewProps } from './editor/canvas/types';
import * as libraryApi from '@/features/library/api';
import { ExportError, exportErrors } from './export/options';
import { chooseEditorAction } from '@/test/moreMenu';

// Exportar imagen desde el editor: el diálogo, las opciones, el aviso de cambios
// sin guardar y la procedencia que se guarda en la biblioteca. El lienzo de Konva
// y el dibujo de la exportación se sustituyen por dobles (jsdom no tiene <canvas>).

vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => <div data-testid="canvas-stub" data-layers={props.document.layers.length} />,
}));

const mocks = vi.hoisted(() => ({
  renderDocument: vi.fn(),
  uploadAsset: vi.fn(),
  download: vi.fn(),
}));

vi.mock('@/features/content/editor/canvas/exporter', () => ({ renderDocument: mocks.renderDocument }));

const EDITOR = `${BRAND_BASE}/contenidos/content-1`;

function documentWithText(): ContentDocument {
  const doc = createEmptyDocument({ aspectRatio: '4:5' });
  return {
    ...doc,
    pages: [{ id: 'p1', name: '', layers: [
      {
        id: 'titular',
        type: 'text',
        name: '',
        x: 100,
        y: 100,
        width: 800,
        height: 200,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        anchor: { x: 'center', y: 'center' },
        text: 'Titular',
        fontFamily: 'sans-serif',
        fontSize: 80,
        fontWeight: 700,
        italic: false,
        color: '#111111',
        align: 'center',
        lineHeight: 1.2,
      },
    ] }],
  };
}

function seed(role: { orgRole: 'owner' | 'member'; brandRole?: 'editor' | 'viewer' }) {
  seedWorkspace(role);
  fake.tables.content_items = [
    {
      id: 'content-1',
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      title: 'Menú de otoño',
      network: 'instagram',
      format: 'post',
      status: 'draft',
      current_version: 3,
      archived_at: null,
      created_by: ME.id,
      created_at: '2026-11-10T09:00:00Z',
      updated_at: '2026-11-10T09:00:00Z',
    },
  ];
  const row = (n: number): ContentVersionRow => ({
    id: `v-${n}`,
    content_id: 'content-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    version: n,
    schema_version: 1,
    data: documentWithText() as unknown as ContentVersionRow['data'],
    change_note: '',
    restored_from: null,
    created_by: ME.id,
    created_at: `2026-11-1${n}T09:00:00Z`,
  });
  fake.tables.content_versions = [row(1), row(2), row(3)];
  fake.rpc('save_content_version', (args) => {
    const next = (fake.rows('content_items')[0]!.current_version as number) + 1;
    const saved = {
      ...row(next),
      data: args.p_data as ContentVersionRow['data'],
      change_note: args.p_change_note as string,
    };
    fake.rows('content_versions').push(saved);
    fake.rows('content_items')[0]!.current_version = next;
    return saved;
  });
}

async function openEditor(role: Parameters<typeof seed>[0]) {
  seed(role);
  const app = renderApp(EDITOR);
  await screen.findByTestId('editor-title');
  return app;
}

async function openDialog(user: Awaited<ReturnType<typeof openEditor>>['user']) {
  await chooseEditorAction(user, 'editor-export');
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => {
  // Los módulos de la biblioteca ya están cargados por la preparación común: se espía la función.
  vi.spyOn(libraryApi, 'uploadAsset').mockImplementation(mocks.uploadAsset);
  // jsdom no crea direcciones de objeto ni descarga: se anota el nombre del archivo que se descargaría.
  URL.createObjectURL = vi.fn(() => 'blob:prueba');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    mocks.download(this.download);
  });
  mocks.renderDocument.mockReset();
  mocks.uploadAsset.mockReset();
  mocks.download.mockReset();
  mocks.renderDocument.mockResolvedValue({ blob: new Blob(['x'], { type: 'image/png' }), width: 1080, height: 1350 });
  mocks.uploadAsset.mockResolvedValue({ id: 'asset-1' });
});

describe('Exportar imagen', () => {
  it('descarga la imagen a tamaño real con un nombre legible y sin tocar la biblioteca si no se pide', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    const dialog = await openDialog(user);
    expect(dialog.getByTestId('export-name')).toHaveValue('menu-de-otono-1080x1350-v3.png');
    expect(dialog.queryByTestId('export-dirty-notice')).not.toBeInTheDocument();

    await user.click(dialog.getByTestId('export-library'));
    await user.click(dialog.getByTestId('export-confirm'));

    expect(await dialog.findByTestId('export-done')).toHaveTextContent('menu-de-otono-1080x1350-v3.png');
    expect(mocks.renderDocument).toHaveBeenCalledWith(
      expect.objectContaining({ canvas: expect.objectContaining({ width: 1080, height: 1350 }) }),
      expect.anything(),
      { format: 'png', quality: 0.92, pixelRatio: 1 },
    );
    expect(mocks.download).toHaveBeenCalledWith('menu-de-otono-1080x1350-v3.png');
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
  });

  it('guarda en la biblioteca con la procedencia: pieza, versión, formato y tamaño', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    const dialog = await openDialog(user);
    await user.click(dialog.getByTestId('export-format-jpeg'));
    await user.click(dialog.getByTestId('export-download'));
    expect(dialog.getByTestId('export-name')).toHaveValue('menu-de-otono-1080x1350-v3.jpg');
    await user.click(dialog.getByTestId('export-confirm'));

    await dialog.findByTestId('export-done');
    expect(mocks.download).not.toHaveBeenCalled();
    const input = mocks.uploadAsset.mock.calls[0]![0] as {
      file: File;
      brandId: string;
      organizationId: string;
      folder: string;
      provenance: Record<string, unknown>;
    };
    expect(input).toMatchObject({ brandId: BRAND_ID, organizationId: ORG_ID, folder: 'Exportaciones' });
    expect(input.file.name).toBe('menu-de-otono-1080x1350-v3.jpg');
    expect(input.file.type).toBe('image/jpeg');
    expect(input.provenance).toMatchObject({
      type: 'export',
      content_id: 'content-1',
      version: 3,
      unsaved_changes: false,
      format: 'jpeg',
      width: 1080,
      height: 1350,
      pixel_ratio: 1,
    });
    expect(dialog.getByRole('link', { name: 'Ver en la biblioteca' })).toHaveAttribute(
      'href',
      `${BRAND_BASE}/biblioteca`,
    );
  });

  it('con cambios sin guardar avisa y, por omisión, guarda antes una versión para que la procedencia sea exacta', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    await user.click(screen.getByTestId('add-text'));
    const dialog = await openDialog(user);
    expect(dialog.getByTestId('export-dirty-notice')).toHaveTextContent('cambios sin guardar');
    expect(dialog.getByTestId('export-save-first')).toBeChecked();
    expect(dialog.getByTestId('export-name')).toHaveValue('menu-de-otono-1080x1350-v4.png');

    await user.click(dialog.getByTestId('export-confirm'));
    await dialog.findByTestId('export-done');

    expect(fake.callsTo('save_content_version', 'rpc')).toHaveLength(1);
    expect(mocks.renderDocument.mock.calls[0]![0].layers).toHaveLength(2);
    expect(mocks.uploadAsset.mock.calls[0]![0].provenance).toMatchObject({ version: 4, unsaved_changes: false });
    expect(mocks.uploadAsset.mock.calls[0]![0].file.name).toBe('menu-de-otono-1080x1350-v4.png');
    expect(screen.getByTestId('editor-version')).toHaveTextContent('Versión 4');
  });

  it('si no se guarda antes, la procedencia lo dice: versión base y cambios sin guardar', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    await user.click(screen.getByTestId('add-text'));
    const dialog = await openDialog(user);
    await user.click(dialog.getByTestId('export-save-first'));
    expect(dialog.getByTestId('export-name')).toHaveValue('menu-de-otono-1080x1350-v3-borrador.png');
    await user.click(dialog.getByTestId('export-confirm'));
    await dialog.findByTestId('export-done');

    expect(fake.callsTo('save_content_version', 'rpc')).toHaveLength(0);
    expect(mocks.uploadAsset.mock.calls[0]![0].provenance).toMatchObject({ version: 3, unsaved_changes: true });
    expect(screen.getByTestId('editor-dirty')).toBeInTheDocument();
  });

  it('si no se puede guardar la versión, no exporta nada', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    fake.rpc('save_content_version', () => {
      throw { code: 'CT001', message: 'Otra persona ha guardado una versión más reciente de este contenido.' };
    });
    await user.click(screen.getByTestId('add-text'));
    const dialog = await openDialog(user);
    await user.click(dialog.getByTestId('export-confirm'));
    expect(await dialog.findByTestId('export-error')).toHaveTextContent('no se ha exportado nada');
    expect(mocks.renderDocument).not.toHaveBeenCalled();
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
  });

  it('explica qué imagen impide exportar y no descarga ni guarda nada', async () => {
    mocks.renderDocument.mockRejectedValue(exportErrors.tainted(['«Foto del plato»']));
    const { user } = await openEditor({ orgRole: 'owner' });
    const dialog = await openDialog(user);
    await user.click(dialog.getByTestId('export-confirm'));
    const error = await dialog.findByTestId('export-error');
    expect(error).toHaveTextContent('«Foto del plato»');
    expect(error).toHaveTextContent('CORS');
    expect(error).toHaveTextContent('Ctrl+F5');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
    expect(dialog.getByTestId('export-confirm')).toBeEnabled();
  });

  it('si la biblioteca falla tras descargar, lo dice y deja reintentar', async () => {
    mocks.uploadAsset.mockRejectedValue({ code: '42501', message: 'permission denied' });
    const { user } = await openEditor({ orgRole: 'owner' });
    const dialog = await openDialog(user);
    await user.click(dialog.getByTestId('export-confirm'));
    expect(await dialog.findByTestId('export-error')).toBeInTheDocument();
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(dialog.queryByTestId('export-done')).not.toBeInTheDocument();
  });

  it('el calidad solo se ofrece en JPEG y viaja en las opciones; el doble tamaño también', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    const dialog = await openDialog(user);
    expect(dialog.queryByTestId('export-quality')).not.toBeInTheDocument();
    await user.click(dialog.getByTestId('export-format-jpeg'));
    expect(dialog.getByTestId('export-quality')).toBeInTheDocument();
    await user.click(dialog.getByTestId('export-ratio-2'));
    expect(dialog.getByTestId('export-name')).toHaveValue('menu-de-otono-2160x2700-v3.jpg');
    await user.click(dialog.getByTestId('export-confirm'));
    await dialog.findByTestId('export-done');
    expect(mocks.renderDocument.mock.calls[0]![2]).toEqual({ format: 'jpeg', quality: 0.92, pixelRatio: 2 });
  });

  it('quien solo mira puede descargar pero no guardar en la biblioteca', async () => {
    const { user } = await openEditor({ orgRole: 'member', brandRole: 'viewer' });
    const dialog = await openDialog(user);
    expect(dialog.getByTestId('export-library')).toBeDisabled();
    expect(dialog.getByTestId('export-library')).not.toBeChecked();
    await user.click(dialog.getByTestId('export-confirm'));
    await dialog.findByTestId('export-done');
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
  });

  it('no deja exportar sin elegir descarga ni biblioteca', async () => {
    const { user } = await openEditor({ orgRole: 'owner' });
    const dialog = await openDialog(user);
    await user.click(dialog.getByTestId('export-download'));
    await user.click(dialog.getByTestId('export-library'));
    await waitFor(() => expect(dialog.getByTestId('export-confirm')).toBeDisabled());
  });
});

describe('ExportError', () => {
  it('es reconocible por su nombre aunque venga de otro módulo', () => {
    const error = exportErrors.imageLoad(['«Logo»']);
    expect(error).toBeInstanceOf(ExportError);
    expect(error.name).toBe('ExportError');
    expect(error.message).toContain('«Logo»');
  });
});
