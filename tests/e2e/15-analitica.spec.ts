import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  simulatedAccountValue,
  simulatedMediaValue,
} from '../../supabase/functions/_shared/analytics/simulated-insights';
import { SIMULATED_IG_USER_ID } from '../../supabase/functions/_shared/social/simulated-graph';
import { abrir, dato, LOCAL, sinErrores, sql } from './apoyo';

// Analítica de extremo a extremo (Fase 5), contra el Supabase LOCAL y la Graph
// API de Meta SIMULADA (supabase/functions/e2e.env): se capturan las métricas
// de la cuenta conectada y de lo publicado en 13-publicacion-calendario, se ven
// en el panel (dato frente a hipótesis y lo que no se puede medir), se genera
// el informe mensual sin intervención (reloj → social-insights → trabajador de
// medios con pdf-lib) y se abre el PDF.
//
// Los relojes (pg_cron) no se esperan: la prueba hace lo que hacen ellos —
// encolar y llamar a `social-insights` con la clave de servicio del stack
// local— y arranca el trabajador en modo `drain`, como en 11-reels.
//
// Requisitos además de los de la tanda: las migraciones 20261119610000 a
// 20261119630000 aplicadas, `npm ci` en worker/ (pdf-lib) y Node ≥ 22.18.
// ESCRITA Y SIN EJECUTAR todavía (18/11/2026).
//
// Parte de lo que dejó 13-publicacion-calendario: la marca La Espiga Obrador
// (marcaA2) con su cuenta de Instagram simulada conectada y la pieza «Hogaza del
// domingo» publicada.

test.describe.configure({ mode: 'serial' });

const RAIZ = path.resolve('.');
const marca = () => `/o/${dato('orgA')}/m/${dato('marcaA2')}`;
const PUBLICADA = 'Hogaza del domingo';
const mesActual = () => `${new Date().toISOString().slice(0, 7)}-01`;

function serviceKey(): string {
  const salida = execSync('supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const clave = /^SERVICE_ROLE_KEY="?([^"\r\n]*)"?/m.exec(salida)?.[1];
  if (!clave) throw new Error('No se pudo leer la clave de servicio del stack local (supabase status).');
  return clave;
}

/** Lo que hace pg_cron cada hora: llamar a `social-insights` con la clave de servicio. */
async function llamaInsights(): Promise<{ results: Array<{ kind: string; outcome: string }> }> {
  const clave = serviceKey();
  const respuesta = await fetch(`${LOCAL.api}/functions/v1/social-insights`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clave}`, apikey: clave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'e2e' }),
  });
  expect(respuesta.ok, await respuesta.clone().text()).toBe(true);
  return (await respuesta.json()) as { results: Array<{ kind: string; outcome: string }> };
}

/** Arranca el trabajador de medios contra el stack local y espera a que vacíe la cola. */
function trabajadorLocal(limiteMs = 120_000): Promise<{ codigo: number | null; salida: string }> {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, ['worker/scripts/run-supabase.ts', 'local'], {
      cwd: RAIZ,
      env: {
        ...process.env,
        WORKER_MODE: 'drain',
        WORKER_ID: 'e2e-informe',
        WORKER_POLL_MS: '500',
        WORKER_IDLE_EXIT_MS: '3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    hijo.stdout.on('data', (t: Buffer) => (salida += t.toString()));
    hijo.stderr.on('data', (t: Buffer) => (salida += t.toString()));
    const tope = setTimeout(() => {
      hijo.kill('SIGTERM');
      rechazar(new Error(`El trabajador no terminó en ${limiteMs / 1000} s.\n${salida}`));
    }, limiteMs);
    hijo.on('error', (e) => {
      clearTimeout(tope);
      rechazar(e);
    });
    hijo.on('exit', (codigo) => {
      clearTimeout(tope);
      resolver({ codigo, salida });
    });
  });
}

test('el reloj captura las métricas de la cuenta y de lo publicado, con las cifras de la red', async () => {
  const [cuenta] = await sql<{ id: string }>(
    `select id from public.social_accounts where brand_id = $1 and status = 'active'`,
    [dato('marcaA2')],
  );
  expect(cuenta, 'La cuenta conectada en 13-publicacion-calendario').toBeTruthy();
  await sql(`select public.analytics_enqueue_captures()`);
  const { results } = await llamaInsights();
  expect(results).toContainEqual(expect.objectContaining({ kind: 'analytics.capture', outcome: 'succeeded' }));

  // Una fila por métrica y día; la cifra es exactamente la que da la red (simulada, determinista).
  const alcance = await sql<{ metric_date: string; value: string }>(
    `select metric_date::text, value::text from public.account_metrics_daily
     where social_account_id = $1 and metric_id = 'instagram.account.reach' order by metric_date`,
    [cuenta!.id],
  );
  expect(alcance.length).toBe(28);
  for (const fila of alcance) {
    expect(Number(fila.value)).toBe(simulatedAccountValue(SIMULATED_IG_USER_ID, 'reach', fila.metric_date));
  }
  const [publicada] = await sql<{ external_id: string }>(
    `select p.external_id from public.scheduled_publications p join public.content_items c on c.id = p.content_id
     where c.title = $1 and p.status = 'published'`,
    [PUBLICADA],
  );
  const [alcancePieza] = await sql<{ value: string }>(
    `select value::text from public.media_metrics_daily where external_media_id = $1 and metric_id = 'instagram.media.reach'`,
    [publicada!.external_id],
  );
  expect(Number(alcancePieza!.value)).toBe(simulatedMediaValue(publicada!.external_id, 'FEED', 'reach', 0));

  // Otra pasada el mismo día no duplica nada (la cola devuelve el mismo trabajo).
  await sql(`select public.analytics_enqueue_captures()`);
  await llamaInsights();
  const [n] = await sql<{ n: number }>(
    `select count(*)::int as n from public.account_metrics_daily where social_account_id = $1 and metric_id = 'instagram.account.reach'`,
    [cuenta!.id],
  );
  expect(n).toEqual({ n: 28 });
});

test('el panel enseña las cifras, separa dato de hipótesis y dice lo que no se puede medir', async ({ browser }) => {
  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/inicio`);
  await page.getByRole('link', { name: 'Analítica' }).first().click();
  await expect(page).toHaveURL(new RegExp(`${marca()}/analitica`));

  // Por defecto, «Últimos 28 días»: días completos, sin hoy. Ahí están las
  // cifras diarias (de ayer hacia atrás), no lo capturado o publicado hoy.
  const kpis = page.getByTestId('analytics-kpis');
  await expect(kpis.getByTestId('kpi-instagram.account.reach')).toContainText('Estimación de Meta');
  await expect(page.getByTestId('analytics-chart')).toBeVisible();
  await expect(page.getByTestId('analytics-facts')).toContainText('Dato');
  await expect(page.getByTestId('analytics-facts')).toContainText('Alcance:');
  await expect(page.getByTestId('analytics-hypotheses')).toBeVisible();
  await expect(page.getByTestId('analytics-caveats')).toContainText('hora universal');
  const noMedible = page.getByTestId('analytics-unmeasurable');
  await expect(noMedible).toContainText('Impresiones');
  await expect(noMedible).toContainText('Facebook');
  await expect(page.getByTestId('analytics-networks')).toContainText('Las páginas de Facebook todavía no se conectan.');
  // La tanda tiene la IA de texto (VITE_AI_TEXT_ENABLED, proveedor simulado) y
  // La Espiga no está en modo agencia: la IA interpreta, solo con los datos medidos.
  await page.getByTestId('analytics-ai').click();
  const ia = page.getByTestId('analytics-ai-hypotheses');
  await expect(ia).toContainText('Interpretación (IA)');
  await expect(ia).toContainText('[simulado] Podría merecer la pena fijarse en esto');
  await expect(ia).toContainText('Se apoya en:');

  // Los seguidores (una foto del día de la captura, hoy) y la pieza publicada
  // hoy en 13-publicacion-calendario están en «Este mes», que incluye hoy.
  await page.getByRole('combobox', { name: 'Periodo' }).selectOption({ label: 'Este mes' });
  await expect(kpis.getByTestId('kpi-instagram.account.followers')).toBeVisible();
  await expect(page.getByTestId('analytics-best-posts')).toContainText(PUBLICADA);
  sinErrores(s);
  await s.context.close();
});

