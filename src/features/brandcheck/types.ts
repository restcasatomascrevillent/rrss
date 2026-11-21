// Contrato del verificador de marca SIN IA. Lógica pura: sin red, sin base de
// datos, sin interfaz. Regla del producto: no se afirma nada que no se pueda
// comprobar; cada hallazgo lleva el dato medido y el umbral que lo exige.

// ── Entrada ──────────────────────────────────────────────────────────────

/** Texto de la pieza tal y como se publicará. */
export interface PieceText {
  /** Pie completo; puede contener ya #hashtags y @menciones. */
  caption: string;
  /** Hashtags que se añaden aparte del pie (con o sin `#`). Se cuentan junto a los del pie. */
  hashtags?: string[];
  /** Menciones que se añaden aparte del pie (con o sin `@`). */
  mentions?: string[];
  /** Texto alternativo de la imagen. */
  altText?: string;
}

/** Unidad con la que la red cuenta la longitud del texto. */
export type LengthUnit = 'utf16' | 'codepoints' | 'graphemes';

/**
 * Límites de la red de destino. Se pasan como dato (vienen de la tabla de
 * formatos versionada): aquí no se codifica ninguno. `undefined` = se desconoce.
 */
export interface NetworkLimits {
  /** Nombre legible de la red o formato, solo para los mensajes («Instagram»). */
  label?: string;
  maxCaptionLength?: number;
  maxHashtags?: number;
  maxMentions?: number;
  maxAltTextLength?: number;
  /** Cómo cuenta la red los caracteres. Por defecto `utf16` (el más estricto de los habituales). */
  lengthUnit?: LengthUnit;
}

/** Capa de texto de una pieza generada por el producto. Los colores van en hexadecimal. */
export interface TextLayer {
  id: string;
  /** Contenido; si se pasa, también se revisan las palabras vetadas. */
  text?: string;
  /** `#RGB`, `#RRGGBB` o `#RRGGBBAA` (el alfa se mezcla con el fondo). */
  color: string;
  /** `#RGB` o `#RRGGBB` opaco. Sin dato = no se puede comprobar el contraste. */
  background?: string | null;
  /** Tamaño en puntos; sin dato se aplica el criterio de texto normal (el más estricto). */
  fontSizePt?: number;
  bold?: boolean;
  /** Texto exento de contraste según WCAG (logotipos, texto puramente decorativo). */
  exempt?: boolean;
  /** Caja que ocupa en el lienzo (con su giro), en unidades del lienzo. Sin dato no se comprueba la zona segura. */
  bounds?: { left: number; top: number; right: number; bottom: number };
  /** Página en la que está (desde 1), en un documento de varias páginas. */
  page?: number;
}

/** Zona del lienzo que la interfaz de la red no tapa (ver `content/safeZones.ts`). */
export interface SafeArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** `unverified` = cifra orientativa, sin fuente oficial. */
  provenance: 'official' | 'unverified';
}

/** Color de la paleta dominante ya extraída de la imagen. */
export interface PaletteColor {
  hex: string;
  /** Proporción de la imagen que ocupa (0-1). Sin dato, todos pesan igual. */
  weight?: number;
}

/**
 * `graphic` = pieza generada por el producto (plantilla, fondo de marca): se
 * espera que use la paleta. `photo` = fotografía: sus colores no dependen de la marca.
 */
export type ImageKind = 'graphic' | 'photo';

export interface BrandColor {
  name?: string;
  hex: string;
}

export interface EmojiPolicy {
  /** `false` = la marca no quiere emojis. */
  allowed?: boolean;
  /** Máximo de emojis por pieza. */
  max?: number;
}

/**
 * Reglas de marca que el verificador necesita. Se rellenan desde el perfil
 * (`brandRulesFromProfile`). Un campo ausente o vacío significa «el perfil no lo
 * define»: la comprobación se omite con un hallazgo informativo, no se inventa la regla.
 */
export interface BrandRules {
  forbiddenPhrases?: string[];
  brandColors?: BrandColor[];
  requiredHashtags?: string[];
  recommendedHashtags?: string[];
  /** Llamadas a la acción de la marca («reserva tu mesa»); basta con que aparezca una. */
  callsToAction?: string[];
  emojiPolicy?: EmojiPolicy;
}

