// Servidor HTTP local que habla como la autenticación, PostgREST y Storage de
// Supabase, con datos en memoria. No se conecta a ningún Supabase: sirve para
// comprobar qué pide la herramienta, con qué identidad y qué hace con la respuesta.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ANON_KEY = 'clave-publica-de-prueba';
export const USER_TOKEN = 'token-de-la-cuenta-de-la-agencia';
export const AGENCY_USER = { id: '11111111-1111-4111-8111-111111111111', email: 'agencia@agencia.test' };
export const PASSWORD = 'contraseña-de-prueba';

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type RpcHandler = (body: Record<string, unknown>) => { status: number; body: unknown };

export interface FakeSupabase {
  url: string;
  seen: Seen[];
  /** Filas que devuelve cada tabla (se filtran por `id=eq.` si se pide). */
  tables: Record<string, object[]>;
  rpc: Record<string, RpcHandler>;
  close(): Promise<void>;
}

export async function startFakeSupabase(): Promise<FakeSupabase> {
  const fake: Omit<FakeSupabase, 'url' | 'close'> = { seen: [], tables: {}, rpc: {} };
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url!, 'http://localhost');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    fake.seen.push({
      method: request.method!,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body,
    });
    const json = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };

    if (request.headers.apikey !== ANON_KEY) return json(401, { message: 'Invalid API key' });

    if (url.pathname === '/auth/v1/token') {
      if (body?.email === AGENCY_USER.email && body?.password === PASSWORD) {
        return json(200, { access_token: USER_TOKEN, token_type: 'bearer', user: AGENCY_USER });
      }
      return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }

    if (request.headers.authorization !== `Bearer ${USER_TOKEN}`) {
      return json(401, { message: 'JWT expired', code: 'PGRST301' });
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const handler = fake.rpc[url.pathname.slice('/rest/v1/rpc/'.length)];
      if (!handler) return json(404, { code: 'PGRST202', message: 'Could not find the function' });
      const reply = handler(body ?? {});
      return json(reply.status, reply.body);
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      let rows = (fake.tables[table] ?? []) as Record<string, unknown>[];
      const id = url.searchParams.get('id');
      if (id?.startsWith('eq.')) rows = rows.filter((r) => r.id === id.slice(3));
      if (id?.startsWith('in.(')) {
        const ids = id.slice(4, -1).split(',');
        rows = rows.filter((r) => ids.includes(r.id as string));
      }
      const kind = url.searchParams.get('kind');
      if (kind?.startsWith('eq.')) rows = rows.filter((r) => r.kind === kind.slice(3));
      return json(200, rows);
    }

    if (url.pathname === '/storage/v1/object/sign/brand-media') {
      const paths = (body?.paths as string[]) ?? [];
      return json(
        200,
        paths.map((p) => ({ path: p, signedURL: `/object/sign/brand-media/${p}?token=firmado`, error: null })),
      );
    }

    return json(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    ...fake,
    get seen() {
      return fake.seen;
    },
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
