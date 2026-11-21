import { expect, test } from '@playwright/test';
import { abrir, archivoPng, aviso, dato, png, sinErrores, sql, accionDelMenu } from './apoyo';
import { arrancarMinio, MINIO, objetoEnMinio, pararMinio } from './minio';

// Almacenamiento en Cloudflare R2 de extremo a extremo, contra el Supabase
// LOCAL y un S3 local (MinIO en Docker) en lugar de R2
// (supabase/functions/_shared/storage/config.ts, activado en
// supabase/functions/e2e.env con MEDIA_STORAGE_E2E_SIMULATED): la
// superadministradora configura R2 en Plataforma → Integraciones y lo prueba;
// Ana sube una foto a la biblioteca (va a R2 con una URL firmada), la ve, la usa
// en el editor y exporta la pieza (la exportación también va a R2); al borrar la
// foto, se borra de R2. Al acabar se quita R2: los archivos siguientes vuelven a
// Supabase Storage.
//
// Parte de lo que dejaron los archivos anteriores: Ana es superadministradora
// (escenario 08) y propietaria de la organización A con la marca La Espiga.

test.describe.configure({ mode: 'serial' });

const marca = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
const FOTO = 'terraza-r2.png';
const DATOS = png(320, 200, [40, 120, 200], true);

async function quitarR2(): Promise<void> {
  await sql(
    `delete from vault.secrets where id in (
       select s.vault_secret_id from private.integration_settings s
       join private.integration_setting_keys k on k.setting_key = s.setting_key
       where k.integration = 'r2' and s.vault_secret_id is not null)`,
  );
  await sql(
    `delete from private.integration_settings s using private.integration_setting_keys k
     where k.setting_key = s.setting_key and k.integration = 'r2'`,
  );
}

test.beforeAll(async () => {
  await quitarR2();
  // Al relanzar solo este archivo (E2E_CONTINUAR=1), la foto de la pasada anterior
  // haría que la subida se tomara por un duplicado: se quita su fila.
  await sql(`delete from public.media_assets where brand_id = $1 and file_name = $2`, [dato('marcaA'), FOTO]);
  await arrancarMinio();
});

test.afterAll(async () => {
  await quitarR2();
  pararMinio();
  // Las funciones guardan la configuración leída 30 s (_shared/integrations/settings.ts):
  // hasta que caduca, `media-storage` seguiría firmando subidas a MinIO, ya parado, y la
  // primera subida del archivo siguiente fallaría («No hay conexión con el servidor»).
  await new Promise((resolve) => setTimeout(resolve, 35_000));
});

test('la superadministradora configura Cloudflare R2 (aquí, MinIO) y «Probar conexión» funciona', async ({
  browser,
}) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto('/plataforma/integraciones');
  await page.getByRole('tab', { name: 'Cloudflare R2 (almacenamiento)' }).click();
  const r2 = page.getByTestId('integration-r2');
  await r2.getByTestId('setting-R2_BUCKET').getByRole('textbox').fill(MINIO.cubo);
  await r2.getByLabel('Access Key ID').fill(MINIO.usuario);
  await r2.getByLabel('Secret Access Key').fill(MINIO.clave);
  await r2.getByTestId('integration-save').click();
  await aviso(page, 'Guardado');
  await expect(r2.getByTestId('setting-state-R2_SECRET_ACCESS_KEY')).toContainText('Configurado');

  await r2.getByTestId('integration-test').click();
  const resultado = r2.getByTestId('integration-test-result');
  await expect(resultado).toContainText('Funciona');
  await expect(resultado).toContainText('El S3 local responde');
  await page.reload();
  await expect(page.getByTestId('integration-flags')).toContainText('Archivos en Cloudflare R2');
  sinErrores(s);
  await s.context.close();
});

