import { expect, test, type Page } from '@playwright/test';
import { abrir, aviso, dato, guardarEstado, ORG_B, sinErrores, sql, type Alias, accionDelMenu } from './apoyo';

// Aceptación de la Fase 2 (docs/04-plan-por-fases.md) contra el Supabase local,
// con la función `ai-generate` servida en local y el proveedor SIMULADO de
// pruebas locales (supabase/functions/_shared/ai/text/local-test.ts): sus
// respuestas se construyen de forma determinista a partir del perfil de cada
// marca y del encargo, así se puede comprobar que lo generado respeta el perfil.
//
// Parte de lo que dejaron los archivos anteriores: Ana es propietaria de la
// organización A (marca La Espiga) y superadministradora; Bruno, de la B
// (marca Café Lumen).

test.describe.configure({ mode: 'serial' });

/** Perfiles distintos a propósito: trato, mensaje, veto, hashtag y llamada a la acción. */
const PERFIL = {
  A: {
    tono: 'Formal, de usted',
    mensaje: 'Pan de masa madre recién hecho cada mañana',
    vetada: 'barato',
    hashtag: 'LaEspiga',
    cta: 'Reserve su hogaza',
    arranque: 'Le presentamos',
  },
  B: {
    tono: 'Cercano y alegre',
    mensaje: 'Café de especialidad tostado en casa',
    vetada: 'oferta',
    hashtag: 'CafeLumen',
    cta: 'Pásate a probarlo',
    arranque: 'Te presentamos',
  },
} as const;

const marca = (lado: 'A' | 'B') =>
  `/o/${dato(lado === 'A' ? 'orgA' : 'orgB')}/m/${dato(lado === 'A' ? 'marcaA' : 'marcaB')}`;
const org = (lado: 'A' | 'B') => dato(lado === 'A' ? 'orgA' : 'orgB');

/** Errores de red esperados: las respuestas 402 de la función cuando no hay cupo. */
const ERRORES_DE_CUPO = [/status of 402/];

/** Como `formatMicros` de la aplicación, sin moneda fijada. */
const importe = (micros: number) =>
  `${new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(micros / 1_000_000)} créditos`;

async function generaciones(lado: 'A' | 'B'): Promise<number> {
  const [fila] = await sql<{ n: string }>(
    'select count(*) as n from public.ai_generations where organization_id = $1',
    [org(lado)],
  );
  return Number(fila?.n ?? 0);
}

async function rellenarPerfil(page: Page, lado: 'A' | 'B') {
  const p = PERFIL[lado];
  await page.goto(`${marca(lado)}/marca?seccion=voz`);
  await page.getByTestId('profile-tone').fill(p.tono);
  await page.getByTestId('profile-tone').press('Enter');
  await page.getByRole('textbox', { name: 'Mensajes clave' }).fill(p.mensaje);
  await page.getByRole('textbox', { name: 'Mensajes clave' }).press('Enter');
  await page.getByRole('textbox', { name: 'Expresiones prohibidas' }).fill(p.vetada);
  await page.getByRole('textbox', { name: 'Expresiones prohibidas' }).press('Enter');
  await page.getByTestId('profile-hashtags-required').fill(`#${p.hashtag}`);
  await page.getByTestId('profile-hashtags-required').press('Enter');
  await page.getByTestId('profile-ctas').fill(p.cta);
  await page.getByTestId('profile-ctas').press('Enter');
  await page.getByTestId('profile-note').fill('Reglas de voz para la IA');
  await page.getByTestId('profile-save').click();
  await aviso(page, /Perfil guardado \(versión \d+\)/);
}

