import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { addPerson, BASE, BRAND_BASE, BRAND_ID, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

const TEAM = `${BASE}/ajustes/equipo`;
const BRAND_TEAM = `${BRAND_BASE}/equipo`;

type UI = ReturnType<typeof renderApp>['user'];

/** Equipo de ejemplo: yo, otro propietario, una administradora y dos miembros. */
function seedTeam() {
  addPerson('otro-owner', 'Olga Propietaria', 'owner');
  addPerson('ana-admin', 'Ana Admin', 'admin');
  addPerson('mario', 'Mario Miembro', 'member', 'editor');
  addPerson('sara', 'Sara Sola', 'member');
}

const actionsFor = (name: string) => screen.queryByRole('button', { name: `Acciones para ${name}` });

async function openActions(user: UI, name: string) {
  await user.click(await screen.findByRole('button', { name: `Acciones para ${name}` }));
  return within(await screen.findByRole('menu'));
}

function registerInvitationRpcs() {
  fake.rpc('create_invitation', (args) => {
    fake.rows('invitations').push({
      id: `inv-${fake.rows('invitations').length + 1}`,
      organization_id: ORG_ID,
      email: args.p_email,
      org_role: args.p_org_role,
      brand_id: args.p_brand_id,
      brand_role: args.p_brand_role,
      expires_at: '2030-01-01T00:00:00Z',
      created_at: '2026-11-16T10:00:00Z',
      invited_by: 'user-me',
    });
    return [{ token: 'token-de-prueba' }];
  });
  fake.rpc('revoke_invitation', (args) => {
    fake.tables.invitations = fake.rows('invitations').filter((row) => row.id !== args.p_invitation_id);
    return null;
  });
}

describe('Equipo de la organización: lo que ve y puede hacer cada rol', () => {
  describe('propietario', () => {
    beforeEach(() => {
      seedWorkspace({ orgRole: 'owner' });
      seedTeam();
    });

    it('ve a todos, puede invitar y gestionar a cualquiera, incluso a otro propietario', async () => {
      const { user } = renderApp(TEAM);
      expect(await screen.findByTestId('invite-open')).toBeInTheDocument();
      expect(await screen.findByText('Olga Propietaria')).toBeInTheDocument();
      expect(screen.getByTestId('member-ana-admin@example.com')).toHaveTextContent('Administrador');
      expect(screen.getByTestId('member-mario@example.com')).toHaveTextContent('Miembro');
      expect(screen.getByTestId('member-yo@example.com')).toHaveTextContent('(tú)');

      let menu = await openActions(user, 'Olga Propietaria');
      expect(menu.getByRole('menuitem', { name: 'Administrador' })).toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: 'Miembro' })).toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: 'Quitar de la organización' })).toBeInTheDocument();
      await user.keyboard('{Escape}');

      menu = await openActions(user, 'Ana Admin');
      expect(menu.getByRole('menuitem', { name: 'Propietario' })).toBeInTheDocument();
      // El rol que ya tiene no se ofrece.
      expect(menu.queryByRole('menuitem', { name: 'Administrador' })).not.toBeInTheDocument();
    });

    it('cambia el rol de un miembro', async () => {
      fake.rpc('set_member_role', () => null);
      const { user } = renderApp(TEAM);
      const menu = await openActions(user, 'Ana Admin');
      await user.click(menu.getByRole('menuitem', { name: 'Miembro' }));
      expect(await screen.findByText('Rol actualizado')).toBeInTheDocument();
      expect(fake.callsTo('set_member_role', 'rpc')[0]?.payload).toEqual({
        p_organization_id: ORG_ID,
        p_user_id: 'ana-admin',
        p_role: 'member',
      });
    });

    it('quitar a alguien pide confirmación que lo nombra', async () => {
      fake.rpc('remove_member', (args) => {
        fake.tables.organization_members = fake
          .rows('organization_members')
          .filter((row) => row.user_id !== args.p_user_id);
        return null;
      });
      const { user } = renderApp(TEAM);
      const menu = await openActions(user, 'Sara Sola');
      await user.click(menu.getByRole('menuitem', { name: 'Quitar de la organización' }));

      const dialog = within(await screen.findByRole('dialog'));
      expect(dialog.getByText('¿Quitar a Sara Sola?')).toBeInTheDocument();
      expect(fake.callsTo('remove_member', 'rpc')).toHaveLength(0);
      await user.click(dialog.getByRole('button', { name: 'Quitar' }));

      expect(await screen.findByText('Miembro quitado')).toBeInTheDocument();
      expect(fake.callsTo('remove_member', 'rpc')[0]?.payload).toEqual({
        p_organization_id: ORG_ID,
        p_user_id: 'sara',
      });
      await waitFor(() => expect(screen.queryByText('Sara Sola')).not.toBeInTheDocument());
    });

    it('si la base rechaza el cambio, muestra el motivo', async () => {
      fake.failNext('set_member_role', 'rpc', { message: 'No puedes dejar la organización sin propietario.' });
      const { user } = renderApp(TEAM);
      const menu = await openActions(user, 'Olga Propietaria');
      await user.click(menu.getByRole('menuitem', { name: 'Miembro' }));
      expect(await screen.findByText('No puedes dejar la organización sin propietario.')).toBeInTheDocument();
    });
  });

  describe('administrador', () => {
    beforeEach(() => {
      seedWorkspace({ orgRole: 'admin' });
      seedTeam();
    });

    it('invita y gestiona miembros, pero no toca a los propietarios ni da ese rol', async () => {
      const { user } = renderApp(TEAM);
      expect(await screen.findByTestId('invite-open')).toBeInTheDocument();
      await screen.findByText('Olga Propietaria');
      expect(actionsFor('Olga Propietaria')).not.toBeInTheDocument();

      const menu = await openActions(user, 'Mario Miembro');
      expect(menu.getByRole('menuitem', { name: 'Administrador' })).toBeInTheDocument();
      expect(menu.queryByRole('menuitem', { name: 'Propietario' })).not.toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: 'Quitar de la organización' })).toBeInTheDocument();
      await user.keyboard('{Escape}');

      // Al invitar, «Propietario» no está entre los roles posibles.
      await user.click(screen.getByTestId('invite-open'));
      const roles = within(await screen.findByTestId('invite-org-role')).getAllByRole('option');
      expect(roles.map((o) => o.textContent)).toEqual(['Miembro', 'Administrador']);
    });
  });

  describe('miembro', () => {
    beforeEach(() => {
      seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
      seedTeam();
    });

    it('solo ve al equipo: no invita, no ve invitaciones, no gestiona a nadie y puede salir', async () => {
      renderApp(TEAM);
      expect(await screen.findByText('Ana Admin')).toBeInTheDocument();
      expect(screen.queryByTestId('invite-open')).not.toBeInTheDocument();
      expect(screen.queryByText('Invitaciones pendientes')).not.toBeInTheDocument();
      for (const name of ['Olga Propietaria', 'Ana Admin', 'Mario Miembro', 'Sara Sola'])
        expect(actionsFor(name)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Salir de la organización/ })).toBeInTheDocument();
    });

    it('salir de la organización pide confirmación y lo avisa de lo que se pierde', async () => {
      fake.rpc('remove_member', () => null);
      const { user } = renderApp(TEAM);
      await user.click(await screen.findByRole('button', { name: /Salir de la organización/ }));
      const dialog = within(await screen.findByRole('dialog'));
      expect(dialog.getByText('¿Salir de la organización?')).toBeInTheDocument();
      expect(dialog.getByText(/Perderás el acceso a todas sus marcas/)).toBeInTheDocument();
      await user.click(dialog.getByRole('button', { name: 'Salir' }));
      await waitFor(() => expect(fake.callsTo('remove_member', 'rpc')).toHaveLength(1));
      expect(fake.callsTo('remove_member', 'rpc')[0]?.payload).toEqual({
        p_organization_id: ORG_ID,
        p_user_id: 'user-me',
      });
    });

    it('en Configuración no ve la pestaña Actividad ni puede cambiar los datos de la organización', async () => {
      renderApp(`${BASE}/ajustes/general`);
      const nav = await screen.findByRole('navigation', { name: 'Secciones de configuración' });
      expect(within(nav).getByRole('link', { name: 'General' })).toBeInTheDocument();
      expect(within(nav).getByRole('link', { name: 'Equipo' })).toBeInTheDocument();
      expect(within(nav).queryByRole('link', { name: 'Actividad' })).not.toBeInTheDocument();
      expect(screen.getByTestId('org-settings-name')).toBeDisabled();
      expect(screen.queryByTestId('org-settings-save')).not.toBeInTheDocument();
    });

    it('aunque escriba la dirección de Actividad, no la ve', async () => {
      renderApp(`${BASE}/ajustes/actividad`);
      expect(await screen.findByText('Solo los administradores pueden ver la actividad.')).toBeInTheDocument();
      expect(fake.callsTo('audit_logs')).toHaveLength(0);
    });
  });
});

