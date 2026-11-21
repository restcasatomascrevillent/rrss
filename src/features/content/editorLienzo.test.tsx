import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentItemRow, ContentStatus, ContentVersionRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import {
  createEmptyDocument,
  DOCUMENT_SCHEMA_VERSION,
  type AspectRatio,
  type ContentDocument,
  type Layer,
  type TextLayer,
} from './document';
import { TextEditOverlay } from './editor/canvas/TextEditOverlay';
import { textEditStyle } from './editor/canvas/textEditStyle';
import type { CanvasViewProps } from './editor/canvas/types';
import { settingsChanges } from './editor/pieceSettings';
import { captionPreview, previewFrameOf, showsCaption } from './editor/preview/frames';
import { getFormatSpec } from './networks';
import { chooseEditorAction } from '@/test/moreMenu';

// Selección múltiple, texto sobre el lienzo, zonas seguras, vista previa y
// nombre y red. El lienzo de Konva se sustituye por un doble: cada capa es un
// botón (clic = elegir, con Mayúsculas = añadir; doble clic = escribir encima)
// y enseña lo que el editor le pasa (selección, texto en edición, zona segura).
vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => (
    <div
      data-testid="canvas-stub"
      data-selected={props.selectedIds.join(',')}
      data-editing={props.editingTextId ?? ''}
      data-safe-zone={props.safeZone ? props.safeZone.unsafe.length : 0}
    >
      {props.document.layers.map((layer) => (
        <button
          key={layer.id}
          type="button"
          data-testid={`stub-${layer.id}`}
          data-x={layer.x}
          data-y={layer.y}
          onClick={(event) => props.onSelect(layer.id, { toggle: event.shiftKey })}
          onDoubleClick={() => props.onEditText(layer.id)}
        >
          {layer.type === 'text' ? layer.text : layer.id}
        </button>
      ))}
      <button type="button" data-testid="stub-marquee" onClick={() => props.onSelectMany(['a', 'b'], false)} />
      {props.editingTextId && (
        <button
          type="button"
          data-testid="stub-commit"
          onClick={() => props.onTextCommit(props.editingTextId!, 'Escrito en el lienzo')}
        />
      )}
    </div>
  ),
}));

vi.mock('@/features/content/editor/canvas/exporter', () => ({
  renderDocument: vi.fn(async () => ({ blob: new Blob(['x'], { type: 'image/jpeg' }), width: 540, height: 540 })),
}));

const EDITOR = `${BRAND_BASE}/contenidos/content-1`;

