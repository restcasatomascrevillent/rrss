import type { PageView } from '../../document';
import type { Rect } from '../../safeZones';
import type { LayerPatch } from '../history';
import type { ImageLookup } from './nodes';

/** Cómo se ha elegido una capa en el lienzo. */
export interface SelectOptions {
  /** Con Mayúsculas, Ctrl o Cmd: añadirla a la selección o quitarla. */
  toggle?: boolean;
}

/** Superposición de la zona segura: lo que puede tapar la interfaz de la red. */
export interface SafeZoneOverlay {
  unsafe: Rect[];
  safe: Rect;
}

/**
 * Lo que el editor le pasa al lienzo. El lienzo (Konva) vive detrás de esta
 * interfaz y se carga aparte, solo en la ruta del editor; en las pruebas de
 * componentes se sustituye por un doble sin Konva.
 */
export interface CanvasViewProps {
  /** La página que se dibuja (con el lienzo del documento). */
  document: PageView;
  /** Capas elegidas (una o varias). */
  selectedIds: string[];
  readOnly: boolean;
  /** Direcciones de las imágenes de la biblioteca, por id de recurso. */
  images: ImageLookup;
  onSelect: (id: string | null, options?: SelectOptions) => void;
  /** Rectángulo de selección: capas que toca. `additive` si se ha empezado con Mayúsculas. */
  onSelectMany: (ids: string[], additive: boolean) => void;
  /** Cambio terminado de una o varias capas (al soltar tras arrastrar, girar o redimensionar). */
  onChange: (changes: { id: string; patch: LayerPatch }[]) => void;
  /** Doble clic en un texto: el editor abre la edición sobre el lienzo. */
  onEditText: (id: string) => void;
  /** Texto que se está editando sobre el lienzo; null si ninguno. */
  editingTextId: string | null;
  /** Confirmar (Intro o clic fuera) o cancelar (Escape) la edición sobre el lienzo. */
  onTextCommit: (id: string, text: string) => void;
  onTextCancel: () => void;
  /** Zona segura de la red que se dibuja encima; null para no dibujarla. */
  safeZone: SafeZoneOverlay | null;
  /** Nombre accesible del lienzo. */
  label: string;
}
