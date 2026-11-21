// Adaptadores de Supabase contra un servidor HTTP local que habla como
// PostgREST y como la API de Storage. No se conecta a ningún Supabase: lo que
// se comprueba es el formato de las peticiones y el tratamiento de errores.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeaseLostError, PermanentError } from '../src/errors.ts';
import { createSupabaseQueue, createSupabaseStorage, DEFAULT_MAX_OBJECT_BYTES } from '../src/supabase.ts';

const KEY = 'clave-de-servicio-de-prueba';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let url: string;
let dir: string;
const seen: Seen[] = [];
const objects = new Map<string, Buffer>();
let rpcReply: { status: number; body: unknown } = { status: 200, body: [] };
/** Cubo «R2» del servidor de prueba (URL firmadas sin cabeceras) y si `media-storage` existe. */
const r2Objects = new Map<string, Buffer>();
let mediaStorageDeployed = true;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rrss-worker-http-'));
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
    const json = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    // drive-media: la imagen va con la dirección firmada, sin cabeceras.
    if (request.url!.startsWith('/functions/v1/drive-media/file/')) {
      if (request.headers.authorization) return json(400, { message: 'no hace falta sesión' });
      const ticket = decodeURIComponent(request.url!.slice('/functions/v1/drive-media/file/'.length));
      if (ticket !== 'firma-de-prueba') return json(403, {});
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return response.end(Buffer.from('jpeg-de-drive'));
    }
    // «R2»: las URL firmadas llevan la firma en la dirección, nunca la clave de servicio.
    if (request.url!.startsWith('/r2/')) {
      if (request.headers.authorization || request.headers.apikey) return json(400, { message: 'sin credenciales' });
      const key = decodeURIComponent(request.url!.slice('/r2/'.length).split('?')[0]!);
      if (request.method === 'PUT') {
        if (request.headers['content-length'] !== String(body.length)) return json(403, { message: 'tamaño' });
        r2Objects.set(key, body);
        return json(200, {});
      }
      const stored = r2Objects.get(key);
      if (!stored) return json(404, {});
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return response.end(stored);
    }
    if (request.headers.apikey !== KEY || request.headers.authorization !== `Bearer ${KEY}`) {
      return json(401, { message: 'Invalid API key' });
    }
    if (request.url!.startsWith('/functions/v1/media-storage/')) {
      if (!mediaStorageDeployed) return json(404, { message: 'Function not found' });
      const input = JSON.parse(body.toString()) as { paths?: string[]; path?: string; bytes?: number };
      if (request.url!.endsWith('/sign')) {
        const urls = Object.fromEntries(
          (input.paths ?? []).map((p) =>
            r2Objects.has(p)
              ? [p, { backend: 'r2', url: `${url}/r2/${encodeURIComponent(p)}?X-Amz-Signature=x` }]
              : [p, { backend: 'supabase', url: `${url}/storage/v1/object/sign/brand-media/${p}` }],
          ),
        );
        return json(200, { urls });
      }
      if (input.path?.includes('/prohibido/')) return json(403, { error: { message: 'Solo quien edita la marca' } });
      return json(200, {
        backend: 'r2',
        url: `${url}/r2/${encodeURIComponent(input.path!)}?X-Amz-Signature=x`,
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
      });
    }
    if (request.url!.startsWith('/rest/v1/rpc/')) return json(rpcReply.status, rpcReply.body);
    if (request.url === '/functions/v1/drive-media/sign') {
      const { paths } = JSON.parse(body.toString()) as { paths: string[] };
      const tickets = Object.fromEntries(
        paths.filter((p) => p.endsWith('/drive/archivoDeDrive01')).map((p) => [p, { full: 'firma-de-prueba' }]),
      );
      return json(200, { tickets });
    }
    const object = decodeURIComponent(request.url!.replace('/storage/v1/object/', ''));
    if (request.method === 'POST') {
      objects.set(object, body);
      return json(200, { Key: object });
    }
    const stored = objects.get(object);
    if (!stored) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(stored);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  rpcReply = { status: 200, body: [] };
  mediaStorageDeployed = true;
});