/** Crea una pieza de Instagram y deja abierto su editor. Devuelve su id. */
async function nuevaPieza(page: Page, lado: 'A' | 'B', titulo: string): Promise<string> {
  await page.goto(`${marca(lado)}/contenidos`);
  await page.getByTestId('content-new').click();
  await page.getByTestId('create-content-title').fill(titulo);
  await page.getByTestId('create-content-network').selectOption('instagram');
  await page.getByTestId('create-content-format').selectOption('post');
  await page.getByTestId('create-content-submit').click();
  await expect(page.getByTestId('editor-title')).toHaveText(titulo);
  const id = /\/contenidos\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (!id) throw new Error(`No se ve el id de la pieza en ${page.url()}`);
  return id;
}

/** Abre «Redactar con IA», escribe el encargo y pide variantes. */
async function pedirTexto(page: Page, encargo: string, variantes = 2) {
  await page.getByRole('tab', { name: 'Publicación' }).click();
  await page.getByTestId('ai-caption-open').click();
  const ventana = page.getByRole('dialog');
  await ventana.getByTestId('ai-caption-brief').fill(encargo);
  await ventana.getByTestId('ai-caption-variants').selectOption(String(variantes));
  await ventana.getByTestId('ai-caption-generate').click();
  return ventana;
}

test('cada marca tiene su perfil de voz: trato, mensaje, veto, hashtag y llamada a la acción', async ({ browser }) => {
  for (const [alias, lado] of [
    ['ana', 'A'],
    ['bruno', 'B'],
  ] as const satisfies readonly (readonly [Alias, 'A' | 'B'])[]) {
    const s = await abrir(browser, alias);
    await rellenarPerfil(s.page, lado);
    const [activo] = await sql<{ data: { voice: { forbiddenPhrases: string[]; callsToAction: string[] } } }>(
      `select data from public.brand_profiles where brand_id = $1 and status = 'active'`,
      [dato(lado === 'A' ? 'marcaA' : 'marcaB')],
    );
    expect(activo?.data.voice.forbiddenPhrases).toContain(PERFIL[lado].vetada);
    expect(activo?.data.voice.callsToAction).toContain(PERFIL[lado].cta);
    sinErrores(s);
    await s.context.close();
  }
});

test('sin cupo asignado, la IA no genera, lo explica y no llama al proveedor', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  guardarEstado({ piezaA: await nuevaPieza(page, 'A', 'Hogaza de otoño') });
  const antes = await generaciones('A');

  const ventana = await pedirTexto(page, 'Hogaza de calabaza para el otoño');
  const aviso402 = ventana.getByTestId('ai-quota-error');
  await expect(aviso402).toContainText('Esta organización no tiene cupo de IA');
  await expect(aviso402).toContainText('Mientras tanto, puedes seguir escribiendo y editando a mano.');
  await expect(ventana.getByTestId('ai-caption-variant')).toHaveCount(0);
  // Sin reserva no hay generación registrada: el proveedor no se llegó a llamar.
  expect(await generaciones('A')).toBe(antes);

  sinErrores(s, ERRORES_DE_CUPO);
  await s.context.close();
});

test('la superadministradora asigna el cupo mensual de IA a las dos organizaciones', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto('/plataforma');
  for (const lado of ['A', 'B'] as const) {
    await page.getByTestId('ai-quota-org').selectOption(org(lado));
    await page.getByTestId('ai-quota-amount').fill('5');
    await page.getByTestId('ai-quota-save').click();
    await aviso(page, 'Cupo de IA guardado');
  }
  await expect(page.getByTestId('ai-quota-saved')).toContainText(ORG_B);
  const cupos = await sql<{ organization_id: string; limit_value: string }>(
    `select organization_id, limit_value from public.usage_quotas where organization_id = any($1::uuid[])`,
    [[org('A'), org('B')]],
  );
  expect(cupos.map((c) => Number(c.limit_value))).toEqual([5_000_000, 5_000_000]);
  sinErrores(s);
  await s.context.close();
});

