import { expect, test, type Page } from '@playwright/test';
import { abrir, archivoPng, dato, png, sinErrores, sql } from './apoyo';

// Edición de fotos con IA de punta a punta (docs/edicion-fotos.md): quitar el
// fondo a una foto de la biblioteca con la edición SIMULADA de pruebas locales
// (`simulated-image-edit`, supabase/functions/_shared/ai/media/local-test.ts,
// que se carga con AI_E2E_SIMULATED_PROVIDER=true de supabase/functions/e2e.env)
// y comprobar que el resultado es un recurso NUEVO y que la foto original
// sigue exactamente igual (fila y archivo).
//
// Parte de lo que dejó 09: Ana (organización A, marca La Espiga) con cupo de IA.
// Necesita `VITE_AI_PHOTO_EDIT_ENABLED=true` en el servidor de Vite de
// playwright.config.ts (ya está).
//

test.describe.configure({ mode: 'serial' });

const marcaA = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
/** Precio inventado de la edición simulada (LOCAL_TEST_EDIT_PRICE_MICROS): 0,01 créditos. */
const COSTE = '0,01 créditos';
const FOTO = png(640, 480, [180, 120, 60]);

/** La tarjeta de un recurso en la cuadrícula de la biblioteca. */
function tarjeta(page: Page, nombre: string) {
  return page.getByTestId('library-asset').filter({ hasText: nombre });
}

test.beforeAll(async () => {
  // Al relanzar solo este archivo (E2E_CONTINUAR=1), la foto de la pasada anterior
  // haría que la subida se tomara por un duplicado: se quitan sus filas y las ediciones.
  await sql(`delete from public.media_assets where brand_id = $1 and file_name in ($2, $3)`, [
    dato('marcaA'),
    'pan-para-recortar.png',
    'Sin fondo · pan-para-recortar.png',
  ]);
});

interface Fila extends Record<string, unknown> {
  id: string;
  storage_path: string;
  provenance: Record<string, unknown>;
}

test('quitar el fondo con IA crea un recurso nuevo y la foto original no cambia', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marcaA()}/biblioteca`);
  await page.getByTestId('library-upload-toggle').click();
  await page.getByTestId('library-file-input').setInputFiles(archivoPng('pan-para-recortar.png', FOTO));
  await expect(page.getByTestId('upload-item-done')).toContainText('pan-para-recortar.png');
  await expect(tarjeta(page, 'pan-para-recortar.png')).toBeVisible();

  const [original] = await sql<Fila>(
    `select * from public.media_assets where brand_id = $1 and file_name = 'pan-para-recortar.png'`,
    [dato('marcaA')],
  );
  expect(original).toBeTruthy();
  const [archivoAntes] = await sql(
    `select metadata->>'size' as size, metadata->>'eTag' as etag, updated_at
       from storage.objects where bucket_id = 'brand-media' and name = $1`,
    [original!.storage_path],
  );

  // Ficha → Editar foto → Fondo: el coste se ve antes, sin reservar nada.
  await tarjeta(page, 'pan-para-recortar.png').click();
  await page.getByTestId('asset-edit-photo').click();
  const editor = page.getByTestId('photo-edit');
  await expect(editor.getByTestId('photo-edit-preview')).toBeVisible();
  await editor.getByRole('tab', { name: 'Fondo', exact: true }).click();
  // Con IA y navegador, está marcado el navegador (docs/edicion-fotos.md §1): se elige la IA.
  await editor.getByTestId('photo-edit-engine-ai').check();
  const quitar = editor.getByTestId('photo-edit-ai-remove_background');
  await expect(quitar.getByTestId('photo-edit-ai-cost')).toContainText(`Coste máximo: ${COSTE}`);
  const generacionesAntes = await sql(`select id from public.ai_generations where purpose = 'photo.remove_background'`);

  await quitar.getByTestId('photo-edit-ai-run-remove_background').click();
  await expect(editor.getByTestId('photo-edit-result')).toContainText('Sin fondo · pan-para-recortar.png');
  // Pasa a editar la foto sin fondo: ya se le puede poner otro sin IA.
  await expect(editor.getByTestId('photo-edit-backgrounds')).toBeVisible();

  // Un recurso nuevo, con su procedencia y en «Ediciones».
  const ediciones = await sql<Fila>(
    `select * from public.media_assets where provenance->>'source_asset_id' = $1 order by created_at`,
    [original!.id],
  );
  expect(ediciones).toHaveLength(1);
  expect(ediciones[0]!.id).not.toBe(original!.id);
  expect(ediciones[0]!.storage_path).not.toBe(original!.storage_path);
  expect(ediciones[0]).toMatchObject({
    origin: 'generated',
    folder: 'Ediciones',
    mime_type: 'image/png',
    provenance: {
      type: 'ai_edit',
      operation: 'remove_background',
      source_asset_id: original!.id,
      provider: 'simulated-image-edit',
      untested_adapter: true,
    },
  });
  const generaciones = await sql(
    `select status::text as status, cost_micros::bigint as cost from public.ai_generations
      where purpose = 'photo.remove_background'`,
  );
  expect(generaciones).toHaveLength(generacionesAntes.length + 1);

  // La foto original, exactamente igual: misma fila y mismo archivo.
  const [despues] = await sql<Fila>(`select * from public.media_assets where id = $1`, [original!.id]);
  expect(despues).toEqual(original);
  const [archivoDespues] = await sql(
    `select metadata->>'size' as size, metadata->>'eTag' as etag, updated_at
       from storage.objects where bucket_id = 'brand-media' and name = $1`,
    [original!.storage_path],
  );
  expect(archivoDespues).toEqual(archivoAntes);

  // Y en la biblioteca se ven las dos.
  // Cierra «Editar foto» y la ficha.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tarjeta(page, 'Sin fondo · pan-para-recortar.png')).toBeVisible();
  await expect(page.getByTestId('library-asset').filter({ hasText: /^pan-para-recortar\.png/ })).toBeVisible();
  sinErrores(s);
});