function shape(id: string, x: number, y: number): Layer {
  return {
    id,
    type: 'shape',
    name: '',
    x,
    y,
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

function text(id: string, value: string, overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    id,
    type: 'text',
    name: '',
    x: 100,
    y: 400,
    width: 800,
    height: 200,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    anchor: { x: 'center', y: 'center' },
    text: value,
    fontFamily: 'Playfair Display',
    fontSize: 80,
    fontWeight: 700,
    italic: true,
    color: '#123456',
    align: 'right',
    lineHeight: 1.3,
    ...overrides,
  };
}

function seed(
  options: { status?: ContentStatus; format?: string; ratio?: AspectRatio; layers?: Layer[]; caption?: string } = {},
) {
  seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
  const base = createEmptyDocument({ aspectRatio: options.ratio ?? '1:1' });
  const document: ContentDocument = {
    ...base,
    pages: [{ id: 'p1', name: '', layers: options.layers ?? [shape('a', 100, 100), shape('b', 400, 300), shape('c', 700, 600), text('t', 'Hola')] }],
    copy: { ...base.copy, caption: options.caption ?? '' },
  };
  const item: ContentItemRow = {
    id: 'content-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Menú de otoño',
    network: 'instagram',
    format: options.format ?? 'post',
    status: options.status ?? 'draft',
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

async function openEditor(options?: Parameters<typeof seed>[0]) {
  seed(options);
  const app = renderApp(EDITOR);
  await screen.findByTestId('canvas-stub');
  return app;
}

const stub = () => screen.getByTestId('canvas-stub');

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:vista-previa');
  URL.revokeObjectURL = vi.fn();
});

describe('Editor: varias capas', () => {
  it('Mayúsculas añade capas; el panel las alinea, las mueve con las flechas y las borra juntas', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByTestId('stub-a'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('stub-b'));
    await user.keyboard('{/Shift}');
    expect(stub()).toHaveAttribute('data-selected', 'a,b');
    expect(screen.getByTestId('multi-selection-panel')).toHaveTextContent('2 capas elegidas');
    // Con dos no se puede repartir.
    expect(screen.getByTestId('distribute-horizontal')).toBeDisabled();

    await user.click(screen.getByTestId('align-left'));
    expect(screen.getByTestId('stub-b')).toHaveAttribute('data-x', '100');

    screen.getByTestId('stub-a').focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('stub-a')).toHaveAttribute('data-y', '101');
    expect(screen.getByTestId('stub-b')).toHaveAttribute('data-y', '301');

    await user.keyboard('{Delete}');
    expect(screen.queryByTestId('stub-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-b')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('undo'));
    expect(screen.getByTestId('stub-a')).toBeInTheDocument();
  });

  it('el rectángulo elige varias; agrupadas, un clic elige el grupo y el panel de capas lo enseña', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByTestId('stub-marquee'));
    expect(stub()).toHaveAttribute('data-selected', 'a,b');
    await user.click(screen.getByTestId('group'));
    await user.click(screen.getByTestId('stub-c'));
    expect(stub()).toHaveAttribute('data-selected', 'c');
    await user.click(screen.getByTestId('stub-b'));
    expect(stub()).toHaveAttribute('data-selected', 'a,b');

    await user.click(screen.getByRole('tab', { name: /Capas/ }));
    expect(screen.getAllByTestId('layer-group')).toHaveLength(2);
    // Desde el panel se elige una sola capa del grupo; con Ctrl se suma otra.
    const items = within(screen.getByTestId('layers-list')).getAllByTestId('layer-item');
    await user.click(items[2]!); // b (la lista va de delante a atrás: t, c, b, a)
    expect(stub()).toHaveAttribute('data-selected', 'b');
    await user.keyboard('{Control>}');
    await user.click(items[1]!);
    await user.keyboard('{/Control}');
    expect(stub()).toHaveAttribute('data-selected', 'b,c');

    // Ctrl+Mayús+G desagrupa.
    await user.click(screen.getByTestId('stub-a'));
    screen.getByTestId('stub-a').focus();
    await user.keyboard('{Control>}{Shift>}g{/Shift}{/Control}');
    expect(screen.queryAllByTestId('layer-group')).toHaveLength(0);
  });

  it('con tres o más, reparte el espacio', async () => {
    const { user } = await openEditor({ layers: [shape('a', 0, 0), shape('b', 150, 0), shape('c', 900, 0)] });
    await user.click(screen.getByTestId('stub-a'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByTestId('stub-b'));
    await user.click(screen.getByTestId('stub-c'));
    await user.keyboard('{/Shift}');
    await user.click(screen.getByTestId('distribute-horizontal'));
    expect(screen.getByTestId('stub-b')).toHaveAttribute('data-x', '450');
  });
});

describe('Editor: escribir el texto sobre el lienzo', () => {
  it('doble clic abre la edición sobre el lienzo y confirmar cambia el texto en un paso de deshacer', async () => {
    const { user } = await openEditor();
    await user.dblClick(screen.getByTestId('stub-t'));
    expect(stub()).toHaveAttribute('data-editing', 't');
    await user.click(screen.getByTestId('stub-commit'));
    expect(stub()).toHaveAttribute('data-editing', '');
    expect(screen.getByTestId('stub-t')).toHaveTextContent('Escrito en el lienzo');
    expect(screen.getByTestId('layer-text')).toHaveValue('Escrito en el lienzo');
    await user.click(screen.getByTestId('undo'));
    expect(screen.getByTestId('stub-t')).toHaveTextContent('Hola');
  });

  it('Intro con el texto elegido, desde el lienzo, también lo abre', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByTestId('stub-t'));
    const canvas = screen.getByRole('region', { name: /^Lienzo/ });
    canvas.focus();
    await user.keyboard('{Enter}');
    expect(stub()).toHaveAttribute('data-editing', 't');
  });
});

