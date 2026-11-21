import { expect, test, type Response } from '@playwright/test';
import { abrir, aviso, dato, sinErrores, sql } from './apoyo';

// Plataforma → Integraciones (migración 20261120010000, función
// platform-integrations): la superadministradora (Ana, desde el escenario 08)
// guarda la aplicación de Meta, la prueba contra la Graph API SIMULADA y la ve
// como configurada sin ver nunca el secreto. Después, una marca conecta su
// cuenta de Instagram pegando un token (también contra la Graph API simulada).

test.describe.configure({ mode: 'serial' });

// Valores de prueba: no son de ninguna aplicación de Meta.
const APP_ID = '1234567890123';
const APP_SECRET = 'secretoe2e0123456789abcdefSIMU';

test.beforeAll(async () => {
  // Cada tanda empieza sin integraciones guardadas.
  await sql(`delete from vault.secrets where name like 'rrss_integration_%'`);
  await sql(`delete from private.integration_settings`);
  await sql(`delete from private.integration_tests`);
});

test('la superadministradora guarda la aplicación de Meta, la prueba y la ve configurada sin ver el secreto', async ({
  browser,
}) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  // Todo lo que responde platform-integrations, para comprobar que el secreto no vuelve nunca.
  const respuestas: Promise<string>[] = [];
  page.on('response', (r: Response) => {
    if (r.url().includes('/functions/v1/platform-integrations')) respuestas.push(r.text().catch(() => ''));
  });

  await page.goto('/plataforma');
  await page.getByTestId('platform-integrations-link').click();
  await expect(page).toHaveURL(/\/plataforma\/integraciones$/);
  const meta = page.getByTestId('integration-meta');
  await expect(meta).toBeVisible();
  // En la prueba local la publicación ya funciona (Graph API simulada): se enseña.
  await expect(page.getByTestId('integration-flags')).toContainText('Se enseña');

  await meta.getByTestId('setting-META_APP_ID').getByRole('textbox').fill(APP_ID);
  await meta.getByLabel('App Secret').fill(APP_SECRET);
  await meta.getByTestId('integration-save').click();
  await aviso(page, 'Guardado');

  const estado = meta.getByTestId('setting-state-META_APP_SECRET');
  await expect(estado).toContainText('Configurado');
  await expect(estado).toContainText(`…${APP_SECRET.slice(-4)}`);
  await expect(meta.getByLabel('App Secret')).toHaveValue('');
  await expect(meta.getByTestId('setting-META_APP_ID').getByRole('textbox')).toHaveValue(APP_ID);

  await meta.getByTestId('integration-test').click();
  const resultado = meta.getByTestId('integration-test-result');
  await expect(resultado).toContainText('Funciona');
  await expect(resultado).toContainText('Aplicación simulada');

  // Tras recargar, sigue configurada y la última prueba queda anotada.
  await page.reload();
  await expect(page.getByTestId('integration-meta').getByTestId('setting-state-META_APP_SECRET')).toContainText(
    'Configurado',
  );
  await expect(page.getByTestId('integration-meta').getByTestId('integration-last-test')).toContainText('Funcionaba');
  await expect(page.getByTestId('integration-audit')).toContainText('META_APP_SECRET');

  // El navegador nunca ha recibido el secreto: ni en la página ni en ninguna respuesta.
  expect(await page.content()).not.toContain(APP_SECRET);
  const cuerpos = await Promise.all(respuestas);
  expect(cuerpos.length).toBeGreaterThan(2);
  for (const cuerpo of cuerpos) expect(cuerpo).not.toContain(APP_SECRET);

  // En la base de datos: el valor está en Vault, cifrado; la tabla solo guarda su identificador.
  const [fila] = await sql<{ claro: boolean; enVault: boolean }>(
    `select (s.plain_value is not null) as claro,
            exists (select 1 from vault.secrets v where v.id = s.vault_secret_id and v.secret <> $1) as "enVault"
     from private.integration_settings s where s.setting_key = 'META_APP_SECRET'`,
    [APP_SECRET],
  );
  expect(fila).toEqual({ claro: false, enVault: true });

  sinErrores(s);
  await s.context.close();
});

test('un secreto mal escrito no se guarda y quien no es superadministrador no entra', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto('/plataforma/integraciones');
  await page.getByRole('tab', { name: 'Stripe' }).click();
  const stripe = page.getByTestId('integration-stripe');
  await stripe.getByLabel('Clave secreta').fill('esto-no-es-una-clave');
  await stripe.getByTestId('integration-save').click();
  await expect(stripe.getByRole('alert')).toContainText('sk_test_');
  await expect(stripe.getByTestId('setting-state-STRIPE_SECRET_KEY')).toContainText('Sin configurar');
  sinErrores(s, [/status of 400/]);
  await s.context.close();

  const bruno = await abrir(browser, 'bruno');
  await bruno.page.goto('/plataforma/integraciones');
  await expect(bruno.page.getByText('Zona reservada')).toBeVisible();
  sinErrores(bruno);
  await bruno.context.close();
});

test('quien gestiona la marca conecta Instagram pegando un token (Graph API simulada)', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  const token = `sim-page-100000000000001-e2e-${Date.now()}`;
  await page.goto(`/o/${dato('orgA')}/m/${dato('marcaA2')}/marca`);
  await page.getByRole('tab', { name: 'Datos de la marca' }).click();
  const tarjeta = page.getByTestId('social-accounts');
  // Esperar a que la tarjeta cargue: con cuenta o sin ella.
  await expect(tarjeta.getByTestId('social-account').or(tarjeta.getByTestId('social-accounts-empty'))).toBeVisible();
  // La cuenta del escenario 13 sigue conectada por OAuth: se desconecta para pegar un token.
  if (await tarjeta.getByTestId('social-disconnect').isVisible()) {
    await tarjeta.getByTestId('social-disconnect').click();
    await page.getByTestId('confirm-action').click();
    await aviso(page, 'Cuenta desconectada');
  }
  await tarjeta.getByTestId('social-connect-token').click();
  await expect(page.getByText(/El token sustituye al inicio de sesión con Meta/)).toBeVisible();
  await page.getByTestId('social-token-ig-id').fill('17841400000000001');
  await page.getByTestId('social-token-value').fill(token);
  await page.getByTestId('social-token-submit').click();
  await aviso(page, 'Cuenta @cuenta_simulada conectada con el token');
  await expect(tarjeta.getByTestId('social-account-token')).toContainText('Conexión avanzada');
  expect(await page.content()).not.toContain(token);

  const [cuenta] = await sql<{ connection_method: string; claro: boolean }>(
    `select a.connection_method, s.access_token_ciphertext like 'sim-%' as claro
     from public.social_accounts a join private.social_account_secrets s on s.account_id = a.id
     where a.brand_id = $1 and a.status = 'active'`,
    [dato('marcaA2')],
  );
  expect(cuenta).toEqual({ connection_method: 'token', claro: false });
  sinErrores(s);
  await s.context.close();
});
