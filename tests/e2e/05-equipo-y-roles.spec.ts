import { expect, test, type Page } from '@playwright/test';
import {
  abrir,
  archivoPng,
  aviso,
  clave,
  correo,
  dato,
  guardarEstado,
  guardarSesion,
  leerEstado,
  MARCA_A,
  MARCA_A2,
  ORG_A,
  png,
  sinErrores,
  sql,
  type Alias,
} from './apoyo';

test.describe.configure({ mode: 'serial' });

const org = () => `/o/${dato('orgA')}`;
const marca = () => `${org()}/m/${dato('marcaA')}`;

/** Crea la invitación con el diálogo abierto, copia el enlace con el botón y lo devuelve. */
async function copiarEnlace(page: Page): Promise<string> {
  await page.getByTestId('invite-submit').click();
  const enlace = await page.getByTestId('invite-link').inputValue();
  expect(enlace).toMatch(/^http:\/\/127\.0\.0\.1:5273\/invitacion\/[\w-]{20,}$/);
  await page.getByRole('button', { name: 'Copiar enlace' }).click();
  await aviso(page, 'Enlace copiado');
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(enlace);
  await expect(page.getByText('El envío automático por correo todavía no está disponible')).toBeVisible();
  await page.getByRole('button', { name: 'Hecho' }).click();
  return enlace;
}

function invitacion(alias: Alias): string {
  const enlace = leerEstado().invitaciones?.[alias];
  if (!enlace) throw new Error(`Falta el enlace de invitación de ${alias}.`);
  return enlace;
}

async function miembros(): Promise<string[]> {
  const filas = await sql<{ fila: string }>(
    `select u.email || ':' || m.role as fila
       from public.organization_members m join auth.users u on u.id = m.user_id
      where m.organization_id = $1 order by 1`,
    [dato('orgA')],
  );
  return filas.map((f) => f.fila.replace(`.${leerEstado().tanda}@ejemplo.test`, ''));
}

