import { expect, test } from '@playwright/test';
import { abrir, aviso, correo, dato, leerEstado, MARCA_A, NOMBRES, ORG_A, ORG_B, sinErrores, sql } from './apoyo';

test.describe.configure({ mode: 'serial' });

const org = () => `/o/${dato('orgA')}`;
// El nombre nuevo lleva el sufijo de la tanda: así su fila es única en el panel de plataforma.
const nombreNuevo = () => `${ORG_A} ${leerEstado().tanda}`;

test('ajustes: cambiar el nombre de la organización y los datos de una marca', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${org()}/ajustes`);
  await expect(page).toHaveURL(/\/ajustes\/general$/);
  await expect(page.getByTestId('org-settings-name')).toHaveValue(ORG_A);
  await expect(page.getByTestId('org-settings-save')).toBeDisabled();

  await page.getByTestId('org-settings-name').fill(nombreNuevo());
  await page.getByTestId('org-settings-save').click();
  await aviso(page, 'Cambios guardados');
  await expect(page.getByTestId('org-switcher').first()).toContainText(nombreNuevo());
  await expect(page.getByText(`Organización ${nombreNuevo()}`)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('org-settings-name')).toHaveValue(nombreNuevo());

  await page.goto(`${org()}/m/${dato('marcaA')}/marca?seccion=datos`);
  await expect(page.getByTestId('brand-sector')).toHaveValue('Panadería artesana');
  await page.getByTestId('brand-sector').fill('Panadería y repostería');
  await page.getByTestId('brand-data-save').click();
  await aviso(page, 'Datos guardados');
  await page.reload();
  await expect(page.getByTestId('brand-sector')).toHaveValue('Panadería y repostería');

  sinErrores(s);
  await s.context.close();
});

test('archivar una marca la oculta de la lista y se puede reactivar', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  const ruta = `${org()}/m/${dato('marcaA2')}/marca?seccion=datos`;
  await page.goto(ruta);
  await page.getByTestId('brand-archive').click();
  await page.getByTestId('confirm-action').click();
  await aviso(page, 'Marca archivada');

  await page.goto(org());
  await expect(page.locator('[data-testid^="brand-card-"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Ver archivadas (1)' }).click();
  await expect(page.getByTestId(`brand-card-${dato('marcaA2')}`)).toContainText('Archivada');

  await page.goto(ruta);
  await page.getByTestId('brand-archive').click();
  await aviso(page, 'Marca reactivada');
  await page.goto(org());
  await expect(page.locator('[data-testid^="brand-card-"]')).toHaveCount(2);

  sinErrores(s);
  await s.context.close();
});

test('equipo y actividad cargan con los datos reales de la organización', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${org()}/ajustes/equipo`);
  for (const [alias, rol] of [
    ['ana', 'Propietario'],
    ['eva', 'Administrador'],
    ['carla', 'Miembro'],
    ['dani', 'Miembro'],
  ] as const) {
    const fila = page.getByTestId(`member-${correo(alias)}`);
    await expect(fila).toContainText(NOMBRES[alias]);
    await expect(fila).toContainText(rol);
  }
  await expect(page.getByText('No hay invitaciones pendientes.')).toBeVisible();

  await page.getByRole('link', { name: 'Actividad' }).click();
  await expect(page).toHaveURL(/\/ajustes\/actividad$/);
  const actividad = page.getByTestId('activity-list');
  await expect(actividad.getByRole('listitem').first()).toBeVisible();
  // Lo último que se hizo, con su autor.
  await expect(actividad).toContainText(`${NOMBRES.ana} actualizó la marca`);
  await expect(actividad).toContainText(`${NOMBRES.ana} cambió los datos de la organización`);
  await expect(actividad).toContainText(`${NOMBRES.ana} cambió el rol de ${NOMBRES.carla} a Revisor`);
  await expect(actividad).toContainText(
    `${NOMBRES.eva} aceptó la invitación y entró en la organización como Administrador`,
  );
  // Las altas que trae la invitación no se repiten como «Eva añadió a Eva».
  await expect(actividad).not.toContainText(`${NOMBRES.eva} añadió a ${NOMBRES.eva}`);
  await expect(actividad).toContainText('guardó la versión 2 del perfil de marca');
  // No queda ninguna frase sin traducir («insert en tabla»).
  await expect(actividad.getByText(/\b(insert|update|delete) en \w+/)).toHaveCount(0);

  // El registro pagina: la página 2 llega hasta el alta de la marca.
  const total = Number(
    (
      await sql<{ n: string }>('select count(*) as n from public.audit_logs where organization_id = $1', [dato('orgA')])
    )[0]?.n,
  );
  expect(total).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Anteriores' }).click();
  await expect(page.getByText('Página 2')).toBeVisible();
  await expect(actividad.getByRole('listitem').first()).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('el panel de plataforma es solo para administradores de la plataforma y muestra cifras reales', async ({
  browser,
}) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;

  // Sin serlo: ni aparece en el menú ni se puede abrir por URL.
  await page.goto(org());
  await page.getByTestId('user-menu').first().click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId('nav-platform')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/plataforma');
  await expect(page.getByText('Zona reservada')).toBeVisible();
  await expect(page.getByTestId('platform-orgs')).toHaveCount(0);

  // Alta como superadministradora, tal como indica docs/05-puesta-en-marcha.md (SQL, no hay pantalla).
  await sql('insert into public.platform_admins (user_id) select id from auth.users where email = $1', [correo('ana')]);

  await page.goto(org());
  await page.getByTestId('user-menu').first().click();
  await page.getByTestId('nav-platform').click();
  await expect(page).toHaveURL(/\/plataforma$/);
  const tabla = page.getByTestId('platform-orgs');
  await expect(tabla).toBeVisible();

  const [real] = await sql<{ miembros: string; marcas: string; recursos: string }>(
    `select (select count(*) from public.organization_members where organization_id = $1) as miembros,
            (select count(*) from public.brands where organization_id = $1) as marcas,
            (select count(*) from public.media_assets where organization_id = $1) as recursos`,
    [dato('orgA')],
  );
  expect(real).toMatchObject({ miembros: '4', marcas: '2' });
  const fila = tabla.getByRole('row').filter({ hasText: nombreNuevo() });
  await expect(fila).toHaveCount(1);
  await expect(fila.getByRole('rowheader')).toContainText('Empresa');
  await expect(fila.getByRole('cell').nth(1)).toHaveText(real!.miembros);
  await expect(fila.getByRole('cell').nth(2)).toHaveText(real!.marcas);
  await expect(fila.getByRole('cell').nth(3)).toHaveText(real!.recursos);
  await expect(fila.getByRole('cell').nth(4)).toHaveText(/\d.*(B|kB|KB|MB)/);
  // Ve también organizaciones de las que no es miembro.
  await expect(tabla.getByRole('row').filter({ hasText: ORG_B }).first()).toContainText('Agencia');

  // Bruno, que no es administrador de la plataforma, sigue sin verlo.
  const bruno = await abrir(browser, 'bruno');
  await bruno.page.goto('/plataforma');
  await expect(bruno.page.getByText('Zona reservada')).toBeVisible();
  sinErrores(bruno);
  await bruno.context.close();

  sinErrores(s);
  await s.context.close();
});

