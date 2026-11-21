// Cliente de la Edge Function `ai-media` (generación de imágenes con IA,
// contrato en docs/ia-medios.md, §7) y seguimiento de las generaciones
// asíncronas leyendo `ai_generations` y `media_assets` (RLS de siempre).
//
// Errores: los mismos códigos y mensajes que la IA de texto (`api.ts`).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assetKeys } from '@/features/library/api';
import type { AiGenerationRow, AiMediaGenerationOutput, MediaAssetRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { AiRequestError, aiErrorMessage, toAiError, type AsyncMutation } from './api';

export type ImageAspectRatio = '1:1' | '4:5' | '9:16' | '16:9';
export const MAX_IMAGE_PROMPT_CHARS = 2000;
export const MAX_IMAGE_REFERENCES = 4;

export interface ImageModelChoice {
  /** `proveedor:modelo`. */
  id: string;
  displayName: string;
  delivery: 'sync' | 'async';
  dataRegion: 'eu' | 'us' | 'global' | 'unknown';
  euProcessing: boolean;
  trainsOnInputs: 'no' | 'yes' | 'unknown';
  untestedAdapter: boolean;
  default: boolean;
}

export interface ImageRequestInput {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  model?: string;
  referenceAssetIds?: string[];
}

export interface ImageEstimate {
  model: string;
  costMicros: number;
  size: { width: number; height: number };
}

interface DataHandling {
  dataRegion: string;
  euProcessing: boolean;
  trainsOnInputs: string;
  untestedAdapter: boolean;
}

export type GenerateImageResult =
  | {
      status: 'completed';
      generationId: string;
      model: string;
      costMicros: number;
      estimatedCostMicros: number;
      asset: { id: string; path: string };
      dataHandling: DataHandling;
    }
  | {
      status: 'pending';
      generationId: string;
      model: string;
      estimatedCostMicros: number;
      jobId: string;
      dataHandling: DataHandling;
    };

/** La generación de imagen tarda más que la de texto: margen sobre los 120 s del servidor. */
const CLIENT_TIMEOUT_MS = 150_000;

async function invokeAiMedia<T>(action: string, brandId: string, input?: unknown): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke('ai-media', {
      body: { action, brandId, input },
      timeout: CLIENT_TIMEOUT_MS,
    });
  } catch (error) {
    throw await toAiError(error);
  }
  if (result.error) throw await toAiError(result.error);
  const data = result.data as (T & { action?: string }) | null;
  if (!data || typeof data !== 'object' || data.action !== action) {
    throw new AiRequestError('internal', aiErrorMessage('internal'), { retryable: true });
  }
  return data;
}

export const imageKeys = {
  models: (brandId: string) => ['ai-image', brandId, 'models'] as const,
  estimate: (brandId: string, input: ImageRequestInput) => ['ai-image', brandId, 'estimate', input] as const,
  generation: (generationId: string) => ['ai-image', 'generation', generationId] as const,
};

/** Modelos de imagen que el servidor tiene configurados. */
export function useImageModels(brandId: string, enabled = true) {
  return useQuery<ImageModelChoice[], AiRequestError>({
    queryKey: imageKeys.models(brandId),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => (await invokeAiMedia<{ models: ImageModelChoice[] }>('image.models', brandId)).models ?? [],
  });
}

/** Coste máximo de una petición, ANTES de generar. No reserva nada. */
export function useImageEstimate(brandId: string, input: ImageRequestInput, enabled = true) {
  return useQuery<ImageEstimate, AiRequestError>({
    queryKey: imageKeys.estimate(brandId, { ...input, prompt: '' }),
    enabled,
    staleTime: 60_000,
    retry: false,
    // El coste no depende del texto: no se vuelve a pedir con cada tecla.
    queryFn: () => invokeAiMedia<ImageEstimate>('image.estimate', brandId, { ...input, prompt: '' }),
  });
}

/** Genera. Al terminar (síncrono) la biblioteca ya tiene la imagen. */
export function useGenerateImage(brandId: string): AsyncMutation<GenerateImageResult, ImageRequestInput> {
  const queryClient = useQueryClient();
  const mutation = useMutation<GenerateImageResult, AiRequestError, ImageRequestInput>({
    mutationFn: (input) => invokeAiMedia<GenerateImageResult>('image.generate', brandId, input),
    onSuccess: (result) => {
      if (result.status === 'completed') void queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
    },
  });
  const copy: Partial<typeof mutation> = { ...mutation };
  delete copy.mutate;
  return copy as AsyncMutation<GenerateImageResult, ImageRequestInput>;
}

export type GenerationProgress =
  | { status: 'running' }
  | { status: 'completed'; asset: MediaAssetRow; costMicros: number | null }
  | { status: 'failed'; message: string };

/** Mensaje para personas de cómo acabó mal una generación (sin el detalle técnico del proveedor). */
function failureMessage(row: Pick<AiGenerationRow, 'status' | 'error_code'>): string {
  if (row.status === 'expired' || row.error_code === 'never_finished') {
    return 'La IA no terminó la imagen a tiempo. No se ha descontado nada del cupo. Vuelve a probar.';
  }
  if (row.error_code === 'moderated') {
    return 'El proveedor ha rechazado la petición por su contenido. Cambia el encargo y vuelve a probar.';
  }
  return aiErrorMessage('provider_failed');
}

/**
 * Sigue una generación asíncrona: consulta cada pocos segundos su estado en
 * `ai_generations` y, al terminar, el recurso que dejó en la biblioteca.
 */
export function useGenerationProgress(brandId: string, generationId: string | null) {
  const queryClient = useQueryClient();
  return useQuery<GenerationProgress>({
    queryKey: imageKeys.generation(generationId ?? ''),
    enabled: generationId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' || !query.state.data ? 3000 : false),
    queryFn: async (): Promise<GenerationProgress> => {
      const generation = unwrap(
        await supabase
          .from('ai_generations')
          .select('id, status, error_code, cost_micros, output')
          .eq('id', generationId!)
          .maybeSingle(),
      ) as Pick<AiGenerationRow, 'id' | 'status' | 'error_code' | 'cost_micros' | 'output'> | null;
      if (!generation || generation.status === 'reserved') return { status: 'running' };
      if (generation.status !== 'succeeded') return { status: 'failed', message: failureMessage(generation) };
      // El servicio anota en la generación el recurso que creó en la biblioteca.
      const assetId = (generation.output as AiMediaGenerationOutput | null)?.assets?.[0]?.asset_id;
      const asset = assetId
        ? (unwrap(
            await supabase.from('media_assets').select('*').eq('brand_id', brandId).eq('id', assetId).maybeSingle(),
          ) as MediaAssetRow | null)
        : null;
      if (!asset) {
        return { status: 'failed', message: 'La IA generó la imagen, pero no se ha podido añadir a la biblioteca.' };
      }
      void queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
      return {
        status: 'completed',
        asset,
        costMicros: generation.cost_micros === null ? null : Number(generation.cost_micros),
      };
    },
  });
}
