import { BringToFront, SendToBack, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { Dispatch, Ref } from 'react';
import { Button } from '@/components/ui';
import {
  ANCHORS_X,
  ANCHORS_Y,
  ASPECT_RATIOS,
  MAX_IMAGE_BLUR,
  type AspectRatio,
  type Canvas,
  type Layer,
  type ShapeLayer,
  type TextLayer,
} from '../../document';
import type { EditorAction, LayerPatch } from '../history';
import { FALLBACK_FONTS, LAYER_TYPE_LABEL, layerLabel } from '../layers';
import { CheckInput, ColorInput, Labeled, NumberInput, SelectInput } from './controls';
import { PhotoPanel, type PhotoToolsContext } from './PhotoPanel';
import { ShadowFields } from './ShadowFields';
import { TextEffectsFields } from './TextEffectsFields';

export interface BrandStyle {
  palette: { hex: string; name: string }[];
  fonts: string[];
}

interface PropertiesPanelProps {
  layer: Layer | null;
  canvas: Canvas;
  readOnly: boolean;
  dispatch: Dispatch<EditorAction>;
  brandStyle: BrandStyle;
  /** Proporciones que admite la red; null si no se sabe. */
  allowedRatios: AspectRatio[] | null;
  textRef: Ref<HTMLTextAreaElement>;
  /** Abre «Editar foto» con la imagen de la capa (solo si es de la biblioteca y se puede editar). */
  onEditPhoto?: () => void;
  /** Lo que necesitan las ediciones de foto que crean una foto nueva (quitar el fondo…). */
  photoTools?: PhotoToolsContext;
}

const ANCHOR_X_LABEL: Record<(typeof ANCHORS_X)[number], string> = {
  left: 'Borde izquierdo',
  center: 'Centro',
  right: 'Borde derecho',
  stretch: 'Se estira',
};
const ANCHOR_Y_LABEL: Record<(typeof ANCHORS_Y)[number], string> = {
  top: 'Borde superior',
  center: 'Centro',
  bottom: 'Borde inferior',
  stretch: 'Se estira',
};

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

export function PropertiesPanel({
  layer,
  canvas,
  readOnly,
  dispatch,
  brandStyle,
  allowedRatios,
  textRef,
  onEditPhoto,
  photoTools,
}: PropertiesPanelProps) {
  const checkpoint = () => dispatch({ type: 'checkpoint' });

  if (!layer) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Lienzo</h3>
        <SelectInput<AspectRatio>
          label="Proporción"
          value={canvas.aspectRatio}
          disabled={readOnly}
          onChange={(ratio) => dispatch({ type: 'setRatio', ratio })}
          options={ASPECT_RATIOS.map((ratio) => ({
            value: ratio,
            label: allowedRatios && !allowedRatios.includes(ratio) ? `${ratio} (la red no la admite)` : ratio,
          }))}
        />
        <p className="text-xs text-muted">
          Al cambiarla, las capas se recolocan según su anclaje. Revisa el resultado; se puede deshacer.
        </p>
        <ColorInput
          label="Fondo"
          value={canvas.backgroundColor}
          palette={brandStyle.palette}
          disabled={readOnly}
          onChange={(color) => dispatch({ type: 'setBackground', color, key: 'background' })}
          onCommit={checkpoint}
        />
        <p className="text-xs text-muted">Elige una capa en el lienzo o en «Capas» para cambiarla.</p>
      </div>
    );
  }

  const id = layer.id;
  const update = (patch: LayerPatch, field?: string) =>
    dispatch({ type: 'update', id, patch, ...(field ? { key: `${field}:${id}` } : {}) });
  const geometryLocked = readOnly || layer.locked;

  return (
    <div className="space-y-5" data-testid="properties-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{layerLabel(layer)}</h3>
          <p className="text-xs text-muted">{LAYER_TYPE_LABEL[layer.type]}</p>
        </div>
        {!readOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={() => dispatch({ type: 'remove', id })}
            data-testid="layer-delete"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Borrar
          </Button>
        )}
      </div>

      {layer.type === 'text' && (
        <TextFields
          layer={layer}
          readOnly={readOnly}
          update={update}
          brandStyle={brandStyle}
          textRef={textRef}
          checkpoint={checkpoint}
        />
      )}
      {layer.type === 'text' && (
        <TextEffectsFields
          layer={layer}
          readOnly={readOnly}
          palette={brandStyle.palette}
          update={update}
          checkpoint={checkpoint}
        />
      )}
      {layer.type === 'shape' && (
        <ShapeFields
          layer={layer}
          readOnly={readOnly}
          update={update}
          brandStyle={brandStyle}
          checkpoint={checkpoint}
        />
      )}
      {layer.type === 'image' && (
        <div className="grid grid-cols-2 gap-3">
          <SelectInput<'cover' | 'contain'>
            label="Encaje"
            value={layer.fit}
            disabled={readOnly}
            onChange={(fit) => update({ fit })}
            options={[
              { value: 'cover', label: 'Llenar (recorta)' },
              { value: 'contain', label: 'Entera' },
            ]}
          />
          <div />
          <NumberInput
            label="Punto de interés X (%)"
            value={layer.focus.x * 100}
            min={0}
            max={100}
            disabled={readOnly}
            onChange={(v) => update({ focus: { ...layer.focus, x: v / 100 } }, 'focus')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Punto de interés Y (%)"
            value={layer.focus.y * 100}
            min={0}
            max={100}
            disabled={readOnly}
            onChange={(v) => update({ focus: { ...layer.focus, y: v / 100 } }, 'focus')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Desenfoque (%)"
            value={layer.blur ?? 0}
            min={0}
            max={MAX_IMAGE_BLUR}
            disabled={readOnly}
            onChange={(v) => update({ blur: v > 0 ? Math.min(MAX_IMAGE_BLUR, v) : undefined }, 'blur')}
            onCommit={checkpoint}
          />
          {onEditPhoto && !readOnly && layer.source.kind === 'asset' && (
            <Button
              variant="secondary"
              size="sm"
              className="col-span-2"
              onClick={onEditPhoto}
              data-testid="layer-edit-photo"
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              Editar foto
            </Button>
          )}
        </div>
      )}

      {layer.type === 'image' && (
        <PhotoPanel
          layer={layer}
          readOnly={readOnly}
          palette={brandStyle.palette}
          update={update}
          checkpoint={checkpoint}
          tools={photoTools ?? { row: null, url: undefined, onUseResult: () => undefined }}
        />
      )}

      <section className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Posición y tamaño</h4>
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="X"
            value={layer.x}
            disabled={geometryLocked}
            onChange={(x) => update({ x }, 'x')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Y"
            value={layer.y}
            disabled={geometryLocked}
            onChange={(y) => update({ y }, 'y')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Ancho"
            value={layer.width}
            min={1}
            disabled={geometryLocked}
            onChange={(width) => update({ width }, 'width')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Alto"
            value={layer.height}
            min={1}
            disabled={geometryLocked}
            onChange={(height) => update({ height }, 'height')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Giro (grados)"
            value={layer.rotation}
            min={-180}
            max={180}
            disabled={geometryLocked}
            onChange={(rotation) => update({ rotation }, 'rotation')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Opacidad (%)"
            value={layer.opacity * 100}
            min={0}
            max={100}
            disabled={readOnly}
            onChange={(v) => update({ opacity: v / 100 }, 'opacity')}
            onCommit={checkpoint}
          />
        </div>
        <div className="flex flex-wrap gap-4">
          <CheckInput
            label="Visible"
            checked={layer.visible}
            disabled={readOnly}
            onChange={(visible) => update({ visible })}
          />
          <CheckInput
            label="Bloqueada"
            checked={layer.locked}
            disabled={readOnly}
            onChange={(locked) => update({ locked })}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Al cambiar de proporción</h4>
        <div className="grid grid-cols-2 gap-3">
          <SelectInput
            label="Horizontal: conserva"
            value={layer.anchor.x}
            disabled={readOnly}
            onChange={(x) => update({ anchor: { ...layer.anchor, x } })}
            options={ANCHORS_X.map((value) => ({ value, label: ANCHOR_X_LABEL[value] }))}
          />
          <SelectInput
            label="Vertical: conserva"
            value={layer.anchor.y}
            disabled={readOnly}
            onChange={(y) => update({ anchor: { ...layer.anchor, y } })}
            options={ANCHORS_Y.map((value) => ({ value, label: ANCHOR_Y_LABEL[value] }))}
          />
        </div>
      </section>

      {!readOnly && (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Orden</h4>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'reorder', id, to: 'front' })}>
              <BringToFront className="h-4 w-4" aria-hidden />
              Al frente
            </Button>
            <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'reorder', id, to: 'back' })}>
              <SendToBack className="h-4 w-4" aria-hidden />
              Al fondo
            </Button>
          </div>
        </section>
      )}

      {!readOnly && (
        <Labeled label="Nombre de la capa">
          {(inputId) => (
            <input
              id={inputId}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={layer.name}
              maxLength={120}
              placeholder={layerLabel({ ...layer, name: '' })}
              onChange={(e) => update({ name: e.target.value }, 'name')}
              onBlur={checkpoint}
            />
          )}
        </Labeled>
      )}
    </div>
  );
}

