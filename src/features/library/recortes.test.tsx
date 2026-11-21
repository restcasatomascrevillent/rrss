import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ORG_ID, seedWorkspace, renderApp } from '@/test/fixtures';

const asset = (id: string, fileName: string, extra: Record<string, unknown> = {}) => ({
  id,
  brand_id: BRAND_ID,
  organization_id: ORG_ID,
  kind: 'image',
  origin: 'upload',
  storage_path: `${ORG_ID}/${BRAND_ID}/media/${fileName}`,
  file_name: fileName,
  mime_type: 'image/jpeg',
  bytes: 1000,
  width: 4000,
  height: 3000,
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
});

const FOTO = `${ORG_ID}/${BRAND_ID}/media/plato.jpg`;

const cropJob = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  organization_id: ORG_ID,
  brand_id: BRAND_ID,
  kind: 'media.image.process',
  payload: {
    source: { path: FOTO },
    outputs: [{ aspect: '1:1', path: `${ORG_ID}/${BRAND_ID}/recortes/x-1-1x1.jpg` }],
  },
  status,
  priority: 0,
  idempotency_key: `media:${BRAND_ID}:${id}`,
  attempts: 0,
  max_attempts: 3,
  run_after: '2026-11-18T10:00:00Z',
  locked_by: null,
  locked_until: null,
  result: null,
  last_error: null,
  created_by: null,
  created_at: '2026-11-18T10:00:00Z',
  updated_at: '2026-11-18T10:00:00Z',
  finished_at: null,
  ...extra,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Recortes desde la ficha de una foto', () => {
  it('sin trabajador de medios no aparecen', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.media_assets = [asset('foto-1', 'plato.jpg')];
    fake.tables.jobs = [];
    const { user } = renderApp(`${BRAND_BASE}/biblioteca`);
    await user.click(await screen.findByTestId('library-asset'));
    await screen.findByRole('dialog');
    expect(screen.queryByTestId('crops')).not.toBeInTheDocument();
  });

  it('quien edita elige formatos y encarga; ve el estado y abre el recorte terminado', async () => {
    vi.stubEnv('VITE_MEDIA_WORKER_ENABLED', 'true');
    seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
    fake.tables.media_assets = [asset('foto-1', 'plato.jpg')];
    // Un recorte de otra foto no sale en esta ficha.
    fake.tables.jobs = [cropJob('otra', 'queued', { payload: { source: { path: 'otra/ruta.jpg' }, outputs: [] } })];
    fake.rpc('request_media_job', (args) => {
      const created = cropJob('nuevo', 'queued', { payload: args.p_input });
      fake.rows('jobs').push(created);
      return created;
    });
    const { user } = renderApp(`${BRAND_BASE}/biblioteca`);
    await user.click(await screen.findByTestId('library-asset'));
    const panel = await screen.findByTestId('crops');
    expect(within(panel).queryByTestId('crop-job')).not.toBeInTheDocument();

    // Por defecto 1:1, 4:5 y 9:16; se quita 4:5 y se añade 16:9.
    await user.click(within(panel).getByTestId('crop-aspect-4:5'));
    await user.click(within(panel).getByTestId('crop-aspect-16:9'));
    await user.click(within(panel).getByTestId('crop-submit'));
    await screen.findByText(/Recortes encargados/);
    const [call] = fake.callsTo('request_media_job', 'rpc');
    expect(call!.payload).toMatchObject({
      p_brand_id: BRAND_ID,
      p_kind: 'media.image.process',
      p_input: {
        source: { path: FOTO },
        focalPoint: { x: 0.5, y: 0.5 },
        outputs: [
          { aspect: '1:1', width: 1080, format: 'jpeg' },
          { aspect: '9:16', width: 1080, format: 'jpeg' },
          { aspect: '16:9', width: 1080, format: 'jpeg' },
        ],
      },
    });
    expect(await within(panel).findByTestId('crop-job-status')).toHaveTextContent('En cola');

    // Termina: el recorte es un recurso nuevo y se abre su ficha.
    const job = fake.rows('jobs').find((j) => j.id === 'nuevo')!;
    const path = `${ORG_ID}/${BRAND_ID}/recortes/x-1-1x1.jpg`;
    Object.assign(job, {
      status: 'succeeded',
      payload: { ...(job.payload as object), outputs: [{ aspect: '1:1', path }] },
      result: { assets: [{ id: 'recorte-1', path, kind: 'image' }] },
    });
    fake
      .rows('media_assets')
      .push(
        asset('recorte-1', 'plato-1x1.jpg', {
          storage_path: path,
          folder: 'Recortes',
          created_at: '2026-11-18T11:00:00Z',
        }),
      );
    await waitFor(() => expect(within(panel).getByTestId('crop-job-status')).toHaveTextContent('Listo'), {
      timeout: 8000,
    });
    await user.click(within(panel).getByTestId('crop-open'));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByDisplayValue('plato-1x1.jpg')).toBeVisible());
  }, 20_000);

  it('quien edita cancela un recorte en marcha', async () => {
    vi.stubEnv('VITE_MEDIA_WORKER_ENABLED', 'true');
    seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
    fake.tables.media_assets = [asset('foto-1', 'plato.jpg')];
    fake.tables.jobs = [cropJob('j1', 'running')];
    fake.rpc('cancel_media_job', (args) => {
      const row = fake.rows('jobs').find((j) => j.id === args.p_job_id)!;
      Object.assign(row, { status: 'cancelled' });
      return row;
    });
    const { user } = renderApp(`${BRAND_BASE}/biblioteca`);
    await user.click(await screen.findByTestId('library-asset'));
    const panel = await screen.findByTestId('crops');
    await user.click(await within(panel).findByTestId('crop-cancel'));
    await waitFor(() => expect(within(panel).getByTestId('crop-job-status')).toHaveTextContent('Cancelado'));
    expect(fake.callsTo('cancel_media_job', 'rpc')[0]!.payload).toEqual({ p_job_id: 'j1' });
  });

  it('quien solo ve la marca ve el estado pero no encarga ni cancela', async () => {
    vi.stubEnv('VITE_MEDIA_WORKER_ENABLED', 'true');
    seedWorkspace({ orgRole: 'member', brandRole: 'viewer' });
    fake.tables.media_assets = [asset('foto-1', 'plato.jpg')];
    fake.tables.jobs = [cropJob('j1', 'queued')];
    const { user } = renderApp(`${BRAND_BASE}/biblioteca`);
    await user.click(await screen.findByTestId('library-asset'));
    const panel = await screen.findByTestId('crops');
    expect(await within(panel).findByTestId('crop-job-status')).toHaveTextContent('En cola');
    expect(within(panel).queryByTestId('crop-submit')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('crop-cancel')).not.toBeInTheDocument();
  });
});
