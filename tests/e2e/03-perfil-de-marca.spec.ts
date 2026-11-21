import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  abrir,
  archivoPng,
  aviso,
  dato,
  DIR_ESTADO,
  guardarEstado,
  idDeUrl,
  MARCA_A,
  MARCA_A2,
  NOMBRES,
  png,
  sinErrores,
  sql,
} from './apoyo';

test.describe.configure({ mode: 'serial' });

const DESCRIPCION_V2 = 'Obrador de pan de masa madre, con reparto diario en el barrio y encargos para hostelería.';
const EXPORTADO = path.join(DIR_ESTADO, 'la-espiga.brand-config.json');
const IMPORTABLE = path.join(DIR_ESTADO, 'la-espiga-obrador.brand-config.json');

function rutaMarca(): string {
  return `/o/${dato('orgA')}/m/${dato('marcaA')}/marca`;
}

async function logosEnBd(nombre: string): Promise<{ filas: number; objetos: number; cola: number }> {
  const [fila] = await sql<{ filas: string; objetos: string; cola: string }>(
    `select (select count(*) from public.media_assets where brand_id = $1 and file_name = $2) as filas,
            (select count(*) from storage.objects where bucket_id = 'brand-media' and name like $3 and name like $4) as objetos,
            (select count(*) from public.storage_cleanup_queue where brand_id = $1) as cola`,
    [dato('marcaA'), nombre, `%${dato('marcaA')}%`, `%${nombre.replace(/\.png$/, '')}%`],
  );
  return { filas: Number(fila?.filas), objetos: Number(fila?.objetos), cola: Number(fila?.cola) };
}

test('editar el perfil crea una versión nueva y el historial la muestra', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(rutaMarca());
  await expect(page.getByText(new RegExp(`Perfil de ${MARCA_A} · versión 1 · \\d+% completo`))).toBeVisible();
  // Lo que se escribió en el asistente está en el perfil.
  await expect(page.getByTestId('profile-description')).toHaveValue(
    'Obrador de pan de masa madre con reparto en el barrio.',
  );
  await expect(page.getByTestId('profile-save-bar')).toHaveCount(0);

  await page.getByTestId('profile-description').fill(DESCRIPCION_V2);
  await expect(page.getByTestId('profile-save-bar')).toBeVisible();
  await page.getByTestId('profile-note').fill('Añadidos los encargos para hostelería');
  await page.getByTestId('profile-save').click();
  await aviso(page, 'Perfil guardado (versión 2)');
  await expect(page.getByText(new RegExp(`Perfil de ${MARCA_A} · versión 2`))).toBeVisible();
  await expect(page.getByTestId('profile-save-bar')).toHaveCount(0);

  await page.getByTestId('profile-history').click();
  const historial = page.getByTestId('history-list');
  await expect(historial.getByRole('listitem')).toHaveCount(2);
  const v2 = historial.getByRole('listitem').nth(0);
  await expect(v2).toContainText('Versión 2');
  await expect(v2).toContainText('Vigente');
  await expect(v2).toContainText('«Añadidos los encargos para hostelería»');
  await expect(v2).toContainText(NOMBRES.ana);
  const v1 = historial.getByRole('listitem').nth(1);
  await expect(v1).toContainText('Versión 1');
  await expect(v1).toContainText('«Alta de la marca»');

  // Ver la versión 1 y restaurarla crea la versión 3 con los datos antiguos.
  await v1.getByRole('button', { name: 'Ver' }).click();
  await expect(page.getByRole('dialog').getByTestId('profile-description')).toHaveValue(
    'Obrador de pan de masa madre con reparto en el barrio.',
  );
  await page.getByTestId('history-restore').click();
  await aviso(page, 'Perfil guardado (versión 3)');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('profile-description')).toHaveValue(
    'Obrador de pan de masa madre con reparto en el barrio.',
  );

  // Se deja la versión buena como vigente (versión 4) para los pasos siguientes.
  await page.getByTestId('profile-description').fill(DESCRIPCION_V2);
  await page.getByTestId('profile-save').click();
  await aviso(page, 'Perfil guardado (versión 4)');

  const versiones = await sql<{ version: number; status: string }>(
    'select version, status from public.brand_profiles where brand_id = $1 order by version',
    [dato('marcaA')],
  );
  expect(versiones.map((v) => `${v.version}:${v.status}`)).toEqual([
    '1:archived',
    '2:archived',
    '3:archived',
    '4:active',
  ]);

  sinErrores(s);
  await s.context.close();
});