test('generar el texto con IA para dos marcas: cada una respeta su propio perfil', async ({ browser }) => {
  // Marca A (Ana). El encargo trae a propósito la palabra que la marca veta.
  const a = await abrir(browser, 'ana');
  await a.page.goto(`${marca('A')}/contenidos/${dato('piezaA')}`);
  await expect(a.page.getByTestId('editor-title')).toHaveText('Hogaza de otoño');
  const ventanaA = await pedirTexto(a.page, 'Hogaza de calabaza para el otoño, a un precio barato');
  const variantesA = ventanaA.getByTestId('ai-caption-variant');
  await expect(variantesA).toHaveCount(2);
  for (const variante of await variantesA.all()) {
    await expect(variante).toContainText(PERFIL.A.mensaje);
    await expect(variante).toContainText(PERFIL.A.cta);
    await expect(variante).toContainText(`#${PERFIL.A.hashtag}`);
    await expect(variante).toContainText('hogaza de calabaza para el otoño');
    await expect(variante).not.toContainText(PERFIL.A.vetada);
    // Nada de la otra marca.
    await expect(variante).not.toContainText(PERFIL.B.mensaje);
    await expect(variante).not.toContainText(`#${PERFIL.B.hashtag}`);
  }
  await expect(variantesA.first()).toContainText(PERFIL.A.arranque); // trato de usted
  await expect(variantesA.first()).toContainText(/\d+ \/ 2\.?200 caracteres/);
  await variantesA.first().getByRole('button', { name: 'Usar esta' }).click();
  await aviso(a.page, 'Texto aplicado');
  await expect(a.page.getByTestId('copy-caption')).toHaveValue(new RegExp(`^${PERFIL.A.arranque}: hogaza de calabaza`));
  await expect(a.page.getByTestId('copy-hashtags')).toHaveValue(`#${PERFIL.A.hashtag}`);
  await expect(a.page.getByTestId('editor-dirty')).toBeVisible();
  // Aplicar es un paso que se deshace.
  await a.page.getByTestId('undo').click();
  await expect(a.page.getByTestId('copy-caption')).toHaveValue('');
  await a.page.getByTestId('redo').click();
  await expect(a.page.getByTestId('copy-caption')).toHaveValue(new RegExp(PERFIL.A.mensaje));
  // Se guarda como primera versión de la pieza.
  await a.page.getByTestId('editor-save').click();
  await a.page.getByTestId('save-note').fill('Texto redactado con IA');
  await a.page.getByTestId('save-confirm').click();
  await aviso(a.page, 'Versión 1 guardada');
  sinErrores(a);
  await a.context.close();

  // Marca B (Bruno), con otra pieza y otro encargo.
  const b = await abrir(browser, 'bruno');
  guardarEstado({ piezaB: await nuevaPieza(b.page, 'B', 'Merienda de otoño') });
  const ventanaB = await pedirTexto(b.page, 'Tarta de zanahoria con café, en oferta esta semana', 1);
  const varianteB = ventanaB.getByTestId('ai-caption-variant');
  await expect(varianteB).toHaveCount(1);
  await expect(varianteB).toContainText(PERFIL.B.mensaje);
  await expect(varianteB).toContainText(PERFIL.B.cta);
  await expect(varianteB).toContainText(`#${PERFIL.B.hashtag}`);
  await expect(varianteB).toContainText(PERFIL.B.arranque); // tuteo
  await expect(varianteB).not.toContainText(PERFIL.B.vetada);
  await expect(varianteB).not.toContainText(PERFIL.A.mensaje);
  await expect(varianteB).not.toContainText(`#${PERFIL.A.hashtag}`);
  await varianteB.getByRole('button', { name: 'Usar esta' }).click();
  await expect(b.page.getByTestId('copy-caption')).toHaveValue(new RegExp(PERFIL.B.mensaje));
  sinErrores(b);
  await b.context.close();

  // Lo generado queda registrado por organización, con el proveedor simulado y su coste.
  const filas = await sql<{ organization_id: string; provider: string; status: string; cost_micros: string }>(
    `select organization_id, provider, status, cost_micros from public.ai_generations
      where organization_id = any($1::uuid[]) and purpose = 'post.caption'`,
    [[org('A'), org('B')]],
  );
  expect(filas.filter((f) => f.organization_id === org('A'))).toHaveLength(1);
  expect(filas.filter((f) => f.organization_id === org('B'))).toHaveLength(1);
  for (const fila of filas) {
    expect(fila).toMatchObject({ provider: 'simulated', status: 'succeeded' });
    expect(Number(fila.cost_micros)).toBeGreaterThan(0);
  }
});

