// RGPD en la interfaz: páginas legales, «Mi cuenta» (documentos aceptados,
// descargar mis datos, borrar la cuenta) y Configuración → Datos (exportar y
// borrar la organización). Contra el Supabase simulado.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_VERSIONS } from '@/features/legal/legal';
import { fake } from '@/test/fakeSupabase';
import { BASE, ME, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

/** Lo que la aplicación «descarga»: se captura el contenido del Blob. */
let downloads: Blob[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  downloads = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    downloads.push(blob);
    return 'blob:prueba';
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

async function downloaded(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(downloads).toHaveLength(1));
  return JSON.parse(await downloads[0]!.text()) as Record<string, unknown>;
}

function acceptance(document: 'terms' | 'privacy', version: string, id: number) {
  return { id, user_id: ME.id, document, version, accepted_at: '2026-11-19T10:00:00Z', source: 'signup' };
}

describe('páginas legales', () => {
  it.each([
    ['/legal/privacidad', 'Política de privacidad'],
    ['/legal/condiciones', 'Condiciones de uso'],
    ['/legal/aviso-legal', 'Aviso legal'],
    ['/legal/cookies', 'Política de cookies'],
  ])('%s se ve sin sesión, con el aviso de borrador y los huecos sin rellenar', async (path, title) => {
    renderApp(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByTestId('legal-draft-warning')).toHaveTextContent('un abogado debe revisar');
    expect(screen.getByTestId('legal-draft-warning')).toHaveTextContent('no es asesoría legal');
    expect(screen.getByTestId('legal-footer')).toBeInTheDocument();
  });

  it('la política de privacidad lista los encargados y no inventa datos de la empresa', async () => {
    renderApp('/legal/privacidad');
    const table = await screen.findByTestId('legal-processors');
    expect(within(table).getByText('Supabase (Supabase Inc.)')).toBeInTheDocument();
    expect(within(table).getByText('Vercel (Vercel Inc.)')).toBeInTheDocument();
    expect(within(table).getByText('Cloudflare R2 (Cloudflare, Inc.)')).toBeInTheDocument();
    expect(within(table).getByText('Google Drive (Google LLC)')).toBeInTheDocument();
    expect(within(table).getByText(/Dictado por voz del navegador/)).toBeInTheDocument();
    expect(within(table).getByText(/jurisdicción UE del cubo/)).toBeInTheDocument();
    const page = screen.getByTestId('legal-page-privacy');
    expect(page).toHaveTextContent('el navegador envía el audio a Google (Chrome) o Microsoft (Edge)');
    expect(page).toHaveTextContent('[RAZÓN SOCIAL]');
    expect(page).toHaveTextContent('[CIF]');
    expect(page).toHaveTextContent('[CORREO DE PRIVACIDAD]');
    expect(page).toHaveTextContent(`Versión ${LEGAL_VERSIONS.privacy}`);
  });

  it('la política de cookies dice que no hay cookies y lista lo que se guarda en el navegador', async () => {
    renderApp('/legal/cookies');
    expect(await screen.findByText('no usa cookies')).toBeInTheDocument();
    expect(within(screen.getByTestId('legal-storage')).getByText('rrss.theme')).toBeInTheDocument();
  });

  it('el pie de la aplicación enlaza a las cuatro', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp(BASE);
    const footer = await screen.findByTestId('legal-footer');
    expect(
      within(footer)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toEqual(['/legal/privacidad', '/legal/condiciones', '/legal/aviso-legal', '/legal/cookies']);
  });
});

describe('Mi cuenta', () => {
  it('se llega desde el menú de usuario y enseña las versiones aceptadas', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'viewer' });
    fake.tables.legal_acceptances = [
      acceptance('terms', LEGAL_VERSIONS.terms, 1),
      acceptance('privacy', LEGAL_VERSIONS.privacy, 2),
    ];
    const { user } = renderApp(BASE);
    await user.click((await screen.findAllByTestId('user-menu'))[0]!);
    await user.click(await screen.findByTestId('nav-account'));
    expect(await screen.findByRole('heading', { name: 'Mi cuenta y privacidad' })).toBeInTheDocument();
    const legal = await screen.findByTestId('account-legal');
    expect(await within(legal).findAllByText('Vigente')).toHaveLength(2);
    expect(within(legal).queryByTestId('account-legal-pending')).not.toBeInTheDocument();
  });

  it('una cuenta sin aceptación vigente puede aceptar desde aquí', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.legal_acceptances = [acceptance('terms', '2020-01-01', 1)];
    fake.rpc('accept_legal_documents', (args) => {
      expect(args).toEqual({ p_terms_version: LEGAL_VERSIONS.terms, p_privacy_version: LEGAL_VERSIONS.privacy });
      return [acceptance('terms', LEGAL_VERSIONS.terms, 3), acceptance('privacy', LEGAL_VERSIONS.privacy, 4)];
    });
    const { user } = renderApp('/cuenta');
    await user.click(await screen.findByTestId('account-legal-accept'));
    await waitFor(() => expect(screen.queryByTestId('account-legal-pending')).not.toBeInTheDocument());
  });

  it('«Descargar mis datos» descarga el JSON que da la base de datos', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.legal_acceptances = [];
    fake.rpc('export_my_data', () => ({ format: 'rrss.personal-data', account: { id: ME.id } }));
    const { user } = renderApp('/cuenta');
    await user.click(await screen.findByTestId('account-export-download'));
    expect(await downloaded()).toEqual({ format: 'rrss.personal-data', account: { id: ME.id } });
    expect(fake.callsTo('export_my_data', 'rpc')[0]!.payload).toEqual({});
  });

  it('borrar la cuenta exige el correo exacto y la contraseña, y avisa de lo que se borra con ella', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.legal_acceptances = [];
    fake.rpc('my_account_deletion_check', () => ({
      blocking: [],
      deleted_with_account: [{ organization_id: ORG_ID, name: 'Grupo Demo' }],
    }));
    fake.fn('delete-account', () => ({ status: 200, body: { deleted: true, deletedOrganizations: [] } }));
    window.localStorage.setItem(`rrss.last.${ME.id}`, '{}');

    const { user } = renderApp('/cuenta');
    await user.click(await screen.findByTestId('account-delete-open'));
    expect(await screen.findByTestId('account-delete-with-account')).toHaveTextContent('Grupo Demo');
    const confirm = screen.getByTestId('account-delete-confirm');
    await user.type(screen.getByTestId('account-delete-email'), 'otra@example.com');
    await user.type(screen.getByTestId('account-delete-password'), 'secreta123');
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByTestId('account-delete-email'));
    await user.type(screen.getByTestId('account-delete-email'), ME.email!.toUpperCase());
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(fake.callsTo('delete-account', 'function')[0]!.payload).toEqual({
      confirmation: ME.email!.toUpperCase(),
      password: 'secreta123',
    });
    expect(fake.session).toBeNull();
    expect(window.localStorage.getItem(`rrss.last.${ME.id}`)).toBeNull();
  });

  it('si es la única propietaria de una organización con más miembros, no deja borrar y dice cuál', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.legal_acceptances = [];
    fake.rpc('my_account_deletion_check', () => ({
      blocking: [{ organization_id: ORG_ID, name: 'Grupo Demo', members: 3 }],
      deleted_with_account: [],
    }));
    const { user } = renderApp('/cuenta');
    await user.click(await screen.findByTestId('account-delete-open'));
    const blocking = await screen.findByTestId('account-delete-blocking');
    expect(within(blocking).getByRole('link', { name: 'Grupo Demo' })).toHaveAttribute(
      'href',
      `/o/${ORG_ID}/ajustes/equipo`,
    );
    expect(screen.getByTestId('account-delete-email')).toBeDisabled();
    expect(screen.getByTestId('account-delete-confirm')).toBeDisabled();
  });

  it('muestra el error del servidor (contraseña incorrecta) y no cierra la sesión', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.legal_acceptances = [];
    fake.rpc('my_account_deletion_check', () => ({ blocking: [], deleted_with_account: [] }));
    fake.fn('delete-account', () => ({
      status: 403,
      body: { error: { code: 'wrong_password', message: 'La contraseña no es correcta.' } },
    }));
    const { user } = renderApp('/cuenta');
    await user.click(await screen.findByTestId('account-delete-open'));
    await user.type(await screen.findByTestId('account-delete-email'), ME.email!);
    await user.type(screen.getByTestId('account-delete-password'), 'mala');
    await user.click(screen.getByTestId('account-delete-confirm'));
    expect(await screen.findByTestId('account-delete-error')).toHaveTextContent('La contraseña no es correcta.');
    expect(fake.session).not.toBeNull();
  });
});