function TextFields({
  layer,
  readOnly,
  update,
  brandStyle,
  textRef,
  checkpoint,
}: {
  layer: TextLayer;
  readOnly: boolean;
  update: (patch: LayerPatch, field?: string) => void;
  brandStyle: BrandStyle;
  textRef: Ref<HTMLTextAreaElement>;
  checkpoint: () => void;
}) {
  const fonts = [...new Set([...brandStyle.fonts, ...FALLBACK_FONTS, layer.fontFamily])];
  return (
    <section className="space-y-3">
      <Labeled label="Texto">
        {(id) => (
          <textarea
            id={id}
            ref={textRef}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
            value={layer.text}
            disabled={readOnly}
            onChange={(e) => update({ text: e.target.value }, 'text')}
            onBlur={checkpoint}
            data-testid="layer-text"
          />
        )}
      </Labeled>
      <div className="grid grid-cols-2 gap-3">
        <SelectInput
          label="Tipografía"
          value={layer.fontFamily}
          disabled={readOnly}
          onChange={(fontFamily) => update({ fontFamily })}
          options={fonts.map((font) => ({
            value: font,
            label: brandStyle.fonts.includes(font) ? `${font} (marca)` : font,
          }))}
        />
        <NumberInput
          label="Cuerpo"
          value={layer.fontSize}
          min={1}
          max={2000}
          disabled={readOnly}
          onChange={(fontSize) => update({ fontSize }, 'fontSize')}
          onCommit={checkpoint}
        />
        <SelectInput
          label="Grosor"
          value={String(layer.fontWeight)}
          disabled={readOnly}
          onChange={(w) => update({ fontWeight: Number(w) })}
          options={WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))}
        />
        <SelectInput<'left' | 'center' | 'right'>
          label="Alineación"
          value={layer.align}
          disabled={readOnly}
          onChange={(align) => update({ align })}
          options={[
            { value: 'left', label: 'Izquierda' },
            { value: 'center', label: 'Centro' },
            { value: 'right', label: 'Derecha' },
          ]}
        />
        <NumberInput
          label="Interlineado"
          value={layer.lineHeight}
          min={0.5}
          max={4}
          step={0.05}
          disabled={readOnly}
          onChange={(lineHeight) => update({ lineHeight }, 'lineHeight')}
          onCommit={checkpoint}
        />
        <div className="flex items-end pb-2">
          <CheckInput
            label="Cursiva"
            checked={layer.italic}
            disabled={readOnly}
            onChange={(italic) => update({ italic })}
          />
        </div>
      </div>
      <ColorInput
        label="Color del texto"
        value={layer.color}
        palette={brandStyle.palette}
        disabled={readOnly}
        onChange={(color) => update({ color }, 'color')}
        onCommit={checkpoint}
      />
    </section>
  );
}

