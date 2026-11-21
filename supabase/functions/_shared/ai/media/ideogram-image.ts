// Adaptador de IMAGEN: Ideogram 3.0 (fuerte en texto legible dentro de la imagen).
//
// SIN PROBAR CONTRA EL SERVICIO REAL: solo con respuestas HTTP simuladas.
// Escrito contra la documentación oficial (consultada el 17/11/2026):
//   https://developer.ideogram.ai/api-reference/api-reference/generate-v3
//
//   POST https://api.ideogram.ai/v1/ideogram-v3/generate   (Api-Key, multipart/form-data)
//     prompt, aspect_ratio («4x5»), rendering_speed, num_images, style_reference_images…
//     → { created, data: [{ url, is_image_safe, resolution, seed }] }
//
// Síncrono. Los enlaces de las imágenes caducan: el servicio las descarga.
//
// Pendiente de confirmar:
//   · Esa misma página marca este endpoint como heredado y remite a
//     `POST /v2/image/generate/ideogram-3`, que no se ha podido leer.
//   · La página no lista los valores admitidos de `aspect_ratio` ni de
//     `rendering_speed` (solo ejemplos: `1x1`, `3x1`, `TURBO`). La velocidad
//     sale de los ajustes del modelo (`settings.rendering_speed`); si no hay,
//     no se envía.
//   · Las imágenes de referencia se mandan como referencia de ESTILO. No se
//     envían referencias de personaje (tienen otra tarifa).
import {
  MediaProviderFailure,
  type MediaProvider,
  type MediaStartRequest,
  type MediaStartResult,
  type MediaUsage,
} from './contract.ts';
import { download, failureFromResponse, isRecord, request, stringAt, type FetchLike } from './http.ts';

export const IDEOGRAM_PROVIDER_ID = 'ideogram';
const PROVIDER_NAME = 'Ideogram';
const GENERATE_URL = 'https://api.ideogram.ai/v1/ideogram-v3/generate';
/** Límite documentado por imagen de referencia. */
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

export interface IdeogramOptions {
  apiKey: string;
  fetch: FetchLike;
  /** Tiempo máximo de la llamada. Por defecto, 120 s. */
  timeoutMs?: number;
}

export function createIdeogramImageProvider(options: IdeogramOptions): MediaProvider {
  const http = { fetch: options.fetch, provider: PROVIDER_NAME, timeoutMs: options.timeoutMs ?? 120_000 };

  return {
    id: IDEOGRAM_PROVIDER_ID,
    kinds: ['image'],
    testedAgainstRealService: false,

    estimateUsage(): MediaUsage {
      return { images: 1 };
    },

    async start({ request: media, model, signal }: MediaStartRequest): Promise<MediaStartResult> {
      if (media.kind !== 'image') {
        throw new MediaProviderFailure('invalid_request', `${PROVIDER_NAME} solo genera imagen`);
      }
      const form = new FormData();
      form.set('prompt', media.prompt);
      form.set('aspect_ratio', media.aspectRatio.replace(':', 'x'));
      form.set('num_images', '1');
      if (typeof model.settings.rendering_speed === 'string')
        form.set('rendering_speed', model.settings.rendering_speed);

      for (const [index, reference] of (media.references ?? []).entries()) {
        let bytes = reference.bytes;
        if (!bytes) {
          if (!reference.url)
            throw new MediaProviderFailure('invalid_request', 'Una imagen de referencia no tiene contenido');
          bytes = (await download(reference.url, { ...http, timeoutMs: 30_000, signal, maxBytes: MAX_REFERENCE_BYTES }))
            .bytes;
        }
        form.append(
          'style_reference_images',
          new Blob([bytes], { type: reference.mimeType }),
          `referencia-${index + 1}`,
        );
      }

      // Sin `Content-Type`: lo pone `fetch` con el delimitador del formulario.
      const { response, body } = await request(
        GENERATE_URL,
        { method: 'POST', headers: { 'Api-Key': options.apiKey }, body: form },
        { ...http, signal },
      );
      if (response.status === 422) {
        throw new MediaProviderFailure(
          'moderated',
          `${PROVIDER_NAME} ha rechazado el texto por su comprobación de seguridad`,
        );
      }
      if (!response.ok) throw failureFromResponse(PROVIDER_NAME, response, body);

      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const [image] = data;
      if (!isRecord(image))
        throw new MediaProviderFailure('bad_response', `${PROVIDER_NAME} no ha devuelto ninguna imagen`);
      const url = stringAt(image, 'url');
      // «If false, url is empty»: la imagen se generó pero no pasa su filtro.
      if (image.is_image_safe === false || !url) {
        throw new MediaProviderFailure(
          'moderated',
          `${PROVIDER_NAME} ha retenido la imagen por su filtro de contenido`,
        );
      }
      return { status: 'completed', outputs: [{ url, mimeType: '' }], usage: { images: 1 } };
    },
  };
}
