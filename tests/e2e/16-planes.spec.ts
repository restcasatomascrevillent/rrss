import { expect, test } from '@playwright/test';
import { abrir, asignarPlan, aviso, dato, sinErrores, sql } from './apoyo';

// Fase 6 · Planes. Ana es superadministradora desde el escenario 08; Bruno es
// propietario de la agencia (organización B), que tiene una marca (escenario 02).
// Al terminar, la organización B vuelve a «Heredado».

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await asignarPlan(dato('orgB'), 'legacy');
});

test('la superadministradora ve el margen por organización y asigna un plan a mano', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto('/plataforma');

  const margen = page.getByTestId('billing-overview');
  await expect(margen).toBeVisible();
  // Por su botón (con el id), no por el nombre: en una base local con tandas
  // anteriores hay varias «Agencia Faro».
  const fila = margen.getByRole('row').filter({ has: page.getByTestId(`assign-plan-${dato('orgB')}`) });
  await expect(fila).toContainText('Heredado');
  await expect(page.getByTestId('plans-table')).toContainText('Profesional');

  await page.getByTestId(`assign-plan-${dato('orgB')}`).click();
  const prueba = await sql<{ id: string }>(`select id from public.plans where code = 'trial'`);
  await page.getByTestId('assign-plan-select').selectOption(prueba[0]!.id);
  await page.getByTestId('assign-plan-save').click();
  await aviso(page, 'Plan asignado');
  await expect(fila).toContainText('Prueba');

  const [sub] = await sql<{ code: string; source: string }>(
    `select p.code, s.source::text from public.subscriptions s join public.plans p on p.id = s.plan_id
     where s.organization_id = $1`,
    [dato('orgB')],
  );
  expect(sub).toEqual({ code: 'trial', source: 'manual' });
  sinErrores(s);
  await s.context.close();
});

test('el propietario ve su plan y su uso, y no puede pasarse del límite de marcas', async ({ browser }) => {
  const s = await abrir(browser, 'bruno');
  const { page } = s;
  await page.goto(`/o/${dato('orgB')}/ajustes/plan`);
  await expect(page.getByTestId('plan-name')).toHaveText('Prueba');
  await expect(page.getByTestId('plan-usage-brands')).toHaveText('1 de 1');
  // Sin VITE_BILLING_ENABLED no aparece nada de pago: ni la tarjeta «Cambiar de
  // plan» ni el botón de contratar. (Por texto suelto no vale: la explicación de
  // los límites dice «…hasta liberar sitio o cambiar de plan».)
  await expect(page.getByRole('heading', { name: 'Cambiar de plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Contratar|Stripe/ })).toHaveCount(0);

  // El asistente de alta llega al final, pero la base de datos no deja crear la segunda marca.
  await page.goto(`/o/${dato('orgB')}/marcas/nueva`);
  await page.getByTestId('brand-name').fill('Marca de más');
  for (let i = 0; i < 6; i += 1) await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-create').click();
  await aviso(page, /límite de marcas activas de tu plan «Prueba»: 1 de 1/);
  const marcas = await sql(`select 1 from public.brands where organization_id = $1 and name = 'Marca de más'`, [
    dato('orgB'),
  ]);
  expect(marcas).toEqual([]);

  sinErrores(s, [/status of 400/]);
  await s.context.close();
});
