import { expect, test } from '@playwright/test';
import { abrir, dato, sinErrores, sql } from './apoyo';

// «Importar publicaciones de la cuenta» de extremo a extremo, contra el Supabase
// LOCAL y la Graph API de Meta SIMULADA (supabase/functions/_shared/social/local-test.ts):
// la cuenta simulada ya tiene 30 publicaciones antiguas (un carrusel de 3
// imágenes, un reel y 28 imágenes). Ana las importa desde Marca → Datos de la
// marca → Cuentas conectadas copiando las imágenes, ve el recuento y las fotos
// en la biblioteca (carpeta «Instagram / Publicadas»); repetirlo no duplica.
//
// Parte de lo que dejaron los archivos anteriores: la cuenta de Instagram
// simulada conectada a La Espiga Obrador (13-publicacion-calendario.spec.ts).

test.describe.configure({ mode: 'serial' });

const marca = () => `/o/${dato('orgA')}/m/${dato('marcaA2')}`;
// 3 del carrusel + 1 portada del reel + 28 imágenes.
const IMAGENES = 32;

test('Ana importa el histórico de la cuenta y copia las imágenes a la biblioteca', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/marca`);
  await page.getByRole('tab', { name: 'Datos de la marca' }).click();
  const panel = page.getByTestId('social-accounts').getByTestId('social-import');
  await expect(panel.getByTestId('social-import-total')).toHaveText('Todavía no se ha importado nada.');

  await panel.getByTestId('social-import-copy').check();
  await panel.getByTestId('social-import-start').click();
  await expect(panel.getByTestId('social-import-done')).toBeVisible({ timeout: 120_000 });
  await expect(panel.getByTestId('social-import-progress')).toContainText(
    '30 publicaciones leídas (30 nuevas) · 30 publicaciones copiadas a la biblioteca',
  );
  await expect(panel.getByTestId('social-import-total')).toHaveText('30 publicaciones importadas de esta marca.');

  // Guardado: una fila por publicación, con enlace y fecha; el token no está en ninguna tabla pública.
  const [filas] = await sql<{ n: number; con_enlace: number }>(
    `select count(*)::int as n, count(permalink)::int as con_enlace from public.social_imported_media where brand_id = $1`,
    [dato('marcaA2')],
  );
  expect(filas).toEqual({ n: 30, con_enlace: 30 });
  const [recursos] = await sql<{ n: number; carpetas: string; enlaces: number }>(
    `select count(*)::int as n, min(folder) as carpetas, count(provenance->>'permalink')::int as enlaces
     from public.media_assets where brand_id = $1 and origin = 'import' and provenance->>'type' = 'instagram_import'`,
    [dato('marcaA2')],
  );
  expect(recursos).toEqual({ n: IMAGENES, carpetas: 'Instagram / Publicadas', enlaces: IMAGENES });

  // Las fotos se ven en la biblioteca, en su carpeta.
  await page.goto(`${marca()}/biblioteca`);
  await page.getByLabel('Filtrar por carpeta').selectOption('Instagram / Publicadas');
  await expect(page.getByTestId('library-asset').first()).toBeVisible();
  expect(await page.getByTestId('library-asset').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('library-asset').first()).toContainText('instagram-');
  await expect(page.getByTestId('library-asset').first().locator('img')).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('importar otra vez renueva lo importado sin duplicar publicaciones ni imágenes', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/marca`);
  await page.getByRole('tab', { name: 'Datos de la marca' }).click();
  const panel = page.getByTestId('social-accounts').getByTestId('social-import');
  await panel.getByTestId('social-import-copy').check();
  await panel.getByTestId('social-import-start').click();
  await expect(panel.getByTestId('social-import-progress')).toContainText('30 publicaciones leídas (0 nuevas)', {
    timeout: 120_000,
  });
  await expect(panel.getByTestId('social-import-done')).toBeVisible();

  const [filas] = await sql<{ n: number }>(
    `select count(*)::int as n from public.social_imported_media where brand_id = $1`,
    [dato('marcaA2')],
  );
  expect(filas?.n).toBe(30);
  const [recursos] = await sql<{ n: number }>(
    `select count(*)::int as n from public.media_assets where brand_id = $1 and provenance->>'type' = 'instagram_import'`,
    [dato('marcaA2')],
  );
  expect(recursos?.n).toBe(IMAGENES);
  sinErrores(s);
  await s.context.close();
});

test('quien no gestiona la marca no ve el botón de importar', async ({ browser }) => {
  // Bruno es de la agencia, no de esta organización: ni siquiera ve la marca.
  const s = await abrir(browser, 'bruno');
  await s.page.goto(`${marca()}/marca`);
  await expect(s.page.getByTestId('social-import')).toHaveCount(0);
  await s.context.close();
});