describe('Invitar a la organización', () => {
  beforeEach(() => {
    seedWorkspace({ orgRole: 'owner' });
    registerInvitationRpcs();
  });

  it('exige un correo con formato válido', async () => {
    const { user } = renderApp(TEAM);
    await user.click(await screen.findByTestId('invite-open'));
    const submit = await screen.findByTestId('invite-submit');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('invite-email'), 'sin-arroba');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('invite-email'), '@x');
    expect(submit).toBeDisabled();
    await user.type(screen.getByTestId('invite-email'), '.com');
    expect(submit).toBeEnabled();
  });

  it('genera el enlace de invitación, avisa de que el correo no se envía solo y permite copiarlo', async () => {
    const { user } = renderApp(TEAM);
    await user.click(await screen.findByTestId('invite-open'));
    await user.type(await screen.findByTestId('invite-email'), '  Nueva.Persona@Example.com ');
    await user.selectOptions(screen.getByTestId('invite-org-role'), 'Administrador');
    await user.click(screen.getByTestId('invite-submit'));

    expect(await screen.findByRole('heading', { name: 'Invitación creada' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('dialog')).getByText(/Envía este enlace a nueva.persona@example.com/),
    ).toBeInTheDocument();
    expect(fake.callsTo('create_invitation', 'rpc')[0]?.payload).toEqual({
      p_organization_id: ORG_ID,
      p_email: 'nueva.persona@example.com',
      p_org_role: 'admin',
      p_brand_id: null,
      p_brand_role: null,
    });

    const link = `${window.location.origin}/invitacion/token-de-prueba`;
    expect(screen.getByTestId('invite-link')).toHaveValue(link);
    expect(screen.getByText(/El envío automático por correo todavía no está disponible/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copiar enlace' }));
    expect(await screen.findByText('Enlace copiado')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(link);
  });

  it('si no se puede copiar, lo dice para que se haga a mano', async () => {
    const { user } = renderApp(TEAM);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('bloqueado'));
    await user.click(await screen.findByTestId('invite-open'));
    await user.type(await screen.findByTestId('invite-email'), 'otra@example.com');
    await user.click(screen.getByTestId('invite-submit'));
    await user.click(await screen.findByRole('button', { name: 'Copiar enlace' }));
    expect(await screen.findByText(/No se ha podido copiar/)).toBeInTheDocument();
  });

  it('invitar a un miembro a una marca envía también el rol en la marca', async () => {
    const { user } = renderApp(TEAM);
    await user.click(await screen.findByTestId('invite-open'));
    await user.type(await screen.findByTestId('invite-email'), 'edi@example.com');
    expect(screen.queryByTestId('invite-brand-role')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('invite-brand'), 'Casa Demo');
    await user.selectOptions(screen.getByTestId('invite-brand-role'), 'Revisor');
    await user.click(screen.getByTestId('invite-submit'));
    await screen.findByRole('heading', { name: 'Invitación creada' });
    expect(fake.callsTo('create_invitation', 'rpc')[0]?.payload).toMatchObject({
      p_org_role: 'member',
      p_brand_id: BRAND_ID,
      p_brand_role: 'reviewer',
    });
  });

  it('a un administrador no se le pide marca ni rol de marca', async () => {
    const { user } = renderApp(TEAM);
    await user.click(await screen.findByTestId('invite-open'));
    await user.selectOptions(await screen.findByTestId('invite-org-role'), 'Administrador');
    expect(screen.queryByTestId('invite-brand')).not.toBeInTheDocument();
  });

  it('muestra el error de la base y deja corregir', async () => {
    fake.failNext('create_invitation', 'rpc', { message: 'Esa persona ya forma parte de la organización.' });
    const { user } = renderApp(TEAM);
    await user.click(await screen.findByTestId('invite-open'));
    await user.type(await screen.findByTestId('invite-email'), 'yo@example.com');
    await user.click(screen.getByTestId('invite-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Esa persona ya forma parte de la organización.');
    expect(screen.getByTestId('invite-email')).toHaveValue('yo@example.com');
  });

  it('las invitaciones pendientes se listan y se pueden anular', async () => {
    fake.tables.invitations = [
      {
        id: 'inv-previa',
        organization_id: ORG_ID,
        email: 'pendiente@example.com',
        org_role: 'member',
        brand_id: BRAND_ID,
        brand_role: 'editor',
        expires_at: '2030-01-01T00:00:00Z',
        created_at: '2026-11-10T10:00:00Z',
        invited_by: 'user-me',
      },
    ];
    registerInvitationRpcs();
    const { user } = renderApp(TEAM);
    const row = await screen.findByTestId('invitation-pendiente@example.com');
    expect(row).toHaveTextContent('Miembro · Editor en Casa Demo');
    await user.click(within(row).getByRole('button', { name: 'Anular' }));
    expect(await screen.findByText('Invitación anulada')).toBeInTheDocument();
    expect(await screen.findByText('No hay invitaciones pendientes.')).toBeInTheDocument();
  });
});

describe('Equipo de una marca', () => {
  beforeEach(() => {
    registerInvitationRpcs();
  });

  it('un gestor de la marca la administra: invita, añade y cambia roles', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'manager' });
    addPerson('mario', 'Mario Miembro', 'member', 'editor');
    addPerson('sara', 'Sara Sola', 'member');
    addPerson('ana-admin', 'Ana Admin', 'admin');
    fake.tables.brand_members = [...fake.rows('brand_members')];
    const { user } = renderApp(BRAND_TEAM);

    expect(await screen.findByTestId('brand-invite-open')).toBeInTheDocument();
    // Los miembros de la marca y los de la organización llegan por separado.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir miembro' })).toBeEnabled());
    expect(await screen.findByTestId('brand-member-mario@example.com')).toHaveTextContent('Editor');
    // Los administradores de la organización aparecen aparte.
    expect(await screen.findByText('Administradores de la organización')).toBeInTheDocument();

    const menu = await openActions(user, 'Mario Miembro');
    expect(menu.queryByRole('menuitem', { name: 'Gestor' })).toBeInTheDocument();
    expect(menu.queryByRole('menuitem', { name: 'Editor' })).not.toBeInTheDocument();
    await user.click(menu.getByRole('menuitem', { name: 'Revisor' }));
    expect(await screen.findByText('Rol actualizado')).toBeInTheDocument();
    expect(fake.rows('brand_members').find((r) => r.user_id === 'mario')?.role).toBe('reviewer');
  });

  it('añade a la marca a alguien que ya está en la organización', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'manager' });
    addPerson('sara', 'Sara Sola', 'member');
    const { user } = renderApp(BRAND_TEAM);
    // El botón nace desactivado hasta saber a quién se puede añadir.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir miembro' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Añadir miembro' }));
    const dialog = within(await screen.findByRole('dialog'));
    const add = dialog.getByRole('button', { name: 'Añadir' });
    expect(add).toBeDisabled();
    await user.selectOptions(dialog.getByLabelText('Persona'), 'Sara Sola (sara@example.com)');
    await user.selectOptions(dialog.getByLabelText('Rol en la marca'), 'Solo lectura');
    await user.click(add);
    expect(await screen.findByText('Acceso concedido')).toBeInTheDocument();
    expect(fake.callsTo('brand_members', 'insert')[0]?.payload).toEqual({
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      user_id: 'sara',
      role: 'viewer',
    });
  });

  it('invitar desde la marca fija la marca y pide solo el rol en ella', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'manager' });
    const { user } = renderApp(BRAND_TEAM);
    await user.click(await screen.findByTestId('brand-invite-open'));
    await user.type(await screen.findByTestId('invite-email'), 'nuevo@example.com');
    expect(screen.queryByTestId('invite-brand')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invite-org-role')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('invite-submit'));
    expect(await screen.findByTestId('invite-link')).toHaveValue(
      `${window.location.origin}/invitacion/token-de-prueba`,
    );
    expect(fake.callsTo('create_invitation', 'rpc')[0]?.payload).toEqual({
      p_organization_id: ORG_ID,
      p_email: 'nuevo@example.com',
      p_org_role: 'member',
      p_brand_id: BRAND_ID,
      p_brand_role: 'editor',
    });
  });

  it.each([['editor' as const], ['reviewer' as const], ['client' as const], ['viewer' as const]])(
    'un %s ve el equipo sin poder invitar, añadir ni cambiar roles',
    async (brandRole) => {
      seedWorkspace({ orgRole: 'member', brandRole });
      addPerson('mario', 'Mario Miembro', 'member', 'editor');
      renderApp(BRAND_TEAM);
      expect(await screen.findByText('Mario Miembro')).toBeInTheDocument();
      expect(screen.queryByTestId('brand-invite-open')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Añadir miembro' })).not.toBeInTheDocument();
      expect(actionsFor('Mario Miembro')).not.toBeInTheDocument();
    },
  );

  it('el administrador de la organización gestiona cualquier marca sin estar en ella', async () => {
    seedWorkspace({ orgRole: 'admin' });
    renderApp(BRAND_TEAM);
    expect(await screen.findByTestId('brand-invite-open')).toBeInTheDocument();
  });
});
