import { ArrowDown, ArrowUp, Eye, EyeOff, Group, Lock, LockOpen } from 'lucide-react';
import type { Dispatch } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Layer } from '../../document';
import type { EditorAction } from '../history';
import { LAYER_TYPE_LABEL, layerLabel } from '../layers';

interface LayersPanelProps {
  layers: Layer[];
  selectedIds: string[];
  readOnly: boolean;
  dispatch: Dispatch<EditorAction>;
}

/**
 * Lista HTML paralela al lienzo: un lienzo no es accesible por sí mismo, así
 * que aquí se selecciona, se oculta, se bloquea y se ordena cada capa con
 * teclado y lector de pantalla. Va de la capa del frente a la del fondo.
 */
export function LayersPanel({ layers, selectedIds, readOnly, dispatch }: LayersPanelProps) {
  if (layers.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">El lienzo está vacío. Añade una capa para empezar.</p>;
  }
  const ordered = [...layers].reverse();
  // Grupos numerados por orden de aparición, para nombrarlos en la lista.
  const groupNumber = new Map<string, number>();
  for (const layer of ordered) {
    if (layer.groupId && !groupNumber.has(layer.groupId)) groupNumber.set(layer.groupId, groupNumber.size + 1);
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted" id="layers-help">
        De delante a atrás. Con Mayúsculas o Ctrl se eligen varias. Con capas elegidas: flechas para moverlas (con
        Mayúsculas, de 10 en 10), Supr para borrarlas, Intro para escribir en un texto y Esc para soltarlas.
      </p>
      <ul className="space-y-1" aria-describedby="layers-help" data-testid="layers-list">
        {ordered.map((layer, index) => {
          const label = layerLabel(layer);
          const selected = selectedIds.includes(layer.id);
          const group = layer.groupId ? groupNumber.get(layer.groupId) : undefined;
          return (
            <li
              key={layer.id}
              className={cn(
                'flex items-center gap-1 rounded-lg border px-1 py-1',
                selected ? 'border-primary bg-primary-soft' : 'border-transparent hover:bg-subtle',
              )}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={(event) => {
                  // Desde aquí se elige la capa sola aunque esté en un grupo (para cambiar solo esa).
                  if (event.shiftKey || event.ctrlKey || event.metaKey) {
                    dispatch({ type: 'select', id: layer.id, toggle: true, exact: true });
                  } else {
                    dispatch({
                      type: 'select',
                      id: selected && selectedIds.length === 1 ? null : layer.id,
                      exact: true,
                    });
                  }
                }}
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm"
                data-testid="layer-item"
              >
                <span className={cn('block truncate font-medium', !layer.visible && 'text-muted line-through')}>
                  {label}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted">
                  {LAYER_TYPE_LABEL[layer.type]}
                  {group !== undefined && (
                    <span className="inline-flex items-center gap-0.5" data-testid="layer-group">
                      <Group className="h-3 w-3" aria-hidden />
                      Grupo {group}
                    </span>
                  )}
                </span>
              </button>
              {!readOnly && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={layer.visible ? `Ocultar ${label}` : `Mostrar ${label}`}
                    onClick={() => dispatch({ type: 'update', id: layer.id, patch: { visible: !layer.visible } })}
                  >
                    {layer.visible ? (
                      <Eye className="h-4 w-4" aria-hidden />
                    ) : (
                      <EyeOff className="h-4 w-4" aria-hidden />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={layer.locked ? `Desbloquear ${label}` : `Bloquear ${label}`}
                    onClick={() => dispatch({ type: 'update', id: layer.id, patch: { locked: !layer.locked } })}
                  >
                    {layer.locked ? (
                      <Lock className="h-4 w-4" aria-hidden />
                    ) : (
                      <LockOpen className="h-4 w-4" aria-hidden />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`Traer ${label} hacia delante`}
                    disabled={index === 0}
                    onClick={() => dispatch({ type: 'reorder', id: layer.id, to: 'forward' })}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`Llevar ${label} hacia atrás`}
                    disabled={index === ordered.length - 1}
                    onClick={() => dispatch({ type: 'reorder', id: layer.id, to: 'backward' })}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
