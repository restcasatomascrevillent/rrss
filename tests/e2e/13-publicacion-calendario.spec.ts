import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { abrir, aviso, dato, LOCAL, sinErrores, sql, accionDelMenu } from './apoyo';

// Publicación de extremo a extremo (Fase 3), contra el Supabase LOCAL y la
// Graph API de Meta SIMULADA (supabase/functions/_shared/social/local-test.ts,
// activada en supabase/functions/e2e.env): Ana conecta la cuenta de Instagram
// de la marca, aprueba una pieza, la exporta, la programa, el publicador la
// publica en la API simulada y el calendario la enseña publicada con su enlace.
// Otra pieza programada sin aprobar no se publica.
//
// El reloj (pg_cron → social-publish) no se espera: la prueba adelanta la hora
// de la publicación en la base de datos y llama ella misma a la función con la
// clave de servicio del stack local, que es lo que hace pg_cron cada minuto.
//
// Parte de lo que dejaron los archivos anteriores: Ana es propietaria de la
// organización A con la marca La Espiga Obrador.

test.describe.configure({ mode: 'serial' });

const marca = () => `/o/${dato('orgA')}/m/${dato('marcaA2')}`;
const APROBADA = 'Hogaza del domingo';
const SIN_APROBAR = 'Borrador de bollería';
let aprobada = '';
let sinAprobar = '';

/** Clave de servicio del stack local (`supabase status`): la que usa pg_cron para llamar al publicador. */
function serviceKey(): string {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const clave = /^SERVICE_ROLE_KEY="?([^"\r\n]*)"?/m.exec(salida)?.[1];
  if (!clave) throw new Error('No se pudo leer la clave de servicio del stack local (supabase status).');
  return clave;
}

/** Lo que hace pg_cron: encolar lo que toca y llamar a la función del publicador. */
async function pasaElReloj(): Promise<{ results: { publicationId: string | null; outcome: string }[] }> {
  await sql(`select public.social_enqueue_due_publications(100)`);
  const clave = serviceKey();
  const respuesta = await fetch(`${LOCAL.api}/functions/v1/social-publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clave}`, apikey: clave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'e2e' }),
  });
  expect(respuesta.ok, await respuesta.clone().text()).toBe(true);
  return (await respuesta.json()) as { results: { publicationId: string | null; outcome: string }[] };
}

/** Crea una pieza de Instagram con su texto, guarda la versión 1 y deja abierto el editor. */
async function piezaConTexto(page: Page, titulo: string, texto: string): Promise<string> {
  await page.goto(`${marca()}/contenidos`);
  await page.getByTestId('content-new').click();
  await page.getByTestId('create-content-title').fill(titulo);
  await page.getByTestId('create-content-network').selectOption('instagram');
  await page.getByTestId('create-content-format').selectOption('post');
  await page.getByTestId('create-content-submit').click();
  await expect(page.getByTestId('editor-title')).toHaveText(titulo);
  const id = /\/contenidos\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error(`No se ve el id de la pieza en ${page.url()}`);
  await page.getByRole('tab', { name: 'Publicación' }).click();
  await page.getByTestId('copy-caption').fill(texto);
  await page.getByTestId('editor-save').click();
  await page.getByTestId('save-confirm').click();
  await aviso(page, 'Versión 1 guardada');
  return id;
}

/** Exporta la versión guardada como JPEG a la biblioteca (sin descargarla). */
async function exportarJpeg(page: Page): Promise<void> {
  await accionDelMenu(page, 'editor-more', 'editor-export');
  await page.getByTestId('export-format-jpeg').check();
  await page.getByTestId('export-download').uncheck();
  await page.getByTestId('export-library').check();
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-done')).toBeVisible();
  await page.getByTestId('export-close').click();
}

/** Programa una pieza desde el calendario para dentro de una hora, con su exportación si la hay. */
async function programar(page: Page, titulo: string): Promise<void> {
  await page.goto(`${marca()}/calendario`);
  await page.getByTestId('calendar-schedule').click();
  const opcion = page.getByTestId('schedule-content').locator('option', { hasText: titulo });
  await page.getByTestId('schedule-content').selectOption(await opcion.getAttribute('value'));
  const recursos = page.getByTestId('schedule-asset');
  if ((await recursos.count()) > 0) await recursos.first().check();
  await page.getByTestId('schedule-submit').click();
}

