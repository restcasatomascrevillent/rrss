import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BrandRole, OrgRole } from '@/lib/database.types';
import { fake } from '@/test/fakeSupabase';
import { BASE, BRAND_BASE, brandRow, renderApp, seedWorkspace } from '@/test/fixtures';

type UI = ReturnType<typeof renderApp>['user'];

// El shell pinta la navegación dos veces (barra lateral y barra inferior móvil);
// el CSS decide cuál se ve. Aquí se comprueba la de escritorio, la primera.
async function mainNav() {
  const navs = await screen.findAllByRole('navigation', { name: 'Principal' });
  return within(navs[0]!);
}
const linkNames = (nav: Awaited<ReturnType<typeof mainNav>>) =>
  nav.getAllByRole('link').map((link: HTMLElement) => link.textContent);

async function openMenu(user: UI, testId: string) {
  await user.click((await screen.findAllByTestId(testId))[0]!);
  return within(await screen.findByRole('menu'));
}

const ROLES: { label: string; orgRole: OrgRole; brandRole?: BrandRole }[] = [
  { label: 'propietario', orgRole: 'owner' },
  { label: 'administrador', orgRole: 'admin' },
  { label: 'miembro gestor de la marca', orgRole: 'member', brandRole: 'manager' },
  { label: 'miembro editor', orgRole: 'member', brandRole: 'editor' },
  { label: 'miembro solo lectura', orgRole: 'member', brandRole: 'viewer' },
];

describe('Menú de una marca', () => {
  it.each(ROLES)('para $label muestra solo lo que ya existe, sin áreas futuras', async ({ orgRole, brandRole }) => {
    seedWorkspace({ orgRole, brandRole });
    renderApp(`${BRAND_BASE}/inicio`);
    const nav = await mainNav();
    expect(linkNames(nav)).toEqual([
      'Inicio',
      'Contenidos',
      'Calendario',
      'Analítica',
      'Biblioteca',
      'Marca',
      'Equipo',
      'Configuración',
    ]);
    for (const futura of ['Crear', 'Campañas', 'Estadísticas', 'Asistente'])
      expect(nav.queryByRole('link', { name: futura })).not.toBeInTheDocument();
  });

  it('sin marca elegida, el menú es el de la organización', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp(BASE);
    const nav = await mainNav();
    expect(linkNames(nav)).toEqual(['Marcas', 'Configuración']);
  });

  it('el enlace de la sección actual queda marcado', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp(`${BRAND_BASE}/equipo`);
    const nav = await mainNav();
    expect(nav.getByRole('link', { name: 'Equipo' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Inicio' })).not.toHaveAttribute('aria-current');
  });
});

describe('Crear marcas: quién ve la opción', () => {
  it.each(ROLES)('selector de marca para $label', async ({ orgRole, brandRole }) => {
    seedWorkspace({ orgRole, brandRole });
    const { user } = renderApp(`${BRAND_BASE}/inicio`);
    const menu = await openMenu(user, 'brand-switcher');
    expect(menu.getByRole('menuitem', { name: /^Casa Demo/ })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Ver todas las marcas' })).toBeInTheDocument();
    const canCreate = orgRole === 'owner' || orgRole === 'admin';
    if (canCreate) expect(menu.getByRole('menuitem', { name: 'Nueva marca' })).toBeInTheDocument();
    else expect(menu.queryByRole('menuitem', { name: 'Nueva marca' })).not.toBeInTheDocument();
  });

  it('el panel de marcas ofrece «Nueva marca» a los administradores', async () => {
    seedWorkspace({ orgRole: 'admin' });
    renderApp(BASE);
    expect((await screen.findByTestId('new-brand')).closest('a')).toHaveAttribute('href', `${BASE}/marcas/nueva`);
  });

  it('el panel de marcas no la ofrece a un miembro y le explica cómo conseguir acceso', async () => {
    seedWorkspace({ orgRole: 'member', brands: [] });
    renderApp(BASE);
    expect(await screen.findByText('Todavía no tienes acceso a ninguna marca')).toBeInTheDocument();
    expect(screen.queryByTestId('new-brand')).not.toBeInTheDocument();
    expect(screen.queryByTestId('new-brand-empty')).not.toBeInTheDocument();
  });

  it('un miembro solo ve las marcas a las que tiene acceso, con su rol', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'reviewer' });
    renderApp(BASE);
    const card = await screen.findByTestId('brand-card-brand-1');
    expect(card).toHaveTextContent('Revisor');
  });
});

