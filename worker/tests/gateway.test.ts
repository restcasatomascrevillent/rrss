// Cola y almacenamiento por el intermediario `worker-gateway` contra un
// servidor HTTP local que lo SIMULA (las mismas rutas y respuestas). Aquí se
// comprueba lo del trabajador: qué pide, con qué token, que nunca manda una
// clave de Supabase, cómo resuelve las URL relativas y cómo trata los
// errores. La prueba con el intermediario y la base de datos de verdad está en
// tests/db/trabajador-gateway.test.ts. También, las reglas de la
// configuración (en Fly no arranca con la clave de servicio).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { LeaseLostError, PermanentError } from '../src/errors.ts';
import { createGatewayQueue, createGatewayStorage } from '../src/gateway.ts';
import type { Job } from '../src/queue.ts';

const TOKEN = `rrss_wgt_${'a'.repeat(43)}`;
const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND = '22222222-2222-4222-8222-222222222222';
const JOB: Job = {
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: ORG,
  brand_id: BRAND,
  kind: 'media.image.process',
  payload: {},
  attempts: 1,
  max_attempts: 3,
};

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let base: string;
let dir: string;
const seen: Seen[] = [];
const stored = new Map<string, Buffer>();
let reply: ((route: string, body: Record<string, unknown>) => { status: number; body: unknown } | null) | null = null;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rrss-worker-gateway-'));
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
    const json = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    const url = request.url!;
    if (url.startsWith('/functions/v1/worker-gateway/')) {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: 'unauthorized' } });
      const route = url.slice('/functions/v1/worker-gateway'.length);
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const custom = reply?.(route, parsed);
      if (custom) return json(custom.status, custom.body);
      if (route === '/claim') return json(200, { jobs: [JOB] });
      if (route === '/read-url') {
        // Lo de Supabase llega relativo; lo de R2, absoluto.
        const p = String(parsed.path);
        return json(
          200,
          p.includes('/r2/')
            ? { backend: 'r2', url: `${base}/r2-bucket/${p}?firma=1` }
            : { backend: 'supabase', url: `/storage/v1/object/sign/brand-media/${p}?token=t` },
        );
      }
      if (route === '/write-url') {
        return json(200, {
          backend: 'supabase',
          url: `/storage/v1/object/upload/sign/brand-media/${String(parsed.path)}?token=t`,
          method: 'PUT',
          headers: { 'Content-Type': String(parsed.contentType) },
        });
      }
      return json(200, { ok: true });
    }
    // Almacén: ni token del trabajador ni ninguna clave; la firma va en la URL.
    if (request.headers.authorization || request.headers.apikey) return json(400, { message: 'sin credenciales' });
    const key = decodeURIComponent(
      url.split('?')[0]!.replace(/^\/(storage\/v1\/object\/(upload\/)?sign\/brand-media|r2-bucket)\//, ''),
    );
    if (request.method === 'PUT') {
      stored.set(key, body);
      return json(200, {});
    }
    const file = stored.get(key);
    if (!file) return json(404, { message: 'Object not found' });
    response.writeHead(200);
    response.end(file);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  reply = null;
});

const options = () => ({ supabaseUrl: base, token: TOKEN });
const gatewayCalls = () => seen.filter((s) => s.url.startsWith('/functions/v1/worker-gateway/'));

describe('cola por el intermediario', () => {
  it('cada operación va con el token del trabajador y su nombre, nunca con una clave de Supabase', async () => {
    const queue = createGatewayQueue(options());
    expect(
      await queue.claim({ worker: 'media-1', kinds: ['media.image.process'], limit: 2, leaseSeconds: 60 }),
    ).toEqual([JOB]);
    await queue.complete(JOB.id, 'media-1', { ok: true });
    await queue.fail(JOB.id, 'media-1', 'se rompió', false);
    await queue.release(JOB.id, 'media-1');
    await queue.extendLease(JOB.id, 'media-1', 120);
    const calls = gatewayCalls();
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['claim', 'complete', 'fail', 'release', 'extend']);
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.headers.apikey).toBeUndefined();
    }
    expect(JSON.parse(calls[0]!.body.toString())).toEqual({
      worker: 'media-1',
      kinds: ['media.image.process'],
      limit: 2,
      leaseSeconds: 60,
    });
    expect(JSON.parse(calls[2]!.body.toString())).toMatchObject({ jobId: JOB.id, error: 'se rompió', retry: false });
  });

  it('reserva perdida → LeaseLostError; rechazos → PermanentError; caídas → error que se reintenta', async () => {
    const queue = createGatewayQueue(options());
    reply = () => ({
      status: 409,
      body: { error: { code: 'lease_lost', message: 'no está reservado por este trabajador' } },
    });
    await expect(queue.complete(JOB.id, 'media-1', {})).rejects.toBeInstanceOf(LeaseLostError);
    reply = () => ({ status: 403, body: { error: { code: 'forbidden', message: 'token revocado' } } });
    await expect(queue.extendLease(JOB.id, 'media-1', 60)).rejects.toBeInstanceOf(PermanentError);
    reply = () => ({ status: 503, body: 'no disponible' });
    const error = await queue.claim({ worker: 'media-1', kinds: [], limit: 1, leaseSeconds: 60 }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentError);
    expect(String(error.message)).toMatch(/503/);
  });

  it('con otra dirección del intermediario (WORKER_GATEWAY_URL)', async () => {
    const queue = createGatewayQueue({ ...options(), gatewayUrl: `${base}/functions/v1/worker-gateway/` });
    await queue.release(JOB.id, 'media-1');
    expect(gatewayCalls()[0]!.url).toBe('/functions/v1/worker-gateway/release');
  });
});

