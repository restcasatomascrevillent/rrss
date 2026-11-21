// «Probar conexión» de cada integración: una llamada inocua y gratuita a cada
// servicio con la configuración efectiva (base de datos y, si no, entorno).
// Nunca genera, publica ni cobra nada, y los mensajes nunca citan un valor
// secreto (ni partes de él).
//
//   meta      GET /{app-id}?fields=id,name con el token de aplicación
//             (App ID|App Secret): Meta dice si reconoce la aplicación.
//   comfyui   GET {base}/system_stats: ComfyUI responde con su versión y GPU.
//   ai_text   por cada adaptador elegido: Anthropic, Mistral y OpenAI, listar modelos;
//             Vertex, pedir un token de acceso con la cuenta de servicio;
//             Bedrock, listar los modelos de Anthropic de la región.
//   ai_image  Vertex, pedir un token; Black Forest Labs, consultar el saldo
//             (/v1/credits). Ideogram no documenta ninguna llamada gratuita:
//             se dice así, sin gastar.
//   stripe    GET /v1/account con la clave secreta. El secreto del webhook no
//             se puede comprobar desde aquí: lo comprueba el primer aviso.
//   google_drive  Google no tiene una llamada gratuita que valide un cliente
//             OAuth sin una persona que lo autorice: se comprueba que la
//             configuración está completa y se dice que el cliente se
//             comprueba al conectar (como Ideogram, sin gastar nada).
//   r2        HeadBucket sobre el cubo con la clave (una operación de clase B,
//             dentro de las 10 M gratuitas al mes): dice si el cubo existe y
//             si la clave puede usarlo. No sube ni baja nada.
//   media_worker  GET /v1/apps/{app}/machines/{id} en la API de máquinas de
//             Fly: si la máquina existe, su estado y su región, y si el token
//             vale. No la arranca (arrancar es cosa de la base de datos).
//
// ⚠ Escrito contra la documentación de cada servicio y probado solo con
// servicios simulados (tests/db/integraciones-funciones.test.ts).
import { parseServiceAccountKey, createGoogleTokenSource, GOOGLE_TOKEN_URL } from '../ai/text/google-auth.ts';
import { signAwsRequest } from '../ai/text/sigv4.ts';
import { ANTHROPIC_API_VERSION } from '../ai/text/anthropic-messages.ts';
import { loadAiTextConfig } from '../ai/text/config.ts';
import { normalizeOpenAiBaseUrl } from '../ai/text/openai.ts';
import { loadLocalTestTextConfig } from '../ai/text/local-test.ts';
import { BFL_DEFAULT_BASE_URL, isBflBaseUrl } from '../ai/media/bfl-image.ts';
import { isComfyUiBaseUrl } from '../ai/media/comfyui-image.ts';
import { MEDIA_ENV } from '../ai/media/config.ts';
import { DEFAULT_GRAPH_API_VERSION, META_GRAPH_HOST } from '../social/meta-graph.ts';
import { loadSocialConfig } from '../social/config.ts';
import { loadDriveConfig } from '../drive/config.ts';
import { DRIVE_LOCAL_TEST_FLAG } from '../drive/local-test.ts';
import { loadMediaStorageConfig } from '../storage/config.ts';
import { createS3Storage } from '../storage/s3.ts';
import { FLY_APP_PATTERN, FLY_MACHINE_PATTERN, type IntegrationId } from './catalog.ts';
import type { Env } from './settings.ts';

export type ProbeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeCheck {
  name: string;
  /** null = no se puede comprobar desde aquí (se dice por qué). */
  ok: boolean | null;
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  checks: ProbeCheck[];
}

export interface ProbeDeps {
  fetch: ProbeFetch;
  /** Graph API para la prueba de Meta (en la prueba local, la simulada). */
  graphFetch?: ProbeFetch;
  timeoutMs?: number;
}

const value = (env: Env, name: string) => {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
};

async function call(
  deps: ProbeDeps,
  url: string,
  init: RequestInit = {},
  fetcher: ProbeFetch = deps.fetch,
): Promise<{ status: number; body: unknown } | { error: 'timeout' | 'network' }> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { error: timeout ? 'timeout' : 'network' };
  }
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const unreachable = (service: string, r: { error: 'timeout' | 'network' }) =>
  r.error === 'timeout' ? `${service} no respondió a tiempo.` : `No se pudo llegar a ${service} (red o dirección).`;

