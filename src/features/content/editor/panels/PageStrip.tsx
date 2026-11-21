import { ChevronLeft, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { useState, type Dispatch, type DragEvent } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { pageLabel, type ContentDocument, type PageLimits } from '../../document';
import type { ImageLookup } from '../canvas/nodes';
import type { EditorAction } from '../history';
import { PageThumb } from './PageThumb';

interface PageStripProps {
  document: ContentDocument;
  activePageId: string;
  /** Cuántas páginas admite el formato (un carrusel de Instagram, de 2 a 10). */
  limits: PageLimits;
  readOnly: boolean;
  /** Direcciones firmadas de las imágenes de la biblioteca, para dibujar las fotos en las miniaturas. */
  images?: ImageLookup;
  dispatch: Dispatch<EditorAction>;
}

const DRAG_TYPE = 'application/x-rrss-page';

/**
 * Tira de miniaturas de las páginas: elegir la página que se edita, añadir,
 * duplicar, borrar y reordenar (arrastrando o con los botones de mover, que
 * también sirven con teclado). Cada cambio es un paso de deshacer.
 */
export function PageStrip({ document, activePageId, limits, readOnly, images, dispatch }: PageStripProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const count = document.pages.length;
  const activeIndex = Math.max(
    0,
    document.pages.findIndex((page) => page.id === activePageId),
  );
  const full = count >= limits.max;
  const status =
    count < limits.min
      ? `Faltan páginas: este formato pide al menos ${limits.min}.`
      : count > limits.max
        ? `Sobran páginas: este formato admite ${limits.max}.`
        : `${count} de ${limits.max} páginas como máximo.`;

  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    const pageId = event.dataTransfer.getData(DRAG_TYPE) || dragging;
    setDragging(null);
    setOver(null);
    if (pageId) dispatch({ type: 'movePage', pageId, to: index });
  };

  return (
    <div className="mt-2 space-y-1.5" data-testid="page-strip">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Páginas</span>
        <span className="text-xs text-muted" data-testid="page-status">
          {status}
        </span>
        {!readOnly && (
          <span className="ml-auto flex flex-wrap gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={full}
              title={full ? `Este formato admite ${limits.max} como máximo` : 'Página vacía detrás de esta'}
              onClick={() => dispatch({ type: 'addPage' })}
              data-testid="page-add"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Añadir
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={full}
              title="Copia de esta página detrás de ella"
              onClick={() => dispatch({ type: 'duplicatePage' })}
              data-testid="page-duplicate"
            >
              <Copy className="h-4 w-4" aria-hidden />
              Duplicar
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Mover la página a la izquierda"
              title="Mover a la izquierda"
              disabled={activeIndex === 0}
              onClick={() => dispatch({ type: 'movePage', pageId: activePageId, to: activeIndex - 1 })}
              data-testid="page-move-left"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Mover la página a la derecha"
              title="Mover a la derecha"
              disabled={activeIndex === count - 1}
              onClick={() => dispatch({ type: 'movePage', pageId: activePageId, to: activeIndex + 1 })}
              data-testid="page-move-right"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={count <= 1}
              title={count <= 1 ? 'Una pieza tiene al menos una página' : 'Borrar esta página (Ctrl+Z la recupera)'}
              onClick={() => dispatch({ type: 'removePage' })}
              data-testid="page-remove"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Borrar
            </Button>
          </span>
        )}
      </div>
      <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Páginas del carrusel" data-testid="page-list">
        {document.pages.map((page, index) => {
          const active = page.id === activePageId;
          const label = pageLabel(page, index);
          return (
            <li
              key={page.id}
              className={cn('w-16 shrink-0', over === index && dragging !== page.id && 'border-l-2 border-primary pl-1')}
              onDragOver={(event) => {
                if (readOnly || !dragging) return;
                event.preventDefault();
                setOver(index);
              }}
              onDragLeave={() => setOver((value) => (value === index ? null : value))}
              onDrop={(event) => onDrop(event, index)}
            >
              <button
                type="button"
                draggable={!readOnly}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, page.id);
                  event.dataTransfer.effectAllowed = 'move';
                  setDragging(page.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onClick={() => dispatch({ type: 'selectPage', pageId: page.id })}
                aria-current={active ? 'true' : undefined}
                aria-label={`${label}${page.layers.length ? `, ${page.layers.length} capas` : ', vacía'}`}
                title={readOnly ? label : `${label}. Arrastra para cambiar el orden.`}
                className={cn(
                  'block w-full rounded-md border-2 p-0.5 text-left',
                  active ? 'border-primary' : 'border-transparent hover:border-border',
                  dragging === page.id && 'opacity-50',
                )}
                data-testid="page-thumb"
                data-page-id={page.id}
              >
                <PageThumb canvas={document.canvas} layers={page.layers} images={images} />
              </button>
              <span className="block text-center text-[11px] text-muted">{index + 1}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
