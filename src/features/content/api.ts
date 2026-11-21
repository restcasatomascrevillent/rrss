import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { likePattern } from '@/features/library/api';
import type { ContentItemRow, ContentStatus, ContentVersionRow, Json } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import {
  DocumentError,
  migrateDocument,
  validateDocument,
  type ContentDocument,
  type ContentDocumentInput,
} from './document';
import { isKnownTarget } from './networks';

// Acceso a datos de los contenidos de una marca: piezas (content_items) y
// versiones de su documento (content_versions). Las reglas viven en la base de
// datos (migración 20261117100000); aquí solo se valida lo que conviene decir
// antes de ir al servidor, y nunca se guarda un documento que no cumpla el esquema.

export const CONTENT_PAGE_SIZE = 30;

/** Código con el que la base de datos rechaza un guardado sobre una versión que ya no es la última. */
export const CONTENT_VERSION_CONFLICT = 'CT001';

export interface ContentFilters {
  status: ContentStatus | '';
  network: string;
  search: string;
  /** false: las piezas vivas; true: solo las archivadas. */
  archived: boolean;
}

export const DEFAULT_CONTENT_FILTERS: ContentFilters = { status: '', network: '', search: '', archived: false };

export const contentKeys = {
  all: (brandId: string) => ['brand', brandId, 'content'] as const,
  list: (brandId: string, filters: ContentFilters) => ['brand', brandId, 'content', 'list', filters] as const,
  item: (brandId: string, contentId: string) => ['brand', brandId, 'content', 'item', contentId] as const,
  versions: (brandId: string, contentId: string) => ['brand', brandId, 'content', 'versions', contentId] as const,
  version: (brandId: string, contentId: string, version: number) =>
    ['brand', brandId, 'content', 'version', contentId, version] as const,
};

// ── Lectura ──────────────────────────────────────────────────────────────

/** Piezas de la marca, de la más reciente a la más antigua, por páginas. */
export function useContentItems(brandId: string, filters: ContentFilters = DEFAULT_CONTENT_FILTERS) {
  return useInfiniteQuery({
    queryKey: contentKeys.list(brandId, filters),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<ContentItemRow[]> => {
      let query = supabase
        .from('content_items')
        .select('*')
        .eq('brand_id', brandId)
        .order('updated_at', { ascending: false })
        .order('id')
        .range(pageParam, pageParam + CONTENT_PAGE_SIZE - 1);
      query = filters.archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.network) query = query.eq('network', filters.network);
      if (filters.search.trim()) query = query.ilike('title', likePattern(filters.search.trim()));
      return unwrap(await query);
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.length < CONTENT_PAGE_SIZE ? undefined : pages.length * CONTENT_PAGE_SIZE,
  });
}

export interface LoadedVersion {
  row: ContentVersionRow;
  /** El documento en la versión actual del esquema; null si no se ha podido leer. */
  document: ContentDocument | null;
  /** Por qué no se ha podido leer, en palabras para la persona. */
  documentError: string | null;
}

export interface LoadedContent {
  item: ContentItemRow;
  /** La versión vigente; null si la pieza todavía no tiene documento. */
  current: LoadedVersion | null;
}

/**
 * Lee el documento de una versión guardada y lo trae a la versión actual del
 * esquema. Nunca lanza: una versión ilegible no debe impedir ver el historial
 * ni restaurar otra.
 */
export function readVersionDocument(row: ContentVersionRow): LoadedVersion {
  try {
    return { row, document: migrateDocument(row.data), documentError: null };
  } catch (error) {
    const message = error instanceof DocumentError ? error.message : 'El documento no es válido.';
    return { row, document: null, documentError: message };
  }
}

export async function fetchContentVersion(contentId: string, version: number): Promise<LoadedVersion> {
  const row: ContentVersionRow = unwrap(
    await supabase.from('content_versions').select('*').eq('content_id', contentId).eq('version', version).single(),
  );
  return readVersionDocument(row);
}

/** La pieza con su versión vigente, que es lo que abre el editor. */
export async function fetchContent(contentId: string): Promise<LoadedContent> {
  const item: ContentItemRow = unwrap(await supabase.from('content_items').select('*').eq('id', contentId).single());
  const current = item.current_version > 0 ? await fetchContentVersion(item.id, item.current_version) : null;
  return { item, current };
}