const rejected = (service: string, status: number) =>
  status === 401 || status === 403
    ? `${service} rechaza la clave (HTTP ${status}).`
    : `${service} respondió con un error (HTTP ${status}).`;

function summarize(checks: ProbeCheck[], empty: string): ProbeResult {
  if (checks.length === 0) return { ok: false, message: empty, checks };
  const failed = checks.filter((c) => c.ok === false);
  const passed = checks.filter((c) => c.ok === true);
  const ok = failed.length === 0 && passed.length > 0;
  const message = ok
    ? passed.map((c) => c.message).join(' ')
    : failed.length > 0
      ? failed.map((c) => c.message).join(' ')
      : checks.map((c) => c.message).join(' ');
  return { ok, message, checks };
}

// ─────────────────────────────── Meta ───────────────────────────────

async function probeMeta(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];
  const appId = value(env, 'META_APP_ID');
  const secret = value(env, 'META_APP_SECRET');
  const version = value(env, 'META_GRAPH_API_VERSION') ?? DEFAULT_GRAPH_API_VERSION;
  if (!appId || !secret) {
    checks.push({ name: 'Aplicación de Meta', ok: false, message: 'Faltan el App ID y el App Secret.' });
  } else if (!/^v\d+\.\d+$/.test(version)) {
    checks.push({
      name: 'Aplicación de Meta',
      ok: false,
      message: 'La versión de la Graph API no tiene la forma v27.0.',
    });
  } else {
    const u = new URL(`${META_GRAPH_HOST}/${version}/${encodeURIComponent(appId)}`);
    u.searchParams.set('fields', 'id,name');
    u.searchParams.set('access_token', `${appId}|${secret}`);
    const r = await call(deps, u.toString(), { headers: { Accept: 'application/json' } }, deps.graphFetch);
    if ('error' in r) {
      checks.push({ name: 'Aplicación de Meta', ok: false, message: unreachable('Meta', r) });
    } else {
      const body = (r.body ?? {}) as { id?: unknown; name?: unknown; error?: { code?: unknown } };
      if (r.status === 200 && String(body.id ?? '') === appId) {
        const name = typeof body.name === 'string' ? body.name.slice(0, 80) : 'sin nombre';
        checks.push({ name: 'Aplicación de Meta', ok: true, message: `Meta reconoce la aplicación «${name}».` });
      } else {
        const code = typeof body.error?.code === 'number' ? ` (código ${body.error.code})` : '';
        checks.push({
          name: 'Aplicación de Meta',
          ok: false,
          message: `Meta no reconoce el App ID con ese App Secret${code}.`,
        });
      }
    }
  }
  // Cifrado de los tokens: sin claves no se puede conectar ninguna cuenta. Se
  // cargan igual que en las funciones (en la prueba local, la clave fija de pruebas).
  try {
    const social = loadSocialConfig(env, async () => {
      throw new Error('sin red');
    });
    // El botón «Conectar con Meta» necesita además la dirección de vuelta: sin
    // ella la aplicación solo ofrece conectar con un token (availability.ts).
    if (social.meta) {
      checks.push(
        social.callbackUrl && social.appUrl
          ? { name: 'Conectar con Meta', ok: true, message: 'Sale el botón «Conectar con Meta».' }
          : {
              name: 'Conectar con Meta',
              ok: false,
              message: social.appUrl
                ? 'Falta la dirección de retorno de Meta (SOCIAL_CALLBACK_URL): no sale el botón «Conectar con Meta».'
                : 'Falta la dirección de la aplicación (SOCIAL_APP_URL): no sale el botón «Conectar con Meta», solo «Conectar con un token».',
            },
      );
    }
    const keyProblem = social.problems.find((p) => p.includes('SOCIAL_TOKEN_KEY'));
    checks.push(
      social.keyRing
        ? { name: 'Cifrado de los tokens', ok: true, message: 'Las claves de cifrado de los tokens están bien.' }
        : {
            name: 'Cifrado de los tokens',
            ok: false,
            message: keyProblem ?? 'Faltan las claves de cifrado de los tokens (SOCIAL_TOKEN_KEYS): genera una.',
          },
    );
  } catch {
    checks.push({
      name: 'Cifrado de los tokens',
      ok: false,
      message: 'La configuración de la publicación no es válida.',
    });
  }
  return summarize(checks, 'Meta no está configurada.');
}

