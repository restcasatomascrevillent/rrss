// Selección de adaptador y modelo por configuración (variables de entorno de
// la función). Todas las claves de estas pruebas son inventadas.
import { describe, expect, it } from 'vitest';
import { loadAiTextConfig, parsePrices, type Env } from '../../supabase/functions/_shared/ai/text/config.ts';
import type { FetchLike } from '../../supabase/functions/_shared/ai/text/http.ts';

const PRICES = JSON.stringify({
  'openai/modelo-o': { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 0.05 },
  'mistral/modelo-m': { input_tokens: 0.7, output_tokens: 2.1, cache_read_input_tokens: 0.07 },
  'anthropic-vertex/modelo-v': {
    input_tokens: 2.2,
    output_tokens: 11,
    cache_read_input_tokens: 0.11,
    cache_write_input_tokens: 2.75,
  },
});

const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'ia@proyecto.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
});

const VERTEX: Env = {
  AI_VERTEX_PROJECT_ID: 'proyecto',
  AI_VERTEX_LOCATION: 'eu',
  AI_VERTEX_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT,
};

const noFetch: FetchLike = () => Promise.reject(new Error('las pruebas de configuración no llaman a nadie'));
const load = (env: Env) => loadAiTextConfig(env, { fetch: noFetch });

describe('qué adaptador y qué modelo sirve cada tarea', () => {
  it('sin configuración no hay IA: ni proveedores ni modelos, y tampoco el simulado', () => {
    const config = load({});
    expect(config.providers).toEqual([]);
    expect(config.models).toEqual([]);
    expect(config.unavailable).toEqual({});
  });

  it('un adaptador y un modelo para todas las tareas de texto', () => {
    const config = load({ AI_TEXT_PROVIDER: 'mistral', AI_TEXT_MODEL: 'modelo-m', MISTRAL_API_KEY: 'k', AI_PRICES: PRICES });
    expect(config.providers.map((p) => p.id)).toEqual(['mistral']);
    expect(config.models.map((m) => [m.purposes, m.provider, m.model])).toEqual([
      [['post.caption'], 'mistral', 'modelo-m'],
      [['profile.proposal'], 'mistral', 'modelo-m'],
      [['brand.check'], 'mistral', 'modelo-m'],
      [['campaign.plan'], 'mistral', 'modelo-m'],
      [['analytics.summary'], 'mistral', 'modelo-m'],
      [['editor.copilot'], 'mistral', 'modelo-m'],
    ]);
    expect(config.models[0]).toMatchObject({
      task: 'text',
      microsPerUnit: { input_tokens: 0.7, output_tokens: 2.1, cache_read_input_tokens: 0.07 },
    });
    expect(config.problems).toEqual([]);
  });

  it('cada tarea puede ir a un adaptador y un modelo distintos', () => {
    const config = load({
      ...VERTEX,
      AI_TEXT_PROVIDER: 'anthropic-vertex',
      AI_TEXT_MODEL: 'modelo-v',
      AI_TEXT_BRAND_CHECK_PROVIDER: 'mistral',
      AI_TEXT_BRAND_CHECK_MODEL: 'modelo-m',
      MISTRAL_API_KEY: 'k',
      AI_PRICES: PRICES,
    });
    expect(config.providers.map((p) => p.id).sort()).toEqual(['anthropic-vertex', 'mistral']);
    const byPurpose = Object.fromEntries(config.models.map((m) => [m.purposes![0], `${m.provider}/${m.model}`]));
    expect(byPurpose).toEqual({
      'post.caption': 'anthropic-vertex/modelo-v',
      'profile.proposal': 'anthropic-vertex/modelo-v',
      'brand.check': 'mistral/modelo-m',
      'campaign.plan': 'anthropic-vertex/modelo-v',
      'analytics.summary': 'anthropic-vertex/modelo-v',
      'editor.copilot': 'anthropic-vertex/modelo-v',
    });
    expect(config.problems).toEqual([]);
  });

  it('solo se configura una tarea: las demás quedan sin modelo', () => {
    const config = load({
      AI_TEXT_POST_CAPTION_PROVIDER: 'mistral',
      AI_TEXT_POST_CAPTION_MODEL: 'modelo-m',
      MISTRAL_API_KEY: 'k',
      AI_PRICES: PRICES,
    });
    expect(config.models.map((m) => m.purposes)).toEqual([['post.caption']]);
  });

  it('adaptador sin modelo (o al revés) se avisa y no se usa', () => {
    const config = load({ AI_TEXT_PROVIDER: 'mistral', MISTRAL_API_KEY: 'k' });
    expect(config.models).toEqual([]);
    expect(config.problems.join(' ')).toMatch(/necesita adaptador y modelo/);
  });
});