function ShapeFields({
  layer,
  readOnly,
  update,
  brandStyle,
  checkpoint,
}: {
  layer: ShapeLayer;
  readOnly: boolean;
  update: (patch: LayerPatch, field?: string) => void;
  brandStyle: BrandStyle;
  checkpoint: () => void;
}) {
  return (
    <section className="space-y-3">
      <CheckInput
        label="Relleno"
        checked={layer.fill !== null}
        disabled={readOnly}
        onChange={(on) => update({ fill: on ? (brandStyle.palette[0]?.hex ?? '#E5E7EB') : null })}
      />
      {layer.fill !== null && (
        <ColorInput
          label="Color de relleno"
          value={layer.fill}
          palette={brandStyle.palette}
          disabled={readOnly}
          onChange={(fill) => update({ fill }, 'fill')}
          onCommit={checkpoint}
        />
      )}
      <CheckInput
        label="Borde"
        checked={layer.stroke !== null}
        disabled={readOnly}
        onChange={(on) => update({ stroke: on ? { color: '#111111', width: 4 } : null })}
      />
      {layer.stroke !== null && (
        <>
          <ColorInput
            label="Color del borde"
            value={layer.stroke.color}
            palette={brandStyle.palette}
            disabled={readOnly}
            onChange={(color) => update({ stroke: { width: layer.stroke?.width ?? 4, color } }, 'stroke')}
            onCommit={checkpoint}
          />
          <NumberInput
            label="Grosor del borde"
            value={layer.stroke.width}
            min={0.5}
            max={1000}
            disabled={readOnly}
            onChange={(width) => update({ stroke: { color: layer.stroke?.color ?? '#111111', width } }, 'stroke')}
            onCommit={checkpoint}
          />
        </>
      )}
      {layer.shape === 'rectangle' && (
        <NumberInput
          label="Radio de las esquinas"
          value={layer.cornerRadius}
          min={0}
          disabled={readOnly}
          onChange={(cornerRadius) => update({ cornerRadius }, 'cornerRadius')}
          onCommit={checkpoint}
        />
      )}
      <ShadowFields
        shadow={layer.shadow}
        palette={brandStyle.palette}
        readOnly={readOnly}
        onChange={(shadow, field) => update({ shadow }, field)}
        onCommit={checkpoint}
      />
    </section>
  );
}
