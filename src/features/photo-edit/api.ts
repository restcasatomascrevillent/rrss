// Edición de fotos: guardar en la biblioteca lo editado en el navegador y
// pedir a `ai-media` lo que necesita IA (quitar el fondo, ampliar). En los dos
// casos el resultado es un recurso NUEVO; la foto original no se toca.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { aiPhotoEditEnabled } from '@/config/app';
import { AiRequestError, aiErrorMessage, toAiError } from '@/features/ai/api';
import { assetKeys, uploadAsset } from '@/features/library/api';
import { isDrivePath, signDrivePaths } from '@/features/drive/api';
import { signStoragePaths } from '@/features/storage/api';
import type { Json, MediaAssetRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { EDIT_TAG, EDITS_FOLDER } from './provenance';

export type AiPhotoOperation = 'remove_background' | 'upscale' | 'replace_background' | 'enhance';

export const AI_OPERATION_LABEL: Record<AiPhotoOperation, string> = {
  remove_background: 'Quitar el fondo',
  upscale: 'Ampliar la resolución',
  replace_background: 'Cambiar el fondo con IA',
  enhance: 'Mejorar luz y color con IA',
};

/** Ideas de fondo para el plato, a un clic (el texto es libre). */
export const BACKGROUND_SUGGESTIONS = [
  'mesa de mármol blanco con luz cálida',
  'mantel de lino beige',
  'mesa de madera rústica',
  'pizarra oscura',
] as const;

/** Una edición con IA que el servidor puede hacer ahora mismo. */
export interface AiEditChoice {
  operation: AiPhotoOperation;
  model: string;
  delivery: 'sync' | 'async';
  dataRegion: 'eu' | 'us' | 'global' | 'unknown';
  euProcessing: boolean;
  trainsOnInputs: 'no' | 'yes' | 'unknown';
  untestedAdapter: boolean;
  /** El modelo usa la máscara del sujeto para proteger el plato. */
  usesSubjectMask?: boolean;
}

export interface AiEditInput {
  assetId: string;
  operation: AiPhotoOperation;
  scale?: 2 | 4;
  /** Solo «cambiar el fondo»: cómo debe quedar. */
  prompt?: string;
  /** Máscara del sujeto (PNG en base64, con las medidas de la foto; lo opaco es el plato). */
  subjectMask?: string;
  /** Solo al estimar: habrá máscara (no se manda). */
  maskPresent?: boolean;
}

/** Pasa una máscara PNG a base64 para mandarla a `ai-media`. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export type AiEditResult =
  | { status: 'completed'; generationId: string; costMicros: number; asset: { id: string; path: string } }
  | { status: 'pending'; generationId: string; jobId: string };

/** Tipos que se pueden editar (en el navegador y con IA). */
export const EDITABLE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** ¿Se puede editar esta foto? Fotos y logotipos JPEG, PNG o WebP. */
export function canEditPhoto(asset: Pick<MediaAssetRow, 'kind' | 'mime_type'>): boolean {
  return (asset.kind === 'image' || asset.kind === 'logo') && EDITABLE_MIME_TYPES.includes(asset.mime_type);
}

/** ¿Se puede mandar a la IA? Además, tiene que estar en nuestro almacenamiento (no en Drive) y con medidas. */
export function canEditWithAi(asset: Pick<MediaAssetRow, 'kind' | 'mime_type' | 'storage_path' | 'width' | 'height'>) {
  return canEditPhoto(asset) && !isDrivePath(asset.storage_path) && Boolean(asset.width && asset.height);
}

/** Lado máximo del resultado al ampliar (el mismo tope que el servidor). */
export const MAX_UPSCALE_SIDE = 4096;

/** Factores de ampliación posibles para una foto de ese tamaño. */
export function upscaleFactors(width: number | null, height: number | null): Array<2 | 4> {
  if (!width || !height) return [];
  return ([2, 4] as const).filter((factor) => Math.max(width, height) * factor <= MAX_UPSCALE_SIDE);
}

async function invokePhoto<T>(action: string, brandId: string, input?: unknown): Promise<T> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke('ai-media', { body: { action, brandId, input }, timeout: 150_000 });
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

export const photoEditKeys = {
  options: (brandId: string) => ['photo-edit', brandId, 'options'] as const,
  estimate: (brandId: string, input: AiEditInput) => ['photo-edit', brandId, 'estimate', input] as const,
  edits: (brandId: string, assetId: string) => [...assetKeys.all(brandId), 'edits', assetId] as const,
};

/**
 * Ediciones con IA disponibles. Sin el interruptor `VITE_AI_PHOTO_EDIT_ENABLED`
 * ni se pregunta (lista vacía); con él, el servidor dice cuáles tienen modelo.
 */
export function useAiEditOptions(brandId: string, enabled = true) {
  const on = aiPhotoEditEnabled() && enabled;
  return useQuery<AiEditChoice[], AiRequestError>({
    queryKey: photoEditKeys.options(brandId),
    enabled: on,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => (await invokePhoto<{ edits: AiEditChoice[] }>('photo.options', brandId)).edits ?? [],
  });
}

/** Coste máximo de una edición con IA, ANTES de hacerla. No reserva nada. */
export function useAiEditEstimate(brandId: string, input: AiEditInput, enabled = true) {
  return useQuery<{ costMicros: number; model: string }, AiRequestError>({
    queryKey: photoEditKeys.estimate(brandId, input),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: () => invokePhoto('photo.estimate', brandId, input),
  });
}

/** Pide la edición con IA. Al terminar (síncrono), el resultado ya está en la biblioteca. */
export function useAiEdit(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation<AiEditResult, AiRequestError, AiEditInput>({
    mutationFn: (input) => invokePhoto<AiEditResult>('photo.edit', brandId, input),
    onSuccess: (result) => {
      if (result.status === 'completed') void queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) });
    },
  });
}

