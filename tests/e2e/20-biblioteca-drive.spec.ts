import { expect, test } from '@playwright/test';
import { abrir, aviso, dato, sinErrores, sql, accionDelMenu } from './apoyo';

// Biblioteca con Google Drive de extremo a extremo, contra el Supabase LOCAL y
// Google Drive SIMULADO (supabase/functions/_shared/drive/local-test.ts,
// activado en supabase/functions/e2e.env): Ana conecta el Drive de la
// organización, añade una foto de Drive a la biblioteca de la marca (sin copia
// en Storage), la ve en la rejilla y la usa en el editor, que la exporta.
//
// Parte de lo que dejaron los archivos anteriores: Ana es propietaria de la
// organización A con la marca La Espiga.

test.describe.configure({ mode: 'serial' });

const ajustes = () => `/o/${dato('orgA')}/ajustes/drive`;
const marca = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
const FOTO = 'Coca de verduras.png';

test('quien administra la organización conecta Google Drive (OAuth simulado)', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(ajustes());
  const tarjeta = page.getByTestId('drive-settings');
  await expect(tarjeta.getByTestId('drive-settings-empty')).toBeVisible();
  await tarjeta.getByTestId('drive-connect').click();
  // Sin diálogo de Google en local: vuelve por el callback a los ajustes.
  await expect(page).toHaveURL(new RegExp(`${ajustes()}`));
  await aviso(page, 'Google Drive conectado');
  await expect(tarjeta.getByTestId('drive-connection')).toContainText('drive-simulado@pruebas.test');

  // El token de refresco está cifrado fuera de `public`.
  const [secreto] = await sql<{ claro: boolean }>(
    `select s.refresh_token_ciphertext like 'sim-%' as claro from private.drive_connection_secrets s
     join public.drive_connections c on c.id = s.connection_id where c.organization_id = $1`,
    [dato('orgA')],
  );
  expect(secreto).toEqual({ claro: false });
  sinErrores(s);
  await s.context.close();
});

test('añadir una foto de Drive a la biblioteca: se ve y no ocupa Storage', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/biblioteca`);
  await page.getByTestId('library-drive').click();
  const carpeta = page.getByTestId('drive-folder');
  await carpeta.getByTestId('drive-subfolder').filter({ hasText: 'Platos' }).click();
  // La HEIC del móvil sale, pero no se puede elegir.
  await expect(page.getByTestId('drive-unsupported')).toContainText('HEIC');
  await expect(page.getByRole('checkbox', { name: 'Elegir IMG_0001.HEIC' })).toBeDisabled();
  await page.getByRole('checkbox', { name: `Elegir ${FOTO}` }).check();
  await page.getByTestId('drive-import-folder').fill('Drive');
  await page.getByTestId('drive-import-submit').click();
  await aviso(page, '1 foto añadida desde Google Drive');

  const tarjeta = page.getByTestId('library-asset').filter({ hasText: FOTO });
  await expect(tarjeta.getByTestId('library-asset-drive')).toBeVisible();
  // La miniatura llega de Drive por la dirección firmada de drive-media.
  await expect(tarjeta.locator('img')).toHaveJSProperty('naturalWidth', 96);

  const [fila] = await sql<{ source: string; objetos: string; ruta: string }>(
    `select a.source, a.storage_path as ruta,
            (select count(*) from storage.objects o where o.bucket_id = 'brand-media' and o.name = a.storage_path)::text as objetos
     from public.media_assets a where a.brand_id = $1 and a.file_name = $2`,
    [dato('marcaA'), FOTO],
  );
  expect(fila).toMatchObject({ source: 'google_drive', objetos: '0' });
  expect(fila!.ruta).toMatch(/\/drive\/simImgCoca00000001$/);
  sinErrores(s);
  await s.context.close();
});

test('usar la foto de Drive en el editor y exportar la pieza', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/contenidos`);
  await page.getByTestId('content-new').click();
  await page.getByTestId('create-content-title').fill('Pieza con foto de Drive');
  await page.getByTestId('create-content-network').selectOption('instagram');
  await page.getByTestId('create-content-format').selectOption('post');
  await page.getByTestId('create-content-submit').click();
  await expect(page.getByTestId('editor-title')).toHaveText('Pieza con foto de Drive');
  const contenido = /\/contenidos\/([0-9a-f-]{36})/.exec(page.url())?.[1];

  const servida = page.waitForResponse((r) => r.url().includes('/functions/v1/drive-media/file/') && r.ok());
  await page.getByTestId('add-image').click();
  await page.getByTestId('image-picker').getByTestId('picker-asset').filter({ hasText: FOTO }).click();
  await servida;
  await expect(page.getByRole('tab', { name: 'Capas (1)' })).toBeVisible();

  await page.getByTestId('editor-save').click();
  await page.getByTestId('save-confirm').click();
  await aviso(page, 'Versión 1 guardada');
  const [version] = await sql<{
    capas: { type: string; source?: { kind: string; assetId?: string } }[];
    recurso: string;
  }>(
    `select v.data #> '{pages,0,layers}' as capas,
            (select a.id::text from public.media_assets a where a.brand_id = $2 and a.file_name = $3) as recurso
     from public.content_versions v where v.content_id = $1 and v.version = 1`,
    [contenido, dato('marcaA'), FOTO],
  );
  expect(version!.capas.some((c) => c.type === 'image' && c.source?.assetId === version!.recurso)).toBe(true);

  // Exportar lee la imagen del lienzo: si la de Drive llegara sin CORS, el lienzo quedaría «manchado» y fallaría.
  await accionDelMenu(page, 'editor-more', 'editor-export');
  await page.getByTestId('export-format-jpeg').check();
  await page.getByTestId('export-download').uncheck();
  await page.getByTestId('export-library').check();
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-done')).toBeVisible();
  sinErrores(s);
  await s.context.close();
});
