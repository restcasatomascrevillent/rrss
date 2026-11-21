import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ContentItemRow, ContentVersionRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

// Editor de reels en una pieza de formato reel: línea de tiempo (ordenar
// arrastrando, recortar por los extremos, deshacer y rehacer), guardado como
// versión, música con su licencia, subtítulos con su interruptor y montaje
// unido a la pieza. La vista previa dibuja en un lienzo, que jsdom no tiene:
// aquí se comprueba el resto.

const EDITOR = `${BRAND_BASE}/contenidos/reel-1`;
const path = (name: string) => `${ORG_ID}/${BRAND_ID}/media/${name}`;

beforeAll(() => {
  // jsdom no trae PointerEvent: un MouseEvent con el mismo nombre basta para estas pruebas.
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      pointerType = 'mouse';
    }
    window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const asset = (id: string, kind: string, fileName: string, mime: string, durationMs: number | null = null) => ({
  id,
  brand_id: BRAND_ID,
  organization_id: ORG_ID,
  kind,
  origin: 'upload',
  storage_path: path(fileName),
  file_name: fileName,
  mime_type: mime,
  bytes: 1000,
  width: null,
  height: null,
  duration_ms: durationMs,
  sha256: null,
  folder: '',
  tags: [],
  rights: {},
  provenance: null,
  created_by: null,
  created_at: `2026-11-18T09:00:0${id.length % 10}Z`,
  updated_at: '2026-11-18T09:00:00Z',
});

const STYLE = {
  sizeRatio: 0.06,
  color: '#FFFFFF',
  marginRatio: 0.2,
  maxWidthRatio: 0.84,
  lineHeight: 1.3,
  box: null,
  outline: null,
  fadeSeconds: 0.25,
};

const project = {
  kind: 'reel',
  template: { id: 'fundido-suave' },
  plan: {
    version: 2,
    clips: [
      { id: 'c1', type: 'photo', path: path('plato.jpg'), seconds: 2 },
      {
        id: 'c2',
        type: 'video',
        path: path('cocina.mp4'),
        in: 0.5,
        out: 3.5,
        volume: 0.6,
        transition: { type: 'fade', seconds: 0.5 },
        subtitles: [{ start: 1, end: 2, text: 'Hola desde la cocina' }],
      },
      { id: 'c3', type: 'photo', path: path('local.jpg'), seconds: 2, transition: { type: 'cut', seconds: 0 } },
    ],
    texts: [{ id: 't1', text: 'Menú del día', start: 0, end: 2, position: 'top', style: STYLE }],
    subtitles: { enabled: true, position: 'bottom', style: STYLE },
  },
};

function seed(options: { status?: ContentItemRow['status']; data?: unknown; version?: number } = {}) {
  seedWorkspace({ orgRole: 'owner' });
  const item: ContentItemRow = {
    id: 'reel-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: 'Reel de la semana',
    network: 'instagram',
    format: 'reel',
    status: options.status ?? 'draft',
    current_version: options.version ?? 1,
    archived_at: null,
    created_by: ME.id,
    created_at: '2026-11-10T09:00:00Z',
    updated_at: '2026-11-10T09:00:00Z',
  } as ContentItemRow;
  const version = {
    id: 'v-1',
    content_id: 'reel-1',
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    version: options.version ?? 1,
    schema_version: 2,
    data: options.data ?? project,
    change_note: '',
    restored_from: null,
    created_by: ME.id,
    created_at: '2026-11-11T09:00:00Z',
  } as unknown as ContentVersionRow;
  fake.tables.content_items = [item];
  fake.tables.content_versions = options.version === 0 ? [] : [version];
  fake.tables.media_assets = [
    asset('foto-1', 'image', 'plato.jpg', 'image/jpeg'),
    asset('foto-2', 'image', 'local.jpg', 'image/jpeg'),
    asset('clip-1', 'video', 'cocina.mp4', 'video/mp4', 6000),
    asset('audio-1', 'audio', 'musica.m4a', 'audio/mp4'),
  ];
  fake.tables.jobs = [];
  fake.tables.brand_fonts = [];
  fake.rpc('brand_reel_font_info', () => []);
  fake.rpc('save_content_version', (args) => {
    const row = {
      ...version,
      id: `v-${Number(args.p_expected_version) + 1}`,
      version: Number(args.p_expected_version) + 1,
      data: args.p_data,
    };
    fake.tables.content_versions!.push(row);
    return row;
  });
}

async function open() {
  const app = renderApp(EDITOR);
  await screen.findByTestId('reel-editor');
  return app;
}

const clipLabels = () =>
  screen.getAllByTestId('reel-clip').map((c) => within(c).getAllByRole('button')[0]!.getAttribute('aria-label'));

describe('editor de reels', () => {
  it('una pieza de formato reel se abre en el editor de reels con su línea de tiempo y sus pistas', async () => {
    seed();
    await open();
    expect(clipLabels()).toEqual(['1. Foto plato.jpg, 2 s', '2. Clip cocina.mp4, 3 s', '3. Foto local.jpg, 2 s']);
    expect(screen.getAllByTestId('reel-text-block')).toHaveLength(1);
    expect(screen.getAllByTestId('reel-cue-block').map((c) => c.textContent)).toEqual(['Hola desde la cocina']);
    // 2 + 3 + 2 − 0,5 de fundido.
    expect(screen.getByTestId('reel-duration')).toHaveTextContent('6,5 s de 90 s como máximo');
    expect(screen.getByTestId('reel-version')).toHaveTextContent('Versión 1');
    expect(screen.getByTestId('reel-preview')).toBeInTheDocument();
  });

  it('se ordena arrastrando un elemento y se deshace y rehace', async () => {
    seed();
    await open();
    const first = within(screen.getAllByTestId('reel-clip')[0]!).getAllByRole('button')[0]!;
    // Zoom por defecto: 60 px por segundo. Se suelta pasado el final (6,5 s → 390 px).
    fireEvent.pointerDown(first, { clientX: 20, button: 0 });
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 420 });
    fireEvent.pointerUp(window, { clientX: 420 });
    await waitFor(() => expect(clipLabels()[2]).toBe('3. Foto plato.jpg, 2 s'));
    expect(clipLabels()[0]).toBe('1. Clip cocina.mp4, 3 s');
    expect(screen.getByTestId('reel-version')).toHaveTextContent('cambios sin guardar');

    fireEvent.click(screen.getByTestId('reel-undo'));
    expect(clipLabels()[0]).toBe('1. Foto plato.jpg, 2 s');
    fireEvent.click(screen.getByTestId('reel-redo'));
    expect(clipLabels()[0]).toBe('1. Clip cocina.mp4, 3 s');
    // Con el teclado: Alt + flecha mueve el elemento con el foco.
    const nowFirst = within(screen.getAllByTestId('reel-clip')[0]!).getAllByRole('button')[0]!;
    fireEvent.keyDown(nowFirst, { key: 'ArrowRight', altKey: true });
    expect(clipLabels()[1]).toBe('2. Clip cocina.mp4, 3 s');
  });

  it('recorta el final de un clip arrastrando su extremo, en un solo paso de deshacer', async () => {
    seed();
    await open();
    const clip = screen.getAllByTestId('reel-clip')[1]!;
    const handle = within(clip).getByTestId('reel-handle-end');
    // −1 s a 60 px por segundo, en varios movimientos.
    fireEvent.pointerDown(handle, { clientX: 300, button: 0 });
    fireEvent.pointerMove(window, { clientX: 270 });
    fireEvent.pointerMove(window, { clientX: 240 });
    fireEvent.pointerUp(window, { clientX: 240 });
    await waitFor(() => expect(clipLabels()[1]).toBe('2. Clip cocina.mp4, 2 s'));
    expect(screen.getByTestId('reel-clip-out')).toHaveValue(2.5);
    // El principio, con el campo exacto del panel.
    fireEvent.change(screen.getByTestId('reel-clip-in'), { target: { value: '1' } });
    expect(clipLabels()[1]).toBe('2. Clip cocina.mp4, 1,5 s');
    fireEvent.click(screen.getByTestId('reel-undo'));
    expect(clipLabels()[1]).toBe('2. Clip cocina.mp4, 2 s');
    fireEvent.click(screen.getByTestId('reel-undo'));
    expect(clipLabels()[1]).toBe('2. Clip cocina.mp4, 3 s');
  });

  it('guarda el montaje como versión nueva de la pieza', async () => {
    seed();
    await open();
    fireEvent.click(within(screen.getAllByTestId('reel-clip')[0]!).getAllByRole('button')[0]!);
    fireEvent.change(screen.getByTestId('reel-photo-seconds'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('reel-save'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(screen.getByTestId('reel-version')).toHaveTextContent('Versión 2'));
    const call = fake.callsTo('save_content_version', 'rpc')[0]!.payload as Record<string, unknown>;
    expect(call).toMatchObject({ p_content_id: 'reel-1', p_schema_version: 2, p_expected_version: 1 });
    const data = call.p_data as { kind: string; plan: { version: number; clips: unknown[] } };
    expect(data).toMatchObject({ kind: 'reel', plan: { version: 2 } });
    expect(data.plan.clips[0]).toMatchObject({ id: 'c1', seconds: 3 });
  });

  it('la música exige confirmar la licencia y queda con su volumen y entrada y salida suaves', async () => {
    seed();
    await open();
    fireEvent.click(screen.getByTestId('reel-add-music'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('reel-music-license')).toHaveTextContent(/responsabilidad de la marca/);
    fireEvent.change(within(dialog).getByTestId('reel-music-choice'), { target: { value: 'audio-1' } });
    expect(within(dialog).getByTestId('reel-music-add')).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId('reel-music-confirm'));
    fireEvent.click(within(dialog).getByTestId('reel-music-add'));
    await screen.findByTestId('reel-inspector-music');
    expect(screen.getByTestId('reel-music-block')).toHaveTextContent('musica.m4a');
    expect(screen.getByTestId('reel-inspector-music')).toHaveTextContent('Licencia confirmada por la marca');
  });

  it('subtítulos: se corrigen a mano y el botón automático sale solo con su interruptor', async () => {
    seed();
    await open();
    fireEvent.click(within(screen.getAllByTestId('reel-clip')[1]!).getAllByRole('button')[0]!);
    expect(screen.queryByTestId('reel-auto-subtitles')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('reel-cue-text'), { target: { value: 'Hola desde el obrador' } });
    expect(screen.getAllByTestId('reel-cue-block').map((c) => c.textContent)).toEqual(['Hola desde el obrador']);
  });

  it('con el interruptor y OpenAI en el servidor, ofrece los subtítulos automáticos con su coste', async () => {
    vi.stubEnv('VITE_REEL_SUBTITLES_ENABLED', 'true');
    seed();
    fake.fn('ai-transcribe', () => ({ status: 200, body: { available: true, microsPerSecond: 100 } }));
    await open();
    fireEvent.click(within(screen.getAllByTestId('reel-clip')[1]!).getAllByRole('button')[0]!);
    fireEvent.click(await screen.findByTestId('reel-auto-subtitles'));
    expect(await screen.findByTestId('reel-auto-subtitles-cost')).toHaveTextContent('Tramo de 3 s');
  });

  it('monta la versión guardada unida a la pieza (con trabajador) y no deja montar cambios sin guardar', async () => {
    vi.stubEnv('VITE_MEDIA_WORKER_ENABLED', 'true');
    seed();
    fake.rpc('request_media_job', (args) => {
      const job = {
        id: 'job-1',
        organization_id: ORG_ID,
        brand_id: BRAND_ID,
        kind: 'media.reel.template',
        payload: args.p_input,
        status: 'queued',
        attempts: 0,
        max_attempts: 3,
        last_error: null,
        result: null,
        created_at: '2026-11-21T10:00:00Z',
      };
      fake.tables.jobs!.push(job);
      return job;
    });
    await open();
    fireEvent.click(screen.getByTestId('reel-render'));
    await waitFor(() => expect(fake.callsTo('request_media_job', 'rpc')).toHaveLength(1));
    const input = (fake.callsTo('request_media_job', 'rpc')[0]!.payload as { p_input: Record<string, unknown> })
      .p_input;
    expect(input).toMatchObject({
      template: { id: 'fundido-suave' },
      content: { id: 'reel-1', version: 1 },
      plan: { version: 2 },
    });
    expect(await screen.findByTestId('reel-piece-job')).toHaveTextContent('Versión 1');

    // Con cambios sin guardar, no se monta.
    fireEvent.click(screen.getByTestId('reel-add-text'));
    expect(screen.getByTestId('reel-render')).toBeDisabled();
  });

  it('una pieza reel con un diseño por capas avisa y empieza un montaje vacío', async () => {
    seed({ data: { schemaVersion: 4, canvas: {}, pages: [] } });
    await open();
    expect(screen.getByText(/es un diseño por capas/)).toBeInTheDocument();
    expect(screen.getByText('Todavía no hay nada en el reel')).toBeInTheDocument();
  });
});
