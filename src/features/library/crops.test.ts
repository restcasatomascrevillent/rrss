import { describe, expect, it } from 'vitest';
import type { MediaJobSummary } from '@/features/reels/plan';
import { buildCropInput, canCrop, cropBox, cropFormat, cropResults, previewPosition } from './crops';

describe('recortes: lógica', () => {
  it('la caja del recorte es la del trabajador: lo más grande con la proporción, centrado y sin salirse', () => {
    const photo = { width: 4000, height: 3000 };
    expect(cropBox(photo, '1:1', { x: 0.5, y: 0.5 })).toEqual({ width: 3000, height: 3000, x: 500, y: 0 });
    // Punto de interés a la izquierda o a la derecha: la caja se pega al borde.
    expect(cropBox(photo, '1:1', { x: 0, y: 0.5 })).toMatchObject({ x: 0 });
    expect(cropBox(photo, '1:1', { x: 1, y: 0.5 })).toMatchObject({ x: 1000 });
    // 16:9 en una foto 4:3: todo el ancho y se recorta en alto.
    expect(cropBox(photo, '16:9', { x: 0.5, y: 0.2 })).toMatchObject({ width: 4000, height: 2250, x: 0, y: 0 });
  });

  it('la vista previa (object-position) enseña la misma caja', () => {
    const photo = { width: 4000, height: 3000 };
    expect(previewPosition(photo, '1:1', { x: 0.5, y: 0.5 })).toBe('50% 50%');
    expect(previewPosition(photo, '1:1', { x: 0.2, y: 0.5 })).toBe('0% 50%');
    expect(previewPosition(photo, '1:1', { x: 0.6, y: 0.5 })).toBe('90% 50%');
  });

  it('el encargo lleva la foto, el punto (entre 0 y 1) y una salida por formato en el formato de la foto', () => {
    expect(buildCropInput('o/b/media/a.png', 'image/png', { x: 1.4, y: -0.2 }, ['1:1', '9:16'])).toEqual({
      source: { path: 'o/b/media/a.png' },
      focalPoint: { x: 1, y: 0 },
      outputs: [
        { aspect: '1:1', width: 1080, format: 'png' },
        { aspect: '9:16', width: 1080, format: 'png' },
      ],
    });
    expect(cropFormat('image/jpeg')).toBe('jpeg');
    expect(cropFormat('image/webp')).toBe('webp');
  });

  it('solo fotos y logotipos en un formato que lee el trabajador', () => {
    expect(canCrop({ kind: 'image', mime_type: 'image/jpeg' })).toBe(true);
    expect(canCrop({ kind: 'logo', mime_type: 'image/png' })).toBe(true);
    expect(canCrop({ kind: 'image', mime_type: 'image/gif' })).toBe(false);
    expect(canCrop({ kind: 'video', mime_type: 'video/mp4' })).toBe(false);
  });

  it('los recortes terminados, con su proporción', () => {
    const job = {
      payload: {
        outputs: [
          { aspect: '1:1', path: 'p1' },
          { aspect: '4:5', path: 'p2' },
        ],
      },
      result: { assets: [{ id: 'a1', path: 'p1' }, { id: 'a2', path: 'p2' }, { path: 'sin-id' }] },
    } as unknown as MediaJobSummary;
    expect(cropResults(job)).toEqual([
      { id: 'a1', aspect: '1:1' },
      { id: 'a2', aspect: '4:5' },
    ]);
    expect(cropResults({ ...job, result: null })).toEqual([]);
  });
});