describe('cola por PostgREST', () => {
  it('llama a las funciones de la cola con sus argumentos por nombre y la clave de servicio', async () => {
    const queue = createSupabaseQueue({ url: `${url}/`, serviceKey: KEY });
    const job = {
      id: 'j1',
      organization_id: 'o',
      brand_id: 'b',
      kind: 'media.image.process',
      payload: {},
      attempts: 1,
      max_attempts: 3,
    };
    rpcReply = { status: 200, body: [job] };

    expect(await queue.claim({ worker: 't1', kinds: ['media.image.process'], limit: 2, leaseSeconds: 600 })).toEqual([
      job,
    ]);
    rpcReply = { status: 200, body: job };
    await queue.complete('j1', 't1', { ok: true });
    await queue.fail('j1', 't1', 'Se cayó', true);
    await queue.release('j1', 't1');
    await queue.extendLease('j1', 't1', 300);

    expect(seen.map((r) => [r.method, r.url, JSON.parse(r.body.toString())])).toEqual([
      [
        'POST',
        '/rest/v1/rpc/claim_jobs',
        { p_worker: 't1', p_kinds: ['media.image.process'], p_limit: 2, p_lease_seconds: 600 },
      ],
      ['POST', '/rest/v1/rpc/complete_job', { p_job_id: 'j1', p_worker: 't1', p_result: { ok: true } }],
      ['POST', '/rest/v1/rpc/fail_job', { p_job_id: 'j1', p_worker: 't1', p_error: 'Se cayó', p_retry: true }],
      ['POST', '/rest/v1/rpc/release_job', { p_job_id: 'j1', p_worker: 't1' }],
      ['POST', '/rest/v1/rpc/extend_job_lease', { p_job_id: 'j1', p_worker: 't1', p_lease_seconds: 300 }],
    ]);
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });

  it('distingue «la reserva ya no es mía» de un fallo de la cola', async () => {
    const queue = createSupabaseQueue({ url, serviceKey: KEY });
    rpcReply = { status: 400, body: { code: 'P0001', message: 'El trabajo no está reservado por este trabajador' } };
    await expect(queue.complete('j1', 't1', {})).rejects.toThrow(LeaseLostError);
    await expect(queue.fail('j1', 't1', 'x', true)).rejects.toThrow(LeaseLostError);
    await expect(queue.release('j1', 't1')).rejects.toThrow(LeaseLostError);
    await expect(queue.extendLease('j1', 't1', 60)).rejects.toThrow(LeaseLostError);

    rpcReply = { status: 503, body: { message: 'upstream timeout' } };
    await expect(queue.claim({ worker: 't1', kinds: ['k'], limit: 1, leaseSeconds: 60 })).rejects.toThrow(
      /La cola respondió 503 a claim_jobs: upstream timeout/,
    );
    await expect(createSupabaseQueue({ url, serviceKey: 'otra' }).complete('j1', 't1', {})).rejects.toThrow(/401/);
  });
});

describe('almacenamiento por la API de Storage', () => {
  it('sube y baja archivos en flujo, con su tipo y sobrescribiendo', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media' });
    const source = path.join(dir, 'subida.bin');
    const content = Buffer.alloc(300_000, 7);
    await writeFile(source, content);

    await storage.upload(source, 'org/marca/reels/mi vídeo.mp4', { contentType: 'video/mp4' });

    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/storage/v1/object/brand-media/org/marca/reels/mi%20v%C3%ADdeo.mp4',
    });
    expect(seen[0]!.headers).toMatchObject({
      'content-type': 'video/mp4',
      'x-upsert': 'true',
      'content-length': '300000',
    });
    expect(objects.get('brand-media/org/marca/reels/mi vídeo.mp4')?.equals(content)).toBe(true);

    const target = path.join(dir, 'bajada.bin');
    await storage.download('org/marca/reels/mi vídeo.mp4', target);
    expect((await readFile(target)).equals(content)).toBe(true);
  });

  it('un resultado que supera el tope del cubo falla sin reintento y sin subir nada', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media', maxObjectBytes: 1024 * 1024 });
    const source = path.join(dir, 'grande.bin');
    await writeFile(source, Buffer.alloc(1.6 * 1024 * 1024, 1));
    const upload = storage.upload(source, 'org/marca/reels/grande.mp4', { contentType: 'video/mp4' });
    await expect(upload).rejects.toThrow(PermanentError);
    await expect(upload).rejects.toThrow(/pesa 1,6 MB y el almacenamiento admite 1,0 MB como máximo/);
    expect(seen).toEqual([]);
  });

  it('por defecto el tope es el del plan gratuito: 50 MB', () => {
    expect(DEFAULT_MAX_OBJECT_BYTES).toBe(52_428_800);
  });

  it('un archivo que no existe es un fallo sin remedio', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media' });
    await expect(storage.download('org/marca/no-existe.jpg', path.join(dir, 'x'))).rejects.toThrow(PermanentError);
  });

  it('un recurso de Google Drive se baja por drive-media con una dirección firmada', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media' });
    const org = '11111111-1111-4111-8111-111111111111';
    const marca = '22222222-2222-4222-8222-222222222222';
    const target = path.join(dir, 'drive.jpg');
    await storage.download(`${org}/${marca}/drive/archivoDeDrive01`, target);
    expect((await readFile(target)).toString()).toBe('jpeg-de-drive');
    expect(seen.map((s) => s.url)).toEqual([
      '/functions/v1/drive-media/sign',
      '/functions/v1/drive-media/file/firma-de-prueba',
    ]);
    // Uno que ya no existe (o de otra organización): fallo sin remedio.
    await expect(storage.download(`${org}/${marca}/drive/otroArchivo0001`, target)).rejects.toThrow(PermanentError);
  });
});

