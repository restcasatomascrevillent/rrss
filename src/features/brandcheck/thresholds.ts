// Umbrales por defecto del verificador y su justificación.

/** WCAG 2.x, criterio 1.4.3 (nivel AA): relación de contraste mínima. */
export const WCAG_NORMAL_TEXT = 4.5;
/** WCAG 2.x: texto grande (≥ 18 pt, o ≥ 14 pt en negrita). */
export const WCAG_LARGE_TEXT = 3;
export const LARGE_TEXT_PT = 18;
export const LARGE_BOLD_TEXT_PT = 14;

/**
 * ΔE2000 por debajo del cual un color se considera «de la paleta de marca».
 * Referencias habituales (Sharma et al. 2005; Mokrzycki y Tomczak 2011):
 * ΔE ≈ 1 es la diferencia apenas perceptible, ≤ 2 solo se nota mirando de cerca,
 * 2-10 se percibe de un vistazo pero se reconoce como el mismo color, y a partir
 * de ~11 el ojo ya lo ve como otro color. Se usa 10: tolera las variaciones por
 * luz, sombreado y compresión de una imagen, sin aceptar colores distintos.
 */
export const DEFAULT_PALETTE_MATCH_DELTA_E = 10;

/**
 * Cobertura mínima de la imagen con colores de marca. Un fondo de marca con un
 * texto encima y un par de acentos supera sobradamente el 20 %; por debajo, la
 * pieza «gráfica» apenas usa la paleta. Es heurístico: configurable por marca.
 */
export const DEFAULT_PALETTE_MIN_COVERAGE = 0.2;

/** Colores que ocupan menos del 3 % de la imagen son ruido de la cuantización. */
export const DEFAULT_PALETTE_MIN_WEIGHT = 0.03;

/**
 * Fernández-Huerta es poco fiable en textos cortos; con menos de 20 palabras
 * (la mayoría de pies de red social) no se calcula.
 */
export const DEFAULT_READABILITY_MIN_WORDS = 20;

/** Valor orientativo «normal» de Fernández-Huerta (60-70). Solo informativo. */
export const READABILITY_REFERENCE = 60;
