import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fitScale } from '../geometry';
import { describeDocument } from './nodes';
import { Scene } from './scene';
import { TextEditOverlay } from './TextEditOverlay';
import type { CanvasViewProps } from './types';

// Envoltorio de React del lienzo de Konva (sin react-konva). Crea la escena una
// vez, le pasa el documento en cada cambio y mide el hueco disponible para
// escalar el lienzo. Se carga aparte (import perezoso) con Konva dentro.

export default function KonvaCanvas({
  document,
  selectedIds,
  readOnly,
  images,
  onSelect,
  onSelectMany,
  onChange,
  onEditText,
  editingTextId,
  onTextCommit,
  onTextCancel,
  safeZone,
  label,
}: CanvasViewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const callbacks = useRef({ onSelect, onSelectMany, onChange, onEditText });
  const [available, setAvailable] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    callbacks.current = { onSelect, onSelectMany, onChange, onEditText };
  });

  useEffect(() => {
    if (!stageRef.current) return;
    const scene = new Scene(stageRef.current, {
      onSelect: (id, options) => callbacks.current.onSelect(id, options),
      onSelectMany: (ids, additive) => callbacks.current.onSelectMany(ids, additive),
      onChange: (changes) => callbacks.current.onChange(changes),
      onEditText: (id) => callbacks.current.onEditText(id),
    });
    sceneRef.current = scene;
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setAvailable({ width: frame.clientWidth, height: frame.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo(() => describeDocument(document, images, readOnly), [document, images, readOnly]);
  const scale = fitScale(document.canvas, available);
  const editing = document.layers.find((layer) => layer.id === editingTextId);

  useEffect(() => {
    sceneRef.current?.render({
      nodes,
      canvas: document.canvas,
      selectedIds,
      editingId: editingTextId,
      safeZone,
      readOnly,
      scale,
    });
  }, [nodes, document.canvas, selectedIds, editingTextId, safeZone, readOnly, scale]);

  return (
    <div
      ref={frameRef}
      className="flex h-full w-full items-center justify-center overflow-hidden"
      // El margen alrededor del documento también quita la selección.
      onPointerDown={(event) => event.target === event.currentTarget && callbacks.current.onSelect(null)}
    >
      <div className="relative shadow-pop ring-1 ring-border">
        <div ref={stageRef} role="img" aria-label={label} data-testid="editor-stage" />
        {editing?.type === 'text' && !readOnly && (
          <TextEditOverlay
            key={editing.id}
            layer={editing}
            scale={scale}
            onCommit={(text) => onTextCommit(editing.id, text)}
            onCancel={onTextCancel}
          />
        )}
      </div>
    </div>
  );
}