export function useContent(brandId: string, contentId: string) {
  return useQuery({
    queryKey: contentKeys.item(brandId, contentId),
    queryFn: () => fetchContent(contentId),
  });
}

/** Una versión concreta del historial, con su documento (para previsualizarla antes de restaurar). */
export function useContentVersion(brandId: string, contentId: string, version: number | null) {
  return useQuery({
    queryKey: contentKeys.version(brandId, contentId, version ?? 0),
    enabled: version !== null,
    // Las versiones son inmutables: una vez leída no cambia.
    staleTime: Infinity,
    queryFn: () => fetchContentVersion(contentId, version as number),
  });
}

export interface ContentVersionSummary extends Pick<
  ContentVersionRow,
  'id' | 'version' | 'schema_version' | 'change_note' | 'restored_from' | 'created_at' | 'created_by'
> {
  author: string;
}

/** Historial de una pieza, de la versión más nueva a la más antigua, sin los documentos. */
export function useContentVersions(brandId: string, contentId: string, enabled = true) {
  return useQuery({
    queryKey: contentKeys.versions(brandId, contentId),
    enabled,
    queryFn: async (): Promise<ContentVersionSummary[]> => {
      const rows = unwrap(
        await supabase
          .from('content_versions')
          .select('id, version, schema_version, change_note, restored_from, created_at, created_by')
          .eq('content_id', contentId)
          .order('version', { ascending: false })
          .limit(200),
      );
      const ids = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => Boolean(v)))];
      const profiles = ids.length
        ? unwrap(await supabase.from('profiles').select('user_id, full_name, email').in('user_id', ids))
        : [];
      const names = new Map(profiles.map((p) => [p.user_id, p.full_name || p.email]));
      return rows.map((r) => ({ ...r, author: (r.created_by && names.get(r.created_by)) || 'Usuario' }));
    },
  });
}

// ── Escritura ────────────────────────────────────────────────────────────

/** ¿El error es que otra persona guardó una versión más reciente? */
export function isVersionConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === CONTENT_VERSION_CONFLICT;
}

function checkTarget(network: string, format: string): void {
  if (!isKnownTarget(network, format)) throw new Error('Esa combinación de red y formato no existe.');
}

function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Ponle un nombre al contenido.');
  if (trimmed.length > 200) throw new Error('El nombre del contenido es demasiado largo.');
  return trimmed;
}

export interface CreateContentInput {
  organizationId: string;
  brandId: string;
  title: string;
  /** Identificadores del catálogo de networks.ts. */
  network: string;
  format: string;
}

/** Crea la pieza como idea, sin documento. El documento se guarda después con `saveContentVersion`. */
export async function createContentItem(input: CreateContentInput): Promise<ContentItemRow> {
  const title = checkTitle(input.title);
  checkTarget(input.network, input.format);
  return unwrap(
    await supabase
      .from('content_items')
      .insert({
        brand_id: input.brandId,
        organization_id: input.organizationId,
        title,
        network: input.network,
        format: input.format,
      })
      .select('*')
      .single(),
  );
}

export interface UpdateContentInput {
  contentId: string;
  title?: string;
  /** Red y formato se cambian juntos. Si la pieza estaba aprobada, vuelve a borrador. */
  target?: { network: string; format: string };
}

export async function updateContentItem(input: UpdateContentInput): Promise<ContentItemRow> {
  const patch: { title?: string; network?: string; format?: string } = {};
  if (input.title !== undefined) patch.title = checkTitle(input.title);
  if (input.target) {
    checkTarget(input.target.network, input.target.format);
    patch.network = input.target.network;
    patch.format = input.target.format;
  }
  if (Object.keys(patch).length === 0) throw new Error('No hay ningún cambio que guardar.');
  const rows = unwrap(await supabase.from('content_items').update(patch).eq('id', input.contentId).select('*'));
  // Sin filas: no hay permiso de edición o la pieza está archivada.
  if (!rows[0]) throw { code: '42501', message: 'permission denied' };
  return rows[0];
}

export interface SaveVersionInput {
  contentId: string;
  document: ContentDocumentInput;
  note?: string;
  /**
   * Versión sobre la que se estaba trabajando (`item.current_version` al abrir).
   * Si otra persona guardó después, falla con un error que cumple
   * `isVersionConflict` en vez de pisar su trabajo. Sin ella se guarda siempre.
   */
  expectedVersion?: number | null;
}

