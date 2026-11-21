import { describe, expect, it } from 'vitest';
import {
  ASPECT_RATIOS,
  CANVAS_SIZES,
  adaptDocument,
  adaptLayer,
  adaptScale,
  createEmptyDocument,
  validateDocument,
  type AspectRatio,
  type ContentDocument,
  type LayerInput,
} from './index';

const ASSET = '11111111-1111-4111-8111-111111111111';

function documentWith(aspectRatio: AspectRatio, layers: LayerInput[]): ContentDocument {
  const result = validateDocument({ ...createEmptyDocument({ aspectRatio }), pages: [{ id: 'p1', layers }] });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
}

const box = (document: ContentDocument, id: string) => {
  const layer = document.pages[0]!.layers.find((l) => l.id === id)!;
  return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
};

/** Un cuadrado 1:1 con una capa por regla de anclaje. */
const square = () =>
  documentWith('1:1', [
    {
      id: 'fondo',
      type: 'image',
      x: 0,
      y: 0,
      width: 1080,
      height: 1080,
      source: { kind: 'asset', assetId: ASSET },
      anchor: { x: 'stretch', y: 'stretch' },
      focus: { x: 0.3, y: 0.7 },
    },
    {
      id: 'logo',
      type: 'logo',
      x: 60,
      y: 40,
      width: 200,
      height: 100,
      assetId: ASSET,
      anchor: { x: 'left', y: 'top' },
    },
    {
      id: 'sello',
      type: 'shape',
      shape: 'ellipse',
      x: 880,
      y: 900,
      width: 150,
      height: 150,
      fill: '#FF0000',
      stroke: { color: '#000000', width: 8 },
      cornerRadius: 16,
      anchor: { x: 'right', y: 'bottom' },
      rotation: 15,
      opacity: 0.8,
    },
    {
      id: 'titular',
      type: 'text',
      x: 140,
      y: 440,
      width: 800,
      height: 200,
      text: 'Hola',
      fontFamily: 'Inter',
      fontSize: 96,
      color: '#FFFFFF',
      align: 'center',
    },
    {
      id: 'banda',
      type: 'shape',
      shape: 'rectangle',
      x: 0,
      y: 930,
      width: 1080,
      height: 100,
      fill: '#000000',
      anchor: { x: 'stretch', y: 'bottom' },
    },
  ]);

describe('adaptScale', () => {
  it('es el factor con el que el lienzo de origen cabe entero en el de destino', () => {
    expect(adaptScale(CANVAS_SIZES['1:1'], CANVAS_SIZES['9:16'])).toBe(1);
    expect(adaptScale(CANVAS_SIZES['1:1'], CANVAS_SIZES['16:9'])).toBe(1);
    expect(adaptScale(CANVAS_SIZES['9:16'], CANVAS_SIZES['1:1'])).toBe(0.5625);
    expect(adaptScale(CANVAS_SIZES['4:5'], CANVAS_SIZES['1:1'])).toBe(0.8);
  });
});