test('editar la pieza (texto y una capa), guardar otra versión y ver el historial', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca('A')}/contenidos/${dato('piezaA')}`);
  await expect(page.getByTestId('editor-version')).toHaveText('Versión 1');

  // Una capa de texto en el lienzo.
  await page.getByTestId('add-text').click();
  await page.getByRole('tab', { name: 'Diseño' }).click();
  await page.getByTestId('layer-text').fill('Hogazas de otoño');
  // Y un retoque del pie que, sin querer, usa la palabra vetada.
  await page.getByRole('tab', { name: 'Publicación' }).click();
  const pie = page.getByTestId('copy-caption');
  await pie.fill(`${await pie.inputValue()} Ahora más barato.`);
  await expect(page.getByTestId('counter-caption')).toContainText('/ 2200');

  await page.getByTestId('editor-save').click();
  await page.getByTestId('save-note').fill('Titular en el lienzo y retoque del pie');
  await page.getByTestId('save-confirm').click();
  await aviso(page, 'Versión 2 guardada');
  await expect(page.getByTestId('editor-version')).toHaveText('Versión 2');

  await accionDelMenu(page, 'editor-more', 'editor-history');
  const historial = page.getByTestId('versions-list');
  await expect(historial.getByRole('listitem')).toHaveCount(2);
  await expect(historial.getByRole('listitem').nth(0)).toContainText('Titular en el lienzo y retoque del pie');
  await expect(historial.getByRole('listitem').nth(1)).toContainText('Texto redactado con IA');
  await page.keyboard.press('Escape');

  const [guardada] = await sql<{
    data: { pages: { layers: { type: string; text?: string }[] }[]; copy: { caption: string } };
  }>(`select data from public.content_versions where content_id = $1 and version = 2`, [dato('piezaA')]);
  expect(guardada?.data.pages[0]?.layers.some((l) => l.type === 'text' && l.text === 'Hogazas de otoño')).toBe(true);
  expect(guardada?.data.copy.caption).toContain('Ahora más barato.');
  sinErrores(s);
  await s.context.close();
});

test('comprobación de marca sin IA y con IA: las dos señalan la palabra vetada', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca('A')}/contenidos/${dato('piezaA')}`);
  await page.getByRole('tab', { name: 'Marca' }).click();

  // Sin IA: reglas del perfil y de la red, con el dato medido.
  await expect(page.getByTestId('brandcheck-verdict')).toHaveAttribute('data-verdict', 'fail');
  const hallazgo = page.getByTestId('brandcheck-finding-FORBIDDEN_PHRASE');
  await expect(hallazgo).toContainText(`Aparece «${PERFIL.A.vetada}»`);
  // Pulsar el hallazgo lleva al pie con el fragmento elegido.
  await hallazgo.click();
  await expect(page.getByRole('tab', { name: 'Publicación' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('copy-caption')).toBeFocused();
  const elegido = await page.getByTestId('copy-caption').evaluate((el) => {
    const area = el as unknown as { value: string; selectionStart: number; selectionEnd: number };
    return area.value.slice(area.selectionStart, area.selectionEnd);
  });
  expect(elegido).toBe(PERFIL.A.vetada);

  // Con IA: tono y temas vetados, con la cita literal.
  await page.getByRole('tab', { name: 'Marca' }).click();
  await page.getByTestId('ai-brand-check-run').click();
  const vetos = page.getByTestId('ai-criterion-banned_topics');
  await expect(vetos).toContainText('No cumple');
  await expect(vetos.getByRole('list', { name: 'Citas del texto' })).toContainText(`«${PERFIL.A.vetada}»`);
  await expect(page.getByTestId('ai-criterion-tone')).toContainText('Cumple');
  sinErrores(s);
  await s.context.close();
});