/** Guarda el documento como versión nueva. Lanza `DocumentError` si no cumple el esquema, sin llegar al servidor. */
export async function saveContentVersion(input: SaveVersionInput): Promise<ContentVersionRow> {
  const checked = validateDocument(input.document);
  if (!checked.ok) throw new DocumentError('invalid', checked.issues);
  return unwrap(
    await supabase.rpc('save_content_version', {
      p_content_id: input.contentId,
      p_data: checked.document as unknown as Json,
      p_schema_version: checked.document.schemaVersion,
      p_change_note: input.note ?? '',
      p_expected_version: input.expectedVersion ?? null,
    }),
  );
}

export interface RestoreVersionInput {
  contentId: string;
  version: number;
  note?: string;
  expectedVersion?: number | null;
}

/** Restaura una versión anterior: crea una versión nueva con su documento. */
export async function restoreContentVersion(input: RestoreVersionInput): Promise<ContentVersionRow> {
  return unwrap(
    await supabase.rpc('restore_content_version', {
      p_content_id: input.contentId,
      p_version: input.version,
      p_change_note: input.note ?? '',
      p_expected_version: input.expectedVersion ?? null,
    }),
  );
}

export interface SetStatusInput {
  contentId: string;
  status: ContentStatus;
  /** Obligatoria para aprobar: la versión que se ha revisado. */
  expectedVersion?: number | null;
}

export async function setContentStatus(input: SetStatusInput): Promise<ContentItemRow> {
  return unwrap(
    await supabase.rpc('set_content_status', {
      p_content_id: input.contentId,
      p_status: input.status,
      p_expected_version: input.expectedVersion ?? null,
    }),
  );
}

/** Archiva una pieza, o la recupera con `archived: false`. */
export async function archiveContentItem(input: { contentId: string; archived?: boolean }): Promise<ContentItemRow> {
  return unwrap(
    await supabase.rpc('archive_content_item', {
      p_content_id: input.contentId,
      p_archived: input.archived ?? true,
    }),
  );
}

/**
 * Lo que se expone de cada mutación. No incluye `mutate` a propósito: los
 * avisos y las redirecciones que siguen a un cambio deben colgar de la promesa
 * de `mutateAsync`, que se resuelve aunque la pantalla que lo lanzó ya no esté
 * montada. Con los avisos de `mutate` se pierden si la pantalla se desmonta
 * antes de que terminen los refrescos (ya pasó tres veces en la Fase 1).
 */
export type ContentMutation<TData, TInput> = Pick<
  UseMutationResult<TData, Error, TInput>,
  'mutateAsync' | 'isPending' | 'error' | 'reset'
>;

function asyncOnly<TData, TInput>(mutation: UseMutationResult<TData, Error, TInput>): ContentMutation<TData, TInput> {
  return {
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}

/**
 * Cambios sobre los contenidos de una marca. Cada uno refresca las listas, la
 * pieza y su historial antes de resolver su promesa.
 *
 *   const { saveVersion } = useContentMutations(orgId, brandId);
 *   saveVersion.mutateAsync({ contentId, document, expectedVersion }).then(
 *     () => toast.success('Guardado'),
 *     (e) => toast.error(isVersionConflict(e) ? '…' : translateError(e)),
 *   );
 */
export function useContentMutations(organizationId: string, brandId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: contentKeys.all(brandId) });

  const create = useMutation({
    mutationFn: (input: Omit<CreateContentInput, 'organizationId' | 'brandId'>) =>
      createContentItem({ ...input, organizationId, brandId }),
    onSuccess,
  });
  const update = useMutation({ mutationFn: updateContentItem, onSuccess });
  const saveVersion = useMutation({ mutationFn: saveContentVersion, onSuccess });
  const restore = useMutation({ mutationFn: restoreContentVersion, onSuccess });
  const setStatus = useMutation({ mutationFn: setContentStatus, onSuccess });
  const archive = useMutation({ mutationFn: archiveContentItem, onSuccess });

  return {
    create: asyncOnly(create),
    update: asyncOnly(update),
    saveVersion: asyncOnly(saveVersion),
    restore: asyncOnly(restore),
    setStatus: asyncOnly(setStatus),
    archive: asyncOnly(archive),
  };
}