/** Lee un recurso de la biblioteca por su identificador (el resultado de una edición con IA). */
export async function fetchAsset(brandId: string, assetId: string): Promise<MediaAssetRow | null> {
  return unwrap(
    await supabase.from('media_assets').select('*').eq('brand_id', brandId).eq('id', assetId).maybeSingle(),
  ) as MediaAssetRow | null;
}

/** Dirección firmada (1 h) de un recurso, de Storage, R2 o Drive (como `useSignedUrls`). */
export async function signedUrlFor(path: string): Promise<string | undefined> {
  const map = isDrivePath(path) ? await signDrivePaths([path], 'full') : await signStoragePaths([path], 3600);
  return map.get(path);
}

/** Ediciones ya hechas de una foto (en el navegador o con IA), las más nuevas primero. */
export function usePhotoEdits(brandId: string, assetId: string) {
  return useQuery({
    queryKey: photoEditKeys.edits(brandId, assetId),
    queryFn: async (): Promise<MediaAssetRow[]> =>
      unwrap(
        await supabase
          .from('media_assets')
          .select('*')
          .eq('brand_id', brandId)
          .eq('provenance->>source_asset_id', assetId)
          .order('created_at', { ascending: false })
          .limit(12),
      ),
  });
}

export interface SaveEditInput {
  source: Pick<MediaAssetRow, 'id' | 'brand_id' | 'organization_id' | 'kind'>;
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
  provenance: Json;
}

/** Guarda una foto editada en el navegador como recurso nuevo (carpeta «Ediciones»). */
export function useSaveEdit(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveEditInput): Promise<MediaAssetRow> => {
      const file = new File([input.blob], input.fileName, { type: input.blob.type || 'image/png' });
      return uploadAsset({
        organizationId: input.source.organization_id,
        brandId: input.source.brand_id,
        file,
        kind: input.source.kind === 'logo' ? 'logo' : 'image',
        folder: EDITS_FOLDER,
        tags: [EDIT_TAG],
        provenance: input.provenance,
        dimensions: { width: input.width, height: input.height, durationMs: null },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: assetKeys.all(brandId) }),
  });
}