describe('almacenamiento por el intermediario', () => {
  it('solo dentro de un trabajo: sin él no toca ningún archivo', async () => {
    const storage = createGatewayStorage(options());
    await expect(storage.download(`${ORG}/${BRAND}/media/x.jpg`, path.join(dir, 'x'))).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(seen).toHaveLength(0);
  });

  it('sube y baja por URL firmadas: relativas contra SUPABASE_URL y absolutas de R2', async () => {
    const storage = createGatewayStorage(options()).forJob!(JOB, 'media-1');
    const local = path.join(dir, 'salida.jpg');
    await writeFile(local, 'jpeg-de-prueba');
    const target = `${ORG}/${BRAND}/recortes/salida.jpg`;
    await storage.upload(local, target, { contentType: 'image/jpeg' });
    expect(stored.get(target)?.toString()).toBe('jpeg-de-prueba');
    const write = JSON.parse(gatewayCalls()[0]!.body.toString());
    expect(write).toEqual({ worker: 'media-1', jobId: JOB.id, path: target, contentType: 'image/jpeg', bytes: 14 });

    const back = path.join(dir, 'vuelta.jpg');
    await storage.download(target, back);
    expect(await readFile(back, 'utf8')).toBe('jpeg-de-prueba');

    stored.set(`${ORG}/${BRAND}/r2/clip.mp4`, Buffer.from('mp4'));
    await storage.download(`${ORG}/${BRAND}/r2/clip.mp4`, path.join(dir, 'clip.mp4'));
    expect(await readFile(path.join(dir, 'clip.mp4'), 'utf8')).toBe('mp4');
    // El almacén nunca recibe el token ni una clave (el servidor lo rechazaría).
    expect(seen.filter((s) => !s.url.includes('worker-gateway')).every((s) => !s.headers.authorization)).toBe(true);
  });

  it('un archivo que no existe, o una ruta que el intermediario rechaza, no se reintenta', async () => {
    const storage = createGatewayStorage(options()).forJob!(JOB, 'media-1');
    await expect(storage.download(`${ORG}/${BRAND}/media/no-esta.jpg`, path.join(dir, 'n'))).rejects.toBeInstanceOf(
      PermanentError,
    );
    reply = (route) =>
      route === '/read-url'
        ? {
            status: 403,
            body: { error: { code: 'forbidden', message: 'La ruta no pertenece a la marca del trabajo' } },
          }
        : null;
    await expect(storage.download(`${ORG}/otra/media/x.jpg`, path.join(dir, 'm'))).rejects.toThrow(/no pertenece/);
  });

  it('por encima del tope del cubo de Supabase, avisa antes de subir', async () => {
    const storage = createGatewayStorage({ ...options(), maxObjectBytes: 4 }).forJob!(JOB, 'media-1');
    const local = path.join(dir, 'grande.jpg');
    await writeFile(local, 'demasiado');
    await expect(
      storage.upload(local, `${ORG}/${BRAND}/recortes/g.jpg`, { contentType: 'image/jpeg' }),
    ).rejects.toThrow(/como máximo/);
    expect(seen.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });
});

describe('configuración: cómo entra el trabajador en Supabase', () => {
  const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
  const SERVICE = 'sb_secret_000000000000000000000000';

  it('por defecto, el intermediario con el token; la clave, si alguien la pone, ni se guarda', () => {
    const config = loadConfig({
      SUPABASE_URL: URL_OK,
      WORKER_GATEWAY_TOKEN: TOKEN,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    });
    expect(config.WORKER_SUPABASE_ACCESS).toBe('gateway');
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it('sin token, o con una clave de Supabase en su lugar, no arranca (y no enseña el valor)', () => {
    expect(() => loadConfig({ SUPABASE_URL: URL_OK })).toThrow(/WORKER_GATEWAY_TOKEN: falta/);
    let message = '';
    try {
      loadConfig({ SUPABASE_URL: URL_OK, WORKER_GATEWAY_TOKEN: SERVICE });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no es un token del trabajador/);
    expect(message).not.toContain(SERVICE);
  });

  it('en local, con el modo explícito, sigue funcionando con la clave de servicio', () => {
    const config = loadConfig({
      SUPABASE_URL: 'http://127.0.0.1:54321',
      WORKER_SUPABASE_ACCESS: 'service-key',
      SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    });
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBe(SERVICE);
    expect(() => loadConfig({ SUPABASE_URL: URL_OK, WORKER_SUPABASE_ACCESS: 'service-key' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY: falta/,
    );
  });

  it('en Fly.io no arranca si encuentra la clave de servicio, aunque también esté el token', () => {
    const fly = { FLY_APP_NAME: 'rrss-worker', FLY_MACHINE_ID: '148e21dc7d0189', SUPABASE_URL: URL_OK };
    expect(() => loadConfig({ ...fly, WORKER_GATEWAY_TOKEN: TOKEN, SUPABASE_SERVICE_ROLE_KEY: SERVICE })).toThrow(
      /en Fly\.io el trabajador no arranca con la clave de servicio/,
    );
    expect(() =>
      loadConfig({ ...fly, WORKER_SUPABASE_ACCESS: 'service-key', SUPABASE_SERVICE_ROLE_KEY: SERVICE }),
    ).toThrow(/en Fly\.io/);
    expect(loadConfig({ ...fly, WORKER_GATEWAY_TOKEN: TOKEN }).WORKER_SUPABASE_ACCESS).toBe('gateway');
  });
});
