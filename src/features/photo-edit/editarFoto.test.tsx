import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as libraryApi from '@/features/library/api';
import * as storageApi from '@/features/storage/api';
import { createEmptyDocument, type ContentDocument } from '@/features/content/document';
import type { CanvasViewProps } from '@/features/content/editor/canvas/types';
import type { ContentVersionRow, MediaAssetRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import * as canvasModule from './canvas';
import * as cutoutEngine from './cutout/engine';
import type { Pixels } from './pixels';

// «Editar foto» desde la biblioteca y desde el editor. jsdom no dibuja: la
// lectura y escritura de píxeles (canvas.ts) se espía con dobles; la
// lógica de los ajustes y del encuadre es la de verdad (pixels.ts, framing.ts).

const mocks = vi.hoisted(() => ({
  loadPixels: vi.fn(),
  encodePixels: vi.fn(),
  loadCoverPixels: vi.fn(),
  uploadAsset: vi.fn(),
}));

vi.mock('@/features/content/editor/canvas/KonvaCanvas', () => ({
  default: (props: CanvasViewProps) => <div data-testid="canvas-stub" data-layers={props.document.layers.length} />,
}));

function pixels(width: number, height: number, alpha = 255): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([40 + (i % 60), 60, 120, alpha], i);
  return { data, width, height };
}

const asset = (id: string, fileName: string, extra: Partial<MediaAssetRow> = {}): MediaAssetRow =>
  ({
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    kind: 'image',
    origin: 'upload',
    storage_path: `${ORG_ID}/${BRAND_ID}/media/${fileName}`,
    file_name: fileName,
    mime_type: 'image/jpeg',
    bytes: 1000,
    width: 1200,
    height: 900,
    duration_ms: null,
    sha256: null,
    folder: '',
    tags: [],
    rights: {},
    provenance: {},
    created_by: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...extra,
  }) as MediaAssetRow;

let uploaded: Array<Parameters<typeof libraryApi.uploadAsset>[0]> = [];

