// Lógica de la Edge Function `platform-integrations` (Plataforma → Integraciones).
// Sin nada de Deno: recibe sus dependencias y devuelve una `Response`, así las
// pruebas la ejecutan en Node con la base de datos real y servicios simulados.
//
// Una sola dirección, POST con `{ action, … }` y la sesión del usuario:
//   availability        cualquiera con sesión: qué integraciones están listas
//                       (solo booleanos), para que la interfaz enseñe lo que funciona.
//   status              superadministrador: qué ajustes hay guardados (los secretos,
//                       SIN valor: «configurado · …a1b2 · fecha · quién»), cuáles
//                       vienen de variables de entorno, la última prueba y la actividad.
//   save                superadministrador: guarda o borra ajustes de UNA integración
//                       (`values: { NOMBRE: "valor" | null }`).
//   test                superadministrador: «Probar conexión» (probes.ts).
//   generate_token_key  superadministrador: añade una clave nueva de cifrado de los
//                       tokens de las redes y la deja como la que cifra lo nuevo.
//   generate_worker_token  superadministrador: token nuevo del trabajador de medios
//                       para `worker-gateway`. Se guarda SOLO su huella SHA-256
//                       (WORKER_GATEWAY_TOKEN, cifrada en Vault) y el token sale
//                       una única vez en la respuesta, para pegarlo en Fly.
//
// El permiso lo impone la base de datos: las RPC de escritura se llaman con la
// sesión del usuario y rechazan a quien no es superadministrador. Ninguna
// respuesta lleva un valor secreto, y los registros tampoco.
import type { RpcClient } from '../_shared/ai/contract.ts';
import type { MediaModelRow } from '../_shared/ai/media/models.ts';
import { computeAvailability, NOTHING_AVAILABLE } from '../_shared/integrations/availability.ts';
import {
  INTEGRATION_IDS,
  INTEGRATION_SETTINGS,
  settingSpec,
  validateSetting,
  WORKER_GATEWAY_TOKEN_PATTERN,
  type IntegrationId,
} from '../_shared/integrations/catalog.ts';
import type { ProbeResult } from '../_shared/integrations/probes.ts';
import type { Env, SettingsLoader } from '../_shared/integrations/settings.ts';