// ─────────────────────────────── ComfyUI ───────────────────────────────

async function probeComfyUi(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const base = value(env, MEDIA_ENV.comfyUiBaseUrl);
  if (!base) return summarize([], 'Falta la dirección de ComfyUI.');
  if (!isComfyUiBaseUrl(base)) {
    return summarize(
      [
        {
          name: 'ComfyUI',
          ok: false,
          message: 'La dirección debe ser https (o http solo en la propia máquina), sin usuario ni contraseña.',
        },
      ],
      '',
    );
  }
  const token = value(env, MEDIA_ENV.comfyUiToken);
  const r = await call(deps, `${base.replace(/\/+$/, '')}/system_stats`, {
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const checks: ProbeCheck[] = [];
  if ('error' in r) {
    checks.push({ name: 'ComfyUI', ok: false, message: unreachable('ComfyUI', r) });
  } else if (r.status !== 200 || !r.body || typeof r.body !== 'object') {
    checks.push({ name: 'ComfyUI', ok: false, message: rejected('ComfyUI', r.status) });
  } else {
    const body = r.body as {
      system?: { comfyui_version?: unknown };
      devices?: Array<{ name?: unknown; vram_free?: unknown }>;
    };
    const version =
      typeof body.system?.comfyui_version === 'string' ? ` ${body.system.comfyui_version.slice(0, 20)}` : '';
    const device = body.devices?.[0];
    const gpu =
      device && typeof device.name === 'string'
        ? `, ${device.name.slice(0, 60)}${typeof device.vram_free === 'number' ? ` con ${(device.vram_free / 1024 ** 3).toFixed(1)} GB libres` : ''}`
        : '';
    checks.push({ name: 'ComfyUI', ok: true, message: `ComfyUI${version} responde${gpu}.` });
  }
  const region = value(env, MEDIA_ENV.comfyUiDataRegion) ?? 'unknown';
  if (region === 'unknown') {
    checks.push({
      name: 'Región de los datos',
      ok: null,
      message:
        'Región sin declarar: se trata como fuera de la UE (solo se ofrece si se admiten modelos de fuera de la UE).',
    });
  }
  return summarize(checks, '');
}

// ─────────────────────────────── IA de texto ───────────────────────────────

async function googleToken(json: string, deps: ProbeDeps): Promise<ProbeCheck> {
  const key = parseServiceAccountKey(json);
  if (!key) return { name: 'Google Vertex AI', ok: false, message: 'El JSON no es el de una cuenta de servicio.' };
  try {
    const source = createGoogleTokenSource({ key, fetch: (u, init) => deps.fetch(u, init) });
    await source(AbortSignal.timeout(deps.timeoutMs ?? 10_000));
    return {
      name: 'Google Vertex AI',
      ok: true,
      message: `Google da acceso a la cuenta de servicio ${key.clientEmail.slice(0, 120)}.`,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 160) : '';
    return {
      name: 'Google Vertex AI',
      ok: false,
      message: `Google no da acceso a la cuenta de servicio. ${detail}`.trim(),
    };
  }
}

async function probeAiText(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const local = loadLocalTestTextConfig(env);
  if (local) {
    return summarize(
      [{ name: 'Proveedor simulado', ok: true, message: 'Proveedor SIMULADO de pruebas locales: responde.' }],
      '',
    );
  }
  const config = loadAiTextConfig(env, { fetch: (u, init) => deps.fetch(u, init) });
  const checks: ProbeCheck[] = [];
  for (const [id, reason] of Object.entries(config.unavailable)) {
    checks.push({ name: id, ok: false, message: reason });
  }
  for (const provider of config.providers) {
    if (provider.id === 'anthropic') {
      const r = await call(deps, 'https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': value(env, 'ANTHROPIC_API_KEY') ?? '', 'anthropic-version': ANTHROPIC_API_VERSION },
      });
      checks.push(
        'error' in r
          ? { name: 'Anthropic', ok: false, message: unreachable('Anthropic', r) }
          : r.status === 200
            ? { name: 'Anthropic', ok: true, message: 'Anthropic acepta la clave.' }
            : { name: 'Anthropic', ok: false, message: rejected('Anthropic', r.status) },
      );
    } else if (provider.id === 'mistral') {
      const r = await call(deps, 'https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${value(env, 'MISTRAL_API_KEY') ?? ''}`, Accept: 'application/json' },
      });
      checks.push(
        'error' in r
          ? { name: 'Mistral', ok: false, message: unreachable('Mistral', r) }
          : r.status === 200
            ? { name: 'Mistral', ok: true, message: 'Mistral acepta la clave.' }
            : { name: 'Mistral', ok: false, message: rejected('Mistral', r.status) },
      );
    } else if (provider.id === 'openai') {
      // Listar modelos es gratuito. Con el endpoint de la UE comprueba además
      // que la clave pertenece a un proyecto con residencia en Europa.
      const base = normalizeOpenAiBaseUrl(value(env, 'OPENAI_BASE_URL'));
      const headers: Record<string, string> = {
        Authorization: `Bearer ${value(env, 'OPENAI_API_KEY') ?? ''}`,
        Accept: 'application/json',
      };
      const org = value(env, 'OPENAI_ORGANIZATION');
      const project = value(env, 'OPENAI_PROJECT');
      if (org) headers['OpenAI-Organization'] = org;
      if (project) headers['OpenAI-Project'] = project;
      const r = await call(deps, `${base}/v1/models`, { headers });
      checks.push(
        'error' in r
          ? { name: 'OpenAI', ok: false, message: unreachable('OpenAI', r) }
          : r.status === 200
            ? { name: 'OpenAI', ok: true, message: `OpenAI acepta la clave (${new URL(base).hostname}).` }
            : { name: 'OpenAI', ok: false, message: rejected('OpenAI', r.status) },
      );
      // Edición de fotos con IA: la misma lista dice si la clave ve un modelo de imagen.
      if (!('error' in r) && r.status === 200) {
        const ids =
          typeof r.body === 'object' && r.body !== null && Array.isArray((r.body as { data?: unknown }).data)
            ? ((r.body as { data: unknown[] }).data as unknown[]).map((m) =>
                typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
                  ? (m as { id: string }).id
                  : '',
              )
            : [];
        const images = ids.filter((id) => id.startsWith('gpt-image'));
        checks.push(
          images.length > 0
            ? {
                name: 'OpenAI imagen',
                ok: true,
                message: `La clave ve ${images.length} modelo(s) de imagen (${images.slice(0, 3).join(', ')}). Editar fotos con IA está disponible.`,
              }
            : {
                name: 'OpenAI imagen',
                ok: null,
                message:
                  'La clave funciona, pero no lista ningún modelo de imagen (gpt-image…). Para editar fotos con IA puede hacer falta verificar la organización en OpenAI o dar acceso al proyecto.',
              },
        );
      }
    } else if (provider.id === 'anthropic-vertex') {
      checks.push(await googleToken(value(env, 'AI_VERTEX_SERVICE_ACCOUNT_JSON') ?? '', deps));
    } else if (provider.id === 'anthropic-bedrock') {
      const region = value(env, 'AI_BEDROCK_REGION') ?? '';
      const url = `https://bedrock.${region}.amazonaws.com/foundation-models?byProvider=anthropic`;
      const accessKeyId = value(env, 'AI_BEDROCK_ACCESS_KEY_ID');
      const secretAccessKey = value(env, 'AI_BEDROCK_SECRET_ACCESS_KEY');
      const headers: Record<string, string> =
        accessKeyId && secretAccessKey
          ? await signAwsRequest({
              method: 'GET',
              url,
              headers: { accept: 'application/json' },
              body: '',
              region,
              service: 'bedrock',
              credentials: { accessKeyId, secretAccessKey },
            })
          : { accept: 'application/json', authorization: `Bearer ${value(env, 'AI_BEDROCK_BEARER_TOKEN') ?? ''}` };
      const r = await call(deps, url, { headers });
      checks.push(
        'error' in r
          ? { name: 'Amazon Bedrock', ok: false, message: unreachable('Amazon Bedrock', r) }
          : r.status === 200
            ? { name: 'Amazon Bedrock', ok: true, message: `Amazon Bedrock acepta las credenciales en ${region}.` }
            : { name: 'Amazon Bedrock', ok: false, message: rejected('Amazon Bedrock', r.status) },
      );
    }
  }
  const priceProblems = config.problems.filter((p) => p.startsWith('AI_PRICES'));
  if (priceProblems.length > 0 && config.providers.length > 0) {
    checks.push({
      name: 'Precios',
      ok: false,
      message: `${priceProblems.join(' ')} Sin precio completo no se genera.`,
    });
  }
  const routeProblems = config.problems.filter((p) => p.startsWith('La tarea'));
  for (const p of routeProblems) checks.push({ name: 'Tareas', ok: false, message: p });
  return summarize(checks, 'No hay ninguna tarea de texto con proveedor y modelo elegidos.');
}

