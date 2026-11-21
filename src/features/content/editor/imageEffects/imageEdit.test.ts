import { describe, expect, it } from 'vitest';
import { stickerPath, traceSticker } from '../canvas/stickers';
import { fitBoxAround, moveCrop, resizeCrop } from './cropMath';
import { adjustPixels, resolveAdjust } from './filters';
import {
  editKey,
  editOf,
  flipPhoto,
  largestCrop,
  orientedSize,
  planBitmap,
  straightenPatch,
  straightenScale,
  turnQuarter,
} from './imageEdit';
import { prepareBitmap } from './prepare';

const neutral = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, sharpness: 0 };

describe('qué pide editar una capa', () => {
  it('una capa sin ediciones, o con ajustes a cero y recorte entero, no pide nada', () => {
    expect(editOf({})).toBeNull();
    expect(editOf({ adjust: neutral, crop: { x: 0, y: 0, width: 1, height: 1 }, straighten: 0 })).toBeNull();
  });

  it('recoge lo que cambia y la clave distingue una edición de otra', () => {
    const edit = editOf({
      adjust: { ...neutral, brightness: 10 },
      turn: 90,
      crop: { x: 0.1, y: 0, width: 0.5, height: 1 },
    });
    expect(edit).toMatchObject({ turn: 90 });
    expect(editKey(edit)).not.toBe(editKey(editOf({ turn: 90 })));
    expect(editKey(null)).toBe('');
  });
});

