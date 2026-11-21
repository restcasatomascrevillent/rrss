import { createEmptyDocument, type ImageLayer } from '../document';
import { imageUrlOf, mainImageLayer } from './useImagePalette';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function image(id: string, assetId: string, width: number, height: number, extra: Partial<ImageLayer> = {}) {
  return {
    id,
    type: 'image',
    name: '',
    x: 0,
    y: 0,
    width,
    height,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    anchor: { x: 'center', y: 'center' },
    source: { kind: 'asset', assetId },
    fit: 'cover',
    focus: { x: 0.5, y: 0.5 },
    ...extra,
  } as ImageLayer;
}

describe('imagen de la que se saca la paleta', () => {
  it('es la capa de imagen visible más grande', () => {
    const doc = createEmptyDocument();
    const small = image('pequeña', A, 100, 100);
    const big = image('grande', B, 800, 800);
    const hidden = image('oculta', A, 2000, 2000, { visible: false });
    expect(mainImageLayer({ ...doc, layers: [small, big, hidden] })?.id).toBe('grande');
    expect(mainImageLayer(doc.pages[0]!)).toBeNull();
  });

  it('solo tiene dirección si la imagen es de la biblioteca y ya está firmada', () => {
    const images = new Map([[A, 'https://ejemplo.test/a.jpg']]);
    expect(imageUrlOf(image('x', A, 1, 1), images)).toBe('https://ejemplo.test/a.jpg');
    expect(imageUrlOf(image('x', B, 1, 1), images)).toBeNull();
    expect(imageUrlOf(null, images)).toBeNull();
  });
});