describe('adaptDocument', () => {
  it('de cuadrado a vertical: cada capa sigue la regla de su anclaje', () => {
    const vertical = adaptDocument(square(), '9:16');
    expect(vertical.canvas).toEqual({ aspectRatio: '9:16', width: 1080, height: 1920, backgroundColor: '#FFFFFF' });

    // stretch: el fondo sigue llenando el lienzo.
    expect(box(vertical, 'fondo')).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    // left/top: misma distancia a la esquina superior izquierda, mismo tamaño.
    expect(box(vertical, 'logo')).toEqual({ x: 60, y: 40, width: 200, height: 100 });
    // right/bottom: misma distancia a la esquina inferior derecha (50 y 30).
    expect(box(vertical, 'sello')).toEqual({ x: 880, y: 1740, width: 150, height: 150 });
    // center: el centro sigue en el centro.
    expect(box(vertical, 'titular')).toEqual({ x: 140, y: 860, width: 800, height: 200 });
    // stretch en horizontal y bottom en vertical: banda a todo el ancho, pegada abajo.
    expect(box(vertical, 'banda')).toEqual({ x: 0, y: 1770, width: 1080, height: 100 });
  });

  it('de vertical a cuadrado: todo encoge con el mismo factor y conserva sus márgenes', () => {
    const vertical = adaptDocument(square(), '9:16');
    const back = adaptDocument(vertical, '1:1');
    const s = 0.5625;

    expect(box(back, 'fondo')).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
    expect(box(back, 'logo')).toEqual({ x: 60 * s, y: 40 * s, width: 200 * s, height: 100 * s });
    // Margen derecho 50 e inferior 30, escalados.
    expect(box(back, 'sello')).toEqual({
      x: 1080 - 50 * s - 150 * s,
      y: 1080 - 30 * s - 150 * s,
      width: 150 * s,
      height: 150 * s,
    });
    // El titular sigue centrado, más pequeño, y su letra encoge igual.
    expect(box(back, 'titular')).toEqual({ x: 540 - 400 * s, y: 540 - 100 * s, width: 800 * s, height: 200 * s });
    const titular = back.pages[0]!.layers.find((l) => l.id === 'titular')!;
    expect(titular.type === 'text' && titular.fontSize).toBe(96 * s);
    // Trazo y radio de las esquinas también.
    const sello = back.pages[0]!.layers.find((l) => l.id === 'sello')!;
    expect(sello.type === 'shape' && [sello.stroke?.width, sello.cornerRadius]).toEqual([8 * s, 16 * s]);
  });

  it('de cuadrado a horizontal: los márgenes laterales se conservan y el centro se desplaza', () => {
    const wide = adaptDocument(square(), '16:9');
    expect(box(wide, 'fondo')).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(box(wide, 'logo')).toEqual({ x: 60, y: 40, width: 200, height: 100 });
    expect(box(wide, 'sello')).toEqual({ x: 1720, y: 900, width: 150, height: 150 });
    expect(box(wide, 'titular')).toEqual({ x: 560, y: 440, width: 800, height: 200 });
    expect(box(wide, 'banda')).toEqual({ x: 0, y: 930, width: 1920, height: 100 });
  });

  it('no cambia el giro, la opacidad, el orden, el contenido ni el texto de la publicación', () => {
    const original = { ...square(), copy: { ...square().copy, caption: 'Pie', hashtags: ['uno'] } };
    const adapted = adaptDocument(original, '4:5');

    expect(adapted.pages[0]!.layers.map((l) => l.id)).toEqual(original.pages[0]!.layers.map((l) => l.id));
    expect(adapted.copy).toEqual(original.copy);
    expect(adapted.schemaVersion).toBe(original.schemaVersion);
    const sello = adapted.pages[0]!.layers.find((l) => l.id === 'sello')!;
    expect([sello.rotation, sello.opacity, sello.anchor]).toEqual([15, 0.8, { x: 'right', y: 'bottom' }]);
    const fondo = adapted.pages[0]!.layers.find((l) => l.id === 'fondo')!;
    expect(fondo.type === 'image' && [fondo.source, fondo.focus, fondo.fit]).toEqual([
      { kind: 'asset', assetId: ASSET },
      { x: 0.3, y: 0.7 },
      'cover',
    ]);
    const titular = adapted.pages[0]!.layers.find((l) => l.id === 'titular')!;
    expect(titular.type === 'text' && [titular.text, titular.fontFamily, titular.color, titular.align]).toEqual([
      'Hola',
      'Inter',
      '#FFFFFF',
      'center',
    ]);
  });

  it('no modifica el documento recibido y devuelve una copia independiente', () => {
    const original = square();
    const snapshot = JSON.parse(JSON.stringify(original));
    const adapted = adaptDocument(original, '9:16');
    adapted.pages[0]!.layers[0]!.anchor.x = 'left';
    adapted.copy.hashtags.push('nuevo');
    expect(original).toEqual(snapshot);
  });

  it('a la misma proporción devuelve el mismo documento, en una copia', () => {
    const original = square();
    const same = adaptDocument(original, '1:1');
    expect(same).toEqual(original);
    expect(same).not.toBe(original);
    expect(same.pages[0]!.layers[0]).not.toBe(original.pages[0]!.layers[0]);
  });

  it('entre cualquier par de proporciones: el resultado es válido y lo que cabía sigue cabiendo', () => {
    for (const from of ASPECT_RATIOS) {
      const { width, height } = CANVAS_SIZES[from];
      const anchorsX = ['left', 'center', 'right', 'stretch'] as const;
      const anchorsY = ['top', 'center', 'bottom', 'stretch'] as const;
      // Una capa por combinación de anclajes, todas dentro del lienzo.
      const layers: LayerInput[] = anchorsX.flatMap((ax, i) =>
        anchorsY.map((ay, j) => ({
          id: `${ax}-${ay}`,
          type: 'shape' as const,
          shape: 'rectangle' as const,
          x: (width * (i + 1)) / 10,
          y: (height * (j + 1)) / 10,
          width: width * 0.45,
          height: height * 0.3,
          anchor: { x: ax, y: ay },
        })),
      );
      const source = documentWith(from, layers);

      for (const to of ASPECT_RATIOS) {
        const adapted = adaptDocument(source, to);
        expect(validateDocument(adapted), `${from} → ${to}`).toEqual({ ok: true, document: adapted });
        for (const layer of adapted.pages[0]!.layers) {
          const label = `${from} → ${to} · ${layer.id}`;
          expect(layer.x, label).toBeGreaterThanOrEqual(-0.001);
          expect(layer.y, label).toBeGreaterThanOrEqual(-0.001);
          expect(layer.x + layer.width, label).toBeLessThanOrEqual(adapted.canvas.width + 0.001);
          expect(layer.y + layer.height, label).toBeLessThanOrEqual(adapted.canvas.height + 0.001);
        }
      }
    }
  });

  it('una capa que no se estira conserva sus proporciones', () => {
    for (const to of ASPECT_RATIOS) {
      const logo = adaptDocument(square(), to).pages[0]!.layers.find((l) => l.id === 'logo')!;
      expect(logo.width / logo.height, to).toBeCloseTo(2, 6);
    }
  });

  it('parte del tamaño real del lienzo, aunque no sea el habitual de su proporción', () => {
    // Mismo cuadrado, dibujado al doble de tamaño lógico.
    const big = documentWith('1:1', []);
    const doubled: ContentDocument = {
      ...big,
      canvas: { ...big.canvas, width: 2160, height: 2160 },
      pages: [{ id: 'p1', name: '', layers: square().pages[0]!.layers.map((l) => ({ ...l, x: l.x * 2, y: l.y * 2, width: l.width * 2, height: l.height * 2 })) }],
    };
    const adapted = adaptDocument(doubled, '9:16');
    expect(adapted.canvas).toMatchObject({ width: 1080, height: 1920 });
    // Igual que adaptar el cuadrado habitual: el tamaño lógico de partida no cambia el resultado.
    const usual = adaptDocument(square(), '9:16');
    for (const id of ['fondo', 'logo', 'sello', 'titular', 'banda']) {
      expect(box(adapted, id), id).toEqual(box(usual, id));
    }
    expect(box(adapted, 'logo')).toEqual({ x: 60, y: 40, width: 200, height: 100 });
  });
});

describe('adaptLayer', () => {
  it('recoloca una capa suelta sin modificarla', () => {
    const [logo] = square().pages[0]!.layers.filter((l) => l.id === 'logo');
    const adapted = adaptLayer(logo!, CANVAS_SIZES['1:1'], CANVAS_SIZES['4:5']);
    expect(adapted).toMatchObject({ id: 'logo', x: 60, y: 40, width: 200, height: 100 });
    expect(adapted).not.toBe(logo);
  });
});
