// Adaptador de IMAGEN: OpenAI (modelos GPT Image), con la misma clave que el
// texto (OPENAI_API_KEY, «Plataforma → Integraciones»).
//
// SIN PROBAR CONTRA EL SERVICIO REAL (no hay clave): solo con respuestas HTTP
// simuladas. Escrito contra la documentación oficial (consultada el 20/11/2026):
//   https://developers.openai.com/api/docs/guides/image-generation
//   https://developers.openai.com/api/reference/resources/images/methods/edit
//   https://developers.openai.com/api/docs/pricing
//
// Lo que dice la documentación y aquí se aplica:
//   * Generar:  POST {base}/v1/images/generations  (JSON: model, prompt, size,
//     quality, n, output_format, background).
//   * Editar:   POST {base}/v1/images/edits  (multipart: model, prompt, image
//     [o image[] si hay varias], mask, size, quality, n, background,
//     output_format). Con varias imágenes, la máscara se aplica a la primera.
//   * Máscara: mismo formato y tamaño que la imagen, con CANAL ALFA; se edita
//     lo transparente y se conserva lo opaco. «La máscara es solo orientativa»:
//     la documentación dice que se aplica por indicación (prompt) y el modelo
//     puede no respetar su forma exacta. Por eso el prompt también pide no
//     tocar el plato, y la interfaz avisa de que no está garantizado.
//   * Fondo transparente: `background: "transparent"` con `output_format` png
//     o webp.
//   * Tamaños: 1024x1024, 1536x1024, 1024x1536 y `auto` en todos los modelos;
//     la familia gpt-image-2 / 2.5 admite además cualquier AnchoxAlto con
//     lados múltiplos de 16, proporción de hasta 3:1, lados ≤ 3840 px y entre
//     655.360 y 8.294.400 píxeles. Ajuste del modelo `size_mode`: `custom`
//     (por defecto) o `preset`.
//   * Respuesta: `data[].b64_json` (los modelos GPT Image no devuelven URL) y
//     `usage` en tokens.
//   * `input_fidelity` NO se envía salvo que el modelo lo pida en sus ajustes
//     (gpt-image-2 lo rechaza: procesa las entradas siempre en alta fidelidad).
//   * Precio: por tokens (entrada de imagen/texto y salida de imagen), no por
//     imagen. El registro lo aproxima por megapíxel (cota superior): consulta
//     docs/ia-medios.md. El consumo real en tokens no se convierte en dinero:
//     se cobra la cota reservada.
//
// Residencia: con `OPENAI_BASE_URL=https://eu.api.openai.com` (proyecto con
// región Europa) el adaptador declara `eu`; con la dirección normal, `global`.
import {
  editOutputSize,
  MediaProviderFailure,
  type ImageEditRequest,
  type ImageRequest,
  type MediaInput,
  type MediaModel,
  type MediaProvider,
  type MediaRequest,
  type MediaStartRequest,
  type MediaStartResult,
  type MediaUsage,
} from './contract.ts';
import { download, failureFromResponse, fromBase64, isRecord, request, type FetchLike } from './http.ts';
import { megapixels } from './models.ts';
import { normalizeOpenAiBaseUrl, openAiEuProblem } from '../text/openai.ts';

export const OPENAI_IMAGE_PROVIDER_ID = 'openai';
const PROVIDER_NAME = 'OpenAI';
/** Límite documentado de la imagen y de la máscara. */
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCES = 4;
/** Megapíxeles que se cuentan como mucho por imagen de entrada al estimar el coste. */
const DEFAULT_MAX_INPUT_MEGAPIXELS = 4;
/** Píxeles del resultado de una edición: como mucho ~1,5 MP (1536×1024), nunca menos del mínimo del modelo. */
const TARGET_PIXELS = 1_572_864;
const MIN_PIXELS = 655_360;
const MAX_SIDE = 3840;

export interface OpenAiImageOptions {
  apiKey: string;
  fetch: FetchLike;
  /** Por defecto https://api.openai.com; con proyecto europeo, https://eu.api.openai.com. */
  baseUrl?: string;
  organization?: string;
  project?: string;
  /** Tiempo máximo de la llamada. Por defecto, 110 s. */
  timeoutMs?: number;
}

const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);

/**
 * Tamaño del resultado para una foto o un pedido de ese ancho y alto.
 * `custom`: mismas proporciones, ~1,5 MP como mucho, lados múltiplos de 16,
 * proporción ≤ 3:1. `preset`: el más cercano de los tres tamaños fijos.
 */
