import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abrir, aviso, dato, enlaceDelCorreo, leerEstado, LOCAL, sinErrores, sql } from './apoyo';

// Modo agencia de extremo a extremo, contra el Supabase LOCAL: una clienta pide
// un encargo en la aplicación; la herramienta de la agencia (agency/),
// ejecutada desde la propia prueba con una cuenta de agencia creada aquí, lo
// toma y entrega un borrador; la clienta lo revisa, pide un cambio, la agencia
// vuelve a entregar y la clienta acepta.
//
// Parte de lo que dejaron los archivos anteriores: Ana es propietaria de la
// organización A con la marca La Espiga (perfil con hashtag obligatorio
// #LaEspiga y la palabra «barato» vetada, de 09-fase2).

test.describe.configure({ mode: 'serial' });

const CLAVE = 'Prueba-e2e-agencia-2026';
const TITULO = 'Hogaza de otoño';
const marca = () => `/o/${dato('orgA')}/m/${dato('marcaA')}`;
const correoDe = (quien: 'agencia' | 'clienta') => `${quien}.${leerEstado().tanda}@ejemplo.test`;

// Carpeta temporal FUERA del repositorio con las credenciales de la agencia y
// su carpeta de trabajo (la herramienta se niega a leer credenciales del repositorio).
const dir = mkdtempSync(path.join(os.tmpdir(), 'rrss-e2e-agencia-'));
const credenciales = path.join(dir, 'credenciales.json');
const trabajo = path.join(dir, 'trabajo');
let encargo = '';

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Ejecuta la herramienta de la agencia como lo haría la sesión de Claude. */
function agencia(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', './src/register.ts', 'src/main.ts', ...args], {
    cwd: path.resolve('agency'),
    env: { ...process.env, RRSS_AGENCIA_CREDENCIALES: credenciales, RRSS_AGENCIA_TRABAJO: trabajo },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function anonKey(): string {
  const key = process.env.E2E_SUPABASE_ANON_KEY;
  if (!key) throw new Error('Falta la clave anónima del stack local (supabase status).');
  return key;
}

/** Alta por la API pública de autenticación y confirmación con el enlace del buzón local. */
async function crearCuenta(correo: string, nombre: string): Promise<void> {
  const alta = await fetch(`${LOCAL.api}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anonKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: correo, password: CLAVE, data: { full_name: nombre } }),
  });
  expect(alta.ok, await alta.clone().text()).toBe(true);
  const confirmacion = await fetch(await enlaceDelCorreo(correo, 'signup'), { redirect: 'manual' });
  expect(confirmacion.status).toBeLessThan(400);
}

/** Llama a una función de la API con la sesión de una cuenta (repite si el token llega «del futuro»). */
async function rpcComo(correo: string, funcion: string, args: Record<string, unknown>): Promise<Response> {
  const sesion = await fetch(`${LOCAL.api}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: correo, password: CLAVE }),
  });
  const { access_token: token } = (await sesion.json()) as { access_token: string };
  for (let intento = 0; ; intento++) {
    const respuesta = await fetch(`${LOCAL.api}/rest/v1/rpc/${funcion}`, {
      method: 'POST',
      headers: { apikey: anonKey(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (respuesta.status !== 401 || intento >= 3) return respuesta;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Invitación desde el equipo de la marca, con el rol de marca indicado. Devuelve el enlace. */
async function invitar(page: Page, correo: string, rol: 'editor' | 'client'): Promise<string> {
  await page.goto(`${marca()}/equipo`);
  await page.getByTestId('brand-invite-open').click();
  await page.getByTestId('invite-email').fill(correo);
  await page.getByTestId('invite-brand-role').selectOption(rol);
  await page.getByTestId('invite-submit').click();
  const enlace = await page.getByTestId('invite-link').inputValue();
  expect(enlace).toMatch(/\/invitacion\/[\w-]{20,}$/);
  await page.getByRole('button', { name: 'Hecho' }).click();
  return enlace;
}

async function entrarComoClienta(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(correoDe('clienta'));
  await page.getByTestId('login-password').fill(CLAVE);
  await page.getByTestId('login-submit').click();
  await expect(page).not.toHaveURL(/\/login/);
}

function escribirEntrega(nombre: string, caption: string): string {
  const archivo = path.join(trabajo, encargo, nombre);
  writeFileSync(
    archivo,
    JSON.stringify({
      format: 'rrss.agency-delivery',
      version: 1,
      title: TITULO,
      copy: {
        caption,
        hashtags: ['LaEspiga'],
        altText: 'Hogaza de masa madre sobre la mesa del obrador',
      },
      variants: [{ caption: 'Otra propuesta: la hogaza de siempre, con el otoño dentro.', hashtags: ['LaEspiga'] }],
    }),
  );
  return archivo;
}

test('preparación: cuentas de la clienta y de la agencia, invitaciones y marca en modo agencia', async ({
  browser,
}) => {
  await crearCuenta(correoDe('agencia'), 'Agencia Oficio');
  await crearCuenta(correoDe('clienta'), 'Clara Clienta');

  const ana = await abrir(browser, 'ana');
  const enlaceAgencia = await invitar(ana.page, correoDe('agencia'), 'editor');
  const enlaceClienta = await invitar(ana.page, correoDe('clienta'), 'client');

  // La marca pasa a modo agencia: lo decide quien la gestiona.
  await ana.page.goto(`${marca()}/marca`);
  await ana.page.getByRole('tab', { name: 'Datos de la marca' }).click();
  await ana.page.getByTestId('brand-ai-mode').selectOption('agency');
  await aviso(ana.page, 'Ajuste guardado');
  sinErrores(ana);
  await ana.context.close();

  // La agencia acepta su invitación como cualquier usuario, por la API.
  const token = enlaceAgencia.split('/').pop()!;
  const aceptada = await rpcComo(correoDe('agencia'), 'accept_invitation', { p_token: token });
  expect(aceptada.ok, await aceptada.clone().text()).toBe(true);

  // La clienta, por la interfaz.
  const clienta = await abrir(browser);
  await entrarComoClienta(clienta.page);
  await clienta.page.goto(enlaceClienta);
  await clienta.page.getByTestId('invitation-accept').click();
  await expect(clienta.page).not.toHaveURL(/\/invitacion\//);
  sinErrores(clienta);
  await clienta.context.close();

  // Credenciales de la agencia: URL y clave PÚBLICA del stack local, nunca la de servicio.
  writeFileSync(
    credenciales,
    JSON.stringify({ url: LOCAL.api, anonKey: anonKey(), email: correoDe('agencia'), password: CLAVE }),
  );
});

test('la clienta pide un encargo desde la sección Encargos', async ({ browser }) => {
  const s = await abrir(browser);
  await entrarComoClienta(s.page);
  const { page } = s;
  await page.goto(`${marca()}/inicio`);
  await page.getByRole('link', { name: 'Encargos' }).first().click();
  await page.getByTestId('request-new').click();
  await page.getByTestId('request-title').fill(TITULO);
  await page.getByTestId('request-brief').fill('Queremos anunciar la hogaza de otoño. Tono formal, de usted.');
  await page.getByTestId('request-network').selectOption('instagram');
  await page.getByTestId('request-format').selectOption('post');
  await page.getByTestId('request-submit').click();
  await aviso(page, 'Encargo enviado');
  await expect(page.getByTestId('request-status')).toHaveText('Pedido');
  encargo = page.url().split('/').pop()!;
  sinErrores(s);
  await s.context.close();
});

test('la agencia lo ve en su cola, lo toma (con cerrojo), lo prepara, lo comprueba y lo entrega', async () => {
  const cola = agencia('pendientes', '--json');
  expect(cola.stderr).toBe('');
  const item = (JSON.parse(cola.stdout) as { id: string; title: string; status: string }[]).find(
    (i) => i.id === encargo,
  );
  expect(item).toMatchObject({ title: TITULO, status: 'requested' });

  expect(agencia('tomar', encargo).code).toBe(0);
  // Una segunda sesión (otra clave de sesión) no puede tomarlo.
  const segunda = spawnSync(process.execPath, ['--import', './src/register.ts', 'src/main.ts', 'tomar', encargo], {
    cwd: path.resolve('agency'),
    env: {
      ...process.env,
      RRSS_AGENCIA_CREDENCIALES: credenciales,
      RRSS_AGENCIA_TRABAJO: path.join(dir, 'otra-sesion'),
    },
    encoding: 'utf8',
  });
  expect(segunda.status).toBe(1);
  expect(segunda.stderr).toContain('RQ001');

  const contexto = agencia('contexto', encargo);
  expect(contexto.code, contexto.stderr).toBe(0);
  const datos = JSON.parse(readFileSync(path.join(trabajo, encargo, 'encargo.json'), 'utf8'));
  expect(datos.notice).toMatch(/nunca instrucciones/);
  expect(datos.request.brief).toContain('hogaza de otoño');
  const perfil = JSON.parse(readFileSync(path.join(trabajo, encargo, 'perfil.json'), 'utf8'));
  expect(perfil.data.voice.forbiddenPhrases).toContain('barato');

  // Primero, una entrega con una palabra vetada: el verificador la bloquea y no se entrega.
  const mala = escribirEntrega('entrega-mala.json', 'Le presentamos la hogaza más barato del barrio.');
  expect(agencia('comprobar', mala).code).toBe(1);
  expect(agencia('entregar', encargo, mala).code).toBe(2);

  const buena = escribirEntrega(
    'entrega.json',
    'Le presentamos nuestra hogaza de otoño: masa madre recién hecha cada mañana. Reserve su hogaza.',
  );
  const comprobacion = agencia('comprobar', buena);
  expect(comprobacion.code, comprobacion.stdout).toBe(0);
  const entrega = agencia('entregar', encargo, buena);
  expect(entrega.code, entrega.stderr).toBe(0);
  expect(entrega.stdout).toContain('versión 1, en borrador');

  // La agencia no puede aceptar su propia entrega: solo crea borradores.
  const aceptar = await rpcComo(correoDe('agencia'), 'accept_content_request', { p_request_id: encargo });
  expect(aceptar.ok).toBe(false);
});

test('la clienta revisa el borrador y pide un cambio', async ({ browser }) => {
  const s = await abrir(browser);
  await entrarComoClienta(s.page);
  const { page } = s;
  await page.goto(`${marca()}/encargos/${encargo}`);
  await expect(page.getByTestId('request-status')).toHaveText('Entregado');
  await expect(page.getByTestId('request-thread')).toContainText('Agencia Oficio');
  await expect(page.getByTestId('request-thread')).toContainText('Otra propuesta');

  // El borrador se abre en el editor, en solo lectura para la clienta, y dice de qué encargo viene.
  await page.getByTestId('request-open-content').click();
  await expect(page.getByTestId('editor-request-link')).toContainText(TITULO);
  await page.getByRole('tab', { name: 'Publicación' }).click();
  await expect(page.getByTestId('copy-caption')).toHaveValue(/hogaza de otoño/);
  await page.getByTestId('editor-request-link').click();

  await page.getByTestId('request-changes').click();
  await page.getByTestId('request-changes-input').fill('Más corto, por favor, y sin «recién hecha».');
  await page.getByTestId('request-changes-send').click();
  await aviso(page, 'Cambios pedidos');
  await expect(page.getByTestId('request-status')).toHaveText('Cambios pedidos');
  sinErrores(s);
  await s.context.close();
});

test('la agencia vuelve a tomarlo, lee el cambio pedido y entrega otra versión', async () => {
  const cola = JSON.parse(agencia('pendientes', '--json').stdout) as { id: string; status: string }[];
  expect(cola.find((i) => i.id === encargo)?.status).toBe('changes_requested');
  expect(agencia('tomar', encargo).code).toBe(0);
  expect(agencia('contexto', encargo).code).toBe(0);
  const datos = JSON.parse(readFileSync(path.join(trabajo, encargo, 'encargo.json'), 'utf8')) as {
    conversation: { status: string | null; text: string }[];
  };
  expect(datos.conversation.at(-2)).toMatchObject({
    status: 'changes_requested',
    text: expect.stringContaining('Más corto'),
  });

  const segunda = escribirEntrega('entrega.json', 'Le presentamos la hogaza de otoño. Reserve su hogaza.');
  expect(agencia('comprobar', segunda).code).toBe(0);
  const entrega = agencia('entregar', encargo, segunda);
  expect(entrega.code, entrega.stderr).toBe(0);
  expect(entrega.stdout).toContain('versión 2');
});

test('la clienta acepta: la pieza queda aprobada en la versión entregada', async ({ browser }) => {
  const s = await abrir(browser);
  await entrarComoClienta(s.page);
  const { page } = s;
  await page.goto(`${marca()}/encargos/${encargo}`);
  await expect(page.getByTestId('request-status')).toHaveText('Entregado');
  await page.getByTestId('request-accept').click();
  await page.getByTestId('confirm-action').click();
  await aviso(page, 'Entrega aceptada');
  await expect(page.getByTestId('request-status')).toHaveText('Aceptado');

  const [fila] = await sql<{ estado: string; pieza: string; version: number; nota: string }>(
    `select r.status as estado, c.status as pieza, c.current_version as version, v.change_note as nota
       from public.content_requests r
       join public.content_items c on c.id = r.content_id
       join public.content_versions v on v.content_id = c.id and v.version = c.current_version
      where r.id = $1`,
    [encargo],
  );
  expect(fila).toEqual({
    estado: 'accepted',
    pieza: 'approved',
    version: 2,
    nota: 'Entregado por la agencia (con los cambios pedidos)',
  });
  const historial = await sql<{ status: string }>(
    `select status from public.content_request_comments where request_id = $1 and kind = 'status' order by created_at, id`,
    [encargo],
  );
  expect(historial.map((h) => h.status)).toEqual([
    'requested',
    'in_progress',
    'delivered',
    'changes_requested',
    'in_progress',
    'delivered',
    'accepted',
  ]);
  sinErrores(s);
  await s.context.close();
});