test('Ana invita a tres personas con roles distintos y copia cada enlace', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${org()}/ajustes/equipo`);
  const yo = page.getByTestId(`member-${correo('ana')}`);
  await expect(yo).toContainText('(tú)');
  await expect(yo).toContainText('Propietario');
  await expect(page.getByText('No hay invitaciones pendientes.')).toBeVisible();

  // Carla: miembro, con el rol Editor en la marca.
  await page.getByTestId('invite-open').click();
  await page.getByTestId('invite-email').fill(correo('carla'));
  // Quien es propietario puede conceder cualquier rol de organización.
  await expect(page.getByTestId('invite-org-role').locator('option')).toHaveText([
    'Miembro',
    'Administrador',
    'Propietario',
  ]);
  await page.getByTestId('invite-brand').selectOption({ label: MARCA_A });
  await expect(page.getByTestId('invite-brand-role')).toHaveValue('editor');
  const carla = await copiarEnlace(page);

  // Eva: administradora de la organización (no necesita rol de marca).
  await page.getByTestId('invite-open').click();
  await page.getByTestId('invite-email').fill(correo('eva'));
  await page.getByTestId('invite-org-role').selectOption('admin');
  await expect(page.getByTestId('invite-brand')).toHaveCount(0);
  const eva = await copiarEnlace(page);

  // Dani: desde el equipo de la marca, como Cliente.
  await page.goto(`${marca()}/equipo`);
  await expect(page.getByText('Nadie más tiene acceso todavía')).toBeVisible();
  await page.getByTestId('brand-invite-open').click();
  await page.getByTestId('invite-email').fill(correo('dani'));
  await expect(page.getByTestId('invite-org-role')).toHaveCount(0);
  await page.getByTestId('invite-brand-role').selectOption('client');
  const dani = await copiarEnlace(page);

  guardarEstado({ invitaciones: { carla, eva, dani } });

  await page.goto(`${org()}/ajustes/equipo`);
  await expect(page.getByTestId(`invitation-${correo('carla')}`)).toContainText(`Miembro · Editor en ${MARCA_A}`);
  await expect(page.getByTestId(`invitation-${correo('eva')}`)).toContainText('Administrador');
  await expect(page.getByTestId(`invitation-${correo('dani')}`)).toContainText(`Miembro · Cliente en ${MARCA_A}`);
  expect(await miembros()).toEqual(['ana:owner']);

  sinErrores(s);
  await s.context.close();
});

test('una invitación no sirve para otra cuenta', async ({ browser }) => {
  const s = await abrir(browser, 'bruno');
  const { page } = s;
  await page.goto(invitacion('dani'));
  await expect(page.getByTestId('invitation-wrong-account')).toContainText(correo('dani'));
  await expect(page.getByTestId('invitation-accept')).toBeDisabled();
  expect(await miembros()).toEqual(['ana:owner']);
  sinErrores(s);
  await s.context.close();
});

test('Carla acepta su invitación y entra como editora de la marca', async ({ browser }) => {
  const s = await abrir(browser, 'carla');
  const { page } = s;
  await page.goto(invitacion('carla'));
  await expect(
    page.getByText(`Te han invitado a ${ORG_A} como Miembro, con el rol Editor en la marca ${MARCA_A}.`),
  ).toBeVisible();
  await page.getByTestId('invitation-accept').click();
  await expect(page).toHaveURL(new RegExp(`${org()}$`));
  await expect(page.getByTestId(`brand-card-${dato('marcaA')}`)).toContainText('Editor');

  // El enlace es de un solo uso.
  await page.goto(invitacion('carla'));
  await expect(page.getByTestId('invitation-invalid')).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('Dani abre el enlace sin sesión, inicia sesión y acepta', async ({ browser }) => {
  const s = await abrir(browser);
  const { page } = s;
  await page.goto(invitacion('dani'));
  await expect(page.getByTestId('invitation-needs-login')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByTestId('login-email').fill(correo('dani'));
  await page.getByTestId('login-password').fill(clave('dani'));
  await page.getByTestId('login-submit').click();
  // Tras entrar vuelve a la invitación, no al inicio.
  await expect(page).toHaveURL(/\/invitacion\//);
  await expect(
    page.getByText(`Te han invitado a ${ORG_A} como Miembro, con el rol Cliente en la marca ${MARCA_A}.`),
  ).toBeVisible();
  await page.getByTestId('invitation-accept').click();
  await expect(page).toHaveURL(new RegExp(`${org()}$`));
  await guardarSesion(s.context, 'dani');
  sinErrores(s);
  await s.context.close();
});

test('Eva acepta y queda como administradora', async ({ browser }) => {
  const s = await abrir(browser, 'eva');
  const { page } = s;
  await page.goto(invitacion('eva'));
  await expect(page.getByText(`Te han invitado a ${ORG_A} como Administrador.`)).toBeVisible();
  await page.getByTestId('invitation-accept').click();
  await expect(page).toHaveURL(new RegExp(`${org()}$`));
  expect(await miembros()).toEqual(['ana:owner', 'carla:member', 'dani:member', 'eva:admin']);
  sinErrores(s);
  await s.context.close();
});

test('editora: sube a la biblioteca, pero no toca el perfil, el equipo ni la organización', async ({ browser }) => {
  const s = await abrir(browser, 'carla');
  const { page } = s;
  await page.goto(org());
  // Solo ve la marca en la que tiene rol.
  await expect(page.locator('[data-testid^="brand-card-"]')).toHaveCount(1);
  await expect(page.getByTestId('new-brand')).toHaveCount(0);

  await page.getByTestId(`brand-card-${dato('marcaA')}`).click();
  await page.getByTestId('nav-biblioteca').click();
  await page.getByTestId('library-upload-toggle').click();
  await page
    .getByTestId('library-file-input')
    .setInputFiles(archivoPng('foto-de-carla.png', png(120, 80, [90, 30, 140])));
  await expect(page.getByTestId('upload-item-done')).toContainText('foto-de-carla.png');
  await expect(page.getByTestId('library-asset').filter({ hasText: 'foto-de-carla.png' })).toBeVisible();

  await page.getByTestId('nav-marca').click();
  await expect(page.getByTestId('profile-description')).toBeDisabled();
  await expect(page.getByTestId('profile-description')).not.toHaveValue('');
  await page.getByRole('tab', { name: 'Datos de la marca' }).click();
  await expect(page.getByTestId('brand-name')).toBeDisabled();
  await expect(page.getByTestId('brand-data-save')).toHaveCount(0);
  await expect(page.getByTestId('brand-archive')).toHaveCount(0);

  await page.getByTestId('nav-equipo').click();
  await expect(page.getByTestId(`brand-member-${correo('carla')}`)).toContainText('Editor');
  await expect(page.getByTestId('brand-invite-open')).toHaveCount(0);

  await page.getByTestId('nav-configuración').click();
  await expect(page.getByTestId('org-settings-name')).toBeDisabled();
  await expect(page.getByTestId('org-settings-save')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Actividad' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Equipo', exact: true }).last().click();
  await expect(page.getByTestId(`member-${correo('ana')}`)).toBeVisible();
  await expect(page.getByTestId('invite-open')).toHaveCount(0);

  // Por URL tampoco.
  await page.goto(`${org()}/marcas/nueva`);
  await expect(page.getByText('No puedes crear marcas')).toBeVisible();
  await page.goto(`${org()}/ajustes/actividad`);
  await expect(page.getByText('Solo los administradores pueden ver la actividad.')).toBeVisible();
  await page.goto(`${org()}/m/${dato('marcaA2')}/inicio`);
  await expect(page.getByText('No encontramos esta marca')).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('cliente: ve la marca y su biblioteca, pero no puede subir, editar ni borrar', async ({ browser }) => {
  const s = await abrir(browser, 'dani');
  const { page } = s;
  await page.goto(org());
  await expect(page.locator('[data-testid^="brand-card-"]')).toHaveCount(1);
  await expect(page.getByTestId(`brand-card-${dato('marcaA')}`)).toContainText('Cliente');

  await page.goto(`${marca()}/biblioteca`);
  await expect(page.getByTestId('library-asset').filter({ hasText: 'escaparate.png' })).toBeVisible();
  await expect(page.getByTestId('library-upload-toggle')).toHaveCount(0);
  await page.getByTestId('library-asset').filter({ hasText: 'escaparate.png' }).click();
  const ficha = page.getByRole('dialog');
  await expect(ficha.getByTestId('asset-name')).toBeDisabled();
  await expect(ficha.getByTestId('asset-delete')).toHaveCount(0);
  await expect(ficha.getByTestId('asset-save')).toHaveCount(0);
  // Sí puede ver el archivo (URL firmada del cubo privado).
  await expect(ficha.locator('img')).toHaveJSProperty('naturalWidth', 200);
  await ficha.getByRole('button', { name: 'Cerrar' }).last().click();

  await page.getByTestId('nav-marca').click();
  await expect(page.getByTestId('profile-description')).toBeDisabled();
  await page.getByTestId('nav-equipo').click();
  await expect(page.getByTestId('brand-invite-open')).toHaveCount(0);

  // La otra marca de la organización no existe para él.
  await page.goto(`${org()}/m/${dato('marcaA2')}/biblioteca`);
  await expect(page.getByText('No encontramos esta marca')).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('administradora: gestiona todas las marcas y el equipo, sin poder nombrar propietarios', async ({ browser }) => {
  const s = await abrir(browser, 'eva');
  const { page } = s;
  await page.goto(org());
  await expect(page.locator('[data-testid^="brand-card-"]')).toHaveCount(2);
  await expect(page.getByTestId(`brand-card-${dato('marcaA2')}`)).toContainText(MARCA_A2);
  await expect(page.getByTestId('new-brand')).toBeVisible();

  // Puede editar el perfil de una marca sin ser miembro de ella.
  await page.goto(`${org()}/m/${dato('marcaA2')}/marca`);
  await expect(page.getByTestId('profile-description')).toBeEnabled();
  await page.getByRole('tab', { name: 'Público y objetivos' }).click();
  await page.getByTestId('profile-goals').fill('Abrir un segundo obrador');
  await page.getByTestId('profile-goals').press('Enter');
  await page.getByTestId('profile-save').click();
  await aviso(page, 'Perfil guardado (versión 2)');

  await page.goto(`${org()}/ajustes/equipo`);
  await expect(page.getByRole('link', { name: 'Actividad' })).toBeVisible();
  // A la propietaria no la puede tocar.
  await expect(page.getByRole('button', { name: /Acciones para Ana/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Acciones para Carla/ })).toBeVisible();
  await page.getByTestId('invite-open').click();
  await expect(page.getByTestId('invite-org-role').locator('option')).toHaveText(['Miembro', 'Administrador']);
  await page.getByRole('button', { name: 'Cancelar' }).click();

  sinErrores(s);
  await s.context.close();
});

test('la propietaria cambia el rol de la editora a revisora y esta deja de poder subir', async ({ browser }) => {
  const ana = await abrir(browser, 'ana');
  await ana.page.goto(`${marca()}/equipo`);
  await expect(ana.page.getByTestId(`brand-member-${correo('carla')}`)).toContainText('Editor');
  await expect(ana.page.getByTestId(`brand-member-${correo('dani')}`)).toContainText('Cliente');
  await ana.page.getByRole('button', { name: /Acciones para Carla/ }).click();
  await ana.page.getByRole('menuitem', { name: 'Revisor' }).click();
  await aviso(ana.page, 'Rol actualizado');
  await expect(ana.page.getByTestId(`brand-member-${correo('carla')}`)).toContainText('Revisor');
  sinErrores(ana);
  await ana.context.close();

  const carla = await abrir(browser, 'carla');
  await carla.page.goto(`${marca()}/biblioteca`);
  await expect(carla.page.getByTestId('library-asset').filter({ hasText: 'foto-de-carla.png' })).toBeVisible();
  await expect(carla.page.getByTestId('library-upload-toggle')).toHaveCount(0);
  sinErrores(carla);
  await carla.context.close();
});
