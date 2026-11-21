import { useQuery } from '@tanstack/react-query';
import { templateAnalysisSchema, type TemplateAnalysis } from '@/features/brand/templates';
import type { BrandDesignTemplateRow } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { pageLimits, validateDocumentFromAnyVersion, type ContentDocument } from '../document';
import { allowedCanvasRatios, getFormatSpec } from '../networks';

// Plantillas de diseño de la marca (brand_design_templates), vistas desde
// Contenidos: se listan para crear una pieza que nace con su documento.
// Solo lectura: las entrega la agencia (docs/importar-publicaciones.md).

export interface BrandTemplate {
  id: string;
  key: string;
  name: string;
  network: string;
  format: string;
  /** El documento ya en la versión vigente del esquema; null si no se ha podido leer. */
  document: ContentDocument | null;
  /** El análisis resumido; null si el registro no lo trae completo. */
  analysis: TemplateAnalysis | null;
  /** `manual`: la entregó la agencia sin importar publicaciones (la interfaz la marca con «Manual»). */
  source: BrandDesignTemplateRow['source'];
}

export const templateKeys = {
  list: (brandId: string) => ['brand', brandId, 'design-templates'] as const,
};

export function parseTemplate(row: BrandDesignTemplateRow): BrandTemplate {
  const document = validateDocumentFromAnyVersion(row.document);
  const analysis = templateAnalysisSchema.safeParse(row.analysis);
  return {
    id: row.id,
    key: row.template_key,
    name: row.name,
    network: row.network,
    format: row.format,
    document: document.ok ? document.document : null,
    analysis: analysis.success ? analysis.data : null,
    source: row.source,
  };
}

/** Plantillas de la marca, las más recientes primero. */
export function useBrandTemplates(brandId: string, enabled = true) {
  return useQuery({
    queryKey: templateKeys.list(brandId),
    enabled,
    queryFn: async (): Promise<BrandTemplate[]> => {
      const rows = unwrap(
        await supabase
          .from('brand_design_templates')
          .select('*')
          .eq('brand_id', brandId)
          .order('created_at', { ascending: false })
          .order('id'),
      );
      return rows.map(parseTemplate);
    },
  });
}

/** ¿El documento de la plantilla vale para esa red y formato (proporción del lienzo y número de páginas)? */
export function templateFits(template: BrandTemplate, network: string, format: string): boolean {
  const document = template.document;
  const spec = getFormatSpec(network, format);
  if (!document || !spec) return false;
  const ratios = allowedCanvasRatios(spec, spec.media.includes('image') ? 'image' : spec.media[0]);
  if (ratios && !ratios.ratios.includes(document.canvas.aspectRatio)) return false;
  const limits = pageLimits(spec);
  return document.pages.length >= limits.min && document.pages.length <= limits.max;
}

/** Cuántas fotos de la plantilla hay que sustituir por las de la pieza. */
export function photoCount(document: ContentDocument): number {
  let count = 0;
  for (const page of document.pages) for (const layer of page.layers) if (layer.type === 'image') count += 1;
  return count;
}