// ─────────────────────────────── IA de imagen ───────────────────────────────

async function probeAiImage(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];
  const vertexJson = value(env, MEDIA_ENV.vertexServiceAccount);
  if (vertexJson || value(env, MEDIA_ENV.vertexProject)) {
    if (!vertexJson || !value(env, MEDIA_ENV.vertexProject)) {
      checks.push({
        name: 'Google Vertex AI',
        ok: false,
        message: 'Faltan el proyecto o la cuenta de servicio de Vertex.',
      });
    } else {
      checks.push(await googleToken(vertexJson, deps));
    }
  }
  const bflKey = value(env, MEDIA_ENV.bflKey);
  if (bflKey) {
    const base = value(env, MEDIA_ENV.bflBaseUrl) ?? BFL_DEFAULT_BASE_URL;
    if (!isBflBaseUrl(base)) {
      checks.push({
        name: 'Black Forest Labs',
        ok: false,
        message: 'La dirección de Black Forest Labs no es una de las documentadas.',
      });
    } else {
      const r = await call(deps, `${base}/v1/credits`, { headers: { 'x-key': bflKey, accept: 'application/json' } });
      checks.push(
        'error' in r
          ? { name: 'Black Forest Labs', ok: false, message: unreachable('Black Forest Labs', r) }
          : r.status === 200
            ? { name: 'Black Forest Labs', ok: true, message: 'Black Forest Labs acepta la clave.' }
            : { name: 'Black Forest Labs', ok: false, message: rejected('Black Forest Labs', r.status) },
      );
    }
  }
  if (value(env, MEDIA_ENV.ideogramKey)) {
    checks.push({
      name: 'Ideogram',
      ok: null,
      message:
        'Ideogram no documenta ninguna llamada gratuita para comprobar la clave: se comprobará con la primera imagen.',
    });
  }
  return summarize(checks, 'No hay ningún proveedor de imagen configurado (ComfyUI se prueba en su propio apartado).');
}

