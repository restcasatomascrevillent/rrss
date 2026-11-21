import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { abrir, dato, LOCAL, sinErrores, sql } from './apoyo';

// Imágenes generadas con IA, de punta a punta, contra el Supabase local con
// `ai-media` y `ai-media-poll` servidas en local y la imagen SIMULADA de
// pruebas locales (supabase/functions/_shared/ai/media/local-test.ts): una
// síncrona y otra asíncrona (esta la cierra `ai-media-poll`, que aquí se llama a
// mano con la clave de servicio del stack local: en local no hay secretos de
// Vault y pg_cron no la dispara).
//
// Parte de lo que dejó 09: Ana (organización A, marca La Espiga) tiene la pieza
// «Hogaza de otoño» con una versión guardada y 5 unidades de cupo.
//
// Necesita `VITE_AI_IMAGE_ENABLED=true` en el servidor de Vite de
// playwright.config.ts (ya está). Pasa en la tanda completa desde el 18/11/2026.

test.describe.configure({ mode: 'serial' });

const marcaA = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
/** Precio inventado del simulado (LOCAL_TEST_IMAGE_PRICE_MICROS): 0,02 créditos. */
const COSTE = '0,02 créditos';

/** Clave de servicio del stack LOCAL (la de todas las instalaciones de la CLI; no es un secreto). */
function claveDeServicioLocal(): string {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const clave = /^SERVICE_ROLE_KEY="?([^"\r\n]*)"?/m.exec(salida)?.[1];
  if (!clave) throw new Error('No se ha podido leer la clave de servicio del stack local (supabase status)');
  return clave;
}

async function abrirPieza(page: Page) {
  await page.goto(`${marcaA()}/contenidos/${dato('piezaA')}`);
  await expect(page.getByTestId('editor-title')).toHaveText('Hogaza de otoño');
}

async function capas(page: Page): Promise<number> {
  const texto = await page.getByRole('tab', { name: /Capas \(\d+\)/ }).textContent();
  return Number(/\((\d+)\)/.exec(texto ?? '')?.[1] ?? -1);
}

async function recursosGenerados(): Promise<{ id: string; provenance: Record<string, unknown> }[]> {
  return sql(
    `select id, provenance from public.media_assets
      where brand_id = $1 and origin = 'generated' and provenance->>'type' = 'ai_generation'
      order by created_at`,
    [dato('marcaA')],
  );
}

test('generar una imagen síncrona: coste antes, capa que se deshace y recurso en la biblioteca', async ({
  browser,
}) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await abrirPieza(page);
  const antes = await capas(page);

  await page.getByTestId('add-image-ai').click();
  const ventana = page.getByRole('dialog');
  // El coste máximo se ve antes de generar, y sin reservar nada.
  await expect(ventana.getByTestId('ai-image-estimate')).toContainText(`Coste máximo: ${COSTE}`);
  await expect(ventana.getByTestId('ai-image-model')).toHaveValue('simulated-image:simulado-e2e');
  await expect(ventana.getByTestId('ai-image-untested')).toBeVisible();
  const generacionesAntes = await sql(`select id from public.ai_generations where purpose = 'post.visual'`);

  await ventana.getByTestId('ai-image-prompt').fill('Hogaza de calabaza sobre una tabla de madera, luz de mañana');
  await ventana.getByTestId('ai-image-generate').click();
  await expect(page.getByText('Imagen generada y añadida al diseño')).toBeVisible();
  await expect(ventana).toBeHidden();
  expect(await capas(page)).toBe(antes + 1);
  await expect(page.getByTestId('editor-dirty')).toBeVisible();

  // En la biblioteca, con su procedencia, y la generación con su coste real.
  const recursos = await recursosGenerados();
  expect(recursos).toHaveLength(1);
  expect(recursos[0]!.provenance).toMatchObject({
    type: 'ai_generation',
    provider: 'simulated-image',
    model: 'simulado-e2e',
    prompt: 'Hogaza de calabaza sobre una tabla de madera, luz de mañana',
  });
  const generaciones = await sql<{ status: string; cost_micros: string }>(
    `select status, cost_micros from public.ai_generations where purpose = 'post.visual' order by created_at`,
  );
  expect(generaciones).toHaveLength(generacionesAntes.length + 1);
  expect(generaciones.at(-1)).toMatchObject({ status: 'succeeded', cost_micros: '20000' });

  // Deshacer quita la capa; la imagen sigue en la biblioteca.
  await page.getByTestId('undo').click();
  expect(await capas(page)).toBe(antes);
  await page.getByTestId('redo').click();
  expect(await capas(page)).toBe(antes + 1);

  await page.goto(`${marcaA()}/biblioteca`);
  await expect(page.getByText(/IA · Hogaza de calabaza/)).toBeVisible();
  sinErrores(s);
  await s.context.close();
});