test('el coste de IA se consulta por organización en «Consumo de IA»', async ({ browser }) => {
  for (const [alias, lado] of [
    ['ana', 'A'],
    ['bruno', 'B'],
  ] as const satisfies readonly (readonly [Alias, 'A' | 'B'])[]) {
    const [libro] = await sql<{ coste: string }>(
      `select coalesce(sum(cost_delta_micros), 0) as coste from public.ai_usage where organization_id = $1`,
      [org(lado)],
    );
    const coste = Number(libro?.coste);
    expect(coste).toBeGreaterThan(0);

    const s = await abrir(browser, alias);
    const { page } = s;
    await page.goto(`/o/${org(lado)}/ajustes/ia`);
    await expect(page.getByTestId('ai-usage-page')).toBeVisible();
    await expect(page.getByTestId('ai-quota-limit')).toContainText('5');
    // La cifra en pantalla es la del libro de consumo de ESTA organización (unidad neutra: la moneda no está decidida).
    await expect(page.getByTestId('ai-quota-consumed')).toHaveText(importe(coste));
    await expect(page.getByTestId('ai-usage-brands')).toContainText(lado === 'A' ? 'La Espiga' : 'Café Lumen');
    await expect(page.getByTestId('ai-usage-brands')).not.toContainText(lado === 'A' ? 'Café Lumen' : 'La Espiga');
    sinErrores(s);
    await s.context.close();
  }
});

test('con el cupo agotado la generación se detiene con un mensaje claro y no llama al proveedor', async ({
  browser,
}) => {
  // La plataforma deja a la organización B con un cupo menor que lo ya gastado.
  const ana = await abrir(browser, 'ana');
  await ana.page.goto('/plataforma');
  await ana.page.getByTestId('ai-quota-org').selectOption(org('B'));
  await ana.page.getByTestId('ai-quota-amount').fill('0,000001');
  await ana.page.getByTestId('ai-quota-save').click();
  await aviso(ana.page, 'Cupo de IA guardado');
  sinErrores(ana);
  await ana.context.close();

  const s = await abrir(browser, 'bruno');
  const { page } = s;
  const antes = await generaciones('B');
  await page.goto(`${marca('B')}/contenidos/${dato('piezaB')}`);
  const ventana = await pedirTexto(page, 'Café con leche de avena', 1);
  const aviso402 = ventana.getByTestId('ai-quota-error');
  await expect(aviso402).toContainText('El cupo de IA de este mes está agotado');
  await expect(aviso402).toContainText('Se renueva el día 1 del mes que viene');
  await expect(ventana.getByTestId('ai-caption-variant')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // El texto se sigue pudiendo escribir a mano…
  await page.getByTestId('copy-caption').fill('Café con leche de avena, recién hecho');
  // …pero la comprobación con IA también se detiene.
  await page.getByRole('tab', { name: 'Marca' }).click();
  await page.getByTestId('ai-brand-check-run').click();
  await expect(page.getByTestId('ai-quota-error')).toContainText('El cupo de IA de este mes está agotado');
  // Ninguna generación nueva: la reserva se rechazó antes de llamar al proveedor.
  expect(await generaciones('B')).toBe(antes);

  // Y la página de consumo de la organización lo dice (en otra pestaña: el editor tiene cambios sin guardar).
  const consumo = await s.context.newPage();
  await consumo.goto(`/o/${org('B')}/ajustes/ia`);
  await expect(consumo.getByTestId('ai-quota-exhausted')).toBeVisible();
  sinErrores(s, ERRORES_DE_CUPO);
  await s.context.close();
});
