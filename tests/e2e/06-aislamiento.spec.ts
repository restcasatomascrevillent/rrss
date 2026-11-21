import { expect, test } from '@playwright/test';
import { abrir, dato, LOCAL, MARCA_A, MARCA_B, ORG_A, ORG_B, sinErrores, sql } from './apoyo';

test.describe.configure({ mode: 'serial' });

const SIN_ACCESO = 'No tienes acceso a esta organización';

test('Bruno (organización B) no ve nada de la organización A en la interfaz ni por URL', async ({ browser }) => {
  const s = await abrir(browser, 'bruno');
  const { page } = s;
  const orgA = dato('orgA');
  const marcaA = dato('marcaA');

  // En su interfaz solo existen su organización y su marca.
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`/o/${dato('orgB')}`));
  await page.getByTestId('org-switcher').first().click();
  await expect(page.getByRole('menuitem').filter({ hasText: ORG_B })).toBeVisible();
  await expect(page.getByRole('menuitem').filter({ hasText: ORG_A })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('brand-switcher').first().click();
  await expect(page.getByRole('menuitem').filter({ hasText: MARCA_B })).toBeVisible();
  await expect(page.getByRole('menuitem').filter({ hasText: MARCA_A })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Por URL directa, cualquier pantalla de la organización A le dice que no tiene acceso.
  const rutas = [
    `/o/${orgA}`,
    `/o/${orgA}/marcas/nueva`,
    `/o/${orgA}/ajustes/general`,
    `/o/${orgA}/ajustes/equipo`,
    `/o/${orgA}/ajustes/actividad`,
    `/o/${orgA}/m/${marcaA}/inicio`,
    `/o/${orgA}/m/${marcaA}/biblioteca`,
    `/o/${orgA}/m/${marcaA}/marca`,
    `/o/${orgA}/m/${marcaA}/equipo`,
  ];
  for (const ruta of rutas) {
    await page.goto(ruta);
    await expect(page.getByText(SIN_ACCESO), ruta).toBeVisible();
    await expect(page.getByText(ORG_A), ruta).toHaveCount(0);
    await expect(page.getByText('escaparate.png'), ruta).toHaveCount(0);
  }

  // Tampoco colando la marca ajena dentro de su propia organización.
  await page.goto(`/o/${dato('orgB')}/m/${marcaA}/biblioteca`);
  await expect(page.getByText('No encontramos esta marca')).toBeVisible();

  sinErrores(s);
  await s.context.close();
});