export function openAiImageSize(
  width: number,
  height: number,
  mode: 'custom' | 'preset' = 'custom',
): { width: number; height: number } {
  const ratio = width / height;
  if (mode === 'preset') {
    if (ratio > 1.2) return { width: 1536, height: 1024 };
    if (ratio < 0.83) return { width: 1024, height: 1536 };
    return { width: 1024, height: 1024 };
  }
  const clamped = Math.min(3, Math.max(1 / 3, ratio));
  let pixels = Math.min(width * height, TARGET_PIXELS);
  pixels = Math.max(MIN_PIXELS, pixels);
  let w = round16(Math.sqrt(pixels * clamped));
  let h = round16(Math.sqrt(pixels / clamped));
  // El redondeo puede dejar el área justo por debajo del mínimo o un lado pasado.
  while (w * h < MIN_PIXELS) {
    w += 16;
    h += 16;
  }
  w = Math.min(MAX_SIDE, w);
  h = Math.min(MAX_SIDE, h);
  return { width: w, height: h };
}

function sizeMode(model: MediaModel): 'custom' | 'preset' {
  return model.settings.size_mode === 'preset' ? 'preset' : 'custom';
}

function settingString(model: MediaModel, name: string, allowed: readonly string[]): string | undefined {
  const value = model.settings[name];
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

/** Texto que se manda al modelo para cada edición. El plato nunca se toca. */
export function editPromptFor(edit: ImageEditRequest): string {
  const keep =
    'Keep the food and the dish in the foreground exactly as they are: same shape, plating, ingredients, ' +
    'colours, textures, garnish and position. Do not add, remove, restyle or rearrange any food. ' +
    'No text, logos, people or watermarks.';
  if (edit.operation === 'remove_background') {
    return (
      'Remove the background completely and leave only the main subject, with clean, natural edges, on a ' +
      `transparent background. ${keep}`
    );
  }
  if (edit.operation === 'enhance') {
    return (
      'Improve the lighting and colour of this photo: balanced exposure, natural and appetising colours, ' +
      `gentle contrast, true white balance. Keep the composition and framing. ${keep}`
    );
  }
  const maskNote = edit.subjectMask
    ? ' The opaque area of the mask is the dish and must not change; only the transparent area (the background) is repainted.'
    : '';
  return (
    `Replace ONLY the background of this photo with: ${(edit.prompt ?? '').trim()}. ` +
    `Match the lighting and perspective of the new setting naturally. ${keep}${maskNote}`
  );
}

function outputMime(format: string): string {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
}

export function createOpenAiImageProvider(options: OpenAiImageOptions): MediaProvider {
  const baseUrl = normalizeOpenAiBaseUrl(options.baseUrl);
  const region = openAiEuProblem(baseUrl) === null ? 'eu' : 'global';
  const http = { fetch: options.fetch, provider: PROVIDER_NAME, timeoutMs: options.timeoutMs ?? 110_000 };
  const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' };
  if (options.organization) headers['OpenAI-Organization'] = options.organization;
  if (options.project) headers['OpenAI-Project'] = options.project;

  function inputMegapixels(inputs: Array<{ width?: number; height?: number }>, model: MediaModel): number {
    const cap = typeof model.settings.max_input_megapixels === 'number' ? model.settings.max_input_megapixels : DEFAULT_MAX_INPUT_MEGAPIXELS;
    return inputs.reduce(
      (sum, input) =>
        sum + Math.min(cap, input.width && input.height ? megapixels(input.width, input.height) : cap),
      0,
    );
  }

  function sizeOf(media: MediaRequest, model: MediaModel): { width: number; height: number } {
    if (media.kind === 'image_edit') {
      const base = editOutputSize(media);
      return openAiImageSize(base.width, base.height, sizeMode(model));
    }
    if (media.kind === 'image') return openAiImageSize(media.size.width, media.size.height, sizeMode(model));
    throw new MediaProviderFailure('invalid_request', `${PROVIDER_NAME} no genera vídeo`);
  }

  async function bytesOf(input: MediaInput, signal: AbortSignal): Promise<Uint8Array> {
    if (input.bytes) return input.bytes;
    if (!input.url) throw new MediaProviderFailure('invalid_request', 'Una imagen de entrada no tiene contenido');
    return (await download(input.url, { ...http, timeoutMs: 30_000, signal, maxBytes: MAX_INPUT_BYTES })).bytes;
  }

  const extensionOf = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');

  return {
    id: OPENAI_IMAGE_PROVIDER_ID,
    kinds: ['image'],
    edits: ['remove_background', 'replace_background', 'enhance'],
    subjectMaskEdits: ['replace_background'],
    testedAgainstRealService: false,
    dataRegion: region,

    estimateUsage(media, model): MediaUsage {
      if (media.kind === 'video') return {};
      if (model.billingUnit !== 'megapixel') return { images: 1 };
      const out = sizeOf(media, model);
      const usage: MediaUsage = { megapixels: megapixels(out.width, out.height) };
      if (media.kind === 'image_edit') {
        // La máscara tiene las medidas de la foto y se cuenta como otra imagen: es una cota.
        usage.input_megapixels = inputMegapixels(media.subjectMask ? [media.source, media.source] : [media.source], model);
      } else if (media.references?.length) {
        usage.input_megapixels = inputMegapixels(media.references, model);
      }
      return usage;
    },

    async start({ request: media, model, signal }: MediaStartRequest): Promise<MediaStartResult> {
      if (media.kind === 'video') {
        throw new MediaProviderFailure('invalid_request', `${PROVIDER_NAME} no genera vídeo`);
      }
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model.model)) {
        throw new MediaProviderFailure('invalid_request', `El nombre del modelo de ${PROVIDER_NAME} no es válido`);
      }
      const size = sizeOf(media, model);
      const quality = settingString(model, 'quality', ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) ?? 'medium';
      const transparent = media.kind === 'image_edit' && media.operation === 'remove_background';
      const format = transparent
        ? 'png'
        : (settingString(model, 'output_format', ['png', 'jpeg', 'webp']) ?? 'jpeg');
      const sizeText = `${size.width}x${size.height}`;
      const fidelity = settingString(model, 'input_fidelity', ['low', 'high']);

      let url: string;
      let init: RequestInit;
      const editSource: MediaInput[] =
        media.kind === 'image_edit' ? [media.source] : (media as ImageRequest).references ?? [];

      if (editSource.length > MAX_REFERENCES) {
        throw new MediaProviderFailure(
          'invalid_request',
          `${PROVIDER_NAME} admite como mucho ${MAX_REFERENCES} imágenes de entrada aquí`,
        );
      }
      if (editSource.length === 0) {
        url = `${baseUrl}/v1/images/generations`;
        init = {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model.model,
            prompt: (media as ImageRequest).prompt,
            size: sizeText,
            quality,
            n: 1,
            output_format: format,
          }),
        };
      } else {
        const form = new FormData();
        form.set('model', model.model);
        form.set('prompt', media.kind === 'image_edit' ? editPromptFor(media) : media.prompt);
        form.set('size', sizeText);
        form.set('quality', quality);
        form.set('n', '1');
        form.set('output_format', format);
        if (transparent) form.set('background', 'transparent');
        if (fidelity) form.set('input_fidelity', fidelity);
        const field = editSource.length > 1 ? 'image[]' : 'image';
        for (const [index, input] of editSource.entries()) {
          const bytes = await bytesOf(input, signal);
          form.append(field, new Blob([bytes], { type: input.mimeType }), `foto-${index + 1}.${extensionOf(input.mimeType)}`);
        }
        if (media.kind === 'image_edit' && media.subjectMask) {
          form.set('mask', new Blob([media.subjectMask.bytes], { type: 'image/png' }), 'mascara.png');
        }
        url = `${baseUrl}/v1/images/edits`;
        // Sin `Content-Type`: lo pone `fetch` con el delimitador del formulario.
        init = { method: 'POST', headers, body: form };
      }

      const { response, body } = await request(url, init, { ...http, signal });
      if (!response.ok) {
        const error = isRecord(body) && isRecord(body.error) ? body.error : {};
        const code = typeof error.code === 'string' ? error.code : '';
        if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
          throw new MediaProviderFailure('insufficient_credits', `${PROVIDER_NAME} no tiene saldo o ha llegado a su límite de gasto`);
        }
        if (code.includes('moderation') || code === 'content_policy_violation') {
          throw new MediaProviderFailure(
            'moderated',
            `${PROVIDER_NAME} ha rechazado la petición por su moderación de contenido`,
          );
        }
        throw failureFromResponse(PROVIDER_NAME, response, body);
      }
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const [image] = data;
      const encoded = isRecord(image) && typeof image.b64_json === 'string' ? image.b64_json : '';
      if (!encoded) throw new MediaProviderFailure('bad_response', `${PROVIDER_NAME} no ha devuelto ninguna imagen`);
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(encoded);
      } catch {
        throw new MediaProviderFailure('bad_response', `${PROVIDER_NAME} ha devuelto una imagen que no se entiende`);
      }
      // Sin `usage` en dinero: se cobra la cota reservada (el consumo real viene en tokens).
      return { status: 'completed', outputs: [{ mimeType: outputMime(format), bytes }] };
    },
  };
}