test('subir una foto a la biblioteca: va a R2, no a Supabase Storage, y se ve', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/biblioteca`);
  const subida = page.waitForRequest((r) => r.method() === 'PUT' && r.url().startsWith(MINIO.publico));
  await page.getByTestId('library-upload-toggle').click();
  await page.getByTestId('library-file-input').setInputFiles(archivoPng(FOTO, DATOS));
  await expect(page.getByTestId('upload-item-done')).toContainText(FOTO);
  // La subida va a la URL firmada, sin la sesión de Supabase.
  expect((await subida).headers().authorization).toBeUndefined();

  const [fila] = await sql<{ backend: string; ruta: string; objetos: string }>(
    `select a.storage_backend as backend, a.storage_path as ruta,
            (select count(*) from storage.objects o where o.bucket_id = 'brand-media' and o.name = a.storage_path)::text as objetos
     from public.media_assets a where a.brand_id = $1 and a.file_name = $2`,
    [dato('marcaA'), FOTO],
  );
  expect(fila).toMatchObject({ backend: 'r2', objetos: '0' });
  expect(await objetoEnMinio(fila!.ruta)).toBe(DATOS.length);

  // La miniatura llega de R2 con una URL firmada de corta duración.
  await page.reload();
  const tarjeta = page.getByTestId('library-asset').filter({ hasText: FOTO });
  const imagen = tarjeta.locator('img');
  await expect(imagen).toHaveAttribute('src', new RegExp(`^${MINIO.publico}/${MINIO.cubo}/.+X-Amz-Expires=3600`));
  await expect(imagen).toHaveJSProperty('naturalWidth', 320);
  sinErrores(s);
  await s.context.close();
});

test('usar la foto de R2 en el editor y exportar la pieza: la exportación también va a R2', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/contenidos`);
  await page.getByTestId('content-new').click();
  await page.getByTestId('create-content-title').fill('Pieza con foto en R2');
  await page.getByTestId('create-content-network').selectOption('instagram');
  await page.getByTestId('create-content-format').selectOption('post');
  await page.getByTestId('create-content-submit').click();
  await expect(page.getByTestId('editor-title')).toHaveText('Pieza con foto en R2');
  const contenido = /\/contenidos\/([0-9a-f-]{36})/.exec(page.url())?.[1];

  const servida = page.waitForResponse((r) => r.url().startsWith(MINIO.publico) && r.ok());
  await page.getByTestId('add-image').click();
  await page.getByTestId('image-picker').getByTestId('picker-asset').filter({ hasText: FOTO }).click();
  await servida;
  await expect(page.getByRole('tab', { name: 'Capas (1)' })).toBeVisible();
  await page.getByTestId('editor-save').click();
  await page.getByTestId('save-confirm').click();
  await aviso(page, 'Versión 1 guardada');

  // Exportar lee el lienzo: con una imagen de R2 sin CORS, el lienzo quedaría «manchado» y fallaría.
  await accionDelMenu(page, 'editor-more', 'editor-export');
  await page.getByTestId('export-format-jpeg').check();
  await page.getByTestId('export-download').uncheck();
  await page.getByTestId('export-library').check();
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-done')).toBeVisible();

  const [exportada] = await sql<{ backend: string; ruta: string; bytes: string }>(
    `select a.storage_backend as backend, a.storage_path as ruta, a.bytes::text as bytes
     from public.media_assets a
     where a.brand_id = $1 and a.provenance ->> 'content_id' = $2
     order by a.created_at desc limit 1`,
    [dato('marcaA'), contenido],
  );
  expect(exportada?.backend).toBe('r2');
  expect(await objetoEnMinio(exportada!.ruta)).toBe(Number(exportada!.bytes));
  sinErrores(s);
  await s.context.close();
});

test('borrar la foto de la biblioteca la borra de R2', async ({ browser }) => {
  const [fila] = await sql<{ ruta: string }>(
    `select storage_path as ruta from public.media_assets where brand_id = $1 and file_name = $2`,
    [dato('marcaA'), FOTO],
  );
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/biblioteca`);
  await page.getByTestId('library-asset').filter({ hasText: FOTO }).click();
  await page.getByTestId('asset-delete').click();
  await page.getByTestId('confirm-action').click();
  await expect(page.getByTestId('library-asset').filter({ hasText: FOTO })).toHaveCount(0);
  await expect.poll(() => objetoEnMinio(fila!.ruta)).toBeNull();
  const [cola] = await sql<{ n: string }>(
    `select count(*)::text as n from public.storage_cleanup_queue where storage_path = $1`,
    [fila!.ruta],
  );
  expect(cola!.n).toBe('0');
  sinErrores(s);
  await s.context.close();
});