describe('OpenAI: precios y copiloto', () => {
  it('sirve el copiloto con su precio sin recargo de escritura de caché', () => {
    const config = load({
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'https://eu.api.openai.com',
      AI_TEXT_EDITOR_COPILOT_PROVIDER: 'openai',
      AI_TEXT_EDITOR_COPILOT_MODEL: 'modelo-o',
      AI_PRICES: PRICES,
    });
    expect(config.providers.map((p) => p.id)).toEqual(['openai']);
    expect(config.models).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'modelo-o', purposes: ['editor.copilot'] }),
    ]);
    expect(config.problems).toEqual([]);
  });

  it('sin precio de entrada, salida o caché leída avisa', () => {
    const config = load({
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'https://eu.api.openai.com',
      AI_TEXT_PROVIDER: 'openai',
      AI_TEXT_MODEL: 'modelo-o',
      AI_PRICES: JSON.stringify({ 'openai/modelo-o': { input_tokens: 1 } }),
    });
    expect(config.problems.join(' ')).toMatch(/openai\/modelo-o.*output_tokens/);
  });
});

describe('sin credenciales el adaptador no está disponible', () => {
  it.each([
    ['mistral', {}, /MISTRAL_API_KEY/],
    ['anthropic-vertex', {}, /AI_VERTEX_PROJECT_ID.*AI_VERTEX_SERVICE_ACCOUNT_JSON/],
    ['anthropic-vertex', { ...VERTEX, AI_VERTEX_SERVICE_ACCOUNT_JSON: '{"tipo":"otra cosa"}' }, /no es el JSON de una cuenta de servicio/],
    ['anthropic-bedrock', { AI_BEDROCK_REGION: 'eu-west-1' }, /credenciales/],
    ['anthropic-bedrock', { AI_BEDROCK_ACCESS_KEY_ID: 'a', AI_BEDROCK_SECRET_ACCESS_KEY: 's' }, /AI_BEDROCK_REGION/],
    ['anthropic', { AI_ALLOW_NON_EU_PROCESSING: 'true' }, /ANTHROPIC_API_KEY/],
    ['inventado', {}, /no existe/],
    ['simulated', {}, /no existe/],
    ['openai', {}, /OPENAI_API_KEY/],
    ['openai', { OPENAI_API_KEY: 'k' }, /eu\.api\.openai\.com/],
    ['openai', { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.openai.com' }, /api\.openai\.com. no es el endpoint/],
    ['openai', { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://eu.api.openai.com' }, /https/],
  ] as [string, Env, RegExp][])('%s: se dice qué falta y no se sustituye por nada', (provider, extra, reason) => {
    const config = load({ AI_TEXT_PROVIDER: provider, AI_TEXT_MODEL: 'modelo', ...extra });
    expect(config.providers).toEqual([]);
    expect(config.unavailable[provider]).toMatch(reason);
    // El modelo sigue apuntando a ese adaptador: el servicio dará el motivo, no usará otro.
    expect(config.models.every((m) => m.provider === provider)).toBe(true);
    // Los avisos nombran variables, nunca valores.
    expect(config.problems.join(' ')).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it('con sus credenciales, cada adaptador se carga', () => {
    const cases: [string, Env][] = [
      ['anthropic-vertex', VERTEX],
      ['mistral', { MISTRAL_API_KEY: 'k' }],
      ['openai', { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://eu.api.openai.com' }],
      ['openai', { OPENAI_API_KEY: 'k', AI_ALLOW_NON_EU_PROCESSING: 'true' }],
      ['anthropic-bedrock', { AI_BEDROCK_REGION: 'eu-west-1', AI_BEDROCK_ACCESS_KEY_ID: 'a', AI_BEDROCK_SECRET_ACCESS_KEY: 's' }],
      ['anthropic-bedrock', { AI_BEDROCK_REGION: 'eu-central-1', AI_BEDROCK_BEARER_TOKEN: 't' }],
      ['anthropic', { ANTHROPIC_API_KEY: 'k', AI_ALLOW_NON_EU_PROCESSING: 'true' }],
    ];
    for (const [provider, extra] of cases) {
      const config = load({ AI_TEXT_PROVIDER: provider, AI_TEXT_MODEL: 'modelo', ...extra });
      expect(config.providers.map((p) => p.id)).toEqual([provider]);
      expect(config.unavailable).toEqual({});
    }
  });
});

describe('criterio de datos: por defecto, procesar en la UE', () => {
  it('la API directa de Anthropic no se carga aunque tenga clave, salvo aceptación expresa', () => {
    const base = { AI_TEXT_PROVIDER: 'anthropic', AI_TEXT_MODEL: 'modelo', ANTHROPIC_API_KEY: 'k' };
    const config = load(base);
    expect(config.providers).toEqual([]);
    expect(config.unavailable.anthropic).toMatch(/no procesa los datos en la UE/);
    expect(load({ ...base, AI_ALLOW_NON_EU_PROCESSING: 'si' }).providers).toEqual([]);
    expect(load({ ...base, AI_ALLOW_NON_EU_PROCESSING: 'true' }).providers.map((p) => p.id)).toEqual(['anthropic']);
  });

  it('Vertex y Bedrock solo se cargan con una ubicación de la UE', () => {
    const vertex = { AI_TEXT_PROVIDER: 'anthropic-vertex', AI_TEXT_MODEL: 'modelo', ...VERTEX };
    expect(load({ ...vertex, AI_VERTEX_LOCATION: 'global' }).unavailable['anthropic-vertex']).toMatch(/no está en la UE/);
    expect(load({ ...vertex, AI_VERTEX_LOCATION: 'us' }).providers).toEqual([]);
    expect(load({ ...vertex, AI_VERTEX_LOCATION: 'europe-west1' }).providers).toHaveLength(1);
    expect(load({ ...vertex, AI_VERTEX_LOCATION: 'global', AI_ALLOW_NON_EU_PROCESSING: 'true' }).providers).toHaveLength(1);

    const bedrock = { AI_TEXT_PROVIDER: 'anthropic-bedrock', AI_BEDROCK_BEARER_TOKEN: 't' };
    expect(
      load({ ...bedrock, AI_TEXT_MODEL: 'anthropic.m', AI_BEDROCK_REGION: 'us-east-1' }).unavailable['anthropic-bedrock'],
    ).toMatch(/no está en la UE/);
    expect(
      load({ ...bedrock, AI_TEXT_MODEL: 'global.anthropic.m', AI_BEDROCK_REGION: 'eu-west-1' }).unavailable['anthropic-bedrock'],
    ).toMatch(/enrutado global/);
  });
});

describe('tabla de precios y tiempo máximo', () => {
  it('los precios son configuración: micros por unidad, por adaptador y modelo', () => {
    const problems: string[] = [];
    expect(parsePrices(PRICES, problems)['mistral/modelo-m']).toEqual({
      input_tokens: 0.7,
      output_tokens: 2.1,
      cache_read_input_tokens: 0.07,
    });
    expect(problems).toEqual([]);
  });

  it('precios ilegibles o incompletos se avisan; el modelo queda sin precio y el servicio no lo usará', () => {
    const roto = load({ AI_TEXT_PROVIDER: 'mistral', AI_TEXT_MODEL: 'modelo-m', MISTRAL_API_KEY: 'k', AI_PRICES: '{mal' });
    expect(roto.models[0]!.microsPerUnit).toEqual({});
    expect(roto.problems.join(' ')).toMatch(/AI_PRICES no es JSON válido/);

    const incompleto = load({
      ...VERTEX,
      AI_TEXT_PROVIDER: 'anthropic-vertex',
      AI_TEXT_MODEL: 'modelo-v',
      AI_PRICES: JSON.stringify({ 'anthropic-vertex/modelo-v': { input_tokens: 2.2, output_tokens: -1 } }),
    });
    expect(incompleto.models[0]!.microsPerUnit).toEqual({ input_tokens: 2.2 });
    expect(incompleto.problems.join(' ')).toMatch(/le falta el precio de output_tokens, cache_read_input_tokens, cache_write_input_tokens/);
  });

  it('el tiempo máximo es opcional y se valida', () => {
    expect(load({ AI_TIMEOUT_MS: '45000' }).timeoutMs).toBe(45_000);
    expect(load({}).timeoutMs).toBeUndefined();
    const mal = load({ AI_TIMEOUT_MS: 'mucho' });
    expect(mal.timeoutMs).toBeUndefined();
    expect(mal.problems.join(' ')).toMatch(/AI_TIMEOUT_MS/);
  });
});