test('quien gestiona la marca conecta su cuenta de Instagram (OAuth simulado)', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/marca`);
  await page.getByRole('tab', { name: 'Datos de la marca' }).click();
  const tarjeta = page.getByTestId('social-accounts');
  await expect(tarjeta.getByTestId('social-accounts-empty')).toBeVisible();
  await tarjeta.getByTestId('social-connect-instagram').click();
  // Sin diálogo de Meta en local: vuelve por el callback a la aplicación.
  await expect(page).toHaveURL(new RegExp(`${marca()}/marca`));
  await aviso(page, 'Cuenta de Instagram conectada');
  await page.getByRole('tab', { name: 'Datos de la marca' }).click();
  await expect(tarjeta.getByTestId('social-account')).toContainText('@cuenta_simulada');

  // El token está cifrado fuera de `public` y no se ve en claro.
  const [secreto] = await sql<{ claro: boolean }>(
    `select s.access_token_ciphertext like 'sim-%' as claro from private.social_account_secrets s
     join public.social_accounts a on a.id = s.account_id where a.brand_id = $1 and a.status = 'active'`,
    [dato('marcaA2')],
  );
  expect(secreto).toEqual({ claro: false });
  sinErrores(s);
  await s.context.close();
});

test('una pieza aprobada y exportada se programa y el publicador la publica', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  aprobada = await piezaConTexto(page, APROBADA, 'La hogaza del domingo ya está en el horno.');
  await exportarJpeg(page);
  await page.getByTestId('status-approved').click();
  await aviso(page, 'Aprobada');

  await programar(page, APROBADA);
  await aviso(page, 'Programada');
  const chip = page.getByTestId('calendar-entry').filter({ hasText: APROBADA });
  await expect(chip).toHaveAttribute('data-state', 'scheduled');
  await expect(chip).toContainText('Programada');

  // Llega su hora.
  await sql(
    `update public.scheduled_publications set scheduled_at = now() - interval '1 second' where content_id = $1`,
    [aprobada],
  );
  const { results } = await pasaElReloj();
  const [fila] = await sql<{ id: string; status: string; external_id: string; external_url: string }>(
    `select id, status::text, external_id, external_url from public.scheduled_publications where content_id = $1`,
    [aprobada],
  );
  expect(results.find((r) => r.publicationId === fila!.id)?.outcome).toBe('published');
  expect(fila!.status).toBe('published');
  expect(fila!.external_id).toMatch(/^\d+$/);
  expect(fila!.external_url).toBe(`https://instagram.simulado.invalid/p/${fila!.external_id}/`);

  // El calendario la enseña publicada, con su identificador y su enlace.
  await page.reload();
  await expect(chip).toHaveAttribute('data-state', 'published');
  await chip.click();
  await expect(page.getByTestId('publication-state')).toHaveText('Publicada');
  await expect(page.getByTestId('publication-external-id')).toHaveText(fila!.external_id);
  await expect(page.getByTestId('publication-link')).toHaveAttribute('href', fila!.external_url);
  await expect(page.getByTestId('publication-attempts')).toContainText('Publicada');

  // Otra pasada del reloj no la publica dos veces.
  await pasaElReloj();
  const [intentos] = await sql<{ n: number }>(
    `select count(*)::int as n from public.publication_attempts where publication_id = $1 and outcome in ('published', 'recovered')`,
    [fila!.id],
  );
  expect(intentos).toEqual({ n: 1 });
  sinErrores(s);
  await s.context.close();
});

test('una pieza programada sin aprobar no se publica aunque llegue su hora', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  sinAprobar = await piezaConTexto(page, SIN_APROBAR, 'Croissants recién hechos.');
  await exportarJpeg(page);

  await programar(page, SIN_APROBAR);
  await aviso(page, /aún no se publicará/);
  const chip = page.getByTestId('calendar-entry').filter({ hasText: SIN_APROBAR });
  await expect(chip).toHaveAttribute('data-state', 'draft');
  await expect(chip).not.toContainText('Programada');

  await sql(
    `update public.scheduled_publications set scheduled_at = now() - interval '1 second' where content_id = $1`,
    [sinAprobar],
  );
  await pasaElReloj();
  const [fila] = await sql<{ status: string; hold_reason: string; external_id: string | null }>(
    `select status::text, hold_reason, external_id from public.scheduled_publications where content_id = $1`,
    [sinAprobar],
  );
  expect(fila).toEqual({ status: 'planned', hold_reason: 'not_approved', external_id: null });

  await page.reload();
  await chip.click();
  await expect(page.getByTestId('publication-state')).toHaveText('Borrador');
  await expect(page.getByTestId('publication-hold')).toContainText('no está aprobada');
  sinErrores(s);
  await s.context.close();
});
