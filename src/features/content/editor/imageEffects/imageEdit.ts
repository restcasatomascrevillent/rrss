// Ediciones de una foto dentro del diseño: lo que se guarda en la capa (ajustes,
// giro, volteo, enderezado y recorte) y las operaciones que lo cambian. Son
// funciones puras sobre datos: no dibujan nada, así se prueban sin navegador y
// valen igual para el lienzo, la exportación y las pruebas. Dibujar la foto ya
// editada es cosa de `prepare.ts`.
//
// Orden en que se aplican (de la foto original a la que se ve):
//   1. girar de 90 en 90  →  2. voltear  →  3. enderezar (giro fino)  →  4. recortar  →  5. luz y color.
// El recorte se guarda como fracciones de la foto YA girada, volteada y
// enderezada (ver `cropSchema`). Cada operación de abajo devuelve el estado
// nuevo con el recorte y el ángulo puestos al día, para que girar o voltear
// después de recortar no descoloque el recorte.
import {
  isNeutralAdjust,
  MAX_STRAIGHTEN,
  MIN_CROP_SIDE,
  type ImageAdjust,
  type ImageCrop,
  type ImageLayer,
} from '../../document';

/** Lo de una capa de imagen que cambia cómo se dibuja la foto en sí (no su caja ni su fondo). */
export interface ImageEdit {
  adjust?: ImageAdjust;
  turn?: 90 | 180 | 270;
  flipX?: true;
  flipY?: true;
  straighten?: number;
  crop?: ImageCrop;
}

export type EditFields = Pick<ImageLayer, 'adjust' | 'turn' | 'flipX' | 'flipY' | 'straighten' | 'crop'>;

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** ¿El recorte es la foto entera (o casi)? Un recorte así no se guarda. */
export function isFullCrop(crop: ImageCrop | undefined): boolean {
  return !crop || (crop.x <= 0.0005 && crop.y <= 0.0005 && crop.width >= 0.999 && crop.height >= 0.999);
}

/** Lo que la capa pide editar, o null si la foto se dibuja tal cual. Los ajustes neutros no cuentan. */
export function editOf(layer: Partial<EditFields>): ImageEdit | null {
  const edit: ImageEdit = {};
  if (layer.adjust && !isNeutralAdjust(layer.adjust)) edit.adjust = layer.adjust;
  if (layer.turn) edit.turn = layer.turn;
  if (layer.flipX) edit.flipX = true;
  if (layer.flipY) edit.flipY = true;
  if (layer.straighten && Math.abs(layer.straighten) >= 0.01) edit.straighten = layer.straighten;
  if (layer.crop && !isFullCrop(layer.crop)) edit.crop = layer.crop;
  return Object.keys(edit).length > 0 ? edit : null;
}

/** ¿Hace falta leer los píxeles de la foto (luz, color, filtro)? Girar y recortar no lo necesitan. */
export function editNeedsPixels(edit: ImageEdit | null): boolean {
  return Boolean(edit?.adjust);
}

/** Clave estable de una edición, para guardar en caché la foto ya preparada. */
export function editKey(edit: ImageEdit | null): string {
  if (!edit) return '';
  const a = edit.adjust;
  const crop = edit.crop;
  return [
    a ? `a${a.brightness},${a.contrast},${a.saturation},${a.temperature},${a.sharpness},${a.filter ?? ''}` : '',
    edit.turn ? `t${edit.turn}` : '',
    edit.flipX ? 'fx' : '',
    edit.flipY ? 'fy' : '',
    edit.straighten ? `s${round(edit.straighten, 2)}` : '',
    crop ? `c${round(crop.x)},${round(crop.y)},${round(crop.width)},${round(crop.height)}` : '',
  ]
    .filter(Boolean)
    .join('|');
}

// ── Medidas ──────────────────────────────────────────────────────────────

