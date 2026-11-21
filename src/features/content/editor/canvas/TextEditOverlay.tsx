import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TextLayer } from '../../document';
import { layerLabel } from '../layers';
import { textEditStyle } from './textEditStyle';

// Campo para escribir el texto de una capa directamente sobre el lienzo. Se
// coloca encima del nodo de Konva (que se oculta mientras tanto) con la misma
// caja, giro, tipografía, cuerpo, color, alineación e interlineado, escalados a
// la pantalla. Intro o clic fuera confirma; Mayúsculas+Intro, salto de línea;
// Escape cancela.

interface TextEditOverlayProps {
  layer: TextLayer;
  scale: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function TextEditOverlay({ layer, scale, onCommit, onCancel }: TextEditOverlayProps) {
  const [value, setValue] = useState(layer.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Escape también provoca el blur al desmontar: que no confirme lo cancelado.
  const done = useRef(false);

  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Lo que se teclea aquí es del campo, no del editor (ni deshacer del documento ni mover la capa).
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    }
  };

  return (
    <textarea
      ref={ref}
      value={value}
      maxLength={2000}
      aria-label={`Texto de la capa «${layerLabel(layer)}». Intro para confirmar, Mayúsculas+Intro para otra línea, Escape para cancelar.`}
      spellCheck
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      className="outline outline-2 outline-offset-2 outline-primary"
      style={textEditStyle(layer, scale)}
      data-testid="canvas-text-editor"
    />
  );
}
