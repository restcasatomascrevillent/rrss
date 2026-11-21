// Preparar un encargo desde la aplicación (además de con la herramienta
// `agency/`): tomarlo, soltarlo y entregar una pieza que ya existe. Usa las
// mismas funciones de la base de datos (`take_content_request`,
// `release_content_request`, `deliver_content_request`) y el mismo
// verificador de marca que la herramienta, que no deja entregar con bloqueos.
//
// Cerrojo: la aplicación toma el encargo sin clave de sesión. La herramienta de
// la agencia usa una clave propia, así que, para la base de datos, la
// aplicación y la herramienta son sesiones distintas aunque sea la misma cuenta.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildBrandCheckInput, verifyPiece, type BrandCheckResult } from '@/features/brandcheck';
import { parseProfile } from '@/features/brand/profile';
import { contentKeys, fetchContent } from '@/features/content/api';
import type { ContentDocument } from '@/features/content/document';
import { getFormatSpec } from '@/features/content/networks';
import type { ContentItemRow, ContentRequestRow, Json } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { requestKeys } from './api';

/** Lo que puede hacer con el cerrojo del encargo quien edita la marca, ahora. */
export type PrepareState =
  /** Se puede tomar (pedido, con cambios pedidos o con el cerrojo caducado). */
  | 'takeable'
  /** Lo tiene tomado esta persona desde la aplicación: puede entregar o soltar. */
  | 'mine'
  /** Lo tiene tomado esta misma cuenta desde otra sesión (la herramienta de la agencia). */
  | 'other_session'
  /** Lo está preparando otra persona. */
  | 'taken_by_other'
  /** Entregado, aceptado o cancelado: aquí no hay nada que preparar. */
  | 'none';

export function prepareState(
  request: Pick<ContentRequestRow, 'status' | 'claimed_by' | 'claim_token' | 'claimed_until'>,
  userId: string,
  now: number = Date.now(),
): PrepareState {
  if (request.status === 'requested' || request.status === 'changes_requested') return 'takeable';
  if (request.status !== 'in_progress') return 'none';
  const live = request.claimed_until !== null && new Date(request.claimed_until).getTime() > now;
  if (!live) return 'takeable';
  if (request.claimed_by !== userId) return 'taken_by_other';
  return request.claim_token ? 'other_session' : 'mine';
}

/** El verificador de marca sobre el documento, con la red y el formato del encargo (como `agency/`). */
export function checkForRequest(
  document: ContentDocument,
  request: Pick<ContentRequestRow, 'network' | 'format'>,
  profileData: unknown | null,
): BrandCheckResult {
  const spec = getFormatSpec(request.network, request.format);
  return verifyPiece(buildBrandCheckInput(document, spec, profileData ? parseProfile(profileData) : null));
}

/** Piezas que se pueden entregar: de la marca, sin archivar, con documento y del mismo destino que el encargo. */
export function useDeliverableItems(brandId: string, network: string, format: string, enabled: boolean) {
  return useQuery({
    queryKey: [...requestKeys.all(brandId), 'deliverable', network, format] as const,
    enabled,
    queryFn: async (): Promise<ContentItemRow[]> =>
      unwrap(
        await supabase
          .from('content_items')
          .select('*')
          .eq('brand_id', brandId)
          .eq('network', network)
          .eq('format', format)
          .is('archived_at', null)
          .gt('current_version', 0)
          .order('updated_at', { ascending: false })
          .limit(100),
      ),
  });
}

/** La pieza elegida con su versión vigente (se lee al elegirla, para verificar lo que se va a entregar). */
export function usePieceToDeliver(brandId: string, contentId: string | null) {
  return useQuery({
    queryKey: [...contentKeys.all(brandId), 'deliver', contentId ?? ''] as const,
    enabled: contentId !== null,
    queryFn: () => fetchContent(contentId!),
  });
}

export function usePrepareMutations(brandId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: requestKeys.all(brandId) });

  const take = useMutation({
    mutationFn: async (requestId: string) =>
      unwrap(await supabase.rpc('take_content_request', { p_request_id: requestId, p_claim_token: null })),
    onSettled: refresh,
  });

  const release = useMutation({
    mutationFn: async (requestId: string) =>
      unwrap(await supabase.rpc('release_content_request', { p_request_id: requestId, p_claim_token: null })),
    onSettled: refresh,
  });

  const deliver = useMutation({
    mutationFn: async (input: {
      request: Pick<ContentRequestRow, 'id' | 'delivered_version'>;
      title: string;
      document: ContentDocument;
    }) =>
      unwrap(
        await supabase.rpc('deliver_content_request', {
          p_request_id: input.request.id,
          p_data: input.document as unknown as Json,
          p_schema_version: input.document.schemaVersion,
          p_claim_token: null,
          p_title: input.title,
          p_change_note:
            input.request.delivered_version === null
              ? 'Entregado desde la aplicación'
              : 'Entregado desde la aplicación (con los cambios pedidos)',
        }),
      ),
    onSettled: async () => {
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: contentKeys.all(brandId) })]);
    },
  });

  return { take, release, deliver };
}
