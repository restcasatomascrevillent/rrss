import { LayoutTemplate } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, Notice, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { assetIdsOf } from '../editor/canvas/nodes';
import { PageThumb } from '../editor/panels/PageThumb';
import { targetLabel } from '../labels';
import { photoCount, templateFits, useBrandTemplates, type BrandTemplate } from './api';
import { useImageLookup } from './useImageLookup';

interface TemplatePickerProps {
  orgId: string;
  brandId: string;
  /** Si se da, solo valen las plantillas que caben en esa red y formato (proporción y páginas). */
  target?: { network: string; format: string };
  selectedId: string | null;
  onSelect: (template: BrandTemplate) => void;
}

/**
 * Plantillas de la marca con su vista previa, nombre y análisis resumido. Sin
 * plantillas, explica cómo se consiguen (importar publicaciones y la agencia).
 */
export function TemplatePicker({ orgId, brandId, target, selectedId, onSelect }: TemplatePickerProps) {
  const templates = useBrandTemplates(brandId);
  const usable = useMemo(
    () =>
      (templates.data ?? []).filter((t) => t.document && (!target || templateFits(t, target.network, target.format))),
    [templates.data, target],
  );
  const assetIds = useMemo(() => usable.flatMap((t) => (t.document ? assetIdsOf(t.document) : [])), [usable]);
  const images = useImageLookup(brandId, assetIds);

  if (templates.isPending) return <Skeleton className="h-32" />;
  if (templates.isError) return <ErrorState error={templates.error} onRetry={() => void templates.refetch()} />;

  if ((templates.data ?? []).length === 0) {
    return (
      <div data-testid="template-empty">
        <EmptyState
          icon={LayoutTemplate}
          title="Esta marca todavía no tiene plantillas"
          description="Las plantillas salen de las publicaciones que la marca ya tiene en Instagram: importa las publicaciones desde Marca → Datos de la marca → Cuentas conectadas y pide a la agencia que las prepare. Mientras tanto, puedes diseñar la pieza desde cero."
          action={
            <Link className="text-sm font-medium text-primary underline" to={`/o/${orgId}/m/${brandId}/marca`}>
              Ir a los datos de la marca
            </Link>
          }
        />
      </div>
    );
  }
  if (usable.length === 0) {
    return (
      <div data-testid="template-none-fit">
        <Notice>
          {target
            ? `Ninguna plantilla de la marca encaja con ${targetLabel(target.network, target.format)} (proporción o número de páginas distintos). Cambia la red o el formato de la pieza, o diséñala desde cero.`
            : 'Las plantillas de la marca no se pueden leer ahora mismo. Avisa a la agencia.'}
        </Notice>
      </div>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="template-list" aria-label="Plantillas de la marca">
      {usable.map((template) => {
        const document = template.document!;
        const first = document.pages[0]!;
        const selected = template.id === selectedId;
        const photos = photoCount(document);
        const recurrence = template.analysis?.recurrence;
        return (
          <li key={template.id}>
            <button
              type="button"
              onClick={() => onSelect(template)}
              aria-pressed={selected}
              className={cn(
                'flex h-full w-full gap-3 rounded-xl border-2 p-2 text-left transition-colors',
                selected ? 'border-primary bg-primary-soft' : 'border-border hover:border-primary/50',
              )}
              data-testid="template-option"
              data-template-key={template.key}
            >
              <span className="w-20 shrink-0">
                <PageThumb canvas={document.canvas} layers={first.layers} images={images} />
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span data-testid="template-name">{template.name}</span>
                  {template.source === 'manual' && (
                    <Badge tone="neutral" className="shrink-0">
                      Manual
                    </Badge>
                  )}
                </span>
                <span className="block text-xs text-muted">
                  {targetLabel(template.network, template.format)}
                  {document.pages.length > 1 ? ` · ${document.pages.length} páginas` : ''}
                </span>
                {template.analysis && (
                  <span className="block text-xs" data-testid="template-summary">
                    {template.analysis.summary}
                  </span>
                )}
                <span className="block text-xs text-muted">
                  {photos > 0 ? `${photos} ${photos === 1 ? 'foto' : 'fotos'} para sustituir` : 'Sin fotos'}
                  {recurrence ? ` · en ${recurrence.count} de ${recurrence.reviewed} publicaciones` : ''}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