/** Medidas de la foto tras girarla de 90 en 90. */
export function orientedSize(
  width: number,
  height: number,
  turn: ImageEdit['turn'] | undefined,
): { width: number; height: number } {
  return turn === 90 || turn === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Ampliación necesaria para que, al enderezar `degrees` grados, la foto siga
 * llenando el cuadro sin dejar esquinas vacías.
 */
export function straightenScale(width: number, height: number, degrees: number): number {
  const angle = (Math.abs(degrees) * Math.PI) / 180;
  if (angle === 0) return 1;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return Math.max(cos + (height / width) * sin, cos + (width / height) * sin);
}

export interface BitmapPlan {
  /** Medidas de la foto ya girada (en píxeles de trabajo, tras reducirla si hacía falta). */
  frame: { width: number; height: number };
  /** Zona recortada, en píxeles de trabajo (toda la foto si no hay recorte). */
  crop: { x: number; y: number; width: number; height: number };
  /** Reducción respecto a la foto original (1 = tamaño real). */
  scale: number;
  /** Ampliación del enderezado (1 si no hay). */
  straightenScale: number;
}

/**
 * Qué lienzo hay que preparar para una foto de `width` × `height` con esta
 * edición, sin pasar de `maxSide` píxeles de lado en lo que se va a ver (con
 * recorte, un recorte pequeño conserva más detalle).
 */
export function planBitmap(width: number, height: number, edit: ImageEdit | null, maxSide: number): BitmapPlan {
  const oriented = orientedSize(width, height, edit?.turn);
  const crop = edit?.crop;
  const visibleLongSide = Math.max(oriented.width * (crop?.width ?? 1), oriented.height * (crop?.height ?? 1));
  const scale = Math.min(1, maxSide / Math.max(1, visibleLongSide));
  const frame = {
    width: Math.max(1, Math.round(oriented.width * scale)),
    height: Math.max(1, Math.round(oriented.height * scale)),
  };
  const box = crop
    ? {
        x: Math.min(frame.width - 1, Math.round(crop.x * frame.width)),
        y: Math.min(frame.height - 1, Math.round(crop.y * frame.height)),
        width: Math.max(1, Math.round(crop.width * frame.width)),
        height: Math.max(1, Math.round(crop.height * frame.height)),
      }
    : { x: 0, y: 0, width: frame.width, height: frame.height };
  box.width = Math.min(box.width, frame.width - box.x);
  box.height = Math.min(box.height, frame.height - box.y);
  return {
    frame,
    crop: box,
    scale,
    straightenScale: edit?.straighten ? straightenScale(frame.width, frame.height, edit.straighten) : 1,
  };
}

// ── Operaciones del panel ────────────────────────────────────────────────

/** Recorte de una foto que se gira 90° en sentido horario: el mismo trozo, visto girado. */
export function turnCrop(crop: ImageCrop): ImageCrop {
  return { x: round(1 - crop.y - crop.height), y: crop.x, width: crop.height, height: crop.width };
}

export function flipCropX(crop: ImageCrop): ImageCrop {
  return { ...crop, x: round(1 - crop.x - crop.width) };
}

export function flipCropY(crop: ImageCrop): ImageCrop {
  return { ...crop, y: round(1 - crop.y - crop.height) };
}

/** Cambios para una capa: lo que vale `undefined` se quita del documento. */
export type EditPatch = { [K in keyof EditFields]?: EditFields[K] | undefined };

/** Girar 90° en sentido horario. Al girar, voltear horizontal y vertical se cambian entre sí. */
export function turnQuarter(layer: Partial<EditFields>): EditPatch {
  const next = (((layer.turn ?? 0) + 90) % 360) as 0 | 90 | 180 | 270;
  return {
    turn: next === 0 ? undefined : next,
    flipX: layer.flipY ? true : undefined,
    flipY: layer.flipX ? true : undefined,
    crop: layer.crop ? turnCrop(layer.crop) : undefined,
  };
}

/** Voltear la foto en horizontal o en vertical. El enderezado cambia de signo: el espejo invierte la inclinación. */
export function flipPhoto(layer: Partial<EditFields>, axis: 'x' | 'y'): EditPatch {
  const straighten = layer.straighten ? -layer.straighten : undefined;
  if (axis === 'x') {
    return {
      flipX: layer.flipX ? undefined : true,
      straighten,
      crop: layer.crop ? flipCropX(layer.crop) : undefined,
    };
  }
  return {
    flipY: layer.flipY ? undefined : true,
    straighten,
    crop: layer.crop ? flipCropY(layer.crop) : undefined,
  };
}

/** Enderezar: giro fino en grados. 0 lo quita. */
export function straightenPatch(degrees: number): EditPatch {
  const value = round(clamp(Number.isFinite(degrees) ? degrees : 0, -MAX_STRAIGHTEN, MAX_STRAIGHTEN), 2);
  return { straighten: Math.abs(value) < 0.01 ? undefined : value };
}

/** Lo que hay que cambiar para dejar la foto como la original: sin ajustes, giro, volteo, enderezado ni recorte. */
export const RESET_EDITS: EditPatch = {
  adjust: undefined,
  turn: undefined,
  flipX: undefined,
  flipY: undefined,
  straighten: undefined,
  crop: undefined,
};

// ── Recorte ──────────────────────────────────────────────────────────────

export interface CropRatio {
  id: string;
  label: string;
  /** Ancho / alto; null = libre. */
  ratio: number | null;
}

/** Proporciones que ofrece el recorte (además de «Como la capa»). */
export const CROP_RATIOS: CropRatio[] = [
  { id: 'free', label: 'Libre', ratio: null },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
];

/**
 * Recorte más grande de la proporción `ratio` (ancho / alto, en píxeles) que
 * cabe en una foto de `frame`, centrado en `around` (por defecto, en el centro).
 * Devuelve fracciones de la foto.
 */
export function largestCrop(
  frame: { width: number; height: number },
  ratio: number,
  around: { x: number; y: number } = { x: 0.5, y: 0.5 },
): ImageCrop {
  const frameRatio = frame.width / frame.height;
  const width = ratio >= frameRatio ? 1 : ratio / frameRatio;
  const height = ratio >= frameRatio ? frameRatio / ratio : 1;
  return {
    x: round(clamp(around.x - width / 2, 0, 1 - width)),
    y: round(clamp(around.y - height / 2, 0, 1 - height)),
    width: round(width),
    height: round(height),
  };
}

/** Deja un recorte dentro de la foto y con un tamaño mínimo. */
export function clampCrop(crop: ImageCrop): ImageCrop {
  const width = clamp(crop.width, MIN_CROP_SIDE, 1);
  const height = clamp(crop.height, MIN_CROP_SIDE, 1);
  return {
    x: round(clamp(crop.x, 0, 1 - width)),
    y: round(clamp(crop.y, 0, 1 - height)),
    width: round(width),
    height: round(height),
  };
}

/** Proporción en píxeles (ancho / alto) de un recorte sobre una foto de `frame`. */
export function cropRatioOf(crop: ImageCrop | undefined, frame: { width: number; height: number }): number {
  return ((crop?.width ?? 1) * frame.width) / ((crop?.height ?? 1) * frame.height);
}