describe('almacenamiento con la función media-storage (Cloudflare R2)', () => {
  const org = '11111111-1111-4111-8111-111111111111';
  const marca = '22222222-2222-4222-8222-222222222222';

  it('sube el resultado a R2 con la URL firmada (sin clave de servicio) y lo vuelve a bajar por ella', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media', mediaStorage: true });
    const source = path.join(dir, 'r2.bin');
    const content = Buffer.alloc(70 * 1024, 3);
    await writeFile(source, content);
    const objectPath = `${org}/${marca}/reels/reel.mp4`;

    await storage.upload(source, objectPath, { contentType: 'video/mp4' });
    expect(seen.map((s) => `${s.method} ${s.url.split('?')[0]}`)).toEqual([
      'POST /functions/v1/media-storage/upload',
      `PUT /r2/${encodeURIComponent(objectPath)}`,
    ]);
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ path: objectPath, contentType: 'video/mp4', bytes: 71_680 });
    expect(r2Objects.get(objectPath)?.equals(content)).toBe(true);

    seen.length = 0;
    const target = path.join(dir, 'r2-bajada.bin');
    await storage.download(objectPath, target);
    expect((await readFile(target)).equals(content)).toBe(true);
    expect(seen.map((s) => s.url.split('?')[0])).toEqual([
      '/functions/v1/media-storage/sign',
      `/r2/${encodeURIComponent(objectPath)}`,
    ]);
  });

  it('en R2 el tope es el de R2, no el del cubo gratuito de Supabase', async () => {
    const storage = createSupabaseStorage({
      url,
      serviceKey: KEY,
      bucket: 'brand-media',
      maxObjectBytes: 1024 * 1024,
      mediaStorage: true,
    });
    const source = path.join(dir, 'r2-grande.bin');
    await writeFile(source, Buffer.alloc(1.5 * 1024 * 1024, 2));
    await storage.upload(source, `${org}/${marca}/reels/grande.mp4`, { contentType: 'video/mp4' });
    expect(r2Objects.has(`${org}/${marca}/reels/grande.mp4`)).toBe(true);
  });

  it('lo que la función dice que está en Supabase se baja de Storage con la clave, no por su URL', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media', mediaStorage: true });
    const objectPath = `${org}/${marca}/media/en-supabase.jpg`;
    objects.set(`brand-media/${objectPath}`, Buffer.from('de-supabase'));
    const target = path.join(dir, 'supabase-bajada.bin');
    await storage.download(objectPath, target);
    expect((await readFile(target)).toString()).toBe('de-supabase');
    expect(seen.map((s) => s.url)).toEqual([
      '/functions/v1/media-storage/sign',
      `/storage/v1/object/brand-media/${objectPath}`,
    ]);
  });

  it('si la función no está desplegada, usa Supabase Storage y no vuelve a preguntar enseguida', async () => {
    mediaStorageDeployed = false;
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media', mediaStorage: true });
    const source = path.join(dir, 'sin-funcion.bin');
    await writeFile(source, Buffer.from('hola'));
    await storage.upload(source, `${org}/${marca}/reels/a.mp4`, { contentType: 'video/mp4' });
    await storage.upload(source, `${org}/${marca}/reels/b.mp4`, { contentType: 'video/mp4' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /functions/v1/media-storage/upload',
      `POST /storage/v1/object/brand-media/${org}/${marca}/reels/a.mp4`,
      `POST /storage/v1/object/brand-media/${org}/${marca}/reels/b.mp4`,
    ]);
  });

  it('si la base de datos no deja subir a esa marca, es un fallo sin remedio', async () => {
    const storage = createSupabaseStorage({ url, serviceKey: KEY, bucket: 'brand-media', mediaStorage: true });
    const source = path.join(dir, 'prohibido.bin');
    await writeFile(source, Buffer.from('x'));
    await expect(
      storage.upload(source, `${org}/${marca}/prohibido/x.mp4`, { contentType: 'video/mp4' }),
    ).rejects.toThrow(PermanentError);
  });
});
