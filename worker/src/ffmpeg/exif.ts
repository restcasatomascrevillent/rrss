// Orientación EXIF de un JPEG (las fotos de móvil casi siempre la traen).
//
// Según la versión, FFmpeg gira o no las imágenes por su cuenta, y las
// recientes además copian la orientación al archivo de salida (que entonces
// se vería girado dos veces). Para no depender de la versión instalada, el
// trabajador lee aquí la orientación, la deja en «normal» en su copia de
// trabajo —así FFmpeg ya no ve nada que girar ni que copiar— y aplica él
// mismo el giro con filtros.
import { open } from 'node:fs/promises';

const HEADER_BYTES = 256 * 1024;

interface OrientationTag {
  orientation: number;
  /** Posición del valor (2 bytes) dentro del archivo. */
  offset: number;
  littleEndian: boolean;
}

/** Busca la etiqueta de orientación en la cabecera de un JPEG. */
export function findJpegOrientation(buffer: Buffer): OrientationTag | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    const marker = buffer[offset + 1]!;
    // Inicio de los datos de imagen: ya no hay más metadatos.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && buffer.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
      const start = offset + 10;
      return orientationFromTiff(buffer.subarray(start, offset + 2 + length), start);
    }
    offset += 2 + length;
  }
  return undefined;
}

function orientationFromTiff(tiff: Buffer, start: number): OrientationTag | undefined {
  if (tiff.length < 14) return undefined;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const littleEndian = order === 'II';
  const u16 = (at: number) => (littleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (littleEndian ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) === 0x0112) {
      const orientation = u16(entry + 8);
      if (orientation < 1 || orientation > 8) return undefined;
      return { orientation, offset: start + entry + 8, littleEndian };
    }
  }
  return undefined;
}

/**
 * Devuelve la orientación EXIF (1–8; 1 si no es JPEG o no la declara) y deja
 * el archivo marcado como «normal». Usar solo sobre la copia de trabajo.
 */
export async function takeJpegOrientation(file: string): Promise<number> {
  const handle = await open(file, 'r+');
  try {
    const chunk = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, HEADER_BYTES, 0);
    const tag = findJpegOrientation(chunk.subarray(0, bytesRead));
    if (!tag || tag.orientation === 1) return 1;
    const normal = Buffer.alloc(2);
    if (tag.littleEndian) normal.writeUInt16LE(1);
    else normal.writeUInt16BE(1);
    await handle.write(normal, 0, 2, tag.offset);
    return tag.orientation;
  } finally {
    await handle.close();
  }
}

/** Filtros de FFmpeg que dejan la imagen como debe verse. */
export function orientationFilters(orientation: number): string[] {
  switch (orientation) {
    case 2:
      return ['hflip'];
    case 3:
      return ['hflip', 'vflip'];
    case 4:
      return ['vflip'];
    case 5:
      return ['transpose=cclock_flip'];
    case 6:
      return ['transpose=clock'];
    case 7:
      return ['transpose=clock_flip'];
    case 8:
      return ['transpose=cclock'];
    default:
      return [];
  }
}

/** `true` si la orientación intercambia ancho y alto. */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}
