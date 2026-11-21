import { expect, test, type Page } from '@playwright/test';
import {
  abrir,
  archivoPng,
  aviso,
  dato,
  guardarEstado,
  idDeUrl,
  MARCA_A,
  MARCA_B,
  ORG_B,
  png,
  sinErrores,
  sql,
} from './apoyo';

test.describe.configure({ mode: 'serial' });

async function paso(page: Page, numero: number, titulo: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(`${numero}/7 ${titulo}`);
}

test('Ana da de alta su marca con el asistente de siete pasos, rellenando todos', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`/o/${dato('orgA')}/marcas/nueva`);
  await expect(page.getByTestId('brand-wizard')).toBeVisible();

  // 1. Básicos: sin nombre no se avanza.
  await paso(page, 1, 'Datos básicos');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByText('Escribe el nombre de la marca para continuar.')).toBeVisible();
  await page.getByTestId('brand-name').fill(MARCA_A);
  await page.getByTestId('brand-sector').fill('Panadería artesana');
  await page.getByTestId('brand-website').fill('https://laespiga.ejemplo.test');
  await page.getByTestId('wizard-next').click();

  // 2. Negocio
  await paso(page, 2, 'El negocio');
  await page.getByTestId('profile-description').fill('Obrador de pan de masa madre con reparto en el barrio.');
  await page.getByRole('button', { name: 'Añadir producto o servicio' }).click();
  await page.getByLabel('Nombre (1)').fill('Hogaza de centeno');
  await page.getByLabel('Descripción (1)').fill('Fermentación de 24 horas');
  await page.getByTestId('wizard-next').click();

  // 3. Público y objetivos
  await paso(page, 3, 'Público y objetivos');
  await page.getByTestId('profile-goals').fill('Conseguir más encargos');
  await page.getByTestId('profile-goals').press('Enter');
  await expect(page.getByRole('list', { name: 'Objetivos en redes' })).toContainText('Conseguir más encargos');
  await page.getByTestId('wizard-next').click();

  // 4. Voz
  await paso(page, 4, 'Voz de la marca');
  await page.getByTestId('profile-tone').fill('Cercano');
  await page.getByTestId('profile-tone').press('Enter');
  await page.getByTestId('wizard-next').click();

  // 5. Identidad visual: logotipo y color
  await paso(page, 5, 'Identidad visual');
  await page.getByTestId('wizard-logo-input').setInputFiles(archivoPng('logo-espiga.png', png(64, 64, [180, 120, 40])));
  await expect(page.getByText('logo-espiga.png')).toBeVisible();
  await page.getByTestId('profile-add-color').click();
  await page.getByLabel('Nombre (1)').fill('Trigo');
  await page.getByTestId('wizard-next').click();

  // 6. Fuentes: un documento y una web
  await paso(page, 6, 'Fuentes de conocimiento');
  await page.getByTestId('wizard-source-input').setInputFiles({
    name: 'manual-de-marca.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Manual de marca de prueba: tratamos de tú y no usamos mayúsculas sostenidas.'),
  });
  await page.getByTestId('wizard-url').fill('laespiga.ejemplo.test/nosotros');
  await page.getByTestId('wizard-url-add').click();
  await expect(page.getByText('https://laespiga.ejemplo.test/nosotros')).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // 7. Resumen
  await paso(page, 7, 'Revisa y crea');
  const resumen = page.getByTestId('wizard-summary');
  await expect(resumen).toContainText(MARCA_A);
  await expect(resumen).toContainText('Panadería artesana');
  await expect(resumen).toContainText('1 producto o servicio');
  await expect(resumen).toContainText('1 objetivo');
  await expect(resumen).toContainText('Cercano');
  await expect(resumen).toContainText('1 color');
  await expect(resumen).toContainText('1 logotipo');
  await expect(resumen).toContainText('1 documento · 1 web');

  await page.getByTestId('wizard-create').click();
  await aviso(page, 'Marca creada');
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}\/inicio$/);
  const marcaA = idDeUrl(page.url(), 'm');
  guardarEstado({ marcaA });

  await expect(page.getByTestId('brand-switcher').first()).toContainText(MARCA_A);
  await expect(page.getByTestId('completeness-percent')).toBeVisible();

  // Lo que el asistente dice haber guardado está de verdad en la base de datos.
  const [marca] = await sql<{ status: string; versiones: string; logos: string; fuentes: string }>(
    `select b.status,
            (select count(*) from public.brand_profiles p where p.brand_id = b.id) as versiones,
            (select count(*) from public.media_assets a where a.brand_id = b.id and a.kind = 'logo') as logos,
            (select count(*) from public.brand_knowledge_sources f where f.brand_id = b.id) as fuentes
       from public.brands b where b.id = $1`,
    [marcaA],
  );
  expect(marca).toEqual({ status: 'active', versiones: '1', logos: '1', fuentes: '2' });

  sinErrores(s);
  await s.context.close();
});

test('Bruno da de alta una marca en su agencia recorriendo los siete pasos con lo mínimo', async ({ browser }) => {
  const s = await abrir(browser, 'bruno');
  const { page } = s;
  await page.goto(`/o/${dato('orgB')}`);
  await page.getByTestId('new-brand-empty').click();
  await expect(page.getByTestId('brand-wizard')).toBeVisible();

  await paso(page, 1, 'Datos básicos');
  await page.getByTestId('brand-name').fill(MARCA_B);
  const titulos = [
    'El negocio',
    'Público y objetivos',
    'Voz de la marca',
    'Identidad visual',
    'Fuentes de conocimiento',
    'Revisa y crea',
  ];
  for (const [i, titulo] of titulos.entries()) {
    await page.getByTestId('wizard-next').click();
    await paso(page, i + 2, titulo);
  }
  await expect(page.getByTestId('wizard-summary')).toContainText(MARCA_B);
  await page.getByTestId('wizard-create').click();
  await aviso(page, 'Marca creada');
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}\/inicio$/);
  const marcaB = idDeUrl(page.url(), 'm');
  guardarEstado({ marcaB });

  // El panel de la agencia la lista como activa y con el rol de gestor.
  await page.goto(`/o/${dato('orgB')}`);
  await expect(page.getByText(`Las marcas que gestiona ${ORG_B}.`)).toBeVisible();
  const tarjeta = page.getByTestId(`brand-card-${marcaB}`);
  await expect(tarjeta).toContainText(MARCA_B);
  await expect(tarjeta).toContainText('Activa');
  await expect(tarjeta).toContainText('Gestor');
  await expect(page.locator('[data-testid^="brand-card-"]')).toHaveCount(1);

  sinErrores(s);
  await s.context.close();
});
