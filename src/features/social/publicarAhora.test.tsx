import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentItemRow, ScheduledPublicationRow, SocialAccountRow } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

// «Publicar ahora» (calendario y diálogo de programar): confirmación en un
// paso, el aviso, las llamadas (RPC y función con la sesión), el progreso con
// sondeo y el resultado: enlace o error con «Reintentar». Las garantías las
// impone la base de datos (tests/db/publicacion.test.ts).

const soon = () => new Date(Date.now() + 2 * 3_600_000).toISOString();
const LINK = 'https://instagram.simulado.invalid/p/17900000000042/';

function content(id: string, patch: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    title: `Pieza ${id}`,
    network: 'instagram',
    format: 'post',
    status: 'approved',
    current_version: 1,
    archived_at: null,
    created_by: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  } as ContentItemRow;
}

function pub(id: string, contentId: string, patch: Partial<ScheduledPublicationRow> = {}): ScheduledPublicationRow {
  return {
    id,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    content_id: contentId,
    content_version: 1,
    social_account_id: 'acc-1',
    network: 'instagram',
    format: 'post',
    scheduled_at: soon(),
    media_asset_ids: ['asset-1'],
    status: 'scheduled',
    hold_reason: null,
    generation: 1,
    attempt_count: 0,
    last_error_code: null,
    last_error: null,
    container_id: null,
    container_created_at: null,
    external_id: null,
    external_url: null,
    published_at: null,
    locked_by: null,
    locked_until: null,
    created_by: null,
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...patch,
  };
}

const account: SocialAccountRow = {
  id: 'acc-1',
  brand_id: BRAND_ID,
  organization_id: ORG_ID,
  network: 'instagram',
  provider: 'meta',
  external_id: '17841400000000001',
  username: 'casa_demo',
  display_name: 'Casa Demo',
  page_id: '1',
  status: 'active',
  scopes: [],
  token_expires_at: null,
  token_checked_at: null,
  quota_usage: null,
  quota_total: null,
  quota_checked_at: null,
  last_error: null,
  connected_by: null,
  connected_at: '2026-11-18T09:00:00Z',
  disconnected_at: null,
  connection_method: 'oauth',
  created_at: '2026-11-18T09:00:00Z',
  updated_at: '2026-11-18T09:00:00Z',
};

function seed(orgRole: 'owner' | 'member' = 'owner') {
  vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
  seedWorkspace(orgRole === 'owner' ? { orgRole: 'owner' } : { orgRole: 'member', brandRole: 'viewer' });
  fake.tables.content_items = [content('c-prog'), content('c-rev', { status: 'in_review' })];
  fake.tables.scheduled_publications = [pub('p-prog', 'c-prog')];
  fake.tables.publication_attempts = [];
  fake.tables.content_comments = [];
  fake.tables.social_accounts = [account];
  fake.tables.media_assets = [
    {
      id: 'asset-1',
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      kind: 'image',
      mime_type: 'image/jpeg',
      file_name: 'exportada-v1.jpg',
      provenance: { type: 'export', content_id: 'c-prog', version: 1, unsaved_changes: false },
      created_at: '2026-11-18T09:00:00Z',
    },
  ];
}