describe('Configuración → Datos de la organización', () => {
  it('solo la ve un propietario', async () => {
    seedWorkspace({ orgRole: 'admin' });
    renderApp(`${BASE}/ajustes/datos`);
    await waitFor(() => expect(window.location.pathname).toBe(`${BASE}/ajustes/general`));
    expect(screen.queryByTestId('org-data-page')).not.toBeInTheDocument();
  });

  it('exportar descarga el JSON con un enlace firmado por archivo', async () => {
    seedWorkspace({ orgRole: 'owner' });
    const path = `${ORG_ID}/brand-1/media/foto.jpg`;
    fake.rpc('export_organization_data', (args) => {
      expect(args).toEqual({ p_organization_id: ORG_ID });
      return { format: 'rrss.organization-export', brands: [{ id: 'brand-1', assets: [{ storage_path: path }] }] };
    });
    const signed = vi.fn(async (paths: string[], seconds: number) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://firmado.test/${p}?s=${seconds}`, error: null })),
      error: null,
    }));
    const from = fake.storage.from;
    fake.storage.from = () => ({
      ...from(),
      createSignedUrls: signed as unknown as ReturnType<typeof from>['createSignedUrls'],
    });
    try {
      const { user } = renderApp(`${BASE}/ajustes/datos`);
      await user.click(await screen.findByTestId('org-export-download'));
      const data = await downloaded();
      expect(data.format).toBe('rrss.organization-export');
      expect((data.files as { items: unknown[] }).items).toEqual([
        { path, url: `https://firmado.test/${path}?s=3600` },
      ]);
    } finally {
      fake.storage.from = from;
    }
  });

  it('borrar exige escribir el nombre exacto y llama a la función del servidor', async () => {
    seedWorkspace({ orgRole: 'owner' });
    fake.fn('delete-organization', () => ({ status: 200, body: { deleted: true, filesPending: 0 } }));
    const { user } = renderApp(`${BASE}/ajustes/datos`);
    await user.click(await screen.findByTestId('org-delete-open'));
    const confirm = await screen.findByTestId('org-delete-confirm');
    await user.type(screen.getByTestId('org-delete-name'), 'grupo demo');
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByTestId('org-delete-name'));
    await user.type(screen.getByTestId('org-delete-name'), 'Grupo Demo');
    await user.click(confirm);
    await waitFor(() =>
      expect(fake.callsTo('delete-organization', 'function')[0]?.payload).toEqual({
        organizationId: ORG_ID,
        confirmation: 'Grupo Demo',
      }),
    );
  });
});