test('exportar el perfil descarga un JSON con los datos de la marca', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(rutaMarca());
  await expect(page.getByTestId('profile-description')).toHaveValue(DESCRIPCION_V2);

  const descarga = page.waitForEvent('download');
  await page.getByTestId('profile-export').click();
  const archivo = await descarga;
  expect(archivo.suggestedFilename()).toBe('la-espiga.brand-config.json');
  await archivo.saveAs(EXPORTADO);

  const config = JSON.parse(readFileSync(EXPORTADO, 'utf8'));
  expect(config.format).toBe('rrss.brand-config');
  expect(config.version).toBe(1);
  expect(config.brand).toMatchObject({ name: MARCA_A, sector: 'Panadería artesana', default_locale: 'es' });
  expect(config.profile.business.description).toBe(DESCRIPCION_V2);
  expect(config.profile.business.products[0]).toMatchObject({ name: 'Hogaza de centeno' });
  expect(config.profile.goals).toEqual(['Conseguir más encargos']);
  expect(config.profile.voice.tone).toEqual(['Cercano']);
  // Los logotipos son archivos de la marca de origen y no viajan.
  expect(config.profile.visual.logoAssetIds).toEqual([]);

  // Para importarlo como marca nueva se le cambia solo el nombre.
  writeFileSync(IMPORTABLE, JSON.stringify({ ...config, brand: { ...config.brand, name: MARCA_A2 } }, null, 2));

  sinErrores(s);
  await s.context.close();
});

test('importar un JSON crea otra marca con esos datos; uno inválido se rechaza con explicación', async ({
  browser,
}) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`/o/${dato('orgA')}/marcas/nueva`);
  await expect(page.getByTestId('brand-wizard')).toBeVisible();

  await page.getByTestId('wizard-import-input').setInputFiles({
    name: 'otra-cosa.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'otra-cosa', version: 1 })),
  });
  await expect(page.getByTestId('wizard-import-errors')).toContainText('No es una configuración de marca');

  await page.getByTestId('wizard-import-input').setInputFiles(IMPORTABLE);
  await aviso(page, 'Configuración importada');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('7/7 Revisa y crea');
  const resumen = page.getByTestId('wizard-summary');
  await expect(resumen).toContainText(MARCA_A2);
  await expect(resumen).toContainText(DESCRIPCION_V2);
  await expect(resumen).toContainText('Cercano');

  await page.getByTestId('wizard-create').click();
  await aviso(page, 'Marca creada');
  await expect(page).toHaveURL(/\/m\/[0-9a-f-]{36}\/inicio$/);
  const marcaA2 = idDeUrl(page.url(), 'm');
  expect(marcaA2).not.toBe(dato('marcaA'));
  guardarEstado({ marcaA2 });

  await page.getByTestId('nav-marca').click();
  await expect(page.getByText(new RegExp(`Perfil de ${MARCA_A2} · versión 1`))).toBeVisible();
  await expect(page.getByTestId('profile-description')).toHaveValue(DESCRIPCION_V2);
  await page.getByTestId('profile-history').click();
  await expect(page.getByTestId('history-list')).toContainText('«Importada desde configuración»');

  sinErrores(s);
  await s.context.close();
});

test('un logotipo subido en el editor y no guardado no se queda en la biblioteca al salir', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${rutaMarca()}?seccion=visual`);
  // La marca tiene el logotipo que se subió en el asistente.
  await expect(page.getByTestId('logo-item')).toHaveCount(1);

  await page
    .getByTestId('logo-file-input')
    .setInputFiles(archivoPng('logo-descartado.png', png(48, 48, [20, 90, 160])));
  await expect(page.getByTestId('logo-item')).toHaveCount(2);
  await expect(page.getByTestId('profile-save-bar')).toBeVisible();
  // Mientras está en el borrador, el archivo existe de verdad.
  await expect.poll(() => logosEnBd('logo-descartado.png')).toMatchObject({ filas: 1, objetos: 1 });

  // Salir del editor sin guardar (navegación dentro de la aplicación).
  await page.getByTestId('nav-biblioteca').click();
  await expect(page.getByRole('heading', { name: 'Biblioteca' })).toBeVisible();
  await expect.poll(() => logosEnBd('logo-descartado.png')).toEqual({ filas: 0, objetos: 0, cola: 0 });
  await expect(page.getByTestId('library-grid')).toContainText('logo-espiga.png');
  await expect(page.getByTestId('library-grid')).not.toContainText('logo-descartado.png');

  sinErrores(s);
  await s.context.close();
});

test('un logotipo subido en el editor y guardado sí se conserva', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${rutaMarca()}?seccion=visual`);
  await expect(page.getByTestId('logo-item')).toHaveCount(1);
  await page
    .getByTestId('logo-file-input')
    .setInputFiles(archivoPng('logo-negativo.png', png(48, 48, [250, 250, 250])));
  await expect(page.getByTestId('logo-item')).toHaveCount(2);
  await page.getByTestId('profile-save').click();
  await aviso(page, 'Perfil guardado (versión 5)');

  await page.getByTestId('nav-biblioteca').click();
  await expect(page.getByTestId('library-grid')).toContainText('logo-negativo.png');
  // Se da margen a una limpieza indebida antes de mirar la base de datos.
  await page.waitForTimeout(1500);
  expect(await logosEnBd('logo-negativo.png')).toEqual({ filas: 1, objetos: 1, cola: 0 });

  await page.getByTestId('nav-marca').click();
  await page.getByRole('tab', { name: 'Identidad visual' }).click();
  await expect(page.getByTestId('logo-item')).toHaveCount(2);

  sinErrores(s);
  await s.context.close();
});