/** La base de datos simulada: «ahora» deja la fila armada con la hora actual; la función la procesa. */
function simulatePublisher(outcome: 'published' | 'failed') {
  fake.rpc('publish_publication_now', (args) => {
    const row = fake.rows('scheduled_publications').find((r) => r.content_id === args.p_content_id)!;
    Object.assign(row, { scheduled_at: new Date().toISOString(), status: 'scheduled' });
    return structuredClone(row);
  });
  fake.fn('social-publish/now', () => {
    // El publicador tarda un poco: mientras, la ficha enseña «Publicando…».
    setTimeout(() => {
      const row = fake.rows('scheduled_publications')[0]!;
      if (outcome === 'published')
        Object.assign(row, {
          status: 'published',
          external_id: '17900000000042',
          external_url: LINK,
          published_at: new Date().toISOString(),
        });
      else Object.assign(row, { status: 'failed', last_error: 'Instagram rechazó la imagen' });
    }, 300);
    return { status: 200, body: { processed: 1 } };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function openFicha() {
  const { user } = renderApp(`${BRAND_BASE}/calendario`);
  const chip = (await screen.findAllByTestId('calendar-entry')).find((e) => e.textContent?.includes('Pieza c-prog'))!;
  await user.click(chip);
  return user;
}

describe('Publicar ahora desde la ficha del calendario', () => {
  it('confirma en un paso, publica y enseña «Publicada» con su enlace', async () => {
    seed();
    simulatePublisher('published');
    const user = await openFicha();
    await user.click(await screen.findByTestId('publication-publish-now'));

    expect(await screen.findByTestId('publish-now-warning')).toHaveTextContent(
      'Se publicará ahora en @casa_demo. No se puede deshacer desde aquí.',
    );
    // Hasta confirmar no se llama a nada.
    expect(fake.callsTo('publish_publication_now', 'rpc')).toHaveLength(0);
    await user.click(screen.getByTestId('publish-now-confirm'));

    await waitFor(() => expect(fake.callsTo('publish_publication_now', 'rpc')).toHaveLength(1));
    expect(fake.callsTo('publish_publication_now', 'rpc')[0]!.payload).toEqual({
      p_content_id: 'c-prog',
      p_social_account_id: 'acc-1',
      p_media_asset_ids: ['asset-1'],
      p_content_version: 1,
      p_publication_id: 'p-prog',
    });
    // Pide al publicador que la procese ya, con la publicación como único dato.
    await waitFor(() => expect(fake.callsTo('social-publish/now', 'function')).toHaveLength(1));
    expect(fake.callsTo('social-publish/now', 'function')[0]!.payload).toEqual({ publicationId: 'p-prog' });
    expect(await screen.findByTestId('publish-now-progress')).toHaveTextContent('Publicando…');

    // Sin tiempo real: se sondea el estado hasta ver «Publicada».
    expect(await screen.findByTestId('publish-now-done', undefined, { timeout: 6000 })).toHaveTextContent('Publicada');
    expect(screen.getByTestId('publish-now-link')).toHaveAttribute('href', LINK);
  }, 15000);

  it('si falla, enseña el error y «Reintentar» vuelve a pedirlo', async () => {
    seed();
    simulatePublisher('failed');
    const user = await openFicha();
    await user.click(await screen.findByTestId('publication-publish-now'));
    await user.click(await screen.findByTestId('publish-now-confirm'));

    expect(await screen.findByTestId('publish-now-failed', undefined, { timeout: 6000 })).toHaveTextContent(
      'Instagram rechazó la imagen',
    );
    simulatePublisher('published');
    await user.click(screen.getByTestId('publish-now-retry'));
    await waitFor(() => expect(fake.callsTo('publish_publication_now', 'rpc')).toHaveLength(2));
    expect(await screen.findByTestId('publish-now-done', undefined, { timeout: 6000 })).toBeInTheDocument();
  }, 20000);

  it('si la base de datos lo niega, se dice por qué y no queda «Publicando»', async () => {
    seed();
    fake.rpc('publish_publication_now', () => {
      throw { code: 'PB003', message: 'No se puede publicar ahora', details: 'account_needs_reauth' };
    });
    const user = await openFicha();
    await user.click(await screen.findByTestId('publication-publish-now'));
    await user.click(await screen.findByTestId('publish-now-confirm'));
    expect(await screen.findByTestId('publish-now-error')).toHaveTextContent(/ha caducado/);
    expect(screen.queryByTestId('publish-now-progress')).toBeNull();
    expect(fake.callsTo('social-publish/now', 'function')).toHaveLength(0);
  });

  it('quien solo ve no tiene el botón', async () => {
    seed('member');
    renderApp(`${BRAND_BASE}/calendario`);
    const chip = (await screen.findAllByTestId('calendar-entry')).find((e) => e.textContent?.includes('Pieza c-prog'))!;
    chip.click();
    await screen.findByTestId('publication-dialog');
    expect(screen.queryByTestId('publication-publish-now')).toBeNull();
  });
});

describe('Publicar ahora desde «Programar una publicación»', () => {
  it('la opción «Ahora» sustituye al día y la hora y pide confirmación', async () => {
    seed();
    fake.rows('content_items').push(content('c-new', { title: 'Nueva pieza' }));
    fake.rows('media_assets').push({
      id: 'asset-new',
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      kind: 'image',
      mime_type: 'image/jpeg',
      file_name: 'nueva-v1.jpg',
      provenance: { type: 'export', content_id: 'c-new', version: 1, unsaved_changes: false },
      created_at: '2026-11-18T09:00:00Z',
    });
    fake.rpc('publish_publication_now', (args) => {
      const created = pub('p-new', String(args.p_content_id), { media_asset_ids: ['asset-new'] });
      fake.rows('scheduled_publications').push(created);
      return created;
    });
    fake.fn('social-publish/now', () => ({ status: 200, body: {} }));
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    await user.click(await screen.findByTestId('calendar-schedule'));
    await user.selectOptions(await screen.findByTestId('schedule-content'), 'c-new');
    await user.click(await screen.findByTestId('schedule-asset'));
    await user.click(screen.getByTestId('schedule-mode-now'));
    expect(screen.queryByTestId('schedule-when')).toBeNull();
    await user.click(screen.getByTestId('schedule-submit'));

    const dialog = await screen.findByTestId('publish-now');
    expect(within(dialog).getByTestId('publish-now-warning')).toHaveTextContent('Se publicará ahora en @casa_demo.');
    expect(fake.callsTo('save_publication', 'rpc')).toHaveLength(0);
    await user.click(screen.getByTestId('publish-now-confirm'));
    await waitFor(() => expect(fake.callsTo('publish_publication_now', 'rpc')).toHaveLength(1));
    expect(fake.callsTo('publish_publication_now', 'rpc')[0]!.payload).toMatchObject({
      p_content_id: 'c-new',
      p_media_asset_ids: ['asset-new'],
      p_content_version: 1,
      p_publication_id: null,
    });
  });

  it('una pieza sin aprobar no se puede publicar ahora', async () => {
    seed();
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    await user.click(await screen.findByTestId('calendar-schedule'));
    await user.selectOptions(await screen.findByTestId('schedule-content'), 'c-rev');
    await user.click(screen.getByTestId('schedule-mode-now'));
    await user.click(screen.getByTestId('schedule-submit'));
    expect(await screen.findByTestId('schedule-error')).toHaveTextContent('Solo se publica lo aprobado.');
    expect(fake.callsTo('publish_publication_now', 'rpc')).toHaveLength(0);
  });
});

describe('Carrusel: las páginas de la versión aprobada, en orden', () => {
  function seedCarousel() {
    seed();
    fake.rows('content_items').push(content('c-car', { title: 'Carrusel de otoño', format: 'carousel' }));
    // Exportadas en desorden (y una tanda vieja de 2 páginas): se eligen las 3 de la última tanda, en su orden.
    const page = (id: string, n: number, count: number, at: string) => ({
      id,
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      kind: 'image',
      mime_type: 'image/jpeg',
      file_name: `carrusel-v1-p${n}.jpg`,
      provenance: { type: 'export', content_id: 'c-car', version: 1, unsaved_changes: false, page: n, page_count: count },
      created_at: at,
    });
    fake.rows('media_assets').push(
      page('car-3', 3, 3, '2026-11-20T10:00:03Z'),
      page('car-1', 1, 3, '2026-11-20T10:00:01Z'),
      page('vieja-1', 1, 2, '2026-11-19T10:00:00Z'),
      page('car-2', 2, 3, '2026-11-20T10:00:02Z'),
    );
  }

  it('al programar se eligen solas las páginas en orden y se guardan así', async () => {
    seedCarousel();
    fake.rpc('save_publication', (args) => {
      const created = pub('p-car', String(args.p_content_id), {
        format: 'carousel',
        media_asset_ids: args.p_media_asset_ids as string[],
      });
      fake.rows('scheduled_publications').push(created);
      return created;
    });
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    await user.click(await screen.findByTestId('calendar-schedule'));
    await user.selectOptions(await screen.findByTestId('schedule-content'), 'c-car');
    expect(await screen.findByTestId('schedule-pages-hint')).toHaveTextContent('las 3 páginas de la versión 1');
    const checked = screen.getAllByTestId('schedule-asset').filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(3);
    await user.click(screen.getByTestId('schedule-submit'));
    await waitFor(() => expect(fake.callsTo('save_publication', 'rpc')).toHaveLength(1));
    expect(fake.callsTo('save_publication', 'rpc')[0]!.payload).toMatchObject({
      p_content_id: 'c-car',
      p_media_asset_ids: ['car-1', 'car-2', 'car-3'],
    });
  });

  it('«Publicar ahora» manda las páginas en orden', async () => {
    seedCarousel();
    fake.rpc('publish_publication_now', (args) => {
      const created = pub('p-car', String(args.p_content_id), {
        format: 'carousel',
        media_asset_ids: args.p_media_asset_ids as string[],
      });
      fake.rows('scheduled_publications').push(created);
      return created;
    });
    fake.fn('social-publish/now', () => ({ status: 200, body: {} }));
    const { user } = renderApp(`${BRAND_BASE}/calendario`);
    await user.click(await screen.findByTestId('calendar-schedule'));
    await user.selectOptions(await screen.findByTestId('schedule-content'), 'c-car');
    await user.click(screen.getByTestId('schedule-mode-now'));
    await user.click(screen.getByTestId('schedule-submit'));
    await screen.findByTestId('publish-now');
    await user.click(screen.getByTestId('publish-now-confirm'));
    await waitFor(() => expect(fake.callsTo('publish_publication_now', 'rpc')).toHaveLength(1));
    expect(fake.callsTo('publish_publication_now', 'rpc')[0]!.payload).toMatchObject({
      p_content_id: 'c-car',
      p_media_asset_ids: ['car-1', 'car-2', 'car-3'],
    });
  });
});