// ─────────────────────────────── Stripe ───────────────────────────────

async function probeStripe(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];
  const key = value(env, 'STRIPE_SECRET_KEY');
  if (!key) {
    checks.push({ name: 'Clave secreta', ok: false, message: 'Falta la clave secreta de Stripe.' });
  } else {
    const r = await call(deps, 'https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    const mode = /_live_/.test(key) ? 'modo real' : 'modo de pruebas';
    checks.push(
      'error' in r
        ? { name: 'Clave secreta', ok: false, message: unreachable('Stripe', r) }
        : r.status === 200
          ? { name: 'Clave secreta', ok: true, message: `Stripe acepta la clave (${mode}).` }
          : { name: 'Clave secreta', ok: false, message: rejected('Stripe', r.status) },
    );
  }
  checks.push(
    value(env, 'STRIPE_WEBHOOK_SECRET')
      ? {
          name: 'Secreto del webhook',
          ok: null,
          message: 'El secreto del webhook se comprueba con el primer aviso de Stripe.',
        }
      : { name: 'Secreto del webhook', ok: false, message: 'Falta el secreto del webhook (whsec_…).' },
  );
  if (!value(env, 'BILLING_APP_URL')) {
    checks.push({
      name: 'Dirección de la aplicación',
      ok: false,
      message: 'Falta la dirección de la aplicación (BILLING_APP_URL).',
    });
  }
  return summarize(checks, '');
}

