// Lógica de la Edge Function `ai-media`: generación de IMÁGENES con IA. Sin
// nada de Deno: recibe sus dependencias y devuelve una `Response`, así las
// pruebas la ejecutan en Node con la base de datos real y el proveedor simulado.
//
// Acciones (todas con sesión; la marca debe ser visible para quien pide):
//   image.models    modelos de imagen que el servidor tiene configurados;
//   image.estimate  coste máximo de una petición, SIN reservar nada;
//   image.generate  reserva cupo y genera. Síncrono → devuelve el recurso de la
//                   biblioteca; asíncrono → devuelve la generación en curso, que
//                   cierra `ai-media-poll` (o el webhook del proveedor).
//   photo.options   ediciones de foto con IA disponibles (quitar el fondo, ampliar);
//   photo.estimate  coste máximo de editar una foto, SIN reservar nada;
//   photo.edit      reserva cupo y edita una foto de la biblioteca. El resultado
//                   es SIEMPRE un recurso nuevo (procedencia `ai_edit` con el
//                   original); la foto original no se toca (docs/edicion-fotos.md).
//
// El permiso de edición en la marca lo impone la base de datos al reservar el
// cupo (`ai_reserve_generation`, 42501 → 403): no hay forma de generar sin él.
// El vídeo generativo no se expone: nace apagado por criterio de datos
// (docs/06-decisiones-fase-2.md).
//
// Errores: mismos códigos, estados y mensajes que `ai-generate`.
import { AiError, type AiErrorCode } from '../_shared/ai/contract.ts';
import {
  IMAGE_EDIT_OPERATIONS,
  MediaRequestError,
  type AspectRatio,
  type ImageEditOperation,
  type ImageEditRequest,
  type ImageRequest,
  type MediaInput,
} from '../_shared/ai/media/contract.ts';
import type { MediaRuntime } from '../_shared/ai/media/runtime.ts';

export const AI_MEDIA_ACTIONS = [
  'image.models',
  'image.estimate',
  'image.generate',
  'photo.options',
  'photo.estimate',
  'photo.edit',
] as const;
export type AiMediaAction = (typeof AI_MEDIA_ACTIONS)[number];

/** Proporciones del lienzo del editor. */
export const IMAGE_ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9'] as const;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_REFERENCES = 4;
const DEFAULT_PURPOSE = 'post.visual';
const PURPOSE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tope del cuerpo: la máscara del sujeto (PNG, hasta 1 MB) viaja en base64 dentro del JSON. */
const MAX_BODY_BYTES = 1_500_000;
const MAX_BACKGROUND_CHARS = 500;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface AiMediaDeps {
  /** Valida el token de sesión y devuelve el usuario, o `null` si no vale. */
  authenticate(accessToken: string): Promise<{ userId: string } | null>;
  /** ¿Ve el usuario esta marca? Con su identidad (RLS). */
  brandVisible(accessToken: string, brandId: string): Promise<boolean>;
  /**
   * Imágenes de referencia de la biblioteca de la marca, CON LA IDENTIDAD DEL
   * USUARIO (RLS): solo las que ve, solo imágenes, solo de esa marca. Devuelve
   * `null` si alguna no cumple.
   */
  loadReferences(accessToken: string, brandId: string, assetIds: string[]): Promise<MediaInput[] | null>;
  /**
   * La foto que se va a editar, CON LA IDENTIDAD DEL USUARIO (RLS): solo una
   * imagen de esa marca, guardada en nuestro almacenamiento (no Drive), JPEG,
   * PNG o WebP y con medidas. Con `sign`, la URL firmada para el proveedor.
   * `null` si no cumple. Sin ella, la edición de fotos no se ofrece.
   */
  loadPhoto?(
    accessToken: string,
    brandId: string,
    assetId: string,
    options: { sign: boolean },
  ): Promise<{ input: MediaInput & { width: number; height: number }; fileName: string } | null>;
  /** Servicio y modelos, ya montados (ver runtime.ts). */
  runtime(): Promise<MediaRuntime>;
  /** Registro del servidor. Nunca recibe claves ni el encargo. */
  log?: (event: string, data: Record<string, unknown>) => void;
  allowedOrigin?: string;
}

const STATUS: Record<AiErrorCode, number> = {
  quota_exhausted: 402,
  quota_missing: 402,
  forbidden: 403,
  not_configured: 503,
  provider_failed: 502,
  provider_timeout: 504,
  invalid_output: 502,
  refused: 422,
  internal: 500,
};

