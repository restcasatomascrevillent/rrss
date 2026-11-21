import type { BrandFontRow, FontFormat, FontStyle } from '@/lib/database.types';
import { formatBytes } from '@/lib/utils';

// Tipografías de la marca: archivos de fuente que sube quien gestiona la marca
// (migración 20261119211000_brand_fonts). Aquí, la lógica pura: qué archivos
// valen, qué familia y peso se deducen del nombre, cómo se ordenan en el
// selector del editor y cómo se registran en el navegador con `FontFace`.

/** Igual que el tope de la tabla `brand_fonts`. */
export const MAX_FONT_BYTES = 5 * 1024 * 1024;

export const FONT_FORMATS: Record<FontFormat, { mime: string; css: string }> = {
  woff2: { mime: 'font/woff2', css: 'woff2' },
  woff: { mime: 'font/woff', css: 'woff' },
  ttf: { mime: 'font/ttf', css: 'truetype' },
  otf: { mime: 'font/otf', css: 'opentype' },
};

export const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';

export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** Formato por la extensión (el tipo que da el navegador a las fuentes no es fiable). */
export function fontFormatFromName(name: string): FontFormat | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension && extension in FONT_FORMATS ? (extension as FontFormat) : null;
}

/** Motivo por el que el archivo no vale, o null. */
export function validateFontFile(file: { name: string; size: number }): string | null {
  if (!fontFormatFromName(file.name)) return `«${file.name}» no es una fuente .woff2, .woff, .ttf ni .otf.`;
  if (file.size === 0) return `«${file.name}» está vacío.`;
  if (file.size > MAX_FONT_BYTES) {
    return `«${file.name}» pesa ${formatBytes(file.size)} y el máximo es ${formatBytes(MAX_FONT_BYTES)}.`;
  }
  return null;
}

const WEIGHT_NAMES: Array<[RegExp, number]> = [
  [/(thin|hairline)/i, 100],
  [/(extra|ultra)[-_ ]?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/(semi|demi)[-_ ]?bold/i, 600],
  [/(extra|ultra)[-_ ]?bold/i, 800],
  [/(black|heavy)/i, 900],
  [/bold/i, 700],
  [/(regular|normal|book|roman)/i, 400],
];

/** Familia, peso y estilo deducidos del nombre del archivo («Lato-BoldItalic.ttf»), para rellenar el formulario. */
export function guessFontFromFileName(name: string): { family: string; weight: number; style: FontStyle } {
  const base = name.replace(/\.[^.]+$/, '');
  const style: FontStyle = /italic|oblique/i.test(base) ? 'italic' : 'normal';
  const [familyPart = base, variant = ''] = base.split(/[-_](?=[^-_]*$)/);
  const hasVariant = /thin|light|regular|normal|book|roman|medium|bold|black|heavy|italic|oblique/i.test(variant);
  const weight = WEIGHT_NAMES.find(([pattern]) => pattern.test(hasVariant ? variant : ''))?.[1] ?? 400;
  const family = (hasVariant ? familyPart : base)
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[;{}<>"\\]/g, '')
    .trim()
    .slice(0, 100);
  return { family: family || 'Tipografía de la marca', weight, style };
}

/**
 * Familias para el selector del editor: primero las de la marca (archivos
 * subidos y las del perfil), luego las genéricas y, si la capa usa otra, esa.
 */
export function orderFontOptions(
  uploaded: readonly string[],
  profile: readonly string[],
  fallback: readonly string[],
  current?: string,
): string[] {
  return [...new Set([...uploaded, ...profile, ...fallback, ...(current ? [current] : [])])];
}

/** Familias distintas de los archivos subidos, en el orden de la lista. */
export function uploadedFamilies(fonts: readonly Pick<BrandFontRow, 'family'>[]): string[] {
  return [...new Set(fonts.map((font) => font.family))];
}

/** Lo mínimo de la API de tipografías del navegador que se usa (en pruebas, un doble). */
export interface FontEnvironment {
  FontFace: new (
    family: string,
    source: ArrayBuffer,
    descriptors?: { weight?: string; style?: string; display?: string },
  ) => { load(): Promise<unknown>; family: string };
  fonts: { add(face: unknown): unknown };
}

export interface FontLoadReport {
  loaded: string[];
  failed: Array<{ id: string; family: string; reason: string }>;
}

/**
 * Registra los archivos de la marca con `FontFace` y espera a que estén
 * cargados. Un archivo que falla no detiene a los demás: se informa y el
 * lienzo usa la de reserva para esa familia. `loaded` guarda lo ya registrado
 * (por id) para no repetir la descarga.
 */
export async function registerBrandFonts(
  fonts: readonly BrandFontRow[],
  download: (font: BrandFontRow) => Promise<ArrayBuffer>,
  env: FontEnvironment,
  registered: Set<string> = new Set(),
): Promise<FontLoadReport> {
  // En paralelo, pero el informe sale en el orden de la lista.
  const outcomes = await Promise.all(
    fonts.map(async (font): Promise<{ id: string; failed?: FontLoadReport['failed'][number] }> => {
      if (registered.has(font.id)) return { id: font.id };
      try {
        const data = await download(font);
        const face = new env.FontFace(font.family, data, {
          weight: String(font.weight),
          style: font.style,
          display: 'block',
        });
        await face.load();
        env.fonts.add(face);
        registered.add(font.id);
        return { id: font.id };
      } catch (error) {
        return {
          id: font.id,
          failed: { id: font.id, family: font.family, reason: error instanceof Error ? error.message : String(error) },
        };
      }
    }),
  );
  const report: FontLoadReport = {
    loaded: outcomes.filter((o) => !o.failed).map((o) => o.id),
    failed: outcomes.flatMap((o) => (o.failed ? [o.failed] : [])),
  };
  return report;
}

/** Entorno real del navegador, si existe `FontFace`. */
export function browserFontEnvironment(): FontEnvironment | null {
  if (typeof window === 'undefined' || typeof window.FontFace === 'undefined' || !window.document.fonts) return null;
  return {
    FontFace: window.FontFace as unknown as FontEnvironment['FontFace'],
    fonts: window.document.fonts as unknown as FontEnvironment['fonts'],
  };
}