describe('Campo de texto sobre el lienzo', () => {
  const layer = text('t', 'Hola', { rotation: 15, x: 100, y: 50 });

  it('copia caja, giro, tipografía, cuerpo, color, alineación e interlineado a la escala de la pantalla', () => {
    expect(textEditStyle(layer, 0.5)).toMatchObject({
      left: 50,
      top: 25,
      width: 400,
      height: 100,
      transform: 'rotate(15deg)',
      fontFamily: '"Playfair Display"',
      fontSize: 40,
      fontWeight: 700,
      fontStyle: 'italic',
      color: '#123456',
      textAlign: 'right',
      lineHeight: 1.3,
    });
    expect(textEditStyle({ ...layer, rotation: 0 }, 1).transform).toBeUndefined();
  });

  it('Intro confirma, Mayúsculas+Intro hace otra línea y Escape cancela; tiene nombre accesible', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(<TextEditOverlay layer={layer} scale={1} onCommit={onCommit} onCancel={onCancel} />);
    const field = screen.getByRole('textbox', { name: /Texto de la capa «Hola»/ });
    expect(field).toHaveFocus();
    await user.keyboard('Adiós{Shift>}{Enter}{/Shift}y más');
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('Adiós\ny más');
    unmount();

    render(<TextEditOverlay layer={layer} scale={1} onCommit={onCommit} onCancel={onCancel} />);
    await user.keyboard('x{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('al salir del campo (clic fuera) confirma', () => {
    const onCommit = vi.fn();
    render(<TextEditOverlay layer={layer} scale={1} onCommit={onCommit} onCancel={vi.fn()} />);
    const field = screen.getByTestId('canvas-text-editor');
    fireEvent.change(field, { target: { value: 'Nuevo' } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith('Nuevo');
  });
});

describe('Editor: zonas seguras', () => {
  it('en una historia se pueden enseñar, marcadas como orientativas; en una publicación no hay', async () => {
    const { user } = await openEditor({
      format: 'story',
      ratio: '9:16',
      layers: [text('t', 'Abajo del todo', { y: 1700, height: 150 })],
    });
    expect(stub()).toHaveAttribute('data-safe-zone', '0');
    await user.click(screen.getByTestId('safe-zone-toggle'));
    expect(stub()).toHaveAttribute('data-safe-zone', '4');
    expect(screen.getByTestId('safe-zone-note')).toHaveTextContent(/Orientativo/);
    // El verificador avisa del texto en la franja de abajo.
    await user.click(screen.getByRole('tab', { name: 'Marca' }));
    expect(await screen.findByTestId('brandcheck-finding-TEXT_IN_UNSAFE_ZONE')).toBeInTheDocument();
  });

  it('una publicación del muro no tiene zonas seguras', async () => {
    await openEditor();
    expect(screen.queryByTestId('safe-zone-toggle')).not.toBeInTheDocument();
  });
});

describe('Editor: vista previa por red', () => {
  it('enseña la pieza en el muro con el pie cortado en «ver más» y dice que es aproximada', async () => {
    const caption = 'a'.repeat(200);
    const { user } = await openEditor({ caption });
    await chooseEditorAction(user, 'editor-preview');
    const preview = await screen.findByTestId('network-preview');
    expect(preview).toHaveAttribute('data-frame', 'feed');
    expect(await within(preview).findByRole('img')).toHaveAttribute('src', 'blob:vista-previa');
    expect(within(preview).getByTestId('preview-caption')).toHaveTextContent(`Casa Demo ${'a'.repeat(125)}… más`);
    expect(screen.getByRole('dialog')).toHaveTextContent(/Aproximada/);
    expect(preview).toHaveTextContent(/aproximado/);
  });

  it('una historia va a pantalla completa y sin pie', async () => {
    const { user } = await openEditor({ format: 'story', ratio: '9:16', caption: 'Pie' });
    await chooseEditorAction(user, 'editor-preview');
    const preview = await screen.findByTestId('network-preview');
    expect(preview).toHaveAttribute('data-frame', 'vertical');
    expect(within(preview).queryByTestId('preview-caption')).not.toBeInTheDocument();
  });
});

describe('Vista previa: lógica pura', () => {
  it('marco por formato y pie cortado según el catálogo (móvil si hay varias cifras)', () => {
    expect(previewFrameOf(getFormatSpec('instagram', 'reel'))).toBe('vertical');
    expect(previewFrameOf(getFormatSpec('instagram', 'post'))).toBe('feed');
    expect(previewFrameOf(undefined)).toBe('feed');
    expect(showsCaption(getFormatSpec('instagram', 'story'))).toBe(false);
    const linkedin = captionPreview({ caption: 'x'.repeat(300), hashtags: [] }, getFormatSpec('linkedin', 'page_post'));
    expect(linkedin).toMatchObject({ limit: 140, truncated: true, provenance: 'unverified' });
    expect(linkedin.visible).toHaveLength(140);
    // Sin cifra en el catálogo se enseña entero; los hashtags aparte se añaden como los verá la red.
    expect(captionPreview({ caption: 'Hola', hashtags: ['otoño'] }, getFormatSpec('tiktok', 'video'))).toEqual({
      visible: 'Hola\n\n#otoño',
      truncated: false,
      limit: null,
      provenance: null,
    });
  });
});

describe('Editor: nombre, red y formato', () => {
  it('renombra la pieza sin tocar su estado', async () => {
    const { user } = await openEditor();
    await chooseEditorAction(user, 'editor-settings');
    const title = screen.getByTestId('piece-title');
    await user.clear(title);
    await user.type(title, 'Menú de invierno');
    expect(screen.queryByTestId('piece-back-to-draft')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('piece-settings-save'));
    await waitFor(() => expect(screen.getByTestId('editor-title')).toHaveTextContent('Menú de invierno'));
    expect(fake.callsTo('content_items', 'update')[0]?.payload).toEqual({ title: 'Menú de invierno' });
  });

  it('si está aprobada, avisa de que cambiar red o formato la devuelve a borrador', async () => {
    const { user } = await openEditor({ status: 'approved' });
    await chooseEditorAction(user, 'editor-settings');
    await user.selectOptions(screen.getByTestId('piece-format'), 'story');
    expect(screen.getByTestId('piece-back-to-draft')).toBeInTheDocument();
    // El diseño es 1:1 y la historia no da margen de proporciones: no se avisa de lo que no se sabe.
    await user.click(screen.getByTestId('piece-settings-save'));
    await waitFor(() => expect(fake.callsTo('content_items', 'update')).toHaveLength(1));
    expect(fake.callsTo('content_items', 'update')[0]?.payload).toEqual({ network: 'instagram', format: 'story' });
  });

  it('settingsChanges solo manda lo que ha cambiado', () => {
    const current = { title: 'A', network: 'instagram', format: 'post' };
    expect(settingsChanges(current, { ...current, title: ' A ' })).toEqual({});
    expect(settingsChanges(current, { ...current, format: 'reel' })).toEqual({
      target: { network: 'instagram', format: 'reel' },
    });
  });
});

describe('Editor: quitar la selección', () => {
  it('Escape, aunque el foco esté fuera del lienzo, y un clic en el margen del lienzo vuelven a las opciones del documento', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByTestId('stub-a'));
    expect(stub()).toHaveAttribute('data-selected', 'a');
    expect(screen.queryByRole('combobox', { name: 'Proporción' })).toBeNull();

    // Sin foco en ningún campo (p. ej. tras pulsar en un texto del panel).
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Escape}');
    expect(stub()).toHaveAttribute('data-selected', '');
    expect(await screen.findByRole('combobox', { name: 'Proporción' })).toBeInTheDocument();

    // Desde otra pestaña, un clic en el margen del lienzo también quita la selección y enseña «Diseño».
    await user.click(screen.getByTestId('stub-b'));
    await user.click(screen.getByRole('tab', { name: /Capas/ }));
    fireEvent.pointerDown(screen.getByLabelText(/^Lienzo\./));
    expect(stub()).toHaveAttribute('data-selected', '');
    expect(await screen.findByRole('combobox', { name: 'Proporción' })).toBeInTheDocument();
  });

  it('Escape dentro de un campo de texto no quita la selección', async () => {
    const { user } = await openEditor();
    await user.click(screen.getByTestId('stub-a'));
    await user.click(screen.getByRole('tab', { name: 'Publicación' }));
    await user.click(await screen.findByLabelText(/Pie de foto|Texto de la publicación|Pie/));
    await user.keyboard('{Escape}');
    expect(stub()).toHaveAttribute('data-selected', 'a');
  });
});