export interface BrandCheckInput {
  text: PieceText;
  limits: NetworkLimits;
  brand: BrandRules;
  textLayers?: TextLayer[];
  /** La pieza lleva imagen (exige texto alternativo). */
  hasImage?: boolean;
  imageKind?: ImageKind;
  imagePalette?: PaletteColor[];
  /** Zona segura del formato. Sin ella (el formato no la tiene o no aplica a este lienzo), no se comprueba. */
  safeArea?: SafeArea;
  /** Páginas de la pieza y cuántas admite el formato (un carrusel, de 2 a 10). Sin dato no se comprueba. */
  pages?: { count: number; min: number; max: number };
}

/** Umbrales ajustables; los valores por defecto están justificados en `thresholds.ts`. */
export interface BrandCheckOptions {
  /** ΔE2000 máximo para decir que un color «es» de la paleta de marca. */
  paletteMatchDeltaE?: number;
  /** Cobertura mínima (0-1) de la imagen con colores de marca. */
  paletteMinCoverage?: number;
  /** Peso por debajo del cual un color de la paleta se ignora (0-1). */
  paletteMinWeight?: number;
  /** Palabras mínimas para calcular la legibilidad. */
  readabilityMinWords?: number;
}

// ── Salida ───────────────────────────────────────────────────────────────

export type Severity = 'block' | 'warn' | 'info';

/** Identificador estable de cada comprobación (no cambia aunque cambien los textos). */
export type CheckId =
  | 'length'
  | 'hashtags'
  | 'mentions'
  | 'forbidden-phrases'
  | 'brand-hashtags'
  | 'call-to-action'
  | 'contrast'
  | 'safe-zone'
  | 'palette'
  | 'emojis'
  | 'readability'
  | 'alt-text'
  | 'pages';

export type FindingCode =
  | 'LENGTH_EXCEEDED'
  | 'HASHTAGS_EXCEEDED'
  | 'MENTIONS_EXCEEDED'
  | 'NETWORK_LIMIT_UNKNOWN'
  | 'FORBIDDEN_PHRASE'
  | 'BRAND_HASHTAG_MISSING'
  | 'BRAND_HASHTAG_RECOMMENDED_MISSING'
  | 'CALL_TO_ACTION_MISSING'
  | 'CONTRAST_TOO_LOW'
  | 'CONTRAST_UNKNOWN_BACKGROUND'
  | 'TEXT_IN_UNSAFE_ZONE'
  | 'PALETTE_OFF_BRAND'
  | 'EMOJIS_NOT_ALLOWED'
  | 'EMOJIS_EXCEEDED'
  | 'READABILITY_SCORE'
  | 'READABILITY_TOO_SHORT'
  | 'ALT_TEXT_MISSING'
  | 'ALT_TEXT_TOO_LONG'
  | 'PROFILE_DATA_MISSING'
  | 'PAGES_TOO_FEW'
  | 'PAGES_TOO_MANY';

/** A qué parte de la pieza se refiere el hallazgo. */
export type PiecePart = 'caption' | 'hashtags' | 'mentions' | 'altText' | 'textLayer' | 'image' | 'piece';

export interface FindingTarget {
  part: PiecePart;
  /** Capa afectada, si `part` es `textLayer`. */
  layerId?: string;
  /** Posición en el texto de esa parte (índices UTF-16 sobre el original, fin exclusivo). */
  range?: { start: number; end: number };
}

export interface Finding {
  code: FindingCode;
  check: CheckId;
  severity: Severity;
  /** Mensaje en español, listo para mostrar al usuario. */
  message: string;
  /** Dato medido. */
  measured?: number | string | null;
  /** Umbral o regla con la que se compara. */
  threshold?: number | string | null;
  target: FindingTarget;
  /** `true` si la comprobación no pudo ejecutarse por falta de datos (no cuenta como fallo). */
  omitted?: boolean;
}

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface CheckSummary {
  id: CheckId;
  status: CheckStatus;
}

export type Verdict = 'pass' | 'pass_with_warnings' | 'fail';

export interface BrandCheckResult {
  /** `fail` = no apto (hay algún bloqueo); `pass_with_warnings` = apto con avisos. */
  verdict: Verdict;
  counts: Record<Severity, number>;
  /** Hallazgos ordenados: bloqueos, avisos, informativos; dentro de cada grupo, por comprobación y posición. */
  findings: Finding[];
  checks: CheckSummary[];
}
