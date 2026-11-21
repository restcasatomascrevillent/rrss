import type { LayerShadow } from '../../document';
import { DEFAULT_SHADOW } from '../imageEffects/shadowDefaults';
import { CheckInput, ColorInput, RangeInput } from './controls';

/** Sombra de una capa: interruptor y, si está puesta, color, difuminado, distancia y fuerza. */
export function ShadowFields({
  label = 'Sombra',
  shadow,
  palette,
  readOnly,
  maxBlur = 120,
  onChange,
  onCommit,
}: {
  label?: string;
  shadow: LayerShadow | undefined;
  palette: { hex: string; name: string }[];
  readOnly: boolean;
  maxBlur?: number;
  onChange: (shadow: LayerShadow | undefined, field?: string) => void;
  onCommit: () => void;
}) {
  return (
    <section className="space-y-3" data-testid="shadow-fields">
      <CheckInput
        label={label}
        checked={Boolean(shadow)}
        disabled={readOnly}
        onChange={(on) => onChange(on ? DEFAULT_SHADOW : undefined)}
      />
      {shadow && (
        <>
          <ColorInput
            label="Color de la sombra"
            value={shadow.color}
            palette={palette}
            disabled={readOnly}
            onChange={(color) => onChange({ ...shadow, color }, 'shadow')}
            onCommit={onCommit}
          />
          <RangeInput
            label="Difuminado"
            value={shadow.blur}
            min={0}
            max={maxBlur}
            disabled={readOnly}
            onChange={(blur) => onChange({ ...shadow, blur }, 'shadow')}
            onCommit={onCommit}
          />
          <RangeInput
            label="Distancia hacia abajo"
            value={shadow.offsetY}
            min={-100}
            max={100}
            disabled={readOnly}
            onChange={(offsetY) => onChange({ ...shadow, offsetY }, 'shadow')}
            onCommit={onCommit}
          />
          <RangeInput
            label="Distancia hacia la derecha"
            value={shadow.offsetX}
            min={-100}
            max={100}
            disabled={readOnly}
            onChange={(offsetX) => onChange({ ...shadow, offsetX }, 'shadow')}
            onCommit={onCommit}
          />
          <RangeInput
            label="Fuerza (%)"
            value={Math.round(shadow.opacity * 100)}
            min={0}
            max={100}
            disabled={readOnly}
            onChange={(v) => onChange({ ...shadow, opacity: v / 100 }, 'shadow')}
            onCommit={onCommit}
          />
        </>
      )}
    </section>
  );
}
