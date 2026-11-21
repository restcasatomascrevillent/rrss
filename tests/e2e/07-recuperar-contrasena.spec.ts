import { expect, test } from '@playwright/test';
import {
  abrir,
  cerrarSesion,
  CLAVE_INICIAL,
  correo,
  enlaceDelCorreo,
  entrar,
  guardarEstado,
  guardarSesion,
  leerEstado,
  sinErrores,
} from './apoyo';

test.describe.configure({ mode: 'serial' });

const CLAVE_NUEVA = 'Otra-clave-e2e-2026';

test('sin enlace válido, la pantalla de nueva contraseña lo dice y ofrece pedir otro', async ({ browser }) => {
  const s = await abrir(browser);
  await s.page.goto('/restablecer');
  await expect(s.page.getByText('El enlace no es válido o ha caducado. Pide uno nuevo.')).toBeVisible();
  await s.page.getByRole('link', { name: 'Pedir otro enlace' }).click();
  await expect(s.page).toHaveURL(/\/recuperar$/);
  sinErrores(s);
  await s.context.close();
});

test('Carla recupera su contraseña con el enlace que llega al buzón local', async ({ browser }) => {
  const s = await abrir(browser);
  const { page } = s;
  await page.goto('/login');
  await page.getByRole('link', { name: 'He olvidado mi contraseña' }).click();
  await expect(page).toHaveURL(/\/recuperar$/);
  await page.getByTestId('recover-email').fill(correo('carla'));
  await page.getByTestId('recover-submit').click();
  await expect(page.getByTestId('recover-sent')).toContainText(correo('carla'));

  await page.goto(await enlaceDelCorreo(correo('carla'), 'recovery'));
  await expect(page).toHaveURL(/\/restablecer/);
  await expect(page.getByRole('heading', { name: 'Nueva contraseña' })).toBeVisible();
  await page.getByTestId('reset-password').fill(CLAVE_NUEVA);
  await page.getByTestId('reset-submit').click();
  // Queda dentro, en su organización.
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  guardarEstado({ claves: { ...leerEstado().claves, carla: CLAVE_NUEVA } });

  // La contraseña antigua deja de valer y la nueva funciona.
  await cerrarSesion(page);
  await page.getByTestId('login-email').fill(correo('carla'));
  await page.getByTestId('login-password').fill(CLAVE_INICIAL);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('auth-error')).toBeVisible();
  await entrar(page, 'carla');
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  await guardarSesion(s.context, 'carla');

  sinErrores(s, [/status of 400/]);
  await s.context.close();
});
