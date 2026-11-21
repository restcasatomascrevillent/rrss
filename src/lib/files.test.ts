import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES, SOURCE_MIME_TYPES } from '@/config/app';
import {
  assetKindFromMime,
  buildStoragePath,
  sanitizeFileName,
  sha256Hex,
  sourceKindFromMime,
  uploadPercent,
  validateFile,
  xhrUpload,
} from './files';

const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
// Misma forma que exige private.storage_brand_id() en la base de datos.
const PATH_SHAPE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/(media|sources)\/[0-9a-f-]{36}-[a-z0-9.-]+$/;

describe('sanitizeFileName', () => {
  it('quita acentos, espacios y símbolos', () => {
    expect(sanitizeFileName('Foto de Paella (Año 2026).JPG')).toBe('foto-de-paella-ano-2026.jpg');
    expect(sanitizeFileName('  logo  final__v2.PNG')).toBe('logo-final-v2.png');
    expect(sanitizeFileName('informe.final.v2.pdf')).toBe('informe-final-v2.pdf');
    expect(sanitizeFileName('nota. con punto raro')).toBe('nota-con-punto-raro');
  });
  it('neutraliza intentos de salir de la carpeta', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a/b\\c.png')).toBe('c.png');
    expect(sanitizeFileName('..')).toBe('archivo');
  });
  it('nunca devuelve vacío y acota la longitud', () => {
    expect(sanitizeFileName('')).toBe('archivo');
    expect(sanitizeFileName('日本語.png')).toBe('archivo.png');
    expect(sanitizeFileName(`${'a'.repeat(300)}.jpeg`).length).toBeLessThanOrEqual(91);
  });
  it('conserva archivos sin extensión y ocultos', () => {
    expect(sanitizeFileName('LEEME')).toBe('leeme');
    expect(sanitizeFileName('.env')).toBe('env');
  });
});

describe('buildStoragePath', () => {
  it('sigue la forma <organización>/<marca>/<carpeta>/<id>-<nombre>', () => {
    const path = buildStoragePath(ORG, BRAND, 'media', 'Mi Foto.JPG', ID);
    expect(path).toBe(`${ORG}/${BRAND}/media/${ID}-mi-foto.jpg`);
    expect(path).toMatch(PATH_SHAPE);
  });
  it('un nombre malicioso no añade segmentos a la ruta', () => {
    const path = buildStoragePath(ORG, BRAND, 'sources', '../../otra-marca/x.pdf', ID);
    expect(path.split('/')).toHaveLength(4);
    expect(path).toMatch(PATH_SHAPE);
  });
  it('genera un id distinto cada vez', () => {
    expect(buildStoragePath(ORG, BRAND, 'media', 'a.png')).not.toBe(buildStoragePath(ORG, BRAND, 'media', 'a.png'));
  });
});

describe('validateFile', () => {
  it('acepta un archivo permitido', () => {
    expect(validateFile({ name: 'a.jpg', size: 1000, type: 'image/jpeg' })).toBeNull();
  });
  it('rechaza vacíos, demasiado grandes y tipos no admitidos', () => {
    expect(validateFile({ name: 'a.jpg', size: 0, type: 'image/jpeg' })).toMatch(/vacío/);
    expect(validateFile({ name: 'a.mp4', size: MAX_FILE_BYTES + 1, type: 'video/mp4' })).toMatch(/máximo es 50 MB/);
    expect(validateFile({ name: 'a.svg', size: 10, type: 'image/svg+xml' })).toMatch(/no se admite/);
    expect(validateFile({ name: 'a.exe', size: 10, type: '' })).toMatch(/desconocido/);
  });
  it('respeta la lista de tipos que se le pasa', () => {
    expect(validateFile({ name: 'a.mp4', size: 10, type: 'video/mp4' }, SOURCE_MIME_TYPES)).toMatch(/no se admite/);
    expect(validateFile({ name: 'a.pdf', size: 10, type: 'application/pdf' }, SOURCE_MIME_TYPES)).toBeNull();
  });
});

describe('tipos', () => {
  it('deduce el tipo de recurso', () => {
    expect(assetKindFromMime('image/png')).toBe('image');
    expect(assetKindFromMime('video/mp4')).toBe('video');
    expect(assetKindFromMime('audio/mpeg')).toBe('audio');
    expect(assetKindFromMime('application/pdf')).toBe('document');
  });
  it('deduce el tipo de fuente', () => {
    expect(sourceKindFromMime('application/pdf')).toBe('pdf');
    expect(sourceKindFromMime('application/json')).toBe('json');
    expect(sourceKindFromMime('text/plain')).toBe('text');
    expect(sourceKindFromMime('image/webp')).toBe('image');
    expect(sourceKindFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'document',
    );
  });
});

describe('sha256Hex', () => {
  it('calcula la huella conocida de «abc»', async () => {
    const blob = { arrayBuffer: async () => new TextEncoder().encode('abc').buffer } as Blob;
    expect(await sha256Hex(blob)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('uploadPercent', () => {
  it('calcula el porcentaje real y lo acota', () => {
    expect(uploadPercent(0, 100)).toBe(0);
    expect(uploadPercent(50, 200)).toBe(25);
    expect(uploadPercent(199, 200)).toBe(99);
    expect(uploadPercent(300, 200)).toBe(100);
  });
  it('devuelve 0 si no se conoce el total', () => {
    expect(uploadPercent(10, 0)).toBe(0);
    expect(uploadPercent(Number.NaN, 10)).toBe(0);
  });
});

class FakeXhr {
  static last: FakeXhr;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  headers: Record<string, string> = {};
  method = '';
  url = '';
  status = 0;
  responseText = '';
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {}
}

describe('xhrUpload', () => {
  afterEach(() => vi.unstubAllGlobals());
  const options = (onProgress?: (p: number) => void) => ({
    url: 'http://x/upload',
    headers: { Authorization: 'Bearer t' },
    body: new Blob(['abc']),
    onProgress,
  });

  it('informa del progreso por bytes y termina en 100', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const seen: number[] = [];
    const promise = xhrUpload(options((p) => seen.push(p)));
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.headers.Authorization).toBe('Bearer t');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    xhr.status = 200;
    xhr.onload?.();
    await promise;
    expect(seen).toEqual([25, 100, 100]);
  });

  it('rechaza con el mensaje y el estado del servidor', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const promise = xhrUpload(options());
    FakeXhr.last.status = 413;
    FakeXhr.last.responseText = JSON.stringify({ message: 'The object exceeded the maximum allowed size' });
    FakeXhr.last.onload?.();
    await expect(promise).rejects.toEqual({ message: 'The object exceeded the maximum allowed size', statusCode: 413 });
  });

  it('trata un fallo de red como tal', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const promise = xhrUpload(options());
    FakeXhr.last.onerror?.();
    await expect(promise).rejects.toMatchObject({ statusCode: 0 });
  });
});
