import { describe, expect, it } from 'vitest';
import { driveFileUrl, isDriveAsset, isDrivePath } from './api';

const ORG = '11111111-1111-4111-8111-111111111111';
const MARCA = '22222222-2222-4222-8222-222222222222';

describe('rutas de los recursos de Google Drive', () => {
  it('reconoce la ruta virtual <org>/<marca>/drive/<id> y nada más', () => {
    expect(isDrivePath(`${ORG}/${MARCA}/drive/1AbC_def-GHIjkl`)).toBe(true);
    expect(isDrivePath(`${ORG}/${MARCA}/foto.jpg`)).toBe(false);
    expect(isDrivePath(`${ORG}/${MARCA}/drive/../../otra`)).toBe(false);
    expect(isDrivePath(`${ORG}/${MARCA}/carpeta/drive/1AbC_def-GHIjkl`)).toBe(false);
  });

  it('un recurso es de Drive por su origen o por su ruta', () => {
    expect(isDriveAsset({ storage_path: `${ORG}/${MARCA}/x.png`, source: 'google_drive' })).toBe(true);
    expect(isDriveAsset({ storage_path: `${ORG}/${MARCA}/drive/1AbC_def-GHIjkl` })).toBe(true);
    expect(isDriveAsset({ storage_path: `${ORG}/${MARCA}/x.png`, source: 'storage' })).toBe(false);
  });

  it('la dirección de la imagen lleva la firma escapada', () => {
    expect(driveFileUrl('v1.k.a/b')).toMatch(/\/functions\/v1\/drive-media\/file\/v1\.k\.a%2Fb$/);
  });
});
