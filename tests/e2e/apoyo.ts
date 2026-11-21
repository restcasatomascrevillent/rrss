// Utilidades de la prueba de extremo a extremo (solo Supabase LOCAL).
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import pg from 'pg';

/** Puertos del stack local (supabase/config.toml). */
export const LOCAL = {
  api: 'http://127.0.0.1:55321',
  buzon: 'http://127.0.0.1:55324',
  db: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
  app: 'http://127.0.0.1:5273',
} as const;

export const DIR_ESTADO = path.resolve('.e2e');
export const ESTADO_JSON = path.join(DIR_ESTADO, 'estado.json');

export type Alias = 'ana' | 'bruno' | 'carla' | 'dani' | 'eva';

export const NOMBRES: Record<Alias, string> = {
  ana: 'Ana Ejemplo',
  bruno: 'Bruno Ejemplo',
  carla: 'Carla Ejemplo',
  dani: 'Dani Ejemplo',
  eva: 'Eva Ejemplo',
};

/** Contraseña de las cuentas inventadas de la prueba. Solo existe en el stack local. */
export const CLAVE_INICIAL = 'Prueba-e2e-2026';

export const ORG_A = 'Panadería La Espiga';
export const ORG_B = 'Agencia Faro';
export const MARCA_A = 'La Espiga';
export const MARCA_A2 = 'La Espiga Obrador';
export const MARCA_B = 'Café Lumen';

export interface Estado {
  /** Sufijo de los correos de esta tanda. */
  tanda: string;
  /** Contraseña vigente de cada cuenta (cambia en la prueba de recuperación). */
  claves: Partial<Record<Alias, string>>;
  orgA?: string;
  orgB?: string;
  marcaA?: string;
  marcaA2?: string;
  marcaB?: string;
  /** Enlaces de invitación copiados desde la interfaz. */
  invitaciones?: Partial<Record<Alias, string>>;
  /** Ruta en Storage de un archivo de la marca A (para la prueba de aislamiento). */
  rutaArchivoA?: string;
  /** Pieza de contenido de la marca A creada en la prueba de la Fase 2. */
  piezaA?: string;
  piezaB?: string;
}

export function leerEstado(): Estado {
  return JSON.parse(readFileSync(ESTADO_JSON, 'utf8')) as Estado;
}

export function guardarEstado(cambios: Partial<Estado>): Estado {
  const estado = { ...leerEstado(), ...cambios };
  writeFileSync(ESTADO_JSON, JSON.stringify(estado, null, 2));
  return estado;
}

/** Lee un dato que tuvo que dejar un archivo anterior; si falta, el orden de la tanda está roto. */
export function dato<K extends keyof Estado>(clave: K): NonNullable<Estado[K]> {
  const valor = leerEstado()[clave];
  if (valor === undefined || valor === null) {
    throw new Error(`Falta «${clave}» en ${ESTADO_JSON}: ejecuta la tanda completa (npm run test:e2e).`);
  }
  return valor as NonNullable<Estado[K]>;
}

export function correo(alias: Alias): string {
  return `${alias}.${leerEstado().tanda}@ejemplo.test`;
}

export function clave(alias: Alias): string {
  return leerEstado().claves[alias] ?? CLAVE_INICIAL;
}

function rutaSesion(alias: Alias): string {
  return path.join(DIR_ESTADO, `sesion-${alias}.json`);
}

// ── Sesiones de navegador ────────────────────────────────────────────────

export interface Sesion {
  context: BrowserContext;
  page: Page;
  /** Errores de consola y excepciones de página vistos en esta sesión. */
  errores: string[];
  /**
   * Direcciones que respondieron 401 «JWT issued at future» (PGRST303): el
   * PostgREST local guarda la hora con hasta un segundo de retraso y rechaza un
   * token recién emitido. La aplicación lo reintenta y sigue; no es un fallo suyo.
   */
  tokensDelFuturo: Set<string>;
}

