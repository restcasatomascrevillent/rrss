// Adaptador de IMAGEN: Black Forest Labs, FLUX.2.
//
// SIN PROBAR CONTRA EL SERVICIO REAL: solo con respuestas HTTP simuladas.
// Escrito contra la documentación oficial (consultada el 17/11/2026):
//   · Referencia de FLUX.2 [pro] (ruta, cabecera `x-key`, campos, respuesta):
//     https://docs.bfl.ml/api-reference/models/generate-or-edit-an-image-with-flux2-[pro].md
//   · Resultado y estados:   https://docs.bfl.ml/api-reference/utility/get-result.md
//   · Edición con referencias (URL en `input_image`, hasta 8 por API, hasta 4 MP):
//     https://docs.bfl.ml/flux_2/flux2_image_editing.md
//   · Hosts regionales, sondeo, caducidad y límites:
//     https://docs.bfl.ml/api_integration/integration_guidelines.md
//   · Errores:               https://docs.bfl.ml/api_integration/errors.md
//
//   POST https://api.eu.bfl.ai/v1/<modelo>   (x-key)
//     { prompt, width, height, output_format, input_image, input_image_2… }
//     → { id, polling_url }
//   GET  polling_url (x-key) → { status: Pending | Ready | Error | …, result: { sample: <url> } }
//
// Asíncrono, solo por sondeo: la API acepta `webhook_url` y `webhook_secret`,
// pero su documentación no describe el aviso ni cómo se firma, así que aquí no
// se usa. La URL del resultado caduca a los 10 minutos: se descarga enseguida.
//
// Por defecto se usa el host de la UE (`api.eu.bfl.ai`). Ojo con sus
// condiciones: BFL obtiene licencia sobre entradas y salidas, también para
// entrenar, salvo contrato enterprise (docs/investigacion-fase2/02-imagen.md).
import {
  MediaProviderFailure,
  type DataRegion,
  type MediaOutcome,
  type MediaProvider,
  type MediaStartRequest,
  type MediaStartResult,
  type MediaUsage,
  type ProviderJobRef,
} from './contract.ts';
import { isTrustedUrl, requestJson, stringAt, type FetchLike } from './http.ts';
import { megapixels } from './models.ts';

export const BFL_PROVIDER_ID = 'bfl';
const PROVIDER_NAME = 'Black Forest Labs';
const TRUSTED_HOSTS = ['bfl.ai'];
/** Hosts documentados y la región que garantiza cada uno. */
const HOSTS: Record<string, DataRegion> = {
  'https://api.eu.bfl.ai': 'eu',
  'https://api.us.bfl.ai': 'us',
  'https://api.bfl.ai': 'global',
};
export const BFL_DEFAULT_BASE_URL = 'https://api.eu.bfl.ai';
const MAX_REFERENCES = 8;
/** Resolución máxima de FLUX.2: es lo que se supone de una referencia cuyo tamaño no se conoce. */
const MAX_MEGAPIXELS = 4;

export interface BflOptions {
  apiKey: string;
  /** Uno de los tres hosts documentados. Por defecto, el de la UE. */
  baseUrl?: string;
  fetch: FetchLike;
  /** Tiempo máximo de cada llamada. Por defecto, 30 s. */
  timeoutMs?: number;
}

export function isBflBaseUrl(url: string): boolean {
  return url in HOSTS;
}

const PENDING = new Set(['Pending', 'Reasoning', 'Generating']);
const MODERATED = new Set(['Request Moderated', 'Content Moderated']);