test('generar una imagen asíncrona: queda en curso y la cierra ai-media-poll', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await abrirPieza(page);
  const antes = await capas(page);

  await page.getByTestId('add-image-ai').click();
  const ventana = page.getByRole('dialog');
  await ventana.getByTestId('ai-image-model').selectOption('simulated-image-async:simulado-e2e-asincrono');
  await ventana.getByTestId('ai-image-ratio').selectOption('9:16');
  await ventana.getByTestId('ai-image-prompt').fill('Escaparate del obrador al atardecer');
  await ventana.getByTestId('ai-image-generate').click();
  await expect(ventana.getByTestId('ai-image-running')).toBeVisible();

  // Sin la clave de servicio, ai-media-poll no toca la cola.
  const sinClave = await fetch(`${LOCAL.api}/functions/v1/ai-media-poll`, { method: 'POST', body: '{}' });
  expect(sinClave.status).toBe(401);

  // Se sondea como lo haría pg_cron, una y otra vez: el trabajo de la cola no
  // se puede reclamar hasta pasado el intervalo de sondeo (5 s desde que se
  // encoló) y el simulado asíncrono «termina» a los 2 s. Con una sola llamada a
  // los 2,5 s la prueba dependía de lo lenta que fuera la máquina (en el CI,
  // más rápida que en local, el trabajo aún no tocaba y no se cerraba nada).
  const clave = claveDeServicioLocal();
  const vistos: string[] = [];
  await expect
    .poll(
      async () => {
        const sondeo = await fetch(`${LOCAL.api}/functions/v1/ai-media-poll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: clave, authorization: `Bearer ${clave}` },
          body: '{}',
        });
        expect(sondeo.status).toBe(200);
        const { results } = (await sondeo.json()) as { results: Array<{ status: string }> };
        vistos.push(...results.map((r) => r.status));
        return vistos.find((estado) => estado !== 'pending') ?? null;
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe('completed');

  // La interfaz lo ve sola (consulta cada 3 s) y añade la capa.
  await expect(page.getByText('Imagen generada y añadida al diseño')).toBeVisible({ timeout: 30_000 });
  expect(await capas(page)).toBe(antes + 1);
  const recursos = await recursosGenerados();
  expect(recursos.at(-1)!.provenance).toMatchObject({
    provider: 'simulated-image-async',
    prompt: 'Escaparate del obrador al atardecer',
  });
  const [trabajo] = await sql<{ status: string }>(
    `select status from public.jobs where kind = 'ai.media.poll' order by created_at desc limit 1`,
  );
  expect(trabajo?.status).toBe('succeeded');
  sinErrores(s);
  await s.context.close();
});

test('con el cupo agotado, la imagen no se genera y se explica', async ({ browser }) => {
  // Se deja el cupo de la organización A por debajo de lo ya gastado.
  await sql(`update public.usage_quotas set limit_value = 1 where organization_id = $1`, [dato('orgA')]);
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await abrirPieza(page);
  const generados = (await recursosGenerados()).length;

  await page.getByTestId('add-image-ai').click();
  const ventana = page.getByRole('dialog');
  await ventana.getByTestId('ai-image-prompt').fill('Pan de centeno');
  await ventana.getByTestId('ai-image-generate').click();
  await expect(ventana.getByTestId('ai-quota-error')).toContainText('El cupo de IA de este mes está agotado');
  expect((await recursosGenerados()).length).toBe(generados);

  // Se devuelve el cupo que dejó 09.
  await sql(`update public.usage_quotas set limit_value = 5000000 where organization_id = $1`, [dato('orgA')]);
  sinErrores(s, [/status of 402/]);
  await s.context.close();
});
