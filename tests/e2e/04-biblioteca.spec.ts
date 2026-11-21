import { expect, test, type Page } from '@playwright/test';
import { abrir, archivoPng, aviso, dato, guardarEstado, png, proxyLento, sinErrores, sql } from './apoyo';

test.describe.configure({ mode: 'serial' });

const FOTO = png(200, 150, [200, 60, 60]);
// Píxeles pseudoaleatorios: no se comprime, así que pesa varios MB de verdad.
const FOTO_GRANDE = png(1700, 1700, [7, 77, 177], true);

function rutaBiblioteca(): string {
  return `/o/${dato('orgA')}/m/${dato('marcaA')}/biblioteca`;
}

function tarjeta(page: Page, nombre: string) {
  return page.getByTestId('library-asset').filter({ hasText: nombre });
}

async function rutaEnStorage(nombre: string): Promise<string> {
  const filas = await sql<{ storage_path: string }>(
    'select storage_path from public.media_assets where brand_id = $1 and file_name = $2',
    [dato('marcaA'), nombre],
  );
  expect(filas, `fila de ${nombre} en media_assets`).toHaveLength(1);
  return filas[0]!.storage_path;
}

/** Qué queda de un archivo: su fila, su objeto en Storage y su anotación en la cola de limpieza. */
async function rastro(ruta: string, nombre: string): Promise<{ fila: number; objeto: number; cola: number }> {
  const [r] = await sql<{ fila: string; objeto: string; cola: string }>(
    `select (select count(*) from public.media_assets where brand_id = $1 and file_name = $2) as fila,
            (select count(*) from storage.objects where bucket_id = 'brand-media' and name = $3) as objeto,
            (select count(*) from public.storage_cleanup_queue where storage_path = $3) as cola`,
    [dato('marcaA'), nombre, ruta],
  );
  return { fila: Number(r?.fila), objeto: Number(r?.objeto), cola: Number(r?.cola) };
}

test('subir un archivo, verlo en la rejilla y abrir el original', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(rutaBiblioteca());
  await expect(page.getByRole('heading', { name: 'Biblioteca' })).toBeVisible();
  // Los logotipos del perfil ya están en la biblioteca.
  await expect(tarjeta(page, 'logo-espiga.png')).toBeVisible();

  await page.getByTestId('library-upload-toggle').click();
  await page.getByTestId('library-file-input').setInputFiles(archivoPng('escaparate.png', FOTO));
  await expect(page.getByTestId('upload-item-done')).toContainText('escaparate.png');
  await expect(page.getByTestId('library-upload-list')).toContainText('Subida terminada');

  // Se ve en la rejilla, con su miniatura cargada desde el cubo privado (URL firmada).
  const miniatura = tarjeta(page, 'escaparate.png').locator('img');
  await expect(miniatura).toHaveJSProperty('naturalWidth', 200);

  // Un archivo idéntico se detecta antes de subirlo.
  await page.getByTestId('library-file-input').setInputFiles(archivoPng('copia-del-escaparate.png', FOTO));
  await expect(page.getByTestId('upload-item-duplicate')).toContainText('Es idéntico a «escaparate.png».');
  await page.getByRole('button', { name: 'Omitir' }).click();
  await expect(page.getByTestId('upload-item-skipped')).toContainText('copia-del-escaparate.png');
  await expect(tarjeta(page, 'copia-del-escaparate.png')).toHaveCount(0);

  // Ficha del archivo: dimensiones leídas en el navegador y original descargable.
  await tarjeta(page, 'escaparate.png').click();
  const ficha = page.getByRole('dialog');
  await expect(ficha).toContainText('200 × 150 px');
  const enlace = await ficha.getByRole('link', { name: 'Abrir el archivo original' }).getAttribute('href');
  const original = await s.context.request.get(enlace!);
  expect(original.status()).toBe(200);
  expect(original.headers()['content-type']).toBe('image/png');
  expect((await original.body()).equals(FOTO)).toBe(true);
  await ficha.getByRole('button', { name: 'Cancelar' }).click();

  guardarEstado({ rutaArchivoA: await rutaEnStorage('escaparate.png') });
  sinErrores(s);
  await s.context.close();
});