test('con la sesión de Bruno, la API tampoco entrega ni deja tocar datos de la organización A', async ({ browser }) => {
  const s = await abrir(browser, 'bruno');
  const { page } = s;
  await page.goto('/');
  await expect(page.getByTestId('org-switcher').first()).toBeVisible();

  // La clave anónima del stack local (pública), la misma que recibe la aplicación (playwright.config.ts).
  const anon = process.env.E2E_SUPABASE_ANON_KEY ?? '';
  expect(anon, 'clave anónima del stack local').not.toBe('');
  const datos = { api: LOCAL.api, anon, orgA: dato('orgA'), marcaA: dato('marcaA'), ruta: dato('rutaArchivoA') };

  // Las mismas llamadas que haría la aplicación, hechas desde su navegador con su sesión.
  const r = (await page.evaluate(`(async () => {
    const d = ${JSON.stringify(datos)};
    const clave = Object.keys(localStorage).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
    const token = JSON.parse(localStorage.getItem(clave)).access_token;
    const cabeceras = { apikey: d.anon, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const leer = async (ruta) => {
      const res = await fetch(d.api + '/rest/v1/' + ruta, { headers: cabeceras });
      return { estado: res.status, filas: await res.json() };
    };
    const escribir = async (metodo, ruta, cuerpo) => {
      const res = await fetch(d.api + '/rest/v1/' + ruta, {
        method: metodo,
        headers: { ...cabeceras, Prefer: 'return=representation' },
        body: JSON.stringify(cuerpo),
      });
      return { estado: res.status, cuerpo: await res.json().catch(() => null) };
    };
    const firma = await fetch(d.api + '/storage/v1/object/sign/brand-media/' + d.ruta, {
      method: 'POST', headers: cabeceras, body: JSON.stringify({ expiresIn: 60 }),
    });
    const descarga = await fetch(d.api + '/storage/v1/object/authenticated/brand-media/' + d.ruta, { headers: cabeceras });
    return {
      misOrganizaciones: await leer('organizations?select=id'),
      organizacion: await leer('organizations?id=eq.' + d.orgA),
      marcas: await leer('brands?organization_id=eq.' + d.orgA),
      perfiles: await leer('brand_profiles?brand_id=eq.' + d.marcaA),
      recursos: await leer('media_assets?brand_id=eq.' + d.marcaA),
      fuentes: await leer('brand_knowledge_sources?brand_id=eq.' + d.marcaA),
      miembros: await leer('organization_members?organization_id=eq.' + d.orgA),
      invitaciones: await leer('invitations?organization_id=eq.' + d.orgA),
      actividad: await leer('audit_logs?organization_id=eq.' + d.orgA),
      cola: await leer('storage_cleanup_queue?organization_id=eq.' + d.orgA),
      facetas: await escribir('POST', 'rpc/asset_facets', { p_brand_id: d.marcaA }),
      renombrar: await escribir('PATCH', 'brands?id=eq.' + d.marcaA, { name: 'Secuestrada' }),
      colarRecurso: await escribir('POST', 'media_assets', {
        brand_id: d.marcaA, organization_id: d.orgA, kind: 'image', storage_path: d.orgA + '/' + d.marcaA + '/media/intruso.png',
        file_name: 'intruso.png', mime_type: 'image/png', bytes: 10, sha256: 'x'.repeat(64),
      }),
      colarseDeMiembro: await escribir('POST', 'organization_members', { organization_id: d.orgA, user_id: JSON.parse(localStorage.getItem(clave)).user.id, role: 'owner' }),
      firma: firma.status,
      descarga: descarga.status,
    };
  })()`)) as Record<string, { estado: number; filas?: unknown; cuerpo?: unknown }> & {
    firma: number;
    descarga: number;
  };

  // Control: su sesión funciona y ve exactamente una organización, la suya.
  expect(r.misOrganizaciones).toEqual({ estado: 200, filas: [{ id: dato('orgB') }] });

  for (const tabla of [
    'organizacion',
    'marcas',
    'perfiles',
    'recursos',
    'fuentes',
    'miembros',
    'invitaciones',
    'actividad',
    'cola',
  ]) {
    expect(r[tabla], tabla).toEqual({ estado: 200, filas: [] });
  }
  expect(r.facetas).toEqual({ estado: 200, cuerpo: [{ tags: [], folders: [] }] });
  // Escribir: la actualización no toca ninguna fila y las altas se rechazan.
  expect(r.renombrar).toEqual({ estado: 200, cuerpo: [] });
  expect(r.colarRecurso!.estado).toBe(403);
  expect(r.colarseDeMiembro!.estado).toBe(403);
  // El archivo del cubo privado no se puede firmar ni descargar.
  expect(r.firma).toBeGreaterThanOrEqual(400);
  expect(r.descarga).toBeGreaterThanOrEqual(400);

  // Y en la base de datos nada ha cambiado.
  const [marca] = await sql<{ name: string }>('select name from public.brands where id = $1', [dato('marcaA')]);
  expect(marca?.name).toBe(MARCA_A);

  sinErrores(s, [/status of 40\d/]);
  await s.context.close();
});

test('Ana (organización A) tampoco puede abrir la organización B', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  for (const ruta of [`/o/${dato('orgB')}`, `/o/${dato('orgB')}/m/${dato('marcaB')}/biblioteca`]) {
    await page.goto(ruta);
    await expect(page.getByText(SIN_ACCESO), ruta).toBeVisible();
    await expect(page.getByText(MARCA_B), ruta).toHaveCount(0);
  }
  await page.goto(`/o/${dato('orgA')}/m/${dato('marcaB')}/marca`);
  await expect(page.getByText('No encontramos esta marca')).toBeVisible();
  sinErrores(s);
  await s.context.close();
});
