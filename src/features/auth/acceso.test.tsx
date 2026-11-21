import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSIONS } from '@/features/legal/legal';
import { fake } from '@/test/fakeSupabase';
import { renderApp } from '@/test/fixtures';
import { redirectTarget } from './AuthProvider';

const credentialsError = { message: 'Invalid login credentials', status: 400, name: 'AuthApiError' };

describe('Acceso: inicio de sesión', () => {
  it('sin sesión, una ruta privada lleva a iniciar sesión', async () => {
    renderApp('/o/org-1/ajustes/equipo');
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });

  it('el botón Entrar no se activa hasta rellenar correo y contraseña', async () => {
    const { user } = renderApp('/login');
    const submit = await screen.findByRole('button', { name: 'Entrar' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Correo electrónico'), 'ana@example.com');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    expect(submit).toBeEnabled();
  });

  it('con credenciales erróneas muestra el motivo en español y no entra', async () => {
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: credentialsError,
    });
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.com');
    await user.type(screen.getByLabelText('Contraseña'), 'mala');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('El correo o la contraseña no son correctos.');
    expect(window.location.pathname).toBe('/login');
    expect(screen.getByLabelText('Contraseña')).toHaveValue('mala');
  });

  it('si no hay conexión lo dice con claridad', async () => {
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new TypeError('Failed to fetch'),
    });
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.com');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No hay conexión con el servidor');
  });

  it('quita los espacios del correo y, al entrar, vuelve a la página que se pidió', async () => {
    const { user } = renderApp('/bienvenida');
    // Sin sesión se redirige a /login recordando de dónde venía.
    await user.type(await screen.findByLabelText('Correo electrónico'), '  ana@example.com ');
    await user.type(screen.getByLabelText('Contraseña'), 'secreta123');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByRole('heading', { name: /Te damos la bienvenida/ })).toBeInTheDocument();
    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'ana@example.com', password: 'secreta123' });
    expect(window.location.pathname).toBe('/bienvenida');
  });

  it('con sesión abierta, /login no se muestra', async () => {
    fake.signIn({ id: 'u1', email: 'ana@example.com', user_metadata: {} } as never);
    renderApp('/login');
    await waitFor(() => expect(window.location.pathname).not.toBe('/login'));
    expect(screen.queryByRole('heading', { name: 'Inicia sesión' })).not.toBeInTheDocument();
  });

  it('enlaza a crear cuenta y a recuperar la contraseña', async () => {
    const { user } = renderApp('/login');
    expect(await screen.findByRole('link', { name: 'He olvidado mi contraseña' })).toHaveAttribute(
      'href',
      '/recuperar',
    );
    await user.click(screen.getByRole('link', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('heading', { name: 'Crea tu cuenta' })).toBeInTheDocument();
  });
});

describe('Acceso: redirección tras entrar', () => {
  it('solo acepta rutas internas', () => {
    expect(redirectTarget({ from: '/o/1/marca?seccion=voz' })).toBe('/o/1/marca?seccion=voz');
    expect(redirectTarget({ from: '//evil.example' })).toBe('/');
    expect(redirectTarget({ from: 'https://evil.example' })).toBe('/');
    expect(redirectTarget(null)).toBe('/');
    expect(redirectTarget({ from: 42 })).toBe('/');
  });
});

describe('Acceso: registro', () => {
  async function fillRegister(
    user: ReturnType<typeof renderApp>['user'],
    values: { name?: string; email?: string; password?: string; accept?: boolean },
  ) {
    if (values.name) await user.type(await screen.findByLabelText('Nombre'), values.name);
    if (values.email) await user.type(screen.getByLabelText('Correo electrónico'), values.email);
    if (values.password) await user.type(screen.getByLabelText('Contraseña'), values.password);
    // Casilla de las condiciones y la política de privacidad (sin marcar de serie).
    if (values.accept !== false) await user.click(screen.getByTestId('register-accept'));
  }

  it('exige nombre, correo y 8 caracteres de contraseña', async () => {
    const { user } = renderApp('/registro');
    const submit = await screen.findByRole('button', { name: 'Crear cuenta' });
    expect(submit).toBeDisabled();

    await fillRegister(user, { name: 'Ana', email: 'ana@example.com', password: 'corta' });
    expect(submit).toBeDisabled();
    expect(screen.getByText('Le faltan caracteres.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Contraseña'), '1234');
    expect(submit).toBeEnabled();
    expect(screen.queryByText('Le faltan caracteres.')).not.toBeInTheDocument();
  });

  it('sin aceptar las condiciones y la política de privacidad no se crea la cuenta', async () => {
    const { user } = renderApp('/registro');
    await fillRegister(user, { name: 'Ana', email: 'ana@example.com', password: 'secreta123', accept: false });
    const accept = screen.getByTestId('register-accept');
    expect(accept).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'condiciones de uso' })).toHaveAttribute('href', '/legal/condiciones');
    expect(screen.getByRole('link', { name: 'política de privacidad' })).toHaveAttribute('href', '/legal/privacidad');
    await user.click(accept);
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeEnabled();
  });

  it('un nombre en blanco no basta', async () => {
    const { user } = renderApp('/registro');
    await fillRegister(user, { name: '   ', email: 'ana@example.com', password: 'secreta123' });
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeDisabled();
  });

  it('si hay que confirmar el correo, avisa y no entra', async () => {
    fake.auth.signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: null });
    const { user } = renderApp('/registro');
    await fillRegister(user, { name: ' Ana Pérez ', email: 'ana@example.com', password: 'secreta123' });
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(await screen.findByRole('heading', { name: 'Revisa tu correo' })).toBeInTheDocument();
    expect(screen.getByTestId('register-confirm')).toHaveTextContent('ana@example.com');
    expect(fake.auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ana@example.com',
        // Las versiones aceptadas van en los metadatos: la base de datos las apunta.
        options: expect.objectContaining({
          data: {
            full_name: 'Ana Pérez',
            legal: { terms_version: LEGAL_VERSIONS.terms, privacy_version: LEGAL_VERSIONS.privacy },
          },
        }),
      }),
    );
    expect(screen.getByRole('link', { name: 'Volver a iniciar sesión' })).toBeInTheDocument();
  });

  it('si el correo ya existe, lo explica', async () => {
    fake.auth.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'User already registered', status: 422, name: 'AuthApiError' },
    });
    const { user } = renderApp('/registro');
    await fillRegister(user, { name: 'Ana', email: 'ana@example.com', password: 'secreta123' });
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe una cuenta con ese correo.');
  });

  it('si el proyecto no pide confirmar, entra directamente', async () => {
    const { user } = renderApp('/registro');
    await fillRegister(user, { name: 'Ana', email: 'ana@example.com', password: 'secreta123' });
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('heading', { name: /Te damos la bienvenida/ })).toBeInTheDocument();
  });
});

describe('Acceso: recuperar contraseña', () => {
  it('confirma el envío sin revelar si la cuenta existe', async () => {
    const { user } = renderApp('/recuperar');
    await user.type(await screen.findByLabelText('Correo electrónico'), 'ana@example.com');
    await user.click(screen.getByRole('button', { name: 'Enviar enlace' }));
    expect(await screen.findByTestId('recover-sent')).toHaveTextContent('Si existe una cuenta con ana@example.com');
    expect(fake.auth.resetPasswordForEmail).toHaveBeenCalledWith('ana@example.com', expect.anything());
  });

  it('un enlace sin sesión de recuperación se rechaza', async () => {
    renderApp('/restablecer');
    expect(await screen.findByText(/El enlace no es válido o ha caducado/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pedir otro enlace' })).toBeInTheDocument();
  });
});
