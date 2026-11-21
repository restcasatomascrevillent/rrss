// Normalización común del texto extraído (PDF, Word, web, texto plano): el
// mismo texto de entrada da siempre el mismo resultado. Sin IA.

/** Tope de caracteres por fuente. La base de datos admite hasta 200 000. */
export const MAX_SOURCE_TEXT_CHARS = 100_000;

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
/** Tabulador, espacio duro y espacios tipográficos (de ancho variable, fino, ideográfico…). */
const ODD_SPACES = new RegExp(
  `[${[
    0x09, 0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x202f,
    0x205f, 0x3000,
  ]
    .map((code) => String.fromCharCode(code))
    .join('')}]+`,
  'g',
);

/** Espacios raros a espacio normal, líneas recortadas y como mucho una línea en blanco seguida. */
export function normalizeText(raw: string): string {
  return (
    raw
      .replace(BOM, '')
      .replace(/\r\n?/g, '\n')
      // Caracteres de control (salvo salto de línea y tabulador) fuera.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(ODD_SPACES, ' ')
      .split('\n')
      .map((line) => line.replace(/ {2,}/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Recorta al tope sin partir una palabra (si se puede) y dice si se ha recortado. */
export function capText(text: string, max = MAX_SOURCE_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (lastBreak > max * 0.9) cut = cut.slice(0, lastBreak);
  // No dejar medio par sustituto (emoji) al final.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

/** Texto plano (.txt, .json) en UTF-8; los bytes inválidos se sustituyen, no rompen. */
export function decodePlainText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