beforeEach(() => {
  uploaded = [];
  mocks.loadPixels.mockImplementation(async (url: string) => ({
    pixels: /sin[- ]fondo/i.test(url) ? pixels(40, 30, 0) : pixels(120, 90),
    reduced: false,
    natural: { width: 120, height: 90 },
  }));
  mocks.encodePixels.mockImplementation(async (_p: Pixels, mime: string) => new Blob(['x'], { type: mime }));
  mocks.uploadAsset.mockImplementation(async (input: Parameters<typeof libraryApi.uploadAsset>[0]) => {
    uploaded.push(input);
    const row = asset(`editada-${uploaded.length}`, input.file.name, {
      mime_type: input.file.type,
      folder: input.folder ?? '',
      tags: input.tags ?? [],
      provenance: input.provenance ?? {},
    });
    fake.rows('media_assets').push(row);
    return row;
  });
  vi.spyOn(libraryApi, 'uploadAsset').mockImplementation(mocks.uploadAsset);
  // La pantalla ya está cargada por la preparación común: se espían las funciones del lienzo.
  vi.spyOn(canvasModule, 'loadPixels').mockImplementation(mocks.loadPixels);
  vi.spyOn(canvasModule, 'encodePixels').mockImplementation(mocks.encodePixels);
  vi.spyOn(canvasModule, 'loadCoverPixels').mockImplementation(mocks.loadCoverPixels);
  // El navegador de las pruebas puede recortar; el modelo de verdad no se carga nunca aquí.
  vi.spyOn(cutoutEngine, 'cutoutSupport').mockReturnValue({ ok: true });
  vi.spyOn(canvasModule, 'paint').mockImplementation(() => undefined);
  // Direcciones firmadas: una por ruta (el almacenamiento simulado no las da).
  vi.spyOn(storageApi, 'signStoragePaths').mockImplementation(
    async (paths: string[]) => new Map(paths.map((p) => [p, `https://almacen.test/${p}`])),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function openPhoto(
  role: { orgRole: 'owner' | 'member'; brandRole?: 'editor' | 'viewer' },
  rows: MediaAssetRow[],
) {
  seedWorkspace(role);
  fake.tables.media_assets = rows;
  fake.tables.jobs = [];
  fake.tables.brand_profiles = [];
  const app = renderApp(`${BRAND_BASE}/biblioteca`);
  await app.user.click(await screen.findByTestId('library-asset'));
  await screen.findByRole('dialog');
  return app;
}

async function openEditDialog(user: Awaited<ReturnType<typeof openPhoto>>['user']) {
  await user.click(await screen.findByTestId('asset-edit-photo'));
  const dialog = await screen.findByTestId('photo-edit');
  await within(dialog).findByTestId('photo-edit-preview');
  return within(dialog);
}

/** `ai-media` simulado para «Cambiar el fondo con IA» (con modelo que usa la máscara). */
function fakeBackgroundAi(calls: Array<{ action: string; input?: unknown }>) {
  fake.fn('ai-media', (body) => {
    const { action, input } = body as { action: string; input?: Record<string, unknown> };
    calls.push({ action, input });
    if (action === 'photo.options') {
      return {
        status: 200,
        body: {
          action,
          edits: [
            {
              operation: 'replace_background',
              model: 'openai:gpt-image-2.5-sunburst',
              delivery: 'sync',
              dataRegion: 'global',
              euProcessing: false,
              trainsOnInputs: 'no',
              untestedAdapter: true,
              usesSubjectMask: true,
            },
          ],
        },
      };
    }
    if (action === 'photo.estimate') {
      return { status: 200, body: { action, costMicros: 200_000, model: 'openai:gpt-image-2.5-sunburst' } };
    }
    fake
      .rows('media_assets')
      .push(asset('fondo-ia', 'Fondo nuevo · plato.png', { mime_type: 'image/png', origin: 'generated' }));
    return {
      status: 200,
      body: {
        action,
        status: 'completed',
        generationId: 'gen-2',
        costMicros: 200_000,
        asset: { id: 'fondo-ia', path: `${ORG_ID}/${BRAND_ID}/ia/gen-2-0.png` },
      },
    };
  });
}

describe('Editar foto desde la biblioteca', () => {
  it('quien solo ve la marca no puede editar', async () => {
    await openPhoto({ orgRole: 'member', brandRole: 'viewer' }, [asset('foto-1', 'plato.jpg')]);
    expect(screen.queryByTestId('asset-edit-photo')).not.toBeInTheDocument();
  });

  it('mejorar sin IA guarda una copia nueva con su procedencia; el original no cambia', async () => {
    const original = asset('foto-1', 'Chuletón.jpg');
    const { user } = await openPhoto({ orgRole: 'member', brandRole: 'editor' }, [original]);
    const dialog = await openEditDialog(user);

    // Sin IA: no hay pestaña de ampliar ni se pregunta al servidor.
    expect(dialog.queryByRole('tab', { name: 'Ampliar' })).not.toBeInTheDocument();
    expect(dialog.getByTestId('photo-edit-save')).toBeDisabled();
    await user.click(dialog.getByTestId('photo-edit-auto'));
    await user.click(dialog.getByTestId('photo-edit-save'));

    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(uploaded[0]).toMatchObject({
      organizationId: ORG_ID,
      brandId: BRAND_ID,
      folder: 'Ediciones',
      tags: ['edición'],
      provenance: { type: 'photo_edit', source_asset_id: 'foto-1', width: 120, height: 90 },
    });
    expect(uploaded[0]!.file.name).toBe('Mejorada · Chuletón.jpg');
    expect(uploaded[0]!.file.type).toBe('image/jpeg');
    expect((uploaded[0]!.provenance as { steps: Array<{ kind: string; auto?: boolean }> }).steps[0]).toMatchObject({
      kind: 'adjust',
      auto: true,
    });
    expect(await dialog.findByTestId('photo-edit-result')).toHaveTextContent('Mejorada · Chuletón.jpg');
    expect(fake.rows('media_assets').find((r) => r.id === 'foto-1')).toEqual(original);
    expect(fake.calls.filter((c) => c.kind === 'function' && c.name === 'ai-media')).toEqual([]);
  });

  it('recortes por red: guarda un recurso nuevo por formato, con su caja', async () => {
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Recortes' }));
    await user.click(await dialog.findByTestId('photo-edit-crops-save'));
    await waitFor(() => expect(uploaded).toHaveLength(3));
    expect(uploaded.map((u) => u.file.name)).toEqual([
      'Recorte 1:1 · plato.jpg',
      'Recorte 4:5 · plato.jpg',
      'Recorte 9:16 · plato.jpg',
    ]);
    const square = (uploaded[0]!.provenance as { steps: Array<{ box: { width: number; height: number } }> }).steps[0]!;
    expect(square).toMatchObject({ kind: 'crop', aspect: '1:1', smart: true, box: { width: 90, height: 90 } });
    expect(uploaded[0]!.dimensions).toEqual({ width: 90, height: 90, durationMs: null });
  });

  it('sin IA, quitar el fondo se ofrece en el navegador (gratis) y no se llama a ningún servidor', async () => {
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    expect(await dialog.findByTestId('photo-edit-cutout-run')).toBeInTheDocument();
    expect(dialog.getByText(/Gratis y sin IA externa/)).toBeInTheDocument();
    expect(dialog.queryByTestId('photo-edit-ai-remove_background')).not.toBeInTheDocument();
    expect(dialog.queryByTestId('photo-edit-engine-ai')).not.toBeInTheDocument();
  });

  it('si el navegador no puede recortar, lo dice con claridad y no ofrece el botón', async () => {
    vi.spyOn(cutoutEngine, 'cutoutSupport').mockReturnValue({
      ok: false,
      reason: 'Este navegador no puede quitar el fondo (le falta WebAssembly).',
    });
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    expect(await dialog.findByTestId('photo-edit-cutout-unsupported')).toHaveTextContent(/le falta WebAssembly/);
    expect(dialog.queryByTestId('photo-edit-cutout-run')).not.toBeInTheDocument();
  });

  it('quitar el fondo en el navegador: enseña la descarga y el recorte, y guarda un recurso nuevo con su procedencia', async () => {
    const original = asset('foto-1', 'plato.jpg');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const cut = vi.spyOn(cutoutEngine, 'removeBackgroundInBrowser').mockImplementation(async (_image, onProgress) => {
      onProgress?.({ phase: 'downloading', received: 42_000_000, total: 84_000_000 });
      await gate;
      onProgress?.({ phase: 'running' });
      return { pixels: pixels(120, 90, 0), model: 'isnet-general-use', provider: 'wasm', fromCache: false };
    });
    const { user } = await openPhoto({ orgRole: 'owner' }, [original]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    await user.click(await dialog.findByTestId('photo-edit-cutout-run'));
    const progress = await dialog.findByTestId('photo-edit-cutout-progress');
    expect(progress).toHaveTextContent('Descargando el modelo (solo la primera vez): 42 de 84 MB');
    expect(within(progress).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    finish();

    // Con el recorte hecho aparecen los fondos y no se ha guardado nada todavía.
    await dialog.findByTestId('photo-edit-backgrounds');
    expect(cut).toHaveBeenCalledTimes(1);
    expect(uploaded).toHaveLength(0);
    await user.click(dialog.getByTestId('photo-edit-shadow'));
    await user.click(dialog.getByTestId('photo-edit-color-apply'));

    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(uploaded[0]!.file.name).toBe('Fondo nuevo · plato.jpg');
    expect(uploaded[0]!.file.type).toBe('image/jpeg');
    expect(uploaded[0]).toMatchObject({ folder: 'Ediciones', tags: ['edición'] });
    expect(uploaded[0]!.provenance).toMatchObject({
      type: 'photo_edit',
      source_asset_id: 'foto-1',
      steps: [
        { kind: 'remove_background', engine: 'browser', model: 'isnet-general-use' },
        { kind: 'background', color: '#FFFFFF', shadow: true },
      ],
    });
    expect(fake.rows('media_assets').find((r) => r.id === 'foto-1')).toEqual(original);
    expect(fake.calls.filter((c) => c.kind === 'function' && c.name === 'ai-media')).toEqual([]);
  });

  it('se puede guardar solo el recorte (PNG transparente) sin elegir fondo', async () => {
    vi.spyOn(cutoutEngine, 'removeBackgroundInBrowser').mockResolvedValue({
      pixels: pixels(120, 90, 0),
      model: 'isnet-general-use',
      provider: 'webgpu',
      fromCache: true,
    });
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    await user.click(await dialog.findByTestId('photo-edit-cutout-run'));
    await user.click(await dialog.findByTestId('photo-edit-cutout-save'));
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(uploaded[0]!.file.name).toBe('Sin fondo · plato.png');
    expect((uploaded[0]!.provenance as { steps: unknown[] }).steps).toEqual([
      { kind: 'remove_background', engine: 'browser', model: 'isnet-general-use' },
    ]);
  });

  it('si el recorte falla, lo explica y se puede reintentar', async () => {
    vi.spyOn(cutoutEngine, 'removeBackgroundInBrowser').mockRejectedValue(
      Object.assign(new Error('No se ha podido descargar el modelo: revisa la conexión a internet.'), {
        name: 'ModelDownloadError',
      }),
    );
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    await user.click(await dialog.findByTestId('photo-edit-cutout-run'));
    expect(await dialog.findByText(/revisa la conexión a internet/)).toBeInTheDocument();
    expect(dialog.getByTestId('photo-edit-cutout-run')).toBeEnabled();
    expect(uploaded).toHaveLength(0);
  });

  it('una foto sin fondo recibe uno de color (sin IA) en un PNG nuevo', async () => {
    const cutout = asset('sin-fondo', 'sin-fondo.png', { mime_type: 'image/png' });
    const { user } = await openPhoto({ orgRole: 'owner' }, [cutout]);
    const dialog = await openEditDialog(user);
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    await dialog.findByTestId('photo-edit-backgrounds');
    await user.click(dialog.getByTestId('photo-edit-color-apply'));
    await waitFor(() => expect(uploaded).toHaveLength(1));
    expect(uploaded[0]!.file.name).toBe('Fondo nuevo · sin-fondo.png');
    expect(uploaded[0]!.provenance).toMatchObject({
      type: 'photo_edit',
      source_asset_id: 'sin-fondo',
      steps: [{ kind: 'background', color: '#FFFFFF' }],
    });
  });

  it('con IA: quitar el fondo enseña el coste, crea un recurso nuevo y no toca el original', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    const original = asset('foto-1', 'plato.jpg');
    const calls: Array<{ action: string; input?: unknown }> = [];
    fake.fn('ai-media', (body) => {
      const { action, input } = body as { action: string; input?: Record<string, unknown> };
      calls.push({ action, input });
      const choice = (operation: string) => ({
        operation,
        model: `simulated-image-edit:${operation}`,
        delivery: 'sync',
        dataRegion: 'eu',
        euProcessing: true,
        trainsOnInputs: 'no',
        untestedAdapter: true,
      });
      if (action === 'photo.options') {
        return { status: 200, body: { action, edits: [choice('remove_background'), choice('upscale')] } };
      }
      if (action === 'photo.estimate') {
        return { status: 200, body: { action, costMicros: 10_000, model: 'simulated-image-edit:x' } };
      }
      fake
        .rows('media_assets')
        .push(asset('sin-fondo', 'Sin fondo · plato.png', { mime_type: 'image/png', origin: 'generated' }));
      return {
        status: 200,
        body: {
          action,
          status: 'completed',
          generationId: 'gen-1',
          costMicros: 10_000,
          asset: { id: 'sin-fondo', path: `${ORG_ID}/${BRAND_ID}/ia/gen-1-0.png` },
        },
      };
    });
    const { user } = await openPhoto({ orgRole: 'owner' }, [original]);
    const dialog = await openEditDialog(user);
    expect(await dialog.findByRole('tab', { name: 'Ampliar' })).toBeInTheDocument();
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    // Con las dos opciones, la del navegador viene marcada por defecto.
    expect(await dialog.findByTestId('photo-edit-engine-browser')).toBeChecked();
    expect(dialog.queryByTestId('photo-edit-ai-remove_background')).not.toBeInTheDocument();
    await user.click(dialog.getByTestId('photo-edit-engine-ai'));
    const ai = within(await dialog.findByTestId('photo-edit-ai-remove_background'));
    expect(await ai.findByTestId('photo-edit-ai-cost')).toHaveTextContent(/Coste máximo: 0,01/);
    await user.click(ai.getByTestId('photo-edit-ai-run-remove_background'));

    expect(await dialog.findByTestId('photo-edit-result')).toHaveTextContent('Sin fondo · plato.png');
    expect(calls.find((c) => c.action === 'photo.edit')).toEqual({
      action: 'photo.edit',
      input: { assetId: 'foto-1', operation: 'remove_background' },
    });
    expect(fake.rows('media_assets').find((r) => r.id === 'foto-1')).toEqual(original);
    // Pasa a editar la foto sin fondo: ya ofrece fondos sin IA.
    expect(await dialog.findByTestId('photo-edit-backgrounds')).toBeInTheDocument();
  });

  it('con IA: cambiar el fondo pide el texto, avisa de que no hay recorte del plato y crea un recurso nuevo', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    vi.spyOn(cutoutEngine, 'cutoutSupport').mockReturnValue({ ok: false, reason: 'sin WebAssembly' });
    const original = asset('foto-1', 'plato.jpg');
    const calls: Array<{ action: string; input?: unknown }> = [];
    fakeBackgroundAi(calls);
    const { user } = await openPhoto({ orgRole: 'owner' }, [original]);
    const dialog = await openEditDialog(user);
    await user.click(await dialog.findByRole('tab', { name: 'Fondo con IA' }));
    const ai = within(await dialog.findByTestId('photo-edit-ai-replace_background'));
    // Sin recorte del plato se avisa; sin texto no se puede lanzar.
    expect(ai.getByText(/No hay recorte del plato/)).toBeInTheDocument();
    expect(ai.getByText(/fuera de la UE/)).toBeInTheDocument();
    const run = ai.getByTestId('photo-edit-ai-run-replace_background');
    expect(run).toBeDisabled();
    expect(await ai.findByTestId('photo-edit-ai-cost')).toHaveTextContent(/Coste máximo: 0,20/);
    // Sugerencias de la marca a un clic.
    const ideas = ai.getAllByTestId('photo-edit-ai-background-idea').map((b) => b.textContent);
    expect(ideas).toEqual(expect.arrayContaining(['mesa de mármol blanco con luz cálida', 'pizarra oscura']));
    await user.click(ai.getByRole('button', { name: 'mantel de lino beige' }));
    expect(ai.getByTestId('photo-edit-ai-background-text')).toHaveValue('mantel de lino beige');
    expect(run).toBeEnabled();
    await user.click(run);

    expect(await dialog.findByTestId('photo-edit-result')).toHaveTextContent('Fondo nuevo · plato.png');
    expect(calls.find((c) => c.action === 'photo.edit')).toEqual({
      action: 'photo.edit',
      input: { assetId: 'foto-1', operation: 'replace_background', prompt: 'mantel de lino beige' },
    });
    expect(fake.rows('media_assets').find((r) => r.id === 'foto-1')).toEqual(original);
  });

  it('con IA: cambiar el fondo recorta el plato en el navegador, manda la máscara y vuelve a pegar el plato original', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    const original = asset('foto-1', 'plato.jpg');
    const calls: Array<{ action: string; input?: unknown }> = [];
    fakeBackgroundAi(calls);
    const cut = vi.spyOn(cutoutEngine, 'removeBackgroundInBrowser').mockImplementation(async (image, onProgress) => {
      onProgress?.({ phase: 'running' });
      // El plato: la mitad izquierda de la foto.
      const out = new Uint8ClampedArray(image.data);
      for (let i = 0; i < image.width * image.height; i += 1) {
        out[i * 4 + 3] = i % image.width < image.width / 2 ? 255 : 0;
      }
      return {
        pixels: { data: out, width: image.width, height: image.height },
        model: 'isnet-test',
        provider: 'wasm',
        fromCache: true,
      };
    });
    const removed = vi.spyOn(libraryApi, 'deleteAssets').mockResolvedValue(undefined);
    const { user } = await openPhoto({ orgRole: 'owner' }, [original]);
    const dialog = await openEditDialog(user);
    await user.click(await dialog.findByRole('tab', { name: 'Fondo con IA' }));
    const ai = within(await dialog.findByTestId('photo-edit-ai-replace_background'));
    // Hay recorte posible: nada de «no hay recorte»; la casilla viene marcada.
    expect(ai.queryByText(/No hay recorte del plato/)).not.toBeInTheDocument();
    expect(ai.getByTestId('photo-edit-ai-protect')).toBeChecked();
    await user.click(ai.getByRole('button', { name: 'mantel de lino beige' }));
    await user.click(ai.getByTestId('photo-edit-ai-run-replace_background'));

    expect(await dialog.findByTestId('photo-edit-result')).toHaveTextContent('Fondo nuevo · plato.jpg');
    expect(cut).toHaveBeenCalledTimes(1);
    // La máscara viaja en base64 y es un PNG (ya codificado por el doble) con las medidas de la foto.
    const sent = calls.find((c) => c.action === 'photo.edit')!.input as Record<string, unknown>;
    expect(sent).toMatchObject({ assetId: 'foto-1', operation: 'replace_background', prompt: 'mantel de lino beige' });
    expect(typeof sent.subjectMask).toBe('string');
    const maskCall = mocks.encodePixels.mock.calls.find(([p, mime]) => mime === 'image/png' && p.width === 1200);
    expect(maskCall).toBeTruthy();
    const mask = maskCall![0] as Pixels;
    expect([mask.width, mask.height]).toEqual([1200, 900]);
    expect(mask.data[(450 * 1200 + 100) * 4 + 3]).toBe(255); // plato: opaco
    expect(mask.data[(450 * 1200 + 1100) * 4 + 3]).toBe(0); // fondo: transparente
    // Se guarda una versión nueva con el plato protegido (photo_edit, no ai_edit) y se retira la sin proteger.
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.provenance).toMatchObject({
      type: 'photo_edit',
      source_asset_id: 'foto-1',
      steps: [
        {
          kind: 'ai_background',
          operation: 'replace_background',
          prompt: 'mantel de lino beige',
          plate_protected: true,
          mask_model: 'isnet-test',
        },
      ],
    });
    expect(removed).toHaveBeenCalledWith(['fondo-ia']);
    expect(fake.rows('media_assets').find((r) => r.id === 'foto-1')).toEqual(original);
  });

  it('con IA: sin la casilla «Proteger el plato original» manda la máscara pero deja el resultado de la IA', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    const calls: Array<{ action: string; input?: unknown }> = [];
    fakeBackgroundAi(calls);
    vi.spyOn(cutoutEngine, 'removeBackgroundInBrowser').mockImplementation(async (image) => ({
      pixels: image,
      model: 'isnet-test',
      provider: 'wasm',
      fromCache: true,
    }));
    const removed = vi.spyOn(libraryApi, 'deleteAssets').mockResolvedValue(undefined);
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await user.click(await dialog.findByRole('tab', { name: 'Fondo con IA' }));
    const ai = within(await dialog.findByTestId('photo-edit-ai-replace_background'));
    await user.click(ai.getByTestId('photo-edit-ai-protect'));
    await user.click(ai.getByRole('button', { name: 'pizarra oscura' }));
    await user.click(ai.getByTestId('photo-edit-ai-run-replace_background'));

    expect(await dialog.findByTestId('photo-edit-result')).toHaveTextContent('Fondo nuevo · plato.png');
    expect((calls.find((c) => c.action === 'photo.edit')!.input as Record<string, unknown>).subjectMask).toBeTruthy();
    expect(uploaded).toHaveLength(0);
    expect(removed).not.toHaveBeenCalled();
  });

  it('con IA: si no se puede volver a pegar el plato, deja el resultado de la IA y avisa', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    const calls: Array<{ action: string; input?: unknown }> = [];
    fakeBackgroundAi(calls);
    vi.spyOn(cutoutEngine, 'removeBackgroundInBrowser').mockImplementation(async (image) => ({
      pixels: image,
      model: 'isnet-test',
      provider: 'wasm',
      fromCache: true,
    }));
    const removed = vi.spyOn(libraryApi, 'deleteAssets').mockResolvedValue(undefined);
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    // El resultado de la IA tiene otra proporción que la foto: no se puede pegar el plato sin deformarlo.
    mocks.loadPixels.mockImplementation(async (url: string) =>
      /Fondo nuevo|Fondo%20nuevo/.test(url)
        ? { pixels: pixels(160, 40), reduced: false, natural: { width: 160, height: 40 } }
        : { pixels: pixels(120, 90), reduced: false, natural: { width: 120, height: 90 } },
    );
    await user.click(await dialog.findByRole('tab', { name: 'Fondo con IA' }));
    const ai = within(await dialog.findByTestId('photo-edit-ai-replace_background'));
    await user.click(ai.getByRole('button', { name: 'pizarra oscura' }));
    await user.click(ai.getByTestId('photo-edit-ai-run-replace_background'));

    expect(await dialog.findByTestId('photo-edit-result')).toHaveTextContent('Fondo nuevo · plato.png');
    expect(uploaded).toHaveLength(0);
    expect(removed).not.toHaveBeenCalled();
  });

  it('con IA: si no hay modelo de cambiar el fondo, no sale la pestaña', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    fake.fn('ai-media', (body) => ({ status: 200, body: { action: (body as { action: string }).action, edits: [] } }));
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await waitFor(() => expect(fake.calls.some((c) => c.kind === 'function' && c.name === 'ai-media')).toBe(true));
    expect(dialog.queryByRole('tab', { name: 'Fondo con IA' })).not.toBeInTheDocument();
  });

  it('con IA activada pero sin modelo en el servidor, no sale nada de IA', async () => {
    vi.stubEnv('VITE_AI_PHOTO_EDIT_ENABLED', 'true');
    fake.fn('ai-media', (body) => ({ status: 200, body: { action: (body as { action: string }).action, edits: [] } }));
    const { user } = await openPhoto({ orgRole: 'owner' }, [asset('foto-1', 'plato.jpg')]);
    const dialog = await openEditDialog(user);
    await waitFor(() => expect(fake.calls.some((c) => c.kind === 'function' && c.name === 'ai-media')).toBe(true));
    expect(dialog.queryByRole('tab', { name: 'Ampliar' })).not.toBeInTheDocument();
    await user.click(dialog.getByRole('tab', { name: 'Fondo' }));
    // Sin modelo de IA queda el del navegador, sin elegir.
    expect(await dialog.findByTestId('photo-edit-cutout-run')).toBeInTheDocument();
    expect(dialog.queryByTestId('photo-edit-engine-ai')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────── Editor ───────────────────────────────

function documentWithPhoto(): ContentDocument {
  const doc = createEmptyDocument({ aspectRatio: '4:5' });
  return {
    ...doc,
    pages: [{ id: 'p1', name: '', layers: [
      {
        id: 'foto',
        type: 'image',
        name: 'Foto',
        x: 0,
        y: 0,
        width: 1080,
        height: 1350,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        anchor: { x: 'stretch', y: 'stretch' },
        source: { kind: 'asset', assetId: '11111111-1111-4111-8111-111111111111' },
        fit: 'cover',
        focus: { x: 0.5, y: 0.5 },
      },
    ] }],
  };
}

describe('Editar foto desde el editor', () => {
  it('la capa pasa a usar la foto editada; la original sigue en la biblioteca', async () => {
    seedWorkspace({ orgRole: 'owner' });
    const original = asset('11111111-1111-4111-8111-111111111111', 'plato.jpg');
    fake.tables.media_assets = [original];
    fake.tables.brand_profiles = [];
    fake.tables.content_items = [
      {
        id: 'content-1',
        brand_id: BRAND_ID,
        organization_id: ORG_ID,
        title: 'Plato del día',
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
    const version: ContentVersionRow = {
      id: 'v-1',
      content_id: 'content-1',
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      version: 1,
      schema_version: 1,
      data: documentWithPhoto() as unknown as ContentVersionRow['data'],
      change_note: '',
      restored_from: null,
      created_by: ME.id,
      created_at: '2026-11-11T09:00:00Z',
    };
    fake.tables.content_versions = [version];
    // La foto editada tiene que tener un identificador válido para el documento.
    mocks.uploadAsset.mockImplementationOnce(async (input: Parameters<typeof libraryApi.uploadAsset>[0]) => {
      uploaded.push(input);
      const row = asset('22222222-2222-4222-8222-222222222222', input.file.name, {
        provenance: input.provenance ?? {},
      });
      fake.rows('media_assets').push(row);
      return row;
    });

    const { user } = renderApp(`${BRAND_BASE}/contenidos/content-1`);
    await screen.findByTestId('editor-title');
    await user.click(screen.getByRole('tab', { name: /Capas/ }));
    await user.click(await screen.findByTestId('layer-item'));
    await user.click(screen.getByRole('tab', { name: 'Diseño' }));
    await user.click(await screen.findByTestId('layer-edit-photo'));
    const dialog = within(await screen.findByTestId('photo-edit'));
    await dialog.findByTestId('photo-edit-preview');
    await user.click(dialog.getByTestId('photo-edit-auto'));
    await user.click(dialog.getByTestId('photo-edit-save'));
    await user.click(await dialog.findByTestId('photo-edit-use'));

    await waitFor(() => expect(screen.queryByTestId('photo-edit')).not.toBeInTheDocument());
    expect(uploaded[0]!.provenance).toMatchObject({ source_asset_id: original.id });
    expect(fake.rows('media_assets').find((r) => r.id === original.id)).toEqual(original);
    expect(await screen.findByText(/La capa usa ahora la foto editada/)).toBeInTheDocument();
  });
});
