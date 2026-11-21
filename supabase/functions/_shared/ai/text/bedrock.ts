// Adaptador de texto: Anthropic por Amazon Bedrock, en una región de la UE.
//
// ⚠ SIN PROBAR CONTRA EL SERVICIO REAL (no hay cuenta de AWS). Probado solo con
// respuestas HTTP simuladas. Fuente (consultada el 17/11/2026):
//   https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock
//
// Lo que dice la documentación y aquí se aplica:
//   * Punto de entrada `https://bedrock-mantle.{región}.api.aws/anthropic/v1/messages`,
//     con el mismo cuerpo que la API de Anthropic y `anthropic-version` en cabecera.
//   * Los modelos llevan el prefijo `anthropic.` (el nombre exacto es configuración).
//   * Autenticación: firma SigV4 con el servicio `bedrock-mantle` (claves de IAM)
//     o un token de Bedrock de corta duración en la cabecera `x-api-key`. El
//     token caduca a las 12 horas como máximo: para un servidor, usar SigV4.
//
// ⚠ PENDIENTE DE CONFIRMAR EN AWS antes de activarlo: que el modelo elegido se
// sirve dentro de la UE desde la región configurada (enrutado «in-region» o
// perfil de inferencia de la geografía EU) y con qué identificador. Este
// adaptador solo impide lo evidente: una región que no sea `eu-…` o un modelo
// con prefijo `global.`.
import {
  AiProviderFailure,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResult,
  type AiUsage,
} from '../contract.ts';
import {
  ANTHROPIC_API_VERSION,
  buildMessagesBody,
  describeAnthropicError,
  parseMessagesResponse,
} from './anthropic-messages.ts';
import { postJson, type FetchLike } from './http.ts';
import { estimateTextUsage } from './prompt.ts';
import { signAwsRequest, type AwsCredentials } from './sigv4.ts';

export const BEDROCK_PROVIDER_ID = 'anthropic-bedrock';
const NAME = 'Amazon Bedrock';
const SERVICE = 'bedrock-mantle';

export type BedrockAuth = { kind: 'sigv4'; credentials: AwsCredentials } | { kind: 'bearer'; token: string };

export interface BedrockProviderOptions {
  /** Región de AWS, por ejemplo `eu-west-1`. */
  region: string;
  auth: BedrockAuth;
  fetch?: FetchLike;
  /** Solo para pruebas de la firma. */
  now?: () => Date;
  /** Permite regiones fuera de la UE y modelos `global.` (por defecto, no). */
  allowOutsideEu?: boolean;
}

/** ¿Es una región de AWS en Europa? (`eu-west-1`, `eu-central-1`…). */
export function isEuRegion(region: string): boolean {
  return /^eu-[a-z]+-\d+$/.test(region);
}

/** Motivo por el que una combinación de región y modelo sacaría los datos de la UE, o `null`. */
export function euResidencyProblem(region: string, model: string): string | null {
  if (!isEuRegion(region)) return `la región «${region}» no está en la UE`;
  if (/^global\./i.test(model)) return `el modelo «${model}» usa el enrutado global, que sale de la UE`;
  return null;
}

export function createBedrockProvider(options: BedrockProviderOptions): AiProvider {
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const url = `https://${SERVICE}.${options.region}.api.aws/anthropic/v1/messages`;
  const secrets =
    options.auth.kind === 'bearer'
      ? [options.auth.token]
      : [options.auth.credentials.secretAccessKey, options.auth.credentials.sessionToken ?? ''];

  return {
    id: BEDROCK_PROVIDER_ID,

    estimateUsage(request): AiUsage {
      return estimateTextUsage(request.input, { cacheWrites: true });
    },

    async generate(request: AiProviderRequest): Promise<AiProviderResult> {
      if (request.task !== 'text') {
        throw new AiProviderFailure('unsupported_task', `El adaptador de ${NAME} solo sirve la tarea de texto`);
      }
      if (!options.allowOutsideEu) {
        const problem = euResidencyProblem(options.region, request.model);
        if (problem) throw new AiProviderFailure('eu_residency', `${NAME} no se usa: ${problem}`);
      }

      const body = buildMessagesBody(request);
      const base = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_API_VERSION };
      const headers =
        options.auth.kind === 'bearer'
          ? { ...base, 'x-api-key': options.auth.token }
          : await signAwsRequest({
              method: 'POST',
              url,
              headers: base,
              // La firma cubre exactamente los bytes que se envían.
              body: JSON.stringify(body),
              region: options.region,
              service: SERVICE,
              credentials: options.auth.credentials,
              now: options.now?.(),
            });

      const response = await postJson({
        fetch: fetchFn,
        url,
        headers,
        body,
        signal: request.signal,
        providerName: NAME,
        secrets,
        describeError: describeAnthropicError,
      });
      return parseMessagesResponse(response.body, response.headers, NAME);
    },
  };
}
