import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }),
}));
import { fake, makeUser } from '@/test/fakeSupabase';
import { ORG_ID, renderApp } from '@/test/fixtures';

const me = makeUser({ id: 'user-nuevo', email: 'nuevo@example.com', fullName: 'Nuevo Usuario' });

/** RPC `create_organization` como la de la base: crea la organización y hace propietario a quien la crea. */
function registerCreateOrganization() {
  fake.rpc('create_organization', (args) => {
    const org = {
      id: ORG_ID,
      name: args.p_name,
      kind: args.p_kind,
      settings: {},
      created_by: me.id,
      created_at: '2026-11-16T10:00:00Z',
      updated_at: '2026-11-16T10:00:00Z',
    };
    fake.rows('organizations').push(org);
    fake.rows('organization_members').push({
      organization_id: ORG_ID,
      user_id: me.id,
      role: 'owner',
      created_at: '2026-11-16T10:00:00Z',
    });
    return org;
  });
}

describe('Crear organización', () => {
  beforeEach(() => {
    fake.signIn(me);
    registerCreateOrganization();
  });

  it('quien entra sin organización llega a la bienvenida', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { name: /Te damos la bienvenida/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/bienvenida');
  });

  it('no deja crear sin nombre y empieza marcada como empresa', async () => {
    renderApp('/bienvenida');
    const submit = await screen.findByRole('button', { name: 'Crear organización' });
    expect(submit).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Empresa/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Agencia/ })).not.toBeChecked();
  });

  it('un nombre solo con espacios tampoco vale', async () => {
    const { user } = renderApp('/bienvenida');
    await user.type(await screen.findByLabelText(/Nombre de la organización/), '    ');
    expect(screen.getByRole('button', { name: 'Crear organización' })).toBeDisabled();
  });

  it('una empresa se crea y pasa directamente al asistente de su primera marca', async () => {
    const { user } = renderApp('/bienvenida');
    await user.type(await screen.findByLabelText(/Nombre de la organización/), '  Mi Empresa  ');
    await user.click(screen.getByRole('button', { name: 'Crear organización' }));

    expect(await screen.findByRole('heading', { name: 'Nueva marca' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/o/${ORG_ID}/marcas/nueva`);
    expect(fake.callsTo('create_organization', 'rpc')[0]?.payload).toEqual({
      p_name: 'Mi Empresa',
      p_kind: 'business',
    });
  });

  it('una agencia se crea y va a su panel de marcas', async () => {
    const { user } = renderApp('/bienvenida');
    await user.type(await screen.findByLabelText(/Nombre de la organización/), 'Estudio Norte');
    await user.click(screen.getByRole('radio', { name: /Agencia/ }));
    await user.click(screen.getByRole('button', { name: 'Crear organización' }));

    expect(await screen.findByText('Las marcas que gestiona Estudio Norte.')).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/o/${ORG_ID}`);
    expect(fake.callsTo('create_organization', 'rpc')[0]?.payload).toEqual({
      p_name: 'Estudio Norte',
      p_kind: 'agency',
    });
    // Aún no hay marcas: el propietario ve cómo empezar.
    expect(screen.getByText('Da de alta tu primera marca')).toBeInTheDocument();
  });

  it('si la base rechaza la creación, muestra el motivo y se puede reintentar', async () => {
    fake.failNext('create_organization', 'rpc', { code: '42501', message: 'permission denied' });
    const { user } = renderApp('/bienvenida');
    await user.type(await screen.findByLabelText(/Nombre de la organización/), 'Mi Empresa');
    await user.click(screen.getByRole('button', { name: 'Crear organización' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso para hacer esto.');
    expect(window.location.pathname).toBe('/bienvenida');
    expect(screen.getByLabelText(/Nombre de la organización/)).toHaveValue('Mi Empresa');
    expect(screen.getByRole('button', { name: 'Crear organización' })).toBeEnabled();
  });

  it('quien ya tiene organizaciones ve «Crear otra» con la opción de volver', async () => {
    registerCreateOrganization();
    fake.rows('organizations').push({ id: 'org-previa', name: 'Previa', kind: 'business', settings: {} });
    fake.rows('organization_members').push({ organization_id: 'org-previa', user_id: me.id, role: 'owner' });
    renderApp('/bienvenida');
    expect(await screen.findByRole('heading', { name: 'Crear otra organización' })).toBeInTheDocument();
    const form = screen.getByTestId('create-org-form');
    expect(within(form).getByRole('link', { name: 'Volver' })).toHaveAttribute('href', '/');
  });

  it('si la conexión con Meta falla sin saber la marca (/?social=failed), avisa en vez de callarse', async () => {
    toastError.mockClear();
    renderApp('/?social=failed');
    await screen.findByRole('heading', { name: /Te damos la bienvenida/ });
    expect(toastError).toHaveBeenCalledWith('No se pudo conectar la cuenta. Inténtalo de nuevo más tarde.');
  });
});
