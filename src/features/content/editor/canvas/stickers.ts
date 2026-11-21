import type { ShapeKind } from '../../document';

// Contornos de las figuras sencillas que se usan como pegatinas. Cada una se
// describe en un cuadrado de 1 × 1 que luego se estira a la caja de la capa, y
// se traduce a órdenes de trazado simples: así se prueba sin lienzo y lo dibujan
// igual el editor y la exportación.

export type PathCommand =
  | { op: 'M' | 'L'; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number }
  | { op: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: 'Z' };

/** Lo mínimo del contexto de dibujo que hace falta (lo cumplen el de Konva y el nativo). */
export interface PathSink {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Figuras que se dibujan como contorno propio (el rectángulo y la elipse tienen su nodo). */
export type StickerKind = Exclude<ShapeKind, 'rectangle' | 'ellipse'>;

export const STICKER_LABEL: Record<StickerKind, string> = {
  triangle: 'Triángulo',
  star: 'Estrella',
  heart: 'Corazón',
  arrow: 'Flecha',
  burst: 'Destello',
  speech: 'Globo de texto',
  line: 'Línea',
};

export function isSticker(shape: ShapeKind): shape is StickerKind {
  return shape !== 'rectangle' && shape !== 'ellipse';
}

const polygon = (points: [number, number][]): PathCommand[] => [
  ...points.map(([x, y], index): PathCommand => ({ op: index === 0 ? 'M' : 'L', x, y })),
  { op: 'Z' },
];

/** Estrella de `points` puntas, ajustada para llenar el cuadrado de 1 × 1. */
function starPoints(points: number, inner: number): [number, number][] {
  const raw: [number, number][] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? 1 : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    raw.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  const xs = raw.map(([x]) => x);
  const ys = raw.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return raw.map(([x, y]) => [(x - minX) / (maxX - minX), (y - minY) / (maxY - minY)]);
}

/** Contorno de una figura en el cuadrado de 1 × 1. */
export function stickerPath(shape: StickerKind): PathCommand[] {
  switch (shape) {
    case 'triangle':
      return polygon([
        [0.5, 0],
        [1, 1],
        [0, 1],
      ]);
    case 'star':
      return polygon(starPoints(5, 0.4));
    case 'burst':
      return polygon(starPoints(14, 0.78));
    case 'arrow':
      return polygon([
        [0, 0.3],
        [0.6, 0.3],
        [0.6, 0],
        [1, 0.5],
        [0.6, 1],
        [0.6, 0.7],
        [0, 0.7],
      ]);
    case 'heart':
      return [
        { op: 'M', x: 0.5, y: 1 },
        { op: 'C', c1x: 0.1, c1y: 0.7, c2x: 0, c2y: 0.5, x: 0, y: 0.3 },
        { op: 'C', c1x: 0, c1y: 0.12, c2x: 0.12, c2y: 0, x: 0.27, y: 0 },
        { op: 'C', c1x: 0.38, c1y: 0, c2x: 0.46, c2y: 0.06, x: 0.5, y: 0.16 },
        { op: 'C', c1x: 0.54, c1y: 0.06, c2x: 0.62, c2y: 0, x: 0.73, y: 0 },
        { op: 'C', c1x: 0.88, c1y: 0, c2x: 1, c2y: 0.12, x: 1, y: 0.3 },
        { op: 'C', c1x: 1, c1y: 0.5, c2x: 0.9, c2y: 0.7, x: 0.5, y: 1 },
        { op: 'Z' },
      ];
    case 'speech':
      return [
        { op: 'M', x: 0.08, y: 0 },
        { op: 'L', x: 0.92, y: 0 },
        { op: 'Q', cx: 1, cy: 0, x: 1, y: 0.1 },
        { op: 'L', x: 1, y: 0.6 },
        { op: 'Q', cx: 1, cy: 0.7, x: 0.92, y: 0.7 },
        { op: 'L', x: 0.4, y: 0.7 },
        { op: 'L', x: 0.2, y: 1 },
        { op: 'L', x: 0.25, y: 0.7 },
        { op: 'L', x: 0.08, y: 0.7 },
        { op: 'Q', cx: 0, cy: 0.7, x: 0, y: 0.6 },
        { op: 'L', x: 0, y: 0.1 },
        { op: 'Q', cx: 0, cy: 0, x: 0.08, y: 0 },
        { op: 'Z' },
      ];
    case 'line':
      return [
        { op: 'M', x: 0, y: 0.5 },
        { op: 'L', x: 1, y: 0.5 },
      ];
  }
}

/** Traza la figura en una caja de `width` × `height` (sin rellenar ni dibujar el borde). */
export function traceSticker(sink: PathSink, shape: StickerKind, width: number, height: number): void {
  sink.beginPath();
  for (const command of stickerPath(shape)) {
    if (command.op === 'M') sink.moveTo(command.x * width, command.y * height);
    else if (command.op === 'L') sink.lineTo(command.x * width, command.y * height);
    else if (command.op === 'Q') {
      sink.quadraticCurveTo(command.cx * width, command.cy * height, command.x * width, command.y * height);
    } else if (command.op === 'C') {
      sink.bezierCurveTo(
        command.c1x * width,
        command.c1y * height,
        command.c2x * width,
        command.c2y * height,
        command.x * width,
        command.y * height,
      );
    } else sink.closePath();
  }
}
