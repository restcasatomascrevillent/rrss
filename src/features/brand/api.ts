import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOURCE_MIME_TYPES, STORAGE_BUCKET } from '@/config/app';
import type {
  BrandProfileRow,
  BrandRow,
  BrandStatus,
  Json,
  KnowledgeSourceListRow,
  KnowledgeSourceRow,
} from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { buildStoragePath, sourceKindFromMime, validateFile } from '@/lib/files';
import { supabase } from '@/lib/supabase';
import { keys as orgKeys } from '@/features/orgs/api';
import type { BrandBasics } from './config';
import type { BrandProfileData, Provenance } from './profile';

export const brandKeys = {
  profile: (brandId: string) => ['brand', brandId, 'profile'] as const,
  versions: (brandId: string) => ['brand', brandId, 'profile-versions'] as const,
  sources: (brandId: string) => ['brand', brandId, 'sources'] as const,
};

export function useActiveProfile(brandId: string) {
  return useQuery({
    queryKey: brandKeys.profile(brandId),
    queryFn: async (): Promise<BrandProfileRow | null> =>
      unwrap(
        await supabase.from('brand_profiles').select('*').eq('brand_id', brandId).eq('status', 'active').maybeSingle(),
      ),
  });
}

export interface ProfileVersion extends Pick<
  BrandProfileRow,
  'id' | 'version' | 'status' | 'change_note' | 'created_at' | 'created_by'
> {
  author: string;
}

export function useProfileVersions(brandId: string, enabled: boolean) {
  return useQuery({
    queryKey: brandKeys.versions(brandId),
    enabled,
    queryFn: async (): Promise<ProfileVersion[]> => {
      const rows = unwrap(
        await supabase
          .from('brand_profiles')
          .select('id, version, status, change_note, created_at, created_by')
          .eq('brand_id', brandId)
          .order('version', { ascending: false })
          .limit(100),
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

export async function fetchProfileVersion(id: string): Promise<BrandProfileRow> {
  return unwrap(await supabase.from('brand_profiles').select('*').eq('id', id).single());
}

export async function saveBrandProfile(
  brandId: string,
  data: BrandProfileData,
  provenance: Provenance,
  note: string,
): Promise<BrandProfileRow> {
  return unwrap(
    await supabase.rpc('save_brand_profile', {
      p_brand_id: brandId,
      p_data: data as unknown as Json,
      p_provenance: provenance as unknown as Json,
      p_change_note: note,
    }),
  );
}

export function useSaveProfile(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { data: BrandProfileData; provenance: Provenance; note: string }) =>
      saveBrandProfile(brandId, input.data, input.provenance, input.note),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: brandKeys.profile(brandId) }),
        queryClient.invalidateQueries({ queryKey: brandKeys.versions(brandId) }),
      ]),
  });
}

export async function createBrand(organizationId: string, basics: BrandBasics): Promise<BrandRow> {
  return unwrap(
    await supabase
      .from('brands')
      .insert({ organization_id: organizationId, ...basics })
      .select('*')
      .single(),
  );
}

export async function setBrandStatus(brandId: string, status: BrandStatus): Promise<void> {
  const rows = unwrap(await supabase.from('brands').update({ status }).eq('id', brandId).select('id'));
  if (rows.length === 0) throw { code: '42501', message: 'permission denied' };
}

export function useUpdateBrand(orgId: string, brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<BrandBasics> & { status?: BrandStatus }) => {
      const rows = unwrap(await supabase.from('brands').update(patch).eq('id', brandId).select('id'));
      if (rows.length === 0) throw { code: '42501', message: 'permission denied' };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.brands(orgId) }),
  });
}

// ── Fuentes de conocimiento ──────────────────────────────────────────────

/** Columnas de la lista de fuentes: todas menos el texto extraído, que puede pesar cientos de KB. */
const SOURCE_LIST_COLUMNS =
  'id, brand_id, organization_id, kind, title, storage_path, url, mime_type, bytes, status, error, created_by, created_at, updated_at, extracted_chars, extraction, extracted_at, extraction_job_id';

/** Mientras alguna fuente se está analizando, la lista se refresca sola cada pocos segundos. */
export const SOURCES_POLL_MS = 5000;

export function useSources(brandId: string) {
  return useQuery({
    queryKey: brandKeys.sources(brandId),
    queryFn: async (): Promise<KnowledgeSourceListRow[]> =>
      unwrap(
        await supabase
          .from('brand_knowledge_sources')
          .select(SOURCE_LIST_COLUMNS)
          .eq('brand_id', brandId)
          .order('created_at', { ascending: false }),
      ) as KnowledgeSourceListRow[],
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === 'pending' || s.status === 'processing') ? SOURCES_POLL_MS : false,
  });
}

/** Normaliza una URL escrita a mano; null si no es una dirección http(s) válida. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function addUrlSource(organizationId: string, brandId: string, rawUrl: string): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('La dirección web no es válida.');
  unwrap(
    await supabase.from('brand_knowledge_sources').insert({
      brand_id: brandId,
      organization_id: organizationId,
      kind: 'website',
      title: new URL(url).hostname,
      url,
    }),
  );
}

export async function uploadSource(organizationId: string, brandId: string, file: File): Promise<void> {
  const invalid = validateFile(file, SOURCE_MIME_TYPES);
  if (invalid) throw new Error(invalid);
  const path = buildStoragePath(organizationId, brandId, 'sources', file.name);
  const upload = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { contentType: file.type });
  if (upload.error) throw upload.error;
  const inserted = await supabase.from('brand_knowledge_sources').insert({
    brand_id: brandId,
    organization_id: organizationId,
    kind: sourceKindFromMime(file.type),
    title: file.name.slice(0, 200),
    storage_path: path,
    mime_type: file.type,
    bytes: file.size,
  });
  if (inserted.error) {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    throw inserted.error;
  }
}

export function useSourceMutations(organizationId: string, brandId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: brandKeys.sources(brandId) });
  const addUrl = useMutation({ mutationFn: (url: string) => addUrlSource(organizationId, brandId, url), onSuccess });
  const upload = useMutation({ mutationFn: (file: File) => uploadSource(organizationId, brandId, file), onSuccess });
  const remove = useMutation({
    mutationFn: async (source: Pick<KnowledgeSourceRow, 'id' | 'storage_path'>) => {
      const rows = unwrap(await supabase.from('brand_knowledge_sources').delete().eq('id', source.id).select('id'));
      if (rows.length === 0) throw { code: '42501', message: 'permission denied' };
      if (source.storage_path) {
        const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([source.storage_path]);
        if (error) throw error;
      }
    },
    onSuccess,
  });
  return { addUrl, upload, remove };
}