/** Tamaño que se pide para cada proporción: unos 1 MP, en múltiplos de 64. */
export function imageSizeFor(ratio: string): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number) as [number, number];
  const target = 1024 * 1024;
  const width = Math.round(Math.sqrt((target * w) / h) / 64) * 64;
  const height = Math.round(Math.sqrt((target * h) / w) / 64) * 64;
  return { width, height };
}

class InputError extends Error {}

interface PhotoInput {
  assetId: string;
  operation: ImageEditOperation;
  scale?: 2 | 4;
  prompt?: string;
  /** PNG con las medidas de la foto: lo opaco es el sujeto (ver `ImageEditRequest.subjectMask`). */
  subjectMask?: Uint8Array;
  /** Solo al estimar: avisa de que habrá máscara, sin mandarla (el coste cuenta la máscara). */
  maskPresent?: boolean;
}

function decodePng(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new InputError('La máscara del sujeto no es válida.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 33 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
    throw new InputError('La máscara del sujeto tiene que ser un PNG.');
  }
  return bytes;
}

/** Ancho y alto que declara la cabecera de un PNG (IHDR). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parsePhotoInput(data: Record<string, unknown>): PhotoInput {
  if (typeof data.assetId !== 'string' || !UUID.test(data.assetId)) {
    throw new InputError('Indica la foto de la biblioteca que quieres editar.');
  }
  const operation = data.operation;
  if (typeof operation !== 'string' || !(IMAGE_EDIT_OPERATIONS as readonly string[]).includes(operation)) {
    throw new InputError(`Indica la edición: ${IMAGE_EDIT_OPERATIONS.join(', ')}.`);
  }
  const op = operation as ImageEditOperation;
  if (op === 'upscale') {
    const scale = data.scale ?? 2;
    if (scale !== 2 && scale !== 4) throw new InputError('Se puede ampliar ×2 o ×4.');
    if (data.prompt !== undefined || data.subjectMask !== undefined || data.maskPresent !== undefined) {
      throw new InputError('Ampliar no admite descripción ni máscara.');
    }
    return { assetId: data.assetId, operation: op, scale };
  }
  if (data.scale !== undefined) throw new InputError('Esta edición no admite factor de ampliación.');
  if (op === 'replace_background') {
    const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
    if (!prompt) throw new InputError('Describe el fondo que quieres.');
    if (prompt.length > MAX_BACKGROUND_CHARS) {
      throw new InputError(`La descripción del fondo es demasiado larga: como mucho ${MAX_BACKGROUND_CHARS} caracteres.`);
    }
    const subjectMask = data.subjectMask === undefined ? undefined : decodePng(String(data.subjectMask));
    return {
      assetId: data.assetId,
      operation: op,
      prompt,
      ...(subjectMask ? { subjectMask } : {}),
      ...(data.maskPresent === true ? { maskPresent: true } : {}),
    };
  }
  if (data.prompt !== undefined || data.subjectMask !== undefined || data.maskPresent !== undefined) {
    throw new InputError('Esta edición no admite descripción ni máscara.');
  }
  return { assetId: data.assetId, operation: op };
}

interface ParsedInput {
  prompt: string;
  aspectRatio: AspectRatio;
  model?: string;
  referenceAssetIds: string[];
  purpose: string;
}

function parseImageInput(data: Record<string, unknown>, requirePrompt: boolean): ParsedInput {
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (requirePrompt && !prompt) throw new InputError('Describe la imagen que quieres (encargo).');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new InputError(`El encargo es demasiado largo: como mucho ${MAX_PROMPT_CHARS} caracteres.`);
  }
  const aspectRatio = data.aspectRatio;
  if (typeof aspectRatio !== 'string' || !(IMAGE_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new InputError(`Indica la proporción: ${IMAGE_ASPECT_RATIOS.join(', ')}.`);
  }
  if (data.model !== undefined && (typeof data.model !== 'string' || !data.model)) {
    throw new InputError('El modelo indicado no es válido.');
  }
  const refs = data.referenceAssetIds ?? [];
  if (!Array.isArray(refs) || refs.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw new InputError('Las imágenes de referencia no son válidas.');
  }
  const unique = [...new Set(refs as string[])];
  if (unique.length > MAX_REFERENCES) {
    throw new InputError(`Como mucho ${MAX_REFERENCES} imágenes de referencia.`);
  }
  const purpose = data.purpose === undefined ? DEFAULT_PURPOSE : data.purpose;
  if (typeof purpose !== 'string' || !PURPOSE.test(purpose)) throw new InputError('El propósito no es válido.');
  return {
    prompt,
    aspectRatio: aspectRatio as AspectRatio,
    model: data.model as string | undefined,
    referenceAssetIds: unique,
    purpose,
  };
}

export function createAiMediaHandler(deps: AiMediaDeps): (request: Request) => Promise<Response> {
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
  const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    json(status, { error: { code, message, retryable: false, ...extra } });

  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Esta función solo admite POST.');

    // 1. Sesión.
    const header = request.headers.get('authorization') ?? '';
    const accessToken = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    if (!accessToken) return fail(401, 'unauthenticated', 'Inicia sesión para usar la IA.');
    let user: { userId: string } | null;
    try {
      user = await deps.authenticate(accessToken);
    } catch {
      return fail(500, 'internal', 'No se ha podido comprobar la sesión. Inténtalo de nuevo.', { retryable: true });
    }
    if (!user) return fail(401, 'unauthenticated', 'La sesión ha caducado. Vuelve a iniciar sesión.');

    // 2. Petición.
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'La petición es demasiado grande.');
      body = JSON.parse(raw);
    } catch {
      return fail(400, 'invalid_request', 'La petición no es JSON válido.');
    }
    const { action, brandId, input } = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    if (typeof action !== 'string' || !(AI_MEDIA_ACTIONS as readonly string[]).includes(action)) {
      return fail(400, 'invalid_request', `Indica la acción: ${AI_MEDIA_ACTIONS.join(', ')}.`);
    }
    if (typeof brandId !== 'string' || !UUID.test(brandId)) {
      return fail(400, 'invalid_request', 'Indica la marca (brandId).');
    }
    const data = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}) as Record<
      string,
      unknown
    >;

    try {
      if (!(await deps.brandVisible(accessToken, brandId))) {
        return fail(404, 'brand_not_found', 'No existe esa marca o no tienes acceso a ella.');
      }
      const runtime = await deps.runtime();

      if (action === 'image.models') {
        return json(200, { action, models: runtime.imageChoices });
      }

      if (action === 'photo.options') {
        return json(200, { action, edits: deps.loadPhoto ? runtime.editChoices : [] });
      }

      if (action === 'photo.estimate' || action === 'photo.edit') {
        const photo = parsePhotoInput(data);
        if (!deps.loadPhoto || !runtime.editChoices.some((c) => c.operation === photo.operation)) {
          throw new AiError('not_configured', `No hay ningún modelo para «${photo.operation}» disponible.`);
        }
        const loaded = await deps.loadPhoto(accessToken, brandId, photo.assetId, { sign: action === 'photo.edit' });
        if (!loaded) {
          return fail(
            400,
            'invalid_request',
            'Esa foto no existe, no es de esta marca o no se puede editar con IA (solo fotos JPEG, PNG o WebP subidas a la biblioteca).',
          );
        }
        const editRequest: ImageEditRequest = {
          kind: 'image_edit',
          operation: photo.operation,
          source: loaded.input,
          ...(photo.scale ? { scale: photo.scale } : {}),
          ...(photo.prompt ? { prompt: photo.prompt } : {}),
        };
        if (photo.maskPresent && action === 'photo.estimate') {
          editRequest.subjectMask = { mimeType: 'image/png', bytes: new Uint8Array(0) };
        } else if (photo.subjectMask) {
          // La máscara tiene que tener exactamente las medidas de la foto.
          const size = pngSize(photo.subjectMask);
          if (size.width !== loaded.input.width || size.height !== loaded.input.height) {
            throw new InputError('La máscara del sujeto no tiene las mismas medidas que la foto.');
          }
          editRequest.subjectMask = { mimeType: 'image/png', bytes: photo.subjectMask };
        }
        const service = runtime.serviceFor();
        if (action === 'photo.estimate') {
          const estimate = service.estimate(editRequest);
          return json(200, {
            action,
            operation: photo.operation,
            model: `${estimate.provider}:${estimate.model}`,
            costMicros: estimate.costMicros,
            dataHandling: estimate.dataHandling,
          });
        }
        const result = await service.generate({
          userId: user.userId,
          brandId,
          purpose: `photo.${photo.operation}`,
          request: editRequest,
          edit: { sourceAssetId: photo.assetId, sourceName: loaded.fileName },
        });
        const common = {
          action,
          operation: photo.operation,
          generationId: result.generationId,
          model: `${result.provider}:${result.model}`,
          estimatedCostMicros: result.estimatedCostMicros,
          dataHandling: {
            dataRegion: result.dataRegion,
            euProcessing: result.euProcessing,
            trainsOnInputs: result.trainsOnInputs,
            untestedAdapter: result.untestedAdapter,
          },
        };
        if (result.status === 'pending') return json(202, { ...common, status: 'pending', jobId: result.jobId });
        const asset = result.assets[0];
        if (!asset?.assetId) {
          return fail(500, 'internal', 'La foto se editó, pero no se ha podido añadir a la biblioteca.', {
            retryable: true,
            generationId: result.generationId,
          });
        }
        return json(200, {
          ...common,
          status: 'completed',
          costMicros: result.costMicros,
          asset: { id: asset.assetId, path: asset.path, mimeType: asset.mimeType, bytes: asset.bytes },
        });
      }

      const parsed = parseImageInput(data, action === 'image.generate');
      if (parsed.model && !runtime.imageChoices.some((c) => c.id === parsed.model)) {
        return fail(400, 'invalid_request', 'Ese modelo no está disponible. Elige otro de la lista.');
      }
      const references = parsed.referenceAssetIds.length
        ? await deps.loadReferences(accessToken, brandId, parsed.referenceAssetIds)
        : [];
      if (references === null) {
        return fail(400, 'invalid_request', 'Alguna imagen de referencia no existe o no es una imagen de esta marca.');
      }
      const imageRequest: ImageRequest = {
        kind: 'image',
        // Para estimar basta con un texto cualquiera: el coste no depende de él.
        prompt: parsed.prompt || 'estimación',
        aspectRatio: parsed.aspectRatio,
        size: imageSizeFor(parsed.aspectRatio),
        ...(references.length ? { references } : {}),
      };
      const service = runtime.serviceFor(parsed.model);

      if (action === 'image.estimate') {
        const estimate = service.estimate(imageRequest);
        return json(200, {
          action,
          model: `${estimate.provider}:${estimate.model}`,
          costMicros: estimate.costMicros,
          usage: estimate.usage,
          dataHandling: estimate.dataHandling,
          size: imageRequest.size,
        });
      }

      const result = await service.generate({
        userId: user.userId,
        brandId,
        purpose: parsed.purpose,
        request: imageRequest,
      });
      const common = {
        action,
        generationId: result.generationId,
        model: `${result.provider}:${result.model}`,
        estimatedCostMicros: result.estimatedCostMicros,
        dataHandling: {
          dataRegion: result.dataRegion,
          euProcessing: result.euProcessing,
          trainsOnInputs: result.trainsOnInputs,
          untestedAdapter: result.untestedAdapter,
        },
      };
      if (result.status === 'pending') {
        return json(202, { ...common, status: 'pending', jobId: result.jobId });
      }
      const asset = result.assets[0];
      if (!asset?.assetId) {
        return fail(500, 'internal', 'La imagen se generó, pero no se ha podido añadir a la biblioteca.', {
          retryable: true,
          generationId: result.generationId,
        });
      }
      return json(200, {
        ...common,
        status: 'completed',
        costMicros: result.costMicros,
        asset: { id: asset.assetId, path: asset.path, mimeType: asset.mimeType, bytes: asset.bytes },
      });
    } catch (error) {
      if (error instanceof InputError || error instanceof MediaRequestError) {
        return fail(400, 'invalid_request', error.message);
      }
      if (error instanceof AiError) {
        deps.log?.('ai_error', {
          action,
          brandId,
          code: error.code,
          generationId: error.generationId,
          detail: error.code === 'not_configured' ? error.message : error.details,
        });
        const message =
          error.code === 'not_configured'
            ? 'La IA no está disponible en este momento. Avisa a quien administra la plataforma.'
            : error.message;
        return json(STATUS[error.code], {
          error: { code: error.code, message, retryable: error.retryable, generationId: error.generationId },
        });
      }
      deps.log?.('unexpected_error', { action, brandId });
      return fail(500, 'internal', 'Algo ha fallado al usar la IA. Inténtalo de nuevo.', { retryable: true });
    }
  };
}
