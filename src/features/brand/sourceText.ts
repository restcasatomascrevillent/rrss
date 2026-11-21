import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROPOSAL_MAX_CHARS, PROPOSAL_MAX_SOURCES } from '@/features/ai/profileProposal';
import type { KnowledgeSourceListRow, KnowledgeSourceTextRow, SourceStatus } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { brandKeys } from './api';

// Texto extraído de las fuentes de la marca (lo saca el trabajador, sin IA:
// migración 20261119210000_source_text_extraction). Aquí se lee, se revisa y
// se vuelve a pedir; y se elige qué fuentes van a la propuesta de perfil.

export const SOURCE_STATUS: Record<
  SourceStatus,
  { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }
> = {
  pending: { label: 'Pendiente', tone: 'neutral' },
  processing: { label: 'Extrayendo texto', tone: 'warning' },
  ready: { label: 'Texto listo', tone: 'success' },
  failed: { label: 'No se pudo extraer', tone: 'danger' },
};

/** Detalle de la extracción tal como lo guarda la base de datos (todo opcional: viene del trabajador). */
export interface ExtractionDetail {
  format?: string;
  pages?: number | Array<{ url: string; title?: string; chars?: number }>;
  pagesRead?: number;
  skipped?: Array<{ url: string; reason: string }>;
  truncated?: boolean;
}

export function extractionDetail(source: Pick<KnowledgeSourceListRow, 'extraction'>): ExtractionDetail {
  const value = source.extraction;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ExtractionDetail) : {};
}

/** Resumen legible de la extracción: páginas, recortes, páginas web omitidas. */
export function describeExtraction(source: Pick<KnowledgeSourceListRow, 'extraction' | 'extracted_chars'>): string {
  const detail = extractionDetail(source);
  const parts: string[] = [];
  if (source.extracted_chars !== null) parts.push(`${source.extracted_chars.toLocaleString('es-ES')} caracteres`);
  if (typeof detail.pages === 'number') {
    parts.push(
      detail.pagesRead !== undefined && detail.pagesRead < detail.pages
        ? `${detail.pagesRead} de ${detail.pages} páginas`
        : `${detail.pages} ${detail.pages === 1 ? 'página' : 'páginas'}`,
    );
  } else if (Array.isArray(detail.pages)) {
    parts.push(`${detail.pages.length} ${detail.pages.length === 1 ? 'página web' : 'páginas web'}`);
  }
  if (detail.skipped?.length) parts.push(`${detail.skipped.length} omitidas`);
  if (detail.truncated) parts.push('recortado al máximo');
  return parts.join(' · ');
}

/** Fuentes con texto listo para la propuesta de perfil. */
export function sourcesWithText(sources: readonly KnowledgeSourceListRow[]): KnowledgeSourceListRow[] {
  return sources.filter((s) => s.status === 'ready' && (s.extracted_chars ?? 0) > 0);
}

/**
 * Qué fuentes se envían a la propuesta: las más recientes (la lista ya viene
 * ordenada así) mientras quepan en los topes de número y de caracteres. Las
 * demás se dicen, no se pierden en silencio.
 */
export function pickProposalSources(
  sources: readonly KnowledgeSourceListRow[],
  maxSources = PROPOSAL_MAX_SOURCES,
  maxChars = PROPOSAL_MAX_CHARS,
): { chosen: KnowledgeSourceListRow[]; left: KnowledgeSourceListRow[] } {
  const chosen: KnowledgeSourceListRow[] = [];
  const left: KnowledgeSourceListRow[] = [];
  let total = 0;
  for (const source of sourcesWithText(sources)) {
    const chars = source.extracted_chars ?? 0;
    if (chosen.length < maxSources && total + chars <= maxChars) {
      chosen.push(source);
      total += chars;
    } else {
      left.push(source);
    }
  }
  return { chosen, left };
}

export async function fetchSourceTexts(ids: string[]): Promise<KnowledgeSourceTextRow[]> {
  if (ids.length === 0) return [];
  const rows = unwrap(
    await supabase
      .from('brand_knowledge_sources')
      .select('id, title, kind, extracted_text, extracted_chars')
      .in('id', ids),
  ) as KnowledgeSourceTextRow[];
  // En el orden pedido.
  return ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is KnowledgeSourceTextRow => !!row);
}

export function useSourceText(brandId: string, sourceId: string | null, extractedAt: string | null) {
  return useQuery({
    queryKey: [...brandKeys.sources(brandId), 'text', sourceId, extractedAt] as const,
    enabled: sourceId !== null,
    queryFn: async () => (await fetchSourceTexts([sourceId!]))[0] ?? null,
  });
}

export function useRequestExtraction(brandId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sourceId: string) =>
      unwrap(await supabase.rpc('request_source_extraction', { p_source_id: sourceId })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: brandKeys.sources(brandId) }),
  });
}
