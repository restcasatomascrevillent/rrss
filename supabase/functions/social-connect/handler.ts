// Lógica de la Edge Function `social-connect` (../_shared/social/oauth.ts):
//   POST …/social-connect/start     con la sesión del usuario → { url } del diálogo de Meta
//   GET  …/social-connect/callback  vuelta de Meta (sin sesión: la autentica el
//                                   estado anti-CSRF) → 302 a la aplicación
//   POST …/social-connect/token     con la sesión del usuario: conectar pegando un
//                                   token de página (../_shared/social/token-connect.ts)
// En config.toml lleva `verify_jwt = false`: Meta vuelve sin JWT de Supabase. El
// inicio comprueba la sesión con `social_oauth_begin`, que se ejecuta con el
// token del usuario (sin sesión válida, la base de datos lo rechaza).
import type { RpcClient } from '../_shared/ai/contract.ts';
import type { SocialConfig } from '../_shared/social/config.ts';
import { ConnectError, finishConnect, startConnect } from '../_shared/social/oauth.ts';
import { connectWithToken } from '../_shared/social/token-connect.ts';

export interface SocialConnectDeps {
  config: SocialConfig;
  /** RPC con la clave de servicio. */
  rpc: RpcClient;
  /** RPC con la sesión del usuario (su JWT). */
  userRpc(accessToken: string): RpcClient;
  /** Origen permitido para CORS (por defecto, cualquiera: la sesión va en cabecera, no en cookie). */
  allowedOrigin?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export function createSocialConnectHandler(deps: SocialConnectDeps): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
    });

  return async (request) => {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname.endsWith('/callback')) {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      let location: string;
      try {
        location = await finishConnect(deps.config, deps.rpc, url.searchParams, deps.log);
      } catch {
        deps.log?.('callback_failed', {});
        location = `${deps.config.appUrl ?? ''}/?social=failed`;
      }
      return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
    }

    if (url.pathname.endsWith('/token')) {
      if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Hace falta iniciar sesión.' } });
      let body: { brandId?: unknown; network?: unknown; igUserId?: unknown; accessToken?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: { code: 'bad_request', message: 'Cuerpo no válido.' } });
      }
      try {
        const result = await connectWithToken(
          deps.config,
          deps.rpc,
          deps.userRpc(token),
          {
            brandId: body?.brandId,
            network: body?.network,
            igUserId: body?.igUserId,
            accessToken: body?.accessToken,
          },
          deps.log,
        );
        return json(200, result);
      } catch (e) {
        if (e instanceof ConnectError) return json(e.status, { error: { code: e.code, message: e.message } });
        deps.log?.('token_connect_failed', {});
        return json(500, { error: { code: 'internal', message: 'No se pudo conectar la cuenta.' } });
      }
    }

    if (url.pathname.endsWith('/start')) {
      if (request.method !== 'POST') return json(405, { error: { code: 'method_not_allowed' } });
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Hace falta iniciar sesión.' } });
      let body: { brandId?: unknown; network?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: { code: 'bad_request', message: 'Cuerpo no válido.' } });
      }
      try {
        const target = await startConnect(deps.config, deps.userRpc(token), {
          brandId: body?.brandId,
          network: body?.network,
        });
        return json(200, { url: target });
      } catch (e) {
        if (e instanceof ConnectError) return json(e.status, { error: { code: e.code, message: e.message } });
        deps.log?.('start_failed', {});
        return json(500, { error: { code: 'internal', message: 'No se pudo empezar la conexión.' } });
      }
    }

    return json(404, { error: { code: 'not_found' } });
  };
}