export interface PlatformIntegrationsDeps {
  /** Valida el token de sesión y devuelve el usuario, o `null`. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  /** RPC con la sesión del usuario (su JWT): la base de datos decide si es superadministrador. */
  userRpc(accessToken: string): RpcClient;
  /** RPC con la clave de servicio. */
  rpc: RpcClient;
  settings: SettingsLoader;
  /** Variables de entorno de la función: para decir qué viene de ahí (sin valores). */
  baseEnv: Env;
  /** Modelos de imagen activos (`ai_media_models`), con la clave de servicio. */
  imageModelRows(): Promise<MediaModelRow[]>;
  probe(id: IntegrationId, env: Env): Promise<ProbeResult>;
  /** 32 bytes aleatorios en base64 (clave nueva de cifrado de los tokens). */
  randomKey?: () => string;
  /** Token nuevo del trabajador («rrss_wgt_» + 32 bytes en base64url). */
  randomWorkerToken?: () => string;
  now?: () => Date;
  allowedOrigin?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

const isIntegration = (value: unknown): value is IntegrationId =>
  typeof value === 'string' && (INTEGRATION_IDS as readonly string[]).includes(value);

function defaultRandomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function defaultWorkerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `rrss_wgt_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

/** Huella que se guarda del token del trabajador: «sha256:<hex>». */
export async function workerTokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createPlatformIntegrationsHandler(
  deps: PlatformIntegrationsDeps,
): (request: Request) => Promise<Response> {
  const cors = {
    'access-control-allow-origin': deps.allowedOrigin ?? '*',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  const fail = (status: number, code: string, message: string) => json(status, { error: { code, message } });
  const rpcFailure = (error: { code?: string; message: string }) =>
    error.code === '42501'
      ? fail(403, 'forbidden', 'Solo para superadministradores.')
      : error.code === '22023'
        ? fail(400, 'invalid', error.message)
        : fail(500, 'internal', 'No se ha podido completar. Inténtalo de nuevo.');

  async function availability() {
    try {
      const env = await deps.settings.get();
      return computeAvailability(env, await deps.imageModelRows());
    } catch {
      deps.log?.('availability_failed', {});
      return NOTHING_AVAILABLE;
    }
  }

  /** ¿Es superadministrador? Se pregunta a la base de datos con su sesión. */
  async function requireAdmin(token: string): Promise<Response | null> {
    const r = await deps.userRpc(token)('admin_integration_tests', {});
    if (r.error) return rpcFailure(r.error);
    return null;
  }

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    const token = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]?.trim();
    const user = token ? await deps.authenticate(token).catch(() => null) : null;
    if (!token || !user) return fail(401, 'unauthorized', 'Tu sesión ha caducado. Vuelve a iniciar sesión.');

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no es un objeto');
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, 'bad_request', 'La petición no es válida.');
    }

    if (body.action === 'availability') return json(200, await availability());

    const denied = await requireAdmin(token);
    if (denied) return denied;
    const asUser = deps.userRpc(token);

    if (body.action === 'status') {
      const [settings, tests, audit] = await Promise.all([
        asUser('admin_integration_settings', {}),
        asUser('admin_integration_tests', {}),
        asUser('admin_integration_audit', { p_limit: 30 }),
      ]);
      for (const r of [settings, tests, audit]) if (r.error) return rpcFailure(r.error);
      const environment = INTEGRATION_SETTINGS.filter((s) => Boolean(deps.baseEnv[s.key]?.trim())).map((s) => s.key);
      return json(200, {
        settings: settings.data ?? [],
        tests: tests.data ?? [],
        audit: audit.data ?? [],
        environment,
        availability: await availability(),
      });
    }

    if (body.action === 'save') {
      if (!isIntegration(body.integration)) return fail(400, 'bad_request', 'Falta la integración.');
      const values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return fail(400, 'bad_request', 'Faltan los valores.');
      }
      const entries = Object.entries(values as Record<string, unknown>);
      if (entries.length === 0 || entries.length > 60) return fail(400, 'bad_request', 'Faltan los valores.');
      // Todo se comprueba antes de guardar nada.
      for (const [key, value] of entries) {
        const spec = settingSpec(key);
        if (!spec || spec.integration !== body.integration) {
          return fail(400, 'invalid', `«${key.slice(0, 64)}» no es un ajuste de esta integración.`);
        }
        if (key === 'SOCIAL_TOKEN_KEYS') {
          return fail(400, 'invalid', 'Las claves de cifrado de los tokens solo se generan con «Generar clave».');
        }
        // Revocarlo (null) sí; ponerlo a mano, no.
        if (key === 'WORKER_GATEWAY_TOKEN' && value !== null) {
          return fail(400, 'invalid', 'El token del trabajador solo se genera con «Generar token».');
        }
        if (value !== null && typeof value !== 'string') return fail(400, 'invalid', `Valor no válido en ${key}.`);
        if (typeof value === 'string') {
          const problem = validateSetting(key, value);
          if (problem) return fail(400, 'invalid', `${key}: ${problem}`);
        }
      }
      for (const [key, value] of entries) {
        const r =
          value === null
            ? await asUser('admin_delete_integration_setting', { p_key: key })
            : await asUser('admin_set_integration_setting', { p_key: key, p_value: (value as string).trim() });
        if (r.error) {
          deps.settings.invalidate();
          deps.log?.('save_failed', { key, code: r.error.code ?? null });
          return rpcFailure(r.error);
        }
      }
      deps.settings.invalidate();
      deps.log?.('saved', { integration: body.integration, keys: entries.map(([k]) => k) });
      return json(200, { saved: entries.map(([k]) => k) });
    }

    if (body.action === 'test') {
      if (!isIntegration(body.integration)) return fail(400, 'bad_request', 'Falta la integración.');
      deps.settings.invalidate();
      let result: ProbeResult;
      try {
        result = await deps.probe(body.integration, await deps.settings.get());
      } catch {
        deps.log?.('probe_failed', { integration: body.integration });
        result = { ok: false, message: 'No se pudo hacer la prueba (error inesperado del servidor).', checks: [] };
      }
      const recorded = await deps.rpc('integration_record_test', {
        p_user_id: user.userId,
        p_integration: body.integration,
        p_ok: result.ok,
        p_message: result.message.slice(0, 500),
      });
      if (recorded.error) deps.log?.('record_test_failed', { code: recorded.error.code ?? null });
      deps.log?.('tested', { integration: body.integration, ok: result.ok });
      return json(200, result);
    }

    if (body.action === 'generate_token_key') {
      const stored = await deps.rpc('integration_settings_for_service', {});
      if (stored.error) return fail(500, 'internal', 'No se han podido leer las claves actuales.');
      const current = (stored.data as Record<string, unknown> | null)?.SOCIAL_TOKEN_KEYS;
      const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/\D/g, '').slice(0, 14);
      const keyId = `k${stamp}`;
      const entry = `${keyId}:${(deps.randomKey ?? defaultRandomKey)()}`;
      const ring = typeof current === 'string' && current.trim() ? `${current.trim()},${entry}` : entry;
      for (const [key, value] of [
        ['SOCIAL_TOKEN_KEYS', ring],
        ['SOCIAL_TOKEN_KEY_ID', keyId],
      ] as const) {
        const r = await asUser('admin_set_integration_setting', { p_key: key, p_value: value });
        if (r.error) {
          deps.settings.invalidate();
          return rpcFailure(r.error);
        }
      }
      deps.settings.invalidate();
      deps.log?.('token_key_generated', { keyId });
      return json(200, { keyId });
    }

    if (body.action === 'generate_worker_token') {
      const token = (deps.randomWorkerToken ?? defaultWorkerToken)();
      if (!WORKER_GATEWAY_TOKEN_PATTERN.test(token)) return fail(500, 'internal', 'No se ha podido generar el token.');
      const r = await asUser('admin_set_integration_setting', {
        p_key: 'WORKER_GATEWAY_TOKEN',
        p_value: `sha256:${await workerTokenHash(token)}`,
      });
      deps.settings.invalidate();
      if (r.error) return rpcFailure(r.error);
      deps.log?.('worker_token_generated', {});
      // La única vez que sale: no se guarda ni se registra.
      return json(200, { token });
    }

    return fail(400, 'bad_request', 'Acción desconocida.');
  };
}