test('la subida muestra el porcentaje real y llega íntegra a Storage', async ({ browser }) => {
  // El tráfico con Supabase pasa por un proxy que lee despacio las subidas, para que dé tiempo a ver la barra.
  const proxy = await proxyLento();
  const s = await abrir(browser, 'ana', { proxy: proxy.url });
  const { page } = s;
  await page.goto(rutaBiblioteca());
  await page.getByTestId('library-upload-toggle').click();

  const peticion = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().includes('/storage/v1/object/brand-media/'),
  );
  await page.getByTestId('library-file-input').setInputFiles(archivoPng('foto-grande.png', FOTO_GRANDE));

  const vistos: number[] = [];
  const barra = page.getByTestId('upload-progress');
  const tope = Date.now() + 90_000;
  while ((await page.getByTestId('upload-item-done').count()) === 0 && Date.now() < tope) {
    const valor = await barra.getAttribute('aria-valuenow', { timeout: 250 }).catch(() => null);
    if (valor !== null) vistos.push(Number(valor));
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId('upload-item-done')).toContainText('foto-grande.png');

  const intermedios = [...new Set(vistos)].filter((v) => v > 0 && v < 100);
  expect(intermedios.length, `porcentajes vistos: ${[...new Set(vistos)].join(', ')}`).toBeGreaterThanOrEqual(2);
  expect(vistos, 'el porcentaje nunca retrocede').toEqual([...vistos].sort((a, b) => a - b));

  // Todo el archivo ha pasado por el enlace lento: el progreso medido es el de la subida de verdad.
  expect(proxy.bytesSubidos()).toBe(FOTO_GRANDE.length);

  // La petición es la de la API REST de Storage: cuerpo binario, con su tipo y sin sobrescribir.
  const cabeceras = await (await peticion).allHeaders();
  expect(cabeceras['content-type']).toBe('image/png');
  expect(cabeceras['x-upsert']).toBe('false');
  expect(cabeceras['content-length']).toBe(String(FOTO_GRANDE.length));
  expect(cabeceras['authorization']).toMatch(/^Bearer ey/);
  expect(cabeceras['apikey']).toBeTruthy();

  // En Storage está el archivo completo y con su tipo.
  const ruta = await rutaEnStorage('foto-grande.png');
  const [objeto] = await sql<{ size: string; mimetype: string }>(
    `select metadata->>'size' as size, metadata->>'mimetype' as mimetype
       from storage.objects where bucket_id = 'brand-media' and name = $1`,
    [ruta],
  );
  expect(objeto).toEqual({ size: String(FOTO_GRANDE.length), mimetype: 'image/png' });

  // Y lo que se descarga es, byte a byte, lo que se subió.
  await tarjeta(page, 'foto-grande.png').click();
  const ficha = page.getByRole('dialog');
  await expect(ficha).toContainText('1700 × 1700 px');
  const enlace = await ficha.getByRole('link', { name: 'Abrir el archivo original' }).getAttribute('href');
  // Con `fetch` de Node y no con el navegador: la URL firmada no necesita sesión (ni pasar por el proxy).
  const descargado = Buffer.from(await (await fetch(enlace!)).arrayBuffer());
  expect(descargado.equals(FOTO_GRANDE)).toBe(true);

  sinErrores(s);
  await s.context.close();
  await proxy.cerrar();
});

