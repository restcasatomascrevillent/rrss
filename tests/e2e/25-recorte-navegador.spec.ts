import { expect, test, type Page } from '@playwright/test';
import { abrir, archivoPng, dato, png, sinErrores, sql } from './apoyo';

// Quitar el fondo EN EL NAVEGADOR, de punta a punta (docs/edicion-fotos.md, §7):
// una foto de la biblioteca, «Editar foto» → Fondo → «Quitar el fondo» (sin IA,
// sin proveedor), un color liso con sombra, y comprobar que el resultado es un
// recurso NUEVO con procedencia `photo_edit` y que la foto original sigue igual
// (fila y archivo).
//
// El modelo real (≈ 85 MB) no se descarga en las pruebas: el servidor de Vite de
// playwright.config.ts arranca con VITE_CUTOUT_SIMULATED=true, y entonces lo
// único simulado es lo que devuelve el worker (una máscara elíptica). Todo lo
// demás es de verdad: preproceso, aplicar el alfa, composición con sombra,
// codificación PNG y subida al almacenamiento.
//
// Parte de lo que dejó 09: Ana (organización A, marca La Espiga).

test.describe.configure({ mode: 'serial' });

const marcaA = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
const FOTO = png(640, 480, [90, 160, 110]);
const NOMBRE = 'tarta-para-recortar.png';

function tarjeta(page: Page, nombre: string) {
  return page.getByTestId('library-asset').filter({ hasText: nombre });
}

test.beforeAll(async () => {
  // Al relanzar solo este archivo, la foto de la pasada anterior se tomaría por un duplicado.
  await sql(`delete from public.media_assets where brand_id = $1 and file_name in ($2, $3)`, [
    dato('marcaA'),
    NOMBRE,
    'Fondo nuevo · tarta-para-recortar.png',
  ]);
});

interface Fila extends Record<string, unknown> {
  id: string;
  storage_path: string;
  provenance: Record<string, unknown>;
}

test('quitar el fondo en el navegador crea un recurso nuevo y la foto original no cambia', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marcaA()}/biblioteca`);
  await page.getByTestId('library-upload-toggle').click();
  await page.getByTestId('library-file-input').setInputFiles(archivoPng(NOMBRE, FOTO));
  await expect(page.getByTestId('upload-item-done')).toContainText(NOMBRE);
  await expect(tarjeta(page, NOMBRE)).toBeVisible();

  const [original] = await sql<Fila>(`select * from public.media_assets where brand_id = $1 and file_name = $2`, [
    dato('marcaA'),
    NOMBRE,
  ]);
  expect(original).toBeTruthy();
  const [archivoAntes] = await sql(
    `select metadata->>'size' as size, metadata->>'eTag' as etag, updated_at
       from storage.objects where bucket_id = 'brand-media' and name = $1`,
    [original!.storage_path],
  );

  await tarjeta(page, NOMBRE).click();
  await page.getByTestId('asset-edit-photo').click();
  const editor = page.getByTestId('photo-edit');
  await expect(editor.getByTestId('photo-edit-preview')).toBeVisible();
  await editor.getByRole('tab', { name: 'Fondo', exact: true }).click();

  // Quitar el fondo: sin IA ni coste; la opción del navegador es la de siempre.
  await editor.getByTestId('photo-edit-cutout-run').click();
  await expect(editor.getByTestId('photo-edit-backgrounds')).toBeVisible();
  await expect(editor.getByTestId('photo-edit-cutout-preview')).toBeVisible();

  // Todavía no se ha guardado nada: solo la foto original.
  const antes = await sql(`select id from public.media_assets where provenance->>'source_asset_id' = $1`, [
    original!.id,
  ]);
  expect(antes).toHaveLength(0);

  // Fondo liso con sombra suave.
  await editor.getByTestId('photo-edit-shadow').check();
  await editor.getByTestId('photo-edit-color').fill('#336699');
  await editor.getByTestId('photo-edit-color-apply').click();
  await expect(editor.getByTestId('photo-edit-result')).toContainText(`Fondo nuevo · ${NOMBRE}`);

  const ediciones = await sql<Fila>(
    `select * from public.media_assets where provenance->>'source_asset_id' = $1 order by created_at`,
    [original!.id],
  );
  expect(ediciones).toHaveLength(1);
  expect(ediciones[0]!.id).not.toBe(original!.id);
  expect(ediciones[0]!.storage_path).not.toBe(original!.storage_path);
  expect(ediciones[0]).toMatchObject({
    folder: 'Ediciones',
    mime_type: 'image/png',
    provenance: {
      type: 'photo_edit',
      source_asset_id: original!.id,
      steps: [
        { kind: 'remove_background', engine: 'browser', model: 'isnet-general-use' },
        { kind: 'background', color: '#336699', shadow: true },
      ],
    },
  });

  // La foto original, exactamente igual: misma fila y mismo archivo.
  const [despues] = await sql<Fila>(`select * from public.media_assets where id = $1`, [original!.id]);
  expect(despues).toEqual(original);
  const [archivoDespues] = await sql(
    `select metadata->>'size' as size, metadata->>'eTag' as etag, updated_at
       from storage.objects where bucket_id = 'brand-media' and name = $1`,
    [original!.storage_path],
  );
  expect(archivoDespues).toEqual(archivoAntes);

  sinErrores(s);
});