export function createBflImageProvider(options: BflOptions): MediaProvider {
  const baseUrl = options.baseUrl ?? BFL_DEFAULT_BASE_URL;
  const region = HOSTS[baseUrl];
  if (!region) throw new Error('Configuración de Black Forest Labs no válida: el host no es uno de los documentados');
  const http = { fetch: options.fetch, provider: PROVIDER_NAME, timeoutMs: options.timeoutMs ?? 30_000 };
  const headers = { 'x-key': options.apiKey, accept: 'application/json' };

  return {
    id: BFL_PROVIDER_ID,
    kinds: ['image'],
    testedAgainstRealService: false,
    dataRegion: region,

    estimateUsage(request, model): MediaUsage {
      if (request.kind !== 'image') return {};
      if (model.billingUnit !== 'megapixel') return { images: 1 };
      const references = request.references ?? [];
      const usage: MediaUsage = { megapixels: megapixels(request.size.width, request.size.height) };
      if (references.length > 0) {
        usage.input_megapixels = references.reduce(
          (sum, ref) => sum + (ref.width && ref.height ? megapixels(ref.width, ref.height) : MAX_MEGAPIXELS),
          0,
        );
      }
      return usage;
    },

    async start({ request, model, signal }: MediaStartRequest): Promise<MediaStartResult> {
      if (request.kind !== 'image') {
        throw new MediaProviderFailure('invalid_request', `${PROVIDER_NAME} solo genera imagen`);
      }
      if (!/^[a-z0-9][a-z0-9.-]*$/i.test(model.model)) {
        throw new MediaProviderFailure('invalid_request', `El nombre del modelo de ${PROVIDER_NAME} no es válido`);
      }
      const references = request.references ?? [];
      if (references.length > MAX_REFERENCES) {
        throw new MediaProviderFailure(
          'invalid_request',
          `${PROVIDER_NAME} admite como mucho ${MAX_REFERENCES} imágenes de referencia`,
        );
      }
      const format = model.settings.output_format;
      const body: Record<string, unknown> = {
        prompt: request.prompt,
        width: request.size.width,
        height: request.size.height,
        output_format: format === 'png' || format === 'webp' ? format : 'jpeg',
      };
      references.forEach((reference, index) => {
        if (!reference.url) {
          throw new MediaProviderFailure(
            'invalid_request',
            `${PROVIDER_NAME} necesita las imágenes de referencia como dirección pública (una URL firmada)`,
          );
        }
        body[index === 0 ? 'input_image' : `input_image_${index + 1}`] = reference.url;
      });

      const answer = await requestJson(
        `${baseUrl}/v1/${model.model}`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        { ...http, signal },
      );
      const id = stringAt(answer, 'id');
      const pollingUrl = stringAt(answer, 'polling_url');
      // «You must use the polling_url»: sin ella, o si no es de su dominio, no se sigue.
      if (!id || !isTrustedUrl(pollingUrl, TRUSTED_HOSTS)) {
        throw new MediaProviderFailure(
          'bad_response',
          `${PROVIDER_NAME} no ha devuelto una dirección de consulta válida`,
        );
      }
      return { status: 'pending', job: { id, statusUrl: pollingUrl } };
    },

    async poll(job: ProviderJobRef, _model, signal): Promise<MediaOutcome> {
      if (!isTrustedUrl(job.statusUrl, TRUSTED_HOSTS)) {
        return {
          status: 'failed',
          code: 'bad_response',
          message: `Falta la dirección de consulta de ${PROVIDER_NAME}`,
        };
      }
      const body = await requestJson(job.statusUrl, { method: 'GET', headers }, { ...http, signal });
      const status = stringAt(body, 'status') ?? '';
      if (status === 'Ready') {
        const url = stringAt(body, 'result', 'sample');
        if (!url)
          return { status: 'failed', code: 'bad_response', message: `${PROVIDER_NAME} terminó sin entregar la imagen` };
        return { status: 'completed', outputs: [{ url, mimeType: '' }] };
      }
      if (PENDING.has(status)) return { status: 'pending' };
      if (MODERATED.has(status)) {
        return {
          status: 'failed',
          code: 'moderated',
          message: `${PROVIDER_NAME} ha rechazado la petición o el resultado por su moderación de contenido`,
        };
      }
      if (['Error', 'Failed', 'No Card Generated', 'Task not found'].includes(status)) {
        return {
          status: 'failed',
          code: 'provider_error',
          message: `${PROVIDER_NAME} no ha generado la imagen (${status})`,
        };
      }
      // Estado que la documentación no lista: se sigue consultando.
      return { status: 'pending' };
    },
  };
}
