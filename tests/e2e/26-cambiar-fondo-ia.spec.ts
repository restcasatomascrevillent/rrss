import { expect, test } from '@playwright/test';
import { abrir, archivoPng, dato, png, sinErrores, sql } from './apoyo';

// Cambiar el fondo con IA de punta a punta (docs/edicion-fotos.md): con la
// edición SIMULADA de pruebas locales (`simulated-image-edit`, que se carga con
// AI_E2E_SIMULATED_PROVIDER=true). No usa OpenAI: comprueba la interfaz, el
// encargo, que el plato se recorta en el navegador (recorte simulado del worker,
// VITE_CUTOUT_SIMULATED) y se manda como máscara, que el plato original se vuelve
// a pegar (casilla «Proteger el plato original»), que el resultado es UN recurso
// NUEVO con procedencia `photo_edit` + paso `ai_background` con `plate_protected`
// (la versión sin proteger del servidor se retira) y que la foto original no cambia.
// Parte de lo que dejó 09 (Ana, organización A, marca La Espiga, con cupo de IA).

test.describe.configure({ mode: 'serial' });

const marcaA = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
const FOTO = png(640, 480, [200, 140, 70]);

test.beforeAll(async () => {
  await sql(`delete from public.media_assets where brand_id = $1 and file_name in ($2, $3)`, [
    dato('marcaA'),
    'plato-cocina.png',
    'Fondo nuevo · plato-cocina.png',
  ]);
});

test('cambiar el fondo con IA crea un recurso nuevo con el encargo y no toca el plato original', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marcaA()}/biblioteca`);
  await page.getByTestId('library-upload-toggle').click();
  await page.getByTestId('library-file-input').setInputFiles(archivoPng('plato-cocina.png', FOTO));
  await expect(page.getByTestId('upload-item-done')).toContainText('plato-cocina.png');

  const [original] = await sql<{ id: string; storage_path: string }>(
    `select * from public.media_assets where brand_id = $1 and file_name = 'plato-cocina.png'`,
    [dato('marcaA')],
  );
  expect(original).toBeTruthy();

  await page.getByTestId('library-asset').filter({ hasText: 'plato-cocina.png' }).click();
  await page.getByTestId('asset-edit-photo').click();
  const editor = page.getByTestId('photo-edit');
  await expect(editor.getByTestId('photo-edit-preview')).toBeVisible();
  await editor.getByRole('tab', { name: 'Fondo con IA' }).click();
  const ia = editor.getByTestId('photo-edit-ai-replace_background');
  // Con recorte en el navegador: ofrece proteger el plato (marcado); sin texto: no se puede lanzar; el coste se ve antes.
  await expect(ia.getByText(/No hay recorte del plato/)).toHaveCount(0);
  await expect(ia.getByTestId('photo-edit-ai-protect')).toBeChecked();
  await expect(ia.getByTestId('photo-edit-ai-run-replace_background')).toBeDisabled();
  await expect(ia.getByTestId('photo-edit-ai-cost')).toContainText('Coste máximo');
  await ia.getByRole('button', { name: 'mesa de mármol blanco con luz cálida' }).click();
  await ia.getByTestId('photo-edit-ai-run-replace_background').click();
  await expect(editor.getByTestId('photo-edit-result').first()).toContainText('Fondo nuevo · plato-cocina.png');

  const ediciones = await sql<{ provenance: Record<string, unknown>; storage_path: string }>(
    `select * from public.media_assets where provenance->>'source_asset_id' = $1`,
    [original!.id],
  );
  expect(ediciones).toHaveLength(1);
  expect(ediciones[0]!.storage_path).not.toBe(original!.storage_path);
  expect(ediciones[0]!.provenance).toMatchObject({
    type: 'photo_edit',
    source_asset_id: original!.id,
    steps: [
      {
        kind: 'ai_background',
        operation: 'replace_background',
        prompt: 'mesa de mármol blanco con luz cálida',
        plate_protected: true,
      },
    ],
  });
  const [despues] = await sql(`select * from public.media_assets where id = $1`, [original!.id]);
  expect(despues).toEqual(original);
  sinErrores(s);
});