// ─────────────────────────────── Google Drive ───────────────────────────────

function probeGoogleDrive(env: Env): ProbeResult {
  const checks: ProbeCheck[] = [];
  const config = loadDriveConfig(env, async () => {
    throw new Error('Sin red al comprobar la configuración de Drive');
  });
  // Los problemas solo nombran variables, nunca valores.
  const missing = config.problems.filter((p) => !p.startsWith(DRIVE_LOCAL_TEST_FLAG));
  if (missing.length > 0) {
    checks.push({
      name: 'Configuración',
      ok: false,
      message: missing.map((p) => (p.endsWith('.') ? p : `${p}.`)).join(' '),
    });
  } else {
    checks.push({
      name: 'Configuración',
      ok: true,
      message: config.simulated
        ? 'Google Drive simulado de las pruebas locales: configuración completa.'
        : 'La configuración está completa (cliente, dirección de vuelta y claves de cifrado).',
    });
  }
  checks.push({
    name: 'Cliente OAuth de Google',
    ok: null,
    message:
      'Google no tiene una llamada gratuita para comprobar el cliente OAuth: se comprueba al conectar Google Drive.',
  });
  return summarize(checks, '');
}

// ─────────────────────────────── Cloudflare R2 ───────────────────────────────

async function probeR2(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];
  let config: ReturnType<typeof loadMediaStorageConfig>;
  try {
    config = loadMediaStorageConfig(env);
  } catch (e) {
    return summarize([{ name: 'Configuración', ok: false, message: (e as Error).message }], '');
  }
  if (!config.s3) {
    const missing = config.problems.filter((p) => !p.startsWith('MEDIA_STORAGE_E2E_SIMULATED'));
    checks.push({
      name: 'Configuración',
      ok: false,
      message: missing.length
        ? missing.map((p) => (p.endsWith('.') ? p : `${p}.`)).join(' ')
        : 'Faltan la cuenta, la clave y el cubo de R2.',
    });
    return summarize(checks, '');
  }
  const storage = createS3Storage(config.s3, (input, init) =>
    deps.fetch(input, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) }),
  );
  let status: number | null = null;
  try {
    status = (await storage.headBucket()).status;
  } catch {
    status = null;
  }
  const service = config.simulated ? 'El S3 local' : 'Cloudflare R2';
  if (status === null) {
    checks.push({ name: 'Cubo', ok: false, message: `No se pudo llegar a ${service} (red o dirección).` });
  } else if (status === 200) {
    checks.push({
      name: 'Cubo',
      ok: true,
      message: `${service} responde: el cubo existe y la clave puede usarlo.`,
    });
  } else if (status === 404) {
    checks.push({
      name: 'Cubo',
      ok: false,
      message: 'El cubo no existe con ese nombre (o es de otra jurisdicción: revisa «eu»).',
    });
  } else {
    checks.push({ name: 'Cubo', ok: false, message: rejected(service, status) });
  }
  if (config.s3.jurisdiction === 'default') {
    checks.push({
      name: 'Jurisdicción',
      ok: null,
      message: 'El cubo no está en la jurisdicción UE: los archivos pueden guardarse fuera de la UE.',
    });
  }
  if (config.uploadBackend === 'supabase') {
    checks.push({
      name: 'Subidas nuevas',
      ok: null,
      message: 'Las subidas nuevas siguen yendo a Supabase Storage (MEDIA_UPLOAD_BACKEND=supabase).',
    });
  }
  return summarize(checks, '');
}

// ─────────────────────────── Trabajador de medios (Fly.io) ───────────────────────────

/** API de máquinas de Fly (la misma que llama `private.media_worker_wake()`). */
export const FLY_MACHINES_API = 'https://api.machines.dev';

/** Cabecera de autorización de Fly: los tokens «FlyV1 …» van tal cual; los demás, como Bearer. */
export const flyAuthorization = (token: string) => (token.startsWith('FlyV1 ') ? token : `Bearer ${token}`);