describe('medidas', () => {
  it('girar 90° o 270° intercambia ancho y alto', () => {
    expect(orientedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(orientedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
  });

  it('enderezar amplía lo justo para no dejar esquinas vacías', () => {
    expect(straightenScale(1000, 1000, 0)).toBe(1);
    expect(straightenScale(1000, 1000, 10)).toBeGreaterThan(1.15);
    expect(straightenScale(1000, 500, 5)).toBeGreaterThan(straightenScale(1000, 500, 2));
    expect(straightenScale(1000, 500, -5)).toBeCloseTo(straightenScale(1000, 500, 5));
  });

  it('el plan reduce solo lo que se ve y el recorte cabe en la foto', () => {
    const plan = planBitmap(4000, 3000, { crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }, 1000);
    expect(plan.scale).toBeCloseTo(0.5);
    expect(plan.crop.x + plan.crop.width).toBeLessThanOrEqual(plan.frame.width);
    expect(plan.crop.y + plan.crop.height).toBeLessThanOrEqual(plan.frame.height);
    expect(planBitmap(800, 600, null, 2400).scale).toBe(1);
  });
});

describe('girar, voltear y enderezar', () => {
  it('cuatro giros de 90° dejan la foto como estaba, también el recorte', () => {
    let layer: Parameters<typeof turnQuarter>[0] = { crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
    for (let i = 0; i < 4; i += 1) layer = { ...layer, ...turnQuarter(layer) };
    expect(layer.turn).toBeUndefined();
    expect(layer.crop).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it('al girar, el volteo horizontal pasa a vertical', () => {
    expect(turnQuarter({ flipX: true })).toMatchObject({ turn: 90, flipX: undefined, flipY: true });
  });

  it('voltear dos veces lo deja igual y cambia el signo del enderezado', () => {
    const once = flipPhoto({ straighten: 3, crop: { x: 0, y: 0, width: 0.4, height: 1 } }, 'x');
    expect(once).toMatchObject({ flipX: true, straighten: -3, crop: { x: 0.6 } });
    const twice = flipPhoto({ ...once }, 'x');
    expect(twice.flipX).toBeUndefined();
    expect(twice.straighten).toBe(3);
  });

  it('enderezar 0 lo quita y se limita a 45°', () => {
    expect(straightenPatch(0).straighten).toBeUndefined();
    expect(straightenPatch(90).straighten).toBe(45);
  });
});

describe('recorte', () => {
  const frame = { width: 4000, height: 3000 };

  it('el recorte más grande de una proporción cabe y la respeta', () => {
    const crop = largestCrop(frame, 1);
    expect((crop.width * frame.width) / (crop.height * frame.height)).toBeCloseTo(1, 3);
    expect(crop.height).toBe(1);
    const tall = largestCrop(frame, 9 / 16);
    expect(tall.height).toBe(1);
    expect(tall.x + tall.width).toBeLessThanOrEqual(1);
  });

  it('mover no saca el recorte de la foto', () => {
    const moved = moveCrop({ x: 0.5, y: 0.5, width: 0.4, height: 0.4 }, 0.9, -2);
    expect(moved).toMatchObject({ x: 0.6, y: 0 });
  });

  it('arrastrar una esquina deja quieta la contraria y respeta la proporción', () => {
    const crop = resizeCrop({ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.9 }, frame, 1);
    expect(crop.x).toBe(0.2);
    expect(crop.y).toBe(0.2);
    expect((crop.width * frame.width) / (crop.height * frame.height)).toBeCloseTo(1, 2);
    const free = resizeCrop({ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.2 }, frame, null);
    expect(free).toMatchObject({ x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
  });

  it('no se sale de la foto aunque el puntero sí', () => {
    const crop = resizeCrop({ x: 0.5, y: 0.5 }, { x: 3, y: 3 }, frame, null);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1);
  });

  it('la caja de la capa se ajusta a la proporción del recorte sin crecer', () => {
    const box = { x: 0, y: 0, width: 1080, height: 1350 };
    expect(fitBoxAround(box, 4 / 5)).toEqual(box);
    expect(fitBoxAround(box, 1)).toEqual({ x: 0, y: 135, width: 1080, height: 1080 });
    const narrow = fitBoxAround(box, 0.4);
    expect(narrow.height).toBe(1350);
    expect(narrow.width).toBe(540);
  });
});

describe('luz, color y filtros', () => {
  const pixels = { data: new Uint8ClampedArray([200, 100, 50, 255, 20, 40, 60, 128]), width: 2, height: 1 };

  it('suma los deslizadores y el filtro sin salirse de los límites', () => {
    const { adjustments } = resolveAdjust({ ...neutral, temperature: 90, filter: 'warm' });
    expect(adjustments.warmth).toBe(100);
    expect(resolveAdjust({ ...neutral, filter: 'sepia' }).post).toBe('sepia');
  });

  it('blanco y negro quita el color y no toca la transparencia ni la foto de entrada', () => {
    const before = [...pixels.data];
    const out = adjustPixels(pixels, { ...neutral, filter: 'bw' });
    expect(Math.abs(out.data[0]! - out.data[1]!)).toBeLessThanOrEqual(2);
    expect(out.data[7]).toBe(128);
    expect([...pixels.data]).toEqual(before);
  });

  it('el brillo aclara', () => {
    const out = adjustPixels(pixels, { ...neutral, brightness: 40 });
    expect(out.data[0]!).toBeGreaterThan(pixels.data[0]!);
  });
});

describe('figuras', () => {
  it('cada figura tiene contorno dentro del cuadrado de 1 × 1', () => {
    for (const shape of ['triangle', 'star', 'heart', 'arrow', 'burst', 'speech', 'line'] as const) {
      const commands = stickerPath(shape);
      expect(commands.length, shape).toBeGreaterThan(1);
      for (const c of commands) {
        if (c.op === 'Z') continue;
        expect(c.x, shape).toBeGreaterThanOrEqual(-1e-9);
        expect(c.x, shape).toBeLessThanOrEqual(1 + 1e-9);
        expect(c.y, shape).toBeGreaterThanOrEqual(-1e-9);
        expect(c.y, shape).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('se traza estirado a la caja', () => {
    const calls: string[] = [];
    const sink = {
      beginPath: () => calls.push('begin'),
      moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`L${x},${y}`),
      quadraticCurveTo: () => calls.push('Q'),
      bezierCurveTo: () => calls.push('C'),
      closePath: () => calls.push('Z'),
    };
    traceSticker(sink, 'triangle', 200, 100);
    expect(calls).toEqual(['begin', 'M100,0', 'L200,100', 'L0,100', 'Z']);
  });
});

describe('preparar la foto (con un lienzo de mentira)', () => {
  /** Lienzo que anota lo que se le pide, para comprobar medidas y orden de operaciones. */
  function fakeCanvas(log: string[]) {
    return (width: number, height: number) => {
      const context = {
        translate: (x: number, y: number) => log.push(`translate ${x},${y}`),
        rotate: (a: number) => log.push(`rotate ${Math.round((a * 180) / Math.PI)}`),
        scale: (x: number, y: number) => log.push(`scale ${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`),
        drawImage: () => log.push('draw'),
        getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
        putImageData: () => log.push('put'),
      };
      return { width, height, getContext: () => context } as unknown as HTMLCanvasElement;
    };
  }
  // Un lienzo (no una imagen) hace de foto de origen: solo se le piden las medidas.
  const photo = (width: number, height: number) => {
    const canvas = window.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };

  it('el lienzo tiene el tamaño del recorte y gira antes de dibujar', () => {
    const log: string[] = [];
    const canvas = prepareBitmap(
      photo(400, 300),
      { turn: 90, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      2400,
      fakeCanvas(log),
    );
    expect(canvas.width).toBe(150);
    expect(canvas.height).toBe(200);
    expect(log.indexOf('rotate 90')).toBeLessThan(log.indexOf('draw'));
    expect(log).not.toContain('put');
  });

  it('con ajustes lee y escribe los píxeles', () => {
    const log: string[] = [];
    prepareBitmap(photo(40, 30), { adjust: { ...neutral, brightness: 10 } }, 2400, fakeCanvas(log));
    expect(log).toContain('put');
  });
});
