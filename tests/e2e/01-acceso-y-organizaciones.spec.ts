import { expect, test } from '@playwright/test';
import {
  abrir,
  asignarPlan,
  cerrarSesion,
  confirmarCorreo,
  correo,
  entrar,
  guardarEstado,
  guardarSesion,
  idDeUrl,
  ORG_A,
  ORG_B,
  registrar,
  sinErrores,
  type Alias,
} from './apoyo';

test.describe.configure({ mode: 'serial' });

// El intento de entrar sin confirmar el correo devuelve 400: es lo esperado.
const ERROR_400 = /status of 400/;

test('sin sesión, la aplicación lleva a iniciar sesión', async ({ browser }) => {
  const s = await abrir(browser);
  await s.page.goto('/');
  await expect(s.page).toHaveURL(/\/login$/);
  await expect(s.page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
  sinErrores(s);
  await s.context.close();
});

test('Ana se registra, confirma el correo y crea una organización de tipo empresa', async ({ browser }) => {
  const s = await abrir(browser);
  await registrar(s.page, 'ana');

  // Con la confirmación de correo activada, antes de confirmar no se puede entrar.
  await s.page.goto('/login');
  await s.page.getByTestId('login-email').fill(correo('ana'));
  await s.page.getByTestId('login-password').fill('Prueba-e2e-2026');
  await s.page.getByTestId('login-submit').click();
  await expect(s.page.getByTestId('auth-error')).toBeVisible();
  await expect(s.page).toHaveURL(/\/login$/);

  await confirmarCorreo(s.page, 'ana');
  await expect(s.page).toHaveURL(/\/bienvenida$/);
  await expect(s.page.getByRole('heading', { name: /Te damos la bienvenida/ })).toBeVisible();

  await s.page.getByTestId('org-name').fill(ORG_A);
  await expect(s.page.getByTestId('org-kind-business')).toBeChecked();
  await s.page.getByTestId('org-submit').click();
  // Una empresa empieza por dar de alta su marca.
  await expect(s.page).toHaveURL(/\/o\/[0-9a-f-]{36}\/marcas\/nueva$/);
  const orgA = idDeUrl(s.page.url(), 'o');
  guardarEstado({ orgA });
  // Sin los límites del plan «Prueba»: los escenarios siguientes son anteriores a los planes.
  await asignarPlan(orgA, 'legacy');
  await expect(s.page.getByTestId('org-switcher').first()).toContainText(ORG_A);

  sinErrores(s, [ERROR_400]);
  await s.context.close();
});

test('Ana cierra sesión, no entra con una contraseña mala y vuelve a entrar con la buena', async ({ browser }) => {
  const s = await abrir(browser);
  await entrar(s.page, 'ana');
  await expect(s.page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  await cerrarSesion(s.page);

  await s.page.getByTestId('login-email').fill(correo('ana'));
  await s.page.getByTestId('login-password').fill('no-es-la-clave');
  await s.page.getByTestId('login-submit').click();
  await expect(s.page.getByTestId('auth-error')).toBeVisible();

  await entrar(s.page, 'ana');
  await expect(s.page.getByTestId('org-switcher').first()).toContainText(ORG_A);
  await guardarSesion(s.context, 'ana');

  sinErrores(s, [ERROR_400]);
  await s.context.close();
});

test('Bruno se registra y crea una organización independiente de tipo agencia', async ({ browser }) => {
  const s = await abrir(browser);
  await registrar(s.page, 'bruno');
  await confirmarCorreo(s.page, 'bruno');
  await expect(s.page).toHaveURL(/\/bienvenida$/);

  await s.page.getByTestId('org-name').fill(ORG_B);
  await s.page.getByText('Gestiono las redes de varios clientes.').click();
  await expect(s.page.getByTestId('org-kind-agency')).toBeChecked();
  await s.page.getByTestId('org-submit').click();
  // Una agencia empieza por su panel de marcas.
  await expect(s.page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  const orgB = idDeUrl(s.page.url(), 'o');
  guardarEstado({ orgB });
  await asignarPlan(orgB, 'legacy');
  await expect(s.page.getByText(`Las marcas que gestiona ${ORG_B}.`)).toBeVisible();
  await expect(s.page.getByTestId('new-brand-empty')).toBeVisible();

  // Solo ve su organización.
  await s.page.getByTestId('org-switcher').first().click();
  await expect(s.page.getByRole('menuitem').filter({ hasText: ORG_B })).toBeVisible();
  await expect(s.page.getByRole('menuitem').filter({ hasText: ORG_A })).toHaveCount(0);
  await s.page.keyboard.press('Escape');

  await guardarSesion(s.context, 'bruno');
  sinErrores(s);
  await s.context.close();
});

for (const alias of ['carla', 'dani', 'eva'] satisfies Alias[]) {
  test(`${alias} se registra y confirma el correo (sin organización todavía)`, async ({ browser }) => {
    const s = await abrir(browser);
    await registrar(s.page, alias);
    await confirmarCorreo(s.page, alias);
    await expect(s.page).toHaveURL(/\/bienvenida$/);
    await guardarSesion(s.context, alias);
    sinErrores(s);
    await s.context.close();
  });
}