test('los filtros de etiqueta y carpeta salen de asset_facets', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  const primeras = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/asset_facets'));
  await page.goto(rutaBiblioteca());
  // Sin etiquetas ni carpetas, la función devuelve listas vacías y los filtros están apagados.
  expect(await (await primeras).json()).toEqual([{ tags: [], folders: [] }]);
  await expect(page.getByLabel('Filtrar por etiqueta')).toBeDisabled();
  await expect(page.getByLabel('Filtrar por carpeta')).toBeDisabled();

  await tarjeta(page, 'escaparate.png').click();
  const ficha = page.getByRole('dialog');
  await ficha.getByLabel('Carpeta').fill('Campaña otoño');
  await ficha.getByTestId('asset-tag-input').fill('Escaparate');
  await ficha.getByTestId('asset-tag-input').press('Enter');
  const nuevas = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/asset_facets'));
  await ficha.getByTestId('asset-save').click();
  await aviso(page, 'Cambios guardados');
  expect(await (await nuevas).json()).toEqual([{ tags: ['escaparate'], folders: ['Campaña otoño'] }]);

  const porEtiqueta = page.getByLabel('Filtrar por etiqueta');
  await expect(porEtiqueta).toBeEnabled();
  await expect(porEtiqueta.locator('option')).toHaveText(['Todas las etiquetas', 'escaparate']);
  await porEtiqueta.selectOption('escaparate');
  await expect(page.getByTestId('library-asset')).toHaveCount(1);
  await expect(tarjeta(page, 'escaparate.png')).toBeVisible();
  await porEtiqueta.selectOption('');

  const porCarpeta = page.getByLabel('Filtrar por carpeta');
  await expect(porCarpeta.locator('option')).toHaveText(['Todas las carpetas', 'Campaña otoño']);
  await porCarpeta.selectOption('Campaña otoño');
  await expect(page.getByTestId('library-asset')).toHaveCount(1);
  await porCarpeta.selectOption('');

  await page.getByTestId('library-search').fill('grande');
  await expect(page.getByTestId('library-asset')).toHaveCount(1);
  await expect(tarjeta(page, 'foto-grande.png')).toBeVisible();
  await page.getByTestId('library-search').fill('no-existe');
  await expect(page.getByText('Nada coincide con los filtros')).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('borrar un recurso quita la fila, el archivo de Storage y la anotación de limpieza', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(rutaBiblioteca());
  const ruta = await rutaEnStorage('foto-grande.png');
  expect(await rastro(ruta, 'foto-grande.png')).toEqual({ fila: 1, objeto: 1, cola: 0 });

  await tarjeta(page, 'foto-grande.png').click();
  const ficha = page.getByRole('dialog');
  const enlace = await ficha.getByRole('link', { name: 'Abrir el archivo original' }).getAttribute('href');
  await page.getByTestId('asset-delete').click();
  await expect(page.getByText('«foto-grande.png» se borrará de la biblioteca de forma definitiva.')).toBeVisible();
  await page.getByTestId('confirm-action').click();
  await aviso(page, 'Archivo eliminado');
  await expect(tarjeta(page, 'foto-grande.png')).toHaveCount(0);

  await expect.poll(() => rastro(ruta, 'foto-grande.png')).toEqual({ fila: 0, objeto: 0, cola: 0 });
  // La URL firmada que servía el original deja de funcionar: el archivo ya no existe.
  expect((await s.context.request.get(enlace!)).status()).toBeGreaterThanOrEqual(400);

  sinErrores(s);
  await s.context.close();
});

test('si el archivo no se puede borrar, queda anotado y se limpia en la siguiente visita', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(rutaBiblioteca());
  await page.getByTestId('library-upload-toggle').click();
  await page.getByTestId('library-file-input').setInputFiles(archivoPng('temporal.png', png(90, 90, [10, 150, 90])));
  await expect(page.getByTestId('upload-item-done')).toContainText('temporal.png');
  const ruta = await rutaEnStorage('temporal.png');

  // Se simula un corte de red justo en el borrado del archivo (no en el de la fila).
  await page.route('**/storage/v1/object/brand-media', (peticion) =>
    peticion.request().method() === 'DELETE' ? peticion.abort() : peticion.continue(),
  );
  await tarjeta(page, 'temporal.png').click();
  await page.getByTestId('asset-delete').click();
  await page.getByTestId('confirm-action').click();
  // Para quien borra no es un error: el recurso ya no existe en la biblioteca.
  await aviso(page, 'Archivo eliminado');
  await expect(tarjeta(page, 'temporal.png')).toHaveCount(0);
  await expect.poll(() => rastro(ruta, 'temporal.png')).toEqual({ fila: 0, objeto: 1, cola: 1 });

  // Con la red de vuelta, al volver a abrir la biblioteca se reintenta y no queda nada.
  await page.unroute('**/storage/v1/object/brand-media');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Biblioteca' })).toBeVisible();
  await expect.poll(() => rastro(ruta, 'temporal.png')).toEqual({ fila: 0, objeto: 0, cola: 0 });

  sinErrores(s, [/net::ERR_FAILED/]);
  await s.context.close();
});