/**
 * Abre un navegador limpio. Con `alias`, entra con esa cuenta: reutiliza la
 * sesión guardada o, si no hay, inicia sesión por la interfaz y la guarda.
 */
export async function abrir(browser: Browser, alias?: Alias, opciones: { proxy?: string } = {}): Promise<Sesion> {
  const guardada = alias && existsSync(rutaSesion(alias)) ? rutaSesion(alias) : undefined;
  const context = await browser.newContext({
    // `<-loopback>` hace que Chromium use el proxy también para 127.0.0.1; la aplicación va directa.
    proxy: opciones.proxy ? { server: opciones.proxy, bypass: `<-loopback>,${new URL(LOCAL.app).host}` } : undefined,
    baseURL: LOCAL.app,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: { width: 1366, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
    storageState: guardada,
  });
  const errores: string[] = [];
  const tokensDelFuturo = new Set<string>();
  context.on('response', (respuesta) => {
    if (respuesta.status() !== 401 || !respuesta.url().startsWith(`${LOCAL.api}/rest/`)) return;
    void respuesta
      .text()
      .then((cuerpo) => {
        if (cuerpo.includes('JWT issued at future')) tokensDelFuturo.add(respuesta.url());
      })
      .catch(() => undefined);
  });
  context.on('page', (p) => {
    p.on('console', (m) => {
      if (m.type() === 'error') errores.push(`[consola] ${m.text()} — ${m.location().url}`);
    });
    p.on('pageerror', (e) => errores.push(`[excepción] ${e.message}`));
  });
  const page = await context.newPage();
  if (alias && !guardada) {
    await entrar(page, alias);
    await guardarSesion(context, alias);
  }
  return { context, page, errores, tokensDelFuturo };
}

export async function entrar(page: Page, alias: Alias, contrasena = clave(alias)): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(correo(alias));
  await page.getByTestId('login-password').fill(contrasena);
  await page.getByTestId('login-submit').click();
  try {
    await expect(page).not.toHaveURL(/\/login/);
  } catch (error) {
    // Diagnóstico: si el formulario se queda esperando, deja constancia de los bloqueos de sesión del navegador.
    const bloqueos = await page
      .evaluate('navigator.locks.query().then((q) => JSON.stringify(q))')
      .catch(() => 'no disponible');
    const mensaje = await page
      .getByTestId('auth-error')
      .textContent({ timeout: 500 })
      .catch(() => null);
    throw new Error(
      `No se pudo entrar como ${alias}. Error en pantalla: ${mensaje ?? 'ninguno'}. Bloqueos: ${bloqueos}`,
      {
        cause: error,
      },
    );
  }
}

export async function guardarSesion(context: BrowserContext, alias: Alias): Promise<void> {
  await context.storageState({ path: rutaSesion(alias) });
}

export async function cerrarSesion(page: Page): Promise<void> {
  await page.getByTestId('user-menu').first().click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login/);
}

/** Falla si la sesión ha visto errores de consola que no estén entre los esperados. */
export function sinErrores(sesion: Sesion, esperados: RegExp[] = []): void {
  const inesperados = sesion.errores.filter(
    (e) =>
      !esperados.some((patron) => patron.test(e)) &&
      ![...sesion.tokensDelFuturo].some((url) => e.includes('status of 401') && e.includes(url)),
  );
  expect(inesperados, 'errores de consola').toEqual([]);
}

/** Aviso emergente (toast) con ese texto. */
export async function aviso(page: Page, texto: string | RegExp): Promise<void> {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: texto }).first()).toBeVisible();
}

// ── Buzón de correo local (Mailpit) ──────────────────────────────────────

interface MensajeResumen {
  ID: string;
}

