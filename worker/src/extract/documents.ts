// Texto de documentos: PDF (pdf.js, por medio de `unpdf`) y Word .docx
// (`mammoth`). Extracción determinista, sin IA ni reconocimiento de caracteres:
// un PDF escaneado (solo imágenes) no tiene texto que sacar y se dice.
import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';
import { PermanentError } from '../errors.ts';

/** Páginas como máximo de un PDF: más allá, el texto ya no cabe en el tope de la fuente. */
export const MAX_PDF_PAGES = 300;
/** Tamaño descomprimido máximo de un .docx (contra los «zip bomba»). */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

export interface PdfText {
  text: string;
  pages: number;
  pagesRead: number;
}

export async function extractPdfText(bytes: Uint8Array, maxPages = MAX_PDF_PAGES): Promise<PdfText> {
  let pdf;
  try {
    // pdf.js se queda con el búfer: se le pasa una copia.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') throw new PermanentError('El PDF está protegido con contraseña.');
    throw new PermanentError('El archivo no es un PDF válido o está dañado.');
  }
  try {
    const pagesRead = Math.min(pdf.numPages, maxPages);
    const parts: string[] = [];
    for (let number = 1; number <= pagesRead; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''));
      page.cleanup();
    }
    return { text: parts.join('\n\n'), pages: pdf.numPages, pagesRead };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/**
 * Suma de los tamaños descomprimidos que declara el directorio central de un
 * ZIP, sin descomprimir nada. Null si no parece un ZIP.
 */
export function zipUncompressedSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Fin del directorio central: firma 0x06054b50, en los últimos 64 KiB + 22 bytes.
  const start = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const size = view.getUint32(offset + 24, true);
    // 0xFFFFFFFF = ZIP64: tamaño real en el campo extra. Se trata como enorme.
    total += size === 0xffffffff ? Number.MAX_SAFE_INTEGER : size;
    offset +=
      46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return total;
}

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const size = zipUncompressedSize(bytes);
  if (size === null) throw new PermanentError('El archivo no es un documento de Word (.docx) válido.');
  if (size > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw new PermanentError('El documento de Word ocupa demasiado al descomprimirlo; no se analiza.');
  }
  try {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    return result.value;
  } catch {
    throw new PermanentError('El documento de Word (.docx) está dañado o no se puede leer.');
  }
}