test('un miembro puede salir de la organización y vuelve a la bienvenida', async ({ browser }) => {
  const s = await abrir(browser, 'dani');
  const { page } = s;
  await page.goto(`${org()}/ajustes/equipo`);
  await page.getByRole('button', { name: 'Salir de la organización' }).click();
  await expect(page.getByText('¿Salir de la organización?')).toBeVisible();
  await page.getByTestId('confirm-action').click();
  await expect(page).toHaveURL(/\/bienvenida$/);
  await expect(page.getByRole('heading', { name: /Te damos la bienvenida/ })).toBeVisible();

  const quedan = await sql<{ email: string }>(
    `select u.email from public.organization_members m join auth.users u on u.id = m.user_id
      where m.organization_id = $1 and u.email = $2`,
    [dato('orgA'), correo('dani')],
  );
  expect(quedan).toEqual([]);
  // Y ya no puede volver a entrar por URL.
  await page.goto(`${org()}/m/${dato('marcaA')}/biblioteca`);
  await expect(page.getByText('No tienes acceso a esta organización')).toBeVisible();
  await expect(page.getByText(MARCA_A, { exact: true })).toHaveCount(0);

  sinErrores(s);
  await s.context.close();
});

test('la propietaria quita a una administradora y esta pierde el acceso', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${org()}/ajustes/equipo`);
  await expect(page.getByTestId(`member-${correo('dani')}`)).toHaveCount(0);
  await page.getByRole('button', { name: /Acciones para Eva/ }).click();
  await page.getByRole('menuitem', { name: 'Quitar de la organización' }).click();
  await expect(page.getByText(`¿Quitar a ${NOMBRES.eva}?`)).toBeVisible();
  await page.getByTestId('confirm-action').click();
  await aviso(page, 'Miembro quitado');
  await expect(page.getByTestId(`member-${correo('eva')}`)).toHaveCount(0);
  sinErrores(s);
  await s.context.close();

  const eva = await abrir(browser, 'eva');
  await eva.page.goto(org());
  await expect(eva.page.getByText('No tienes acceso a esta organización')).toBeVisible();
  await eva.page.goto('/');
  await expect(eva.page).toHaveURL(/\/bienvenida$/);
  sinErrores(eva);
  await eva.context.close();
});