/** Enlace de confirmación (`signup`) o de recuperación (`recovery`) del último correo a esa dirección. */
export async function enlaceDelCorreo(direccion: string, tipo: 'signup' | 'recovery'): Promise<string> {
  const consulta = encodeURIComponent(`to:${direccion}`);
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    const lista = (await (await fetch(`${LOCAL.buzon}/api/v1/search?query=${consulta}`)).json()) as {
      messages?: MensajeResumen[];
    };
    for (const resumen of lista.messages ?? []) {
      const mensaje = (await (await fetch(`${LOCAL.buzon}/api/v1/message/${resumen.ID}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const cuerpo = `${mensaje.Text ?? ''}\n${(mensaje.HTML ?? '').replaceAll('&amp;', '&')}`;
      const enlaces = cuerpo.match(/https?:\/\/[^\s"'<>()[\]]+\/auth\/v1\/verify\?[^\s"'<>()[\]]+/g) ?? [];
      const enlace = enlaces.find((e) => e.includes(`type=${tipo}`));
      if (enlace) return enlace;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No ha llegado al buzón local ningún correo de tipo «${tipo}» para ${direccion}.`);
}

// ── Enlace lento (para ver avanzar una subida) ───────────────────────────

/**
 * Proxy HTTP local que reenvía todo tal cual, salvo las subidas a Storage: esas
 * las lee despacio (unos 2 MB/s). El navegador solo puede enviar al ritmo al
 * que el proxy lee, así que el progreso que mide es el de bytes realmente
 * enviados, y lo que llega a Storage es la petición auténtica de la aplicación.
 */
export async function proxyLento(): Promise<{ url: string; bytesSubidos: () => number; cerrar: () => Promise<void> }> {
  let bytes = 0;
  const servidor = http.createServer((entrada, salida) => {
    const destino = new URL(entrada.url ?? '/');
    const reenvio = http.request(
      {
        host: destino.hostname,
        port: destino.port,
        path: destino.pathname + destino.search,
        method: entrada.method,
        headers: entrada.headers,
      },
      (respuesta) => {
        salida.writeHead(respuesta.statusCode ?? 502, respuesta.headers);
        respuesta.pipe(salida);
      },
    );
    reenvio.on('error', () => salida.destroy());
    const esSubida = entrada.method === 'POST' && destino.pathname.startsWith('/storage/v1/object/brand-media/');
    if (!esSubida) {
      entrada.pipe(reenvio);
      return;
    }
    entrada.on('data', (trozoDeDatos: Buffer) => {
      bytes += trozoDeDatos.length;
      entrada.pause();
      reenvio.write(trozoDeDatos);
      setTimeout(() => entrada.resume(), Math.ceil(trozoDeDatos.length / 2000));
    });
    entrada.on('end', () => reenvio.end());
  });
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const { port } = servidor.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bytesSubidos: () => bytes,
    cerrar: () =>
      new Promise<void>((cerrado) => {
        servidor.closeAllConnections();
        servidor.close(() => cerrado());
      }),
  };
}

// ── Base de datos local (solo para comprobar lo que la interfaz no enseña) ──

export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  texto: string,
  parametros: unknown[] = [],
): Promise<T[]> {
  const cliente = new pg.Client({ connectionString: LOCAL.db });
  await cliente.connect();
  try {
    return (await cliente.query(texto, parametros)).rows as T[];
  } finally {
    await cliente.end();
  }
}

/**
 * Asigna un plan a una organización directamente en la base de datos (Fase 6).
 * Las organizaciones de la tanda nacen en «Prueba» (una marca, dos personas,
 * sin reels ni imagen con IA); los escenarios 01 a 12 las pasan a «Heredado»,
 * que es como funcionaba todo antes de los planes: sin límites y con la IA
 * solo por el cupo que asigna la plataforma.
 */
export async function asignarPlan(organizationId: string, code: string): Promise<void> {
  const filas = await sql(
    `update public.subscriptions
     set plan_id = (select id from public.plans where code = $2), source = 'manual', status = 'active',
         stripe_subscription_id = null, note = 'Prueba de extremo a extremo'
     where organization_id = $1 returning organization_id`,
    [organizationId, code],
  );
  if (filas.length !== 1) throw new Error(`No se pudo asignar el plan ${code} a ${organizationId}`);
}

// ── Archivos de prueba ───────────────────────────────────────────────────

function trozo(tipo: string, datos: Buffer): Buffer {
  const cabecera = Buffer.alloc(4);
  cabecera.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
  const suma = Buffer.alloc(4);
  suma.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([cabecera, cuerpo, suma]);
}

/**
 * PNG válido generado en memoria. Con `ruido`, los píxeles son pseudoaleatorios
 * y el archivo no se comprime: sirve para fabricar un archivo de varios MB.
 */
export function png(ancho: number, alto: number, color: [number, number, number], ruido = false): Buffer {
  const fila = ancho * 3 + 1;
  const crudo = Buffer.alloc(fila * alto);
  let semilla = (color[0] << 16) | (color[1] << 8) | color[2] | 1;
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = y * fila + 1 + x * 3;
      if (ruido) {
        // xorshift32: rápido y sin dependencias.
        semilla ^= semilla << 13;
        semilla ^= semilla >>> 17;
        semilla ^= semilla << 5;
        crudo.writeUInt8(semilla & 0xff, i);
        crudo.writeUInt8((semilla >>> 8) & 0xff, i + 1);
        crudo.writeUInt8((semilla >>> 16) & 0xff, i + 2);
      } else {
        crudo.writeUInt8(color[0], i);
        crudo.writeUInt8(color[1], i + 1);
        crudo.writeUInt8(color[2], i + 2);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr.writeUInt8(8, 8); // 8 bits por canal
  ihdr.writeUInt8(2, 9); // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', deflateSync(crudo, { level: ruido ? 1 : 9 })),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

export function archivoPng(nombre: string, datos: Buffer) {
  return { name: nombre, mimeType: 'image/png', buffer: datos };
}

// ── Pasos comunes de la interfaz ─────────────────────────────────────────

/** Alta de una cuenta por la interfaz, con confirmación del correo desde el buzón local. */
export async function registrar(page: Page, alias: Alias): Promise<void> {
  await page.goto('/registro');
  await page.getByTestId('register-name').fill(NOMBRES[alias]);
  await page.getByTestId('register-email').fill(correo(alias));
  await page.getByTestId('register-password').fill(CLAVE_INICIAL);
  // Consentimiento (RGPD): sin la casilla el botón no se activa.
  await page.getByTestId('register-accept').check();
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('register-confirm')).toContainText(correo(alias));
}

export async function confirmarCorreo(page: Page, alias: Alias): Promise<void> {
  await page.goto(await enlaceDelCorreo(correo(alias), 'signup'));
  // El enlace vuelve a la aplicación con la sesión ya iniciada. Si la máquina va
  // cargada, Auth puede confirmar la cuenta y aun así responder 504 (su tope es
  // de 10 s): el enlace es de un solo uso, así que en ese caso se entra a mano.
  const volvio = await page
    .waitForURL(new RegExp(`^${LOCAL.app}`), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!volvio) await entrar(page, alias);
  await expect(page.getByTestId('user-menu').first()).toBeVisible();
}

/** Identificador que aparece en la URL tras `/o/` o `/m/`. */
export function idDeUrl(url: string, segmento: 'o' | 'm'): string {
  const id = new RegExp(`/${segmento}/([0-9a-f-]{36})`).exec(url)?.[1];
  if (!id) throw new Error(`La URL ${url} no contiene /${segmento}/<id>.`);
  return id;
}

/**
 * Pulsa una acción secundaria de la cabecera de una página: están en el menú
 * «⋯» (`editor-more`, `library-more`, `calendar-more`…), no a la vista.
 */
export async function accionDelMenu(page: Page, menu: string, accion: string): Promise<void> {
  await page.getByTestId(menu).click();
  await page.getByRole('menu').getByTestId(accion).click();
}
