import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Group,
  Trash2,
  Ungroup,
  type LucideIcon,
} from 'lucide-react';
import type { Dispatch } from 'react';
import { Button } from '@/components/ui';
import type { Layer } from '../../document';
import { ALIGN_LABEL, MIN_TO_DISTRIBUTE, type AlignTarget } from '../arrange';
import type { EditorAction } from '../history';
import { layerLabel } from '../layers';

const ALIGN_ICONS: [AlignTarget, LucideIcon][] = [
  ['left', AlignStartVertical],
  ['centerX', AlignCenterVertical],
  ['right', AlignEndVertical],
  ['top', AlignStartHorizontal],
  ['middle', AlignCenterHorizontal],
  ['bottom', AlignEndHorizontal],
];

interface ArrangeControlsProps {
  /** Capas elegidas, en el orden del documento. */
  layers: Layer[];
  dispatch: Dispatch<EditorAction>;
}

/** Alinear, distribuir y agrupar lo elegido. Con una sola capa, alinea respecto al lienzo. */
export function ArrangeControls({ layers, dispatch }: ArrangeControlsProps) {
  const single = layers.length === 1;
  const canDistribute = layers.length >= MIN_TO_DISTRIBUTE;
  const grouped = layers.some((layer) => layer.groupId);
  return (
    <section className="space-y-2" aria-labelledby="arrange-title" data-testid="arrange-controls">
      <h4 id="arrange-title" className="text-xs font-semibold uppercase tracking-wide text-muted">
        {single ? 'Alinear con el lienzo' : 'Alinear entre sí'}
      </h4>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Alinear">
        {ALIGN_ICONS.map(([to, Icon]) => (
          <Button
            key={to}
            variant="secondary"
            size="icon"
            aria-label={single ? `${ALIGN_LABEL[to]} del lienzo` : ALIGN_LABEL[to]}
            title={ALIGN_LABEL[to]}
            onClick={() => dispatch({ type: 'align', to })}
            data-testid={`align-${to}`}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </Button>
        ))}
      </div>
      {!single && (
        <div className="flex flex-wrap gap-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canDistribute}
            title={canDistribute ? undefined : `Elige al menos ${MIN_TO_DISTRIBUTE} capas`}
            onClick={() => dispatch({ type: 'distribute', axis: 'horizontal' })}
            data-testid="distribute-horizontal"
          >
            <AlignHorizontalDistributeCenter className="h-4 w-4" aria-hidden />
            Repartir en horizontal
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canDistribute}
            title={canDistribute ? undefined : `Elige al menos ${MIN_TO_DISTRIBUTE} capas`}
            onClick={() => dispatch({ type: 'distribute', axis: 'vertical' })}
            data-testid="distribute-vertical"
          >
            <AlignVerticalDistributeCenter className="h-4 w-4" aria-hidden />
            Repartir en vertical
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {!single && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => dispatch({ type: 'group' })}
            title="Agrupar (Ctrl+G)"
            data-testid="group"
          >
            <Group className="h-4 w-4" aria-hidden />
            Agrupar
          </Button>
        )}
        {grouped && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => dispatch({ type: 'ungroup' })}
            title="Desagrupar (Ctrl+Mayús+G)"
            data-testid="ungroup"
          >
            <Ungroup className="h-4 w-4" aria-hidden />
            Desagrupar
          </Button>
        )}
      </div>
    </section>
  );
}

/** Panel «Diseño» con varias capas elegidas: cuáles son y qué se puede hacer con todas. */
export function MultiSelectionPanel({ layers, dispatch }: ArrangeControlsProps) {
  const locked = layers.filter((layer) => layer.locked).length;
  return (
    <div className="space-y-5" data-testid="multi-selection-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{layers.length} capas elegidas</h3>
          <p className="truncate text-xs text-muted">{layers.map((layer) => layerLabel(layer)).join(', ')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-danger"
          onClick={() => dispatch({ type: 'removeSelection' })}
          data-testid="selection-delete"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          Borrar
        </Button>
      </div>
      <ArrangeControls layers={layers} dispatch={dispatch} />
      <p className="text-xs text-muted">
        Flechas para moverlas juntas (con Mayúsculas, de 10 en 10); Supr para borrarlas; Esc para soltarlas.
        {locked > 0 &&
          ` ${locked === 1 ? 'Una está bloqueada' : `${locked} están bloqueadas`}: no se mueve${locked === 1 ? '' : 'n'} ni se borra${locked === 1 ? '' : 'n'}.`}
      </p>
    </div>
  );
}