test('el informe mensual se genera sin intervención y se abre desde el panel', async ({ browser }) => {
  test.setTimeout(240_000);
  // Lo que hace el reloj a partir del día 3: encolar el informe (aquí, del mes en curso, que es el que tiene cifras).
  await sql(`delete from public.analytics_reports where brand_id = $1 and period_start = $2`, [
    dato('marcaA2'),
    mesActual(),
  ]);
  await sql(`select public.analytics_enqueue_monthly_reports($1::date)`, [mesActual()]);
  const { results } = await llamaInsights();
  expect(results).toContainEqual(expect.objectContaining({ kind: 'analytics.report', outcome: 'rendering' }));

  const trabajador = await trabajadorLocal();
  expect(trabajador.codigo, trabajador.salida).toBe(0);

  const [informe] = await sql<{
    status: string;
    media_asset_id: string;
    storage_path: string;
    provenance: { type: string };
  }>(
    `select r.status, r.media_asset_id, a.storage_path, a.provenance from public.analytics_reports r
     join public.media_assets a on a.id = r.media_asset_id where r.brand_id = $1 and r.period_start = $2`,
    [dato('marcaA2'), mesActual()],
  );
  expect(informe).toMatchObject({ status: 'ready', provenance: { type: 'analytics_report' } });

  const s = await abrir(browser, 'ana');
  const { page } = s;
  await page.goto(`${marca()}/analitica`);
  const lista = page.getByTestId('analytics-reports');
  await expect(lista).toContainText('Listo');
  // La descarga abre una pestaña con la dirección firmada (`download`): esa
  // pestaña se queda en blanco y el navegador baja el archivo, así que la
  // dirección se toma de la petición y se descarga aparte para mirar el PDF.
  const [peticion] = await Promise.all([
    page.context().waitForEvent('request', (r) => /\/storage\/v1\/object\/sign\/.+\.pdf\?token=/.test(r.url())),
    lista.getByTestId('analytics-download').first().click(),
  ]);
  const respuesta = await page.request.get(peticion.url());
  expect(respuesta.status()).toBe(200);
  expect(respuesta.headers()['content-type']).toContain('application/pdf');
  expect((await respuesta.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Y está en la biblioteca, carpeta «Informes».
  await page.goto(`${marca()}/biblioteca`);
  await expect(page.getByText(/informe-\d{4}-\d{2}\.pdf/).first()).toBeVisible();
  sinErrores(s);
  await s.context.close();
});