describe('Rutas según permisos', () => {
  it('una marca a la que no se tiene acceso no existe para ese usuario', async () => {
    seedWorkspace({ orgRole: 'member', brands: [] });
    renderApp(`${BASE}/m/brand-1/inicio`);
    expect(await screen.findByText('No encontramos esta marca')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver mis marcas' })).toHaveAttribute('href', BASE);
  });

  it('una organización ajena se trata como inexistente', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp('/o/org-ajena/m/brand-x/inicio');
    expect(await screen.findByText('No tienes acceso a esta organización')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a mis organizaciones' })).toBeInTheDocument();
  });

  it('el inicio de la marca dice el rol de cada persona', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'client' });
    renderApp(`${BRAND_BASE}/inicio`);
    expect(await screen.findByText(/Tu rol: Cliente/)).toBeInTheDocument();
  });

  it('los administradores de la organización entran como gestores de todas las marcas', async () => {
    seedWorkspace({ orgRole: 'admin', brands: [brandRow(), brandRow({ id: 'brand-2', name: 'Otra Marca' })] });
    renderApp(`${BASE}/m/brand-2/inicio`);
    expect(await screen.findByText(/Tu rol: Gestor/)).toBeInTheDocument();
  });

  it('en «Marca», los datos y el archivado son solo para gestores', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
    renderApp(`${BRAND_BASE}/marca?seccion=datos`);
    expect(await screen.findByLabelText('Nombre comercial')).toBeDisabled();
    expect(screen.queryByTestId('brand-archive')).not.toBeInTheDocument();
  });

  it('un gestor de marca sí puede archivarla, con confirmación', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'manager' });
    const { user } = renderApp(`${BRAND_BASE}/marca?seccion=datos`);
    await user.click(await screen.findByTestId('brand-archive'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('¿Archivar Casa Demo?')).toBeInTheDocument();
    expect(fake.callsTo('brands', 'update')).toHaveLength(0);
    await user.click(dialog.getByTestId('confirm-action'));
    expect(await screen.findByText('Marca archivada')).toBeInTheDocument();
    expect(fake.rows('brands')[0]?.status).toBe('archived');
  });
});

describe('Configuración de la organización', () => {
  it.each([
    ['owner' as const, true],
    ['admin' as const, true],
    ['member' as const, false],
  ])('pestañas para %s (Actividad: %s)', async (orgRole, activity) => {
    seedWorkspace({ orgRole, brandRole: orgRole === 'member' ? 'viewer' : undefined });
    renderApp(`${BASE}/ajustes`);
    const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(
      activity
        ? ['General', 'Equipo', 'Actividad', 'Consumo de IA', 'Plan', ...(orgRole === 'owner' ? ['Datos'] : [])]
        : ['General', 'Equipo'],
    );
    // La ruta sin sección lleva a General.
    await waitFor(() => expect(window.location.pathname).toBe(`${BASE}/ajustes/general`));
  });

  it('un administrador puede cambiar el nombre de la organización', async () => {
    seedWorkspace({ orgRole: 'admin' });
    const { user } = renderApp(`${BASE}/ajustes/general`);
    const name = await screen.findByTestId('org-settings-name');
    const save = screen.getByTestId('org-settings-save');
    expect(save).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'Grupo Renovado');
    await user.click(save);
    expect(await screen.findByText('Cambios guardados')).toBeInTheDocument();
    expect(fake.callsTo('organizations', 'update')[0]?.payload).toEqual({ name: 'Grupo Renovado', kind: 'business' });
  });
});

describe('Zona de la plataforma', () => {
  it('el menú de cuenta solo ofrece «Plataforma» a quien administra la plataforma', async () => {
    seedWorkspace({ orgRole: 'owner' });
    const first = renderApp(`${BRAND_BASE}/inicio`);
    let menu = await openMenu(first.user, 'user-menu');
    expect(menu.getByRole('menuitem', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: 'Plataforma' })).not.toBeInTheDocument();
    first.unmount();

    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    const second = renderApp(`${BRAND_BASE}/inicio`);
    menu = await openMenu(second.user, 'user-menu');
    await waitFor(() => expect(menu.getByRole('menuitem', { name: 'Plataforma' })).toBeInTheDocument());
  });

  it('quien no la administra ve «Zona reservada» y no se piden datos', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp('/plataforma');
    expect(await screen.findByText('Zona reservada')).toBeInTheDocument();
    expect(fake.callsTo('admin_list_organizations', 'rpc')).toHaveLength(0);
  });

  it('quien la administra ve las organizaciones', async () => {
    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    fake.rpc('admin_list_organizations', () => [
      {
        id: 'org-1',
        name: 'Grupo Demo',
        kind: 'agency',
        created_at: '2026-10-01T09:00:00Z',
        members: 3,
        brands: 2,
        assets: 10,
        storage_bytes: 2048,
      },
    ]);
    renderApp('/plataforma');
    const table = await screen.findByTestId('platform-orgs');
    expect(within(table).getByRole('rowheader', { name: /Grupo Demo/ })).toHaveTextContent('Agencia');
    expect(within(table).getByText('2 KB')).toBeInTheDocument();
  });
});

describe('Cerrar sesión', () => {
  it('desde el menú de cuenta lleva a iniciar sesión', async () => {
    seedWorkspace({ orgRole: 'owner' });
    const { user } = renderApp(`${BRAND_BASE}/inicio`);
    const menu = await openMenu(user, 'user-menu');
    await user.click(menu.getByRole('menuitem', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(fake.auth.signOut).toHaveBeenCalledTimes(1);
  });
});