async function probeMediaWorker(env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  const checks: ProbeCheck[] = [];
  const token = value(env, 'FLY_API_TOKEN');
  const app = value(env, 'FLY_APP');
  const machine = value(env, 'FLY_MACHINE_ID');
  const missing = [
    !app && 'la app (FLY_APP)',
    !machine && 'el ID de la máquina (FLY_MACHINE_ID)',
    !token && 'el token (FLY_API_TOKEN)',
  ].filter(Boolean);
  if (missing.length > 0) {
    return summarize([{ name: 'Configuración', ok: false, message: `Falta ${missing.join(', ')}.` }], '');
  }
  if (!FLY_APP_PATTERN.test(app!) || !FLY_MACHINE_PATTERN.test(machine!)) {
    return summarize(
      [{ name: 'Configuración', ok: false, message: 'La app o el ID de la máquina no tienen un formato válido.' }],
      '',
    );
  }
  const r = await call(deps, `${FLY_MACHINES_API}/v1/apps/${app}/machines/${machine}`, {
    headers: { Authorization: flyAuthorization(token!), Accept: 'application/json' },
  });
  if ('error' in r) {
    checks.push({ name: 'Máquina', ok: false, message: unreachable('Fly.io', r) });
    return summarize(checks, '');
  }
  if (r.status === 404) {
    checks.push({
      name: 'Máquina',
      ok: false,
      message: 'Fly no encuentra esa máquina en esa app (revisa el nombre de la app y el ID de la máquina).',
    });
    return summarize(checks, '');
  }
  if (r.status !== 200) {
    checks.push({ name: 'Máquina', ok: false, message: rejected('Fly.io', r.status) });
    return summarize(checks, '');
  }
  const body = (r.body ?? {}) as {
    state?: unknown;
    region?: unknown;
    config?: { restart?: { policy?: unknown }; services?: unknown };
  };
  const state = typeof body.state === 'string' ? body.state : 'desconocido';
  const region = typeof body.region === 'string' ? body.region : 'desconocida';
  checks.push({
    name: 'Máquina',
    ok: true,
    message: `Fly responde: la máquina existe (estado «${state}», región ${region}) y el token sirve para esa app.`,
  });
  const policy = body.config?.restart?.policy;
  if (typeof policy === 'string' && policy !== 'no') {
    checks.push({
      name: 'Reinicio',
      ok: null,
      message: `La máquina se reinicia sola al terminar (política «${policy}»): no se parará al vaciar la cola. Revisa [[restart]] en worker/fly.toml.`,
    });
  }
  if (region !== 'fra' && region !== 'desconocida') {
    checks.push({
      name: 'Región',
      ok: null,
      message: `La máquina está en «${region}», no en Fráncfort (fra): los medios se procesarían fuera de la región prevista.`,
    });
  }
  if (Array.isArray(body.config?.services) && body.config.services.length > 0) {
    checks.push({
      name: 'Puertos',
      ok: null,
      message: 'La máquina tiene servicios (puertos) publicados: el trabajador no los necesita.',
    });
  }
  if (!value(env, 'WORKER_GATEWAY_TOKEN')) {
    checks.push({
      name: 'Acceso a Supabase',
      ok: null,
      message:
        'Falta el token del trabajador: pulsa «Generar token» y pégalo en Fly como WORKER_GATEWAY_TOKEN. Sin él, el trabajador no puede reclamar trabajos.',
    });
  }
  return summarize(checks, '');
}

export async function probeIntegration(id: IntegrationId, env: Env, deps: ProbeDeps): Promise<ProbeResult> {
  switch (id) {
    case 'meta':
      return probeMeta(env, deps);
    case 'comfyui':
      return probeComfyUi(env, deps);
    case 'ai_text':
      return probeAiText(env, deps);
    case 'ai_image':
      return probeAiImage(env, deps);
    case 'stripe':
      return probeStripe(env, deps);
    case 'google_drive':
      return probeGoogleDrive(env);
    case 'r2':
      return probeR2(env, deps);
    case 'media_worker':
      return probeMediaWorker(env, deps);
  }
}

/** Para las pruebas: la dirección del punto de tokens de Google (la simula el fetch de prueba). */
export { GOOGLE_TOKEN_URL };
