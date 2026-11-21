import type { TextLayer } from '../../document';
import type { LayerPatch } from '../history';
import { CheckInput, ColorInput, RangeInput } from './controls';
import { ShadowFields } from './ShadowFields';

/** Contorno, sombra y fondo de un texto. */
export function TextEffectsFields({
  layer,
  readOnly,
  palette,
  update,
  checkpoint,
}: {
  layer: TextLayer;
  readOnly: boolean;
  palette: { hex: string; name: string }[];
  update: (patch: LayerPatch, field?: string) => void;
  checkpoint: () => void;
}) {
  const size = layer.fontSize;
  const outline = layer.outline;
  const background = layer.background;
  return (
    <section className="space-y-4" data-testid="text-effects">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Efectos del texto</h4>

      <div className="space-y-3">
        <CheckInput
          label="Contorno de las letras"
          checked={Boolean(outline)}
          disabled={readOnly}
          onChange={(on) =>
            update({
              outline: on
                ? { color: palette[0]?.hex ?? '#FFFFFF', width: Math.max(2, Math.round(size * 0.06)) }
                : undefined,
            })
          }
        />
        {outline && (
          <>
            <ColorInput
              label="Color del contorno"
              value={outline.color}
              palette={palette}
              disabled={readOnly}
              onChange={(color) => update({ outline: { ...outline, color } }, 'outline')}
              onCommit={checkpoint}
            />
            <RangeInput
              label="Grosor del contorno"
              value={outline.width}
              min={1}
              max={Math.max(10, Math.round(size * 0.3))}
              disabled={readOnly}
              onChange={(width) => update({ outline: { ...outline, width } }, 'outline')}
              onCommit={checkpoint}
            />
          </>
        )}
      </div>

      <ShadowFields
        shadow={layer.shadow}
        palette={palette}
        readOnly={readOnly}
        onChange={(shadow, field) => update({ shadow }, field)}
        onCommit={checkpoint}
      />

      <div className="space-y-3">
        <CheckInput
          label="Fondo del texto"
          checked={Boolean(background)}
          disabled={readOnly}
          onChange={(on) =>
            update({
              background: on
                ? {
                    color: palette[1]?.hex ?? '#000000',
                    opacity: 1,
                    padding: Math.round(size * 0.25),
                    radius: Math.round(size * 0.2),
                  }
                : undefined,
            })
          }
        />
        {background && (
          <>
            <ColorInput
              label="Color del fondo"
              value={background.color}
              palette={palette}
              disabled={readOnly}
              onChange={(color) => update({ background: { ...background, color } }, 'background')}
              onCommit={checkpoint}
            />
            <RangeInput
              label="Fuerza del fondo (%)"
              value={Math.round(background.opacity * 100)}
              min={0}
              max={100}
              disabled={readOnly}
              onChange={(v) => update({ background: { ...background, opacity: v / 100 } }, 'background')}
              onCommit={checkpoint}
            />
            <RangeInput
              label="Margen alrededor"
              value={background.padding}
              min={0}
              max={Math.max(40, size)}
              disabled={readOnly}
              onChange={(padding) => update({ background: { ...background, padding } }, 'background')}
              onCommit={checkpoint}
            />
            <RangeInput
              label="Esquinas redondeadas"
              value={background.radius}
              min={0}
              max={Math.max(40, size)}
              disabled={readOnly}
              onChange={(radius) => update({ background: { ...background, radius } }, 'background')}
              onCommit={checkpoint}
            />
          </>
        )}
      </div>
    </section>
  );
}
