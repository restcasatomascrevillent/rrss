// RGPD de punta a punta contra el Supabase LOCAL: registro con consentimiento,
// «Descargar mis datos» y borrar una cuenta de prueba (con la Edge Function
// `delete-account`, servida en local por `supabase functions serve`).
// Usa una cuenta propia de usar y tirar; de los archivos anteriores solo
// necesita a Ana, propietaria de una organización con más miembros.
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { abrir, CLAVE_INICIAL, dato, enlaceDelCorreo, LOCAL, leerEstado, ORG_A, sinErrores, sql } from './apoyo';

test.describe.configure({ mode: 'serial' });

/** Rechazos esperados: el inicio de sesión que falla a propósito y el de la cuenta ya borrada. */
const ERROR_400 = /status of 400/;
/** La contraseña equivocada al borrar: la función responde 403 a propósito. */
const ERROR_403 = /status of 403/;

function correoDePrueba(): string {
  return `rgpd.${leerEstado().tanda}@ejemplo.test`;
}

test('el registro exige aceptar las condiciones y la política de privacidad, y lo deja apuntado', async ({
  browser,
}) => {
  const s = await abrir(browser);
  const { page } = s;
  await page.goto('/registro');
  await page.getByTestId('register-name').fill('Persona Borrable');
  await page.getByTestId('register-email').fill(correoDePrueba());
  await page.getByTestId('register-password').fill(CLAVE_INICIAL);
  // Casilla sin marcar de serie: sin ella no hay cuenta.
  await expect(page.getByTestId('register-accept')).not.toBeChecked();
  await expect(page.getByTestId('register-submit')).toBeDisabled();

  // Los documentos se abren y se pueden leer sin sesión, con el aviso de borrador.
  const [politica] = await Promise.all([
    page.context().waitForEvent('page'),
    // El del formulario (el pie de página tiene otro enlace igual).
    page.getByTestId('register-legal').getByRole('link', { name: 'política de privacidad' }).click(),
  ]);
  await expect(politica.getByRole('heading', { level: 1, name: 'Política de privacidad' })).toBeVisible();
  await expect(politica.getByTestId('legal-draft-warning')).toContainText('abogado');
  await politica.close();

  await page.getByTestId('register-accept').check();
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-confirm')).toContainText(correoDePrueba());

  await page.goto(await enlaceDelCorreo(correoDePrueba(), 'signup'));
  await page.waitForURL(new RegExp(`^${LOCAL.app}`), { timeout: 30_000 });
  await expect(page).toHaveURL(/\/bienvenida$/);

  const aceptadas = await sql<{ document: string; source: string }>(
    `select la.document, la.source from public.legal_acceptances la
     join auth.users u on u.id = la.user_id where u.email = $1 order by la.document`,
    [correoDePrueba()],
  );
  expect(aceptadas).toEqual([
    { document: 'privacy', source: 'signup' },
    { document: 'terms', source: 'signup' },
  ]);

  // Una organización suya, sin más miembros: se irá con la cuenta.
  await page.getByTestId('org-name').fill('Borrable SL');
  await page.getByTestId('org-submit').click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/marcas\/nueva$/);

  // «Descargar mis datos» desde «Mi cuenta y privacidad».
  await page.getByTestId('user-menu').first().click();
  await page.getByTestId('nav-account').click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta y privacidad' })).toBeVisible();
  await expect(page.getByTestId('account-legal')).toContainText('Vigente');
  const descarga = page.waitForEvent('download');
  await page.getByTestId('account-export-download').click();
  const archivo = await descarga;
  expect(archivo.suggestedFilename()).toMatch(/^mis-datos-\d{4}-\d{2}-\d{2}\.json$/);
  const datos = JSON.parse(await readFile((await archivo.path())!, 'utf8')) as {
    format: string;
    account: { email: string };
    legal_acceptances: unknown[];
    organizations: { name: string; role: string }[];
  };
  expect(datos.format).toBe('rrss.personal-data');
  expect(datos.account.email).toBe(correoDePrueba());
  expect(datos.legal_acceptances).toHaveLength(2);
  expect(datos.organizations).toEqual([expect.objectContaining({ name: 'Borrable SL', role: 'owner' })]);
  expect(JSON.stringify(datos)).not.toContain('encrypted_password');

  sinErrores(s);
  await s.context.close();
});

test('la única propietaria de una organización con más miembros no puede borrar su cuenta', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  await s.page.goto('/cuenta');
  await s.page.getByTestId('account-delete-open').click();
  await expect(s.page.getByTestId('account-delete-blocking')).toContainText(ORG_A);
  await expect(s.page.getByTestId('account-delete-confirm')).toBeDisabled();
  expect(await sql(`select 1 from public.organizations where id = $1`, [dato('orgA')])).toHaveLength(1);
  sinErrores(s);
  await s.context.close();
});

test('la cuenta de prueba se borra con su organización y ya no puede entrar', async ({ browser }) => {
  const s = await abrir(browser);
  const { page } = s;
  await page.goto('/login');
  await page.getByTestId('login-email').fill(correoDePrueba());
  await page.getByTestId('login-password').fill(CLAVE_INICIAL);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}/);
  const [{ id: usuario }] = (await sql<{ id: string }>(`select id from auth.users where email = $1`, [
    correoDePrueba(),
  ])) as [{ id: string }];

  await page.goto('/cuenta');
  await page.getByTestId('account-delete-open').click();
  await expect(page.getByTestId('account-delete-with-account')).toContainText('Borrable SL');
  await page.getByTestId('account-delete-email').fill(correoDePrueba());
  await page.getByTestId('account-delete-password').fill('no-es-la-clave');
  await page.getByTestId('account-delete-confirm').click();
  await expect(page.getByTestId('account-delete-error')).toContainText('La contraseña no es correcta.');

  await page.getByTestId('account-delete-password').fill(CLAVE_INICIAL);
  await page.getByTestId('account-delete-confirm').click();
  await expect(page).toHaveURL(/\/login$/);

  // Ni la cuenta, ni su perfil, ni su organización, ni su rastro en la auditoría.
  expect(await sql(`select 1 from auth.users where id = $1`, [usuario])).toEqual([]);
  expect(await sql(`select 1 from public.profiles where user_id = $1`, [usuario])).toEqual([]);
  expect(await sql(`select 1 from public.organizations where name = 'Borrable SL'`)).toEqual([]);
  expect(
    await sql(`select id from public.audit_logs where actor_id = $1 or data::text like $2 or data::text ilike $3`, [
      usuario,
      `%${usuario}%`,
      `%${correoDePrueba()}%`,
    ]),
  ).toEqual([]);

  await page.getByTestId('login-email').fill(correoDePrueba());
  await page.getByTestId('login-password').fill(CLAVE_INICIAL);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('auth-error')).toBeVisible();

  sinErrores(s, [ERROR_400, ERROR_403]);
  await s.context.close();
});
