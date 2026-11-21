import { ASPECT_RATIOS, aspectRatioValue, type AspectRatio } from './document/schema';

// Especificaciones de cada red y formato: medidas, proporciones y límites de
// texto, hashtags y menciones. Salen de docs/investigacion-fase2/06-verificador-y-formatos.md
// (§1) y de ningún otro sitio: lo que el informe no tiene, aquí no está. Un
// campo ausente significa «no lo sabemos», no «no hay límite».
//
// Cada dato lleva su procedencia:
//   official    leído en la documentación oficial de la red
//   unverified  solo en fuentes secundarias; orientativo
// Al revisar una cifra: cambiarla aquí, con su fuente, y actualizar la fecha.

/** Fecha en que se consultaron las fuentes. */
export const NETWORK_SPECS_REVIEWED_ON = '2026-11-16';

export type SpecProvenance = 'official' | 'unverified';

export interface Sourced<T> {
  value: T;
  provenance: SpecProvenance;
  /** Página de la que sale el dato. */
  source: string;
  /** Matices que conviene conocer: a qué aplica, fuentes en conflicto… */
  note?: string;
}

export interface Range {
  min?: number;
  max?: number;
}
export interface FileSize {
  amount: number;
  unit: 'KB' | 'MB' | 'GB';
}
export interface PixelSize {
  width: number;
  height: number;
}
export interface TextLimit {
  maxLength: number;
  /** Cómo cuenta la red: caracteres, o unidades UTF-16 (un emoji puede contar dos). */
  unit: 'characters' | 'utf16';
}
export interface Truncation {
  /** Caracteres visibles antes de «ver más». */
  characters: number;
  context?: 'desktop' | 'mobile';
}

export interface ImageSpec {
  fileTypes?: Sourced<string[]>;
  /** Proporción admitida, como ancho / alto. */
  aspectRatio?: Sourced<Range>;
  recommendedAspectRatio?: Sourced<string>;
  widthPx?: Sourced<Range>;
  recommendedSizePx?: Sourced<PixelSize>;
  maxResolution?: Sourced<string>;
  minFileSize?: Sourced<FileSize>;
  maxFileSize?: Sourced<FileSize>;
}

export interface VideoSpec {
  fileTypes?: Sourced<string[]>;
  /** Proporción admitida, como ancho / alto. */
  aspectRatio?: Sourced<Range>;
  recommendedAspectRatio?: Sourced<string>;
  widthPx?: Sourced<Range>;
  /** Límites de cualquiera de los dos lados. */
  sidePx?: Sourced<Range>;
  minSizePx?: Sourced<PixelSize>;
  maxSizePx?: Sourced<PixelSize>;
  recommendedSizePx?: Sourced<PixelSize>;
  maxResolution?: Sourced<string>;
  frameRate?: Sourced<Range>;
  durationSeconds?: Sourced<Range>;
  maxFileSize?: Sourced<FileSize>;
}

export interface TextSpec {
  /** Pie, descripción o cuerpo de la publicación. */
  caption?: Sourced<TextLimit>;
  title?: Sourced<TextLimit>;
  truncation?: Sourced<Truncation>[];
  maxHashtags?: Sourced<number>;
  maxMentions?: Sourced<number>;
  altText?: Sourced<TextLimit>;
  altTextSupported?: Sourced<boolean>;
  /** Llamadas a la acción que admite la red (valores de su API). */
  callToActions?: Sourced<string[]>;
}

export type NetworkId =
  'instagram' | 'facebook' | 'tiktok' | 'linkedin' | 'x' | 'youtube' | 'pinterest' | 'google_business';
export type MediaKind = 'image' | 'video';

export interface NetworkFormatSpec {
  /** Identificadores que se guardan en content_items.network y .format. */
  network: NetworkId;
  format: string;
  label: string;
  /** Qué admite el formato; el primero es el habitual. */
  media: MediaKind[];
  /** Número máximo de elementos (carruseles). */
  maxItems?: Sourced<number>;
  image?: ImageSpec;
  video?: VideoSpec;
  text: TextSpec;
  /** Reglas sin cifra que el informe recoge. */
  notes?: Sourced<string>[];
  /**
   * Zona que la interfaz de la red puede tapar (nombre, botones, pie…), para
   * un lienzo de la proporción indicada. Ninguna red publica la cifra: todas
   * son orientativas.
   */
  safeZone?: Sourced<SafeZoneSpec>;
}

/** Márgenes que tapa la interfaz, como fracción del lado del lienzo (0–1). */
export interface SafeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SafeZoneSpec {
  /** Proporción del lienzo a la que se refieren los márgenes. */
  ratio: AspectRatio;
  insets: SafeInsets;
}

export const NETWORKS: { id: NetworkId; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'pinterest', label: 'Pinterest' },
  { id: 'google_business', label: 'Perfil de Empresa de Google' },
];

const official = <T>(value: T, source: string, note?: string): Sourced<T> => ({
  value,
  provenance: 'official',
  source,
  ...(note ? { note } : {}),
});
const unverified = <T>(value: T, source: string, note?: string): Sourced<T> => ({
  value,
  provenance: 'unverified',
  source,
  ...(note ? { note } : {}),
});

const IG_MEDIA = 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media';
const IG_TRUNCATION = 'https://www.sendible.com/insights/instagram-character-limit';
const FB_REELS = 'https://developers.facebook.com/docs/video-api/guides/reels-publishing';
const FB_PAGES = 'https://developers.facebook.com/docs/pages-api/posts';
const TIKTOK_MEDIA = 'https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide';
const TIKTOK_POST = 'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post';
const LINKEDIN_POSTS = 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api';
const LINKEDIN_LIMITS = 'https://eden.so/blog/linkedin-character-limits/';
const X_MEDIA = 'https://docs.x.com/x-api/media/quickstart/best-practices';
const YOUTUBE_SHORTS = 'https://support.google.com/youtube/answer/10059070';
const PINTEREST_SPECS = 'https://help.pinterest.com/business/article/pinterest-product-specs';
const GBP_API = 'https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts';
const GBP_MEDIA = 'https://www.ayrshare.com/docs/media-guidelines/google-business-profile.md';

// Zonas seguras del vídeo vertical: no hay cifra oficial (informe 06, «Zonas
// seguras en vídeo vertical»). La más citada se atribuye a la guía de reels de
// Meta: 14 % arriba, 35 % abajo y ~6 % por lado en 1080×1920. El informe propone
// una sola caja conservadora para todo vídeo vertical y avisar de que es orientativa.
const SAFE_ZONE_SOURCE = 'https://www.hopperhq.com/blog/instagram-reel-size/';
const VERTICAL_INSETS: SafeZoneSpec = { ratio: '9:16', insets: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 } };
const metaSafeZone = unverified(
  VERTICAL_INSETS,
  SAFE_ZONE_SOURCE,
  'Cifra atribuida a la guía de reels de Meta por una fuente secundaria; orientativa.',
);
const verticalSafeZone = unverified(
  VERTICAL_INSETS,
  SAFE_ZONE_SOURCE,
  'Sin cifra propia de esta red: se usa la caja conservadora del vídeo vertical que propone el informe (atribuida a Meta); orientativa.',
);

const PINTEREST_NOTE = 'Cifra de la página oficial de anuncios; aplicarla a pines orgánicos está sin verificar.';

// El pie de Instagram es el mismo en publicación y reel.
const instagramCaption = {
  caption: official<TextLimit>({ maxLength: 2200, unit: 'characters' }, IG_MEDIA),
  maxHashtags: official(30, IG_MEDIA),
  maxMentions: official(20, IG_MEDIA),
};

export const FORMAT_SPECS: NetworkFormatSpec[] = [
  {
    network: 'instagram',
    format: 'post',
    label: 'Publicación',
    media: ['image'],
    image: {
      fileTypes: official(['JPEG'], IG_MEDIA),
      widthPx: official({ min: 320, max: 1440 }, IG_MEDIA),
      aspectRatio: official({ min: 4 / 5, max: 1.91 }, IG_MEDIA, 'De 4:5 a 1,91:1.'),
      maxFileSize: official({ amount: 8, unit: 'MB' }, IG_MEDIA),
    },
    text: {
      ...instagramCaption,
      altText: official(
        { maxLength: 1000, unit: 'characters' },
        IG_MEDIA,
        'Solo en imagen única o imagen dentro de un carrusel. La aplicación recomienda 100: fuentes en conflicto.',
      ),
      truncation: [unverified({ characters: 125 }, IG_TRUNCATION)],
    },
    notes: [official('Máximo 3 colaboradores.', IG_MEDIA)],
  },
  {
    network: 'instagram',
    format: 'carousel',
    label: 'Carrusel',
    media: ['image', 'video'],
    maxItems: official(20, IG_MEDIA),
    text: {},
    notes: [
      official('Los reels no entran en carruseles.', IG_MEDIA),
      official('El texto alternativo no se admite en los vídeos del carrusel.', IG_MEDIA),
    ],
  },
  {
    network: 'instagram',
    format: 'reel',
    label: 'Reel',
    media: ['video'],
    video: {
      fileTypes: official(['MP4', 'MOV'], IG_MEDIA),
      frameRate: official({ min: 23, max: 60 }, IG_MEDIA),
      aspectRatio: official(
        { min: 0.01, max: 10 },
        IG_MEDIA,
        'De 0,01:1 a 10:1. La misma página da 0,1:1 como mínimo para historias: fuentes en conflicto.',
      ),
      recommendedAspectRatio: official('9:16', IG_MEDIA),
      widthPx: official({ max: 1920 }, IG_MEDIA),
      durationSeconds: official({ min: 3, max: 900 }, IG_MEDIA),
      maxFileSize: official({ amount: 300, unit: 'MB' }, IG_MEDIA),
    },
    text: { ...instagramCaption, altTextSupported: official(false, IG_MEDIA) },
    notes: [official('Portada en JPEG de 8 MB como máximo.', IG_MEDIA)],
    safeZone: metaSafeZone,
  },
  {
    network: 'instagram',
    format: 'story',
    label: 'Historia',
    media: ['image', 'video'],
    image: {
      fileTypes: official(['JPEG'], IG_MEDIA),
      recommendedAspectRatio: official('9:16', IG_MEDIA),
      maxFileSize: official({ amount: 8, unit: 'MB' }, IG_MEDIA),
    },
    video: {
      recommendedAspectRatio: official('9:16', IG_MEDIA),
      durationSeconds: official({ min: 3, max: 60 }, IG_MEDIA),
      maxFileSize: official({ amount: 100, unit: 'MB' }, IG_MEDIA),
    },
    text: {},
    notes: [official('Sin colaboradores.', IG_MEDIA)],
    safeZone: metaSafeZone,
  },
  {
    network: 'facebook',
    format: 'reel',
    label: 'Reel',
    media: ['video'],
    video: {
      fileTypes: official(['MP4'], FB_REELS),
      aspectRatio: official({ min: 9 / 16, max: 9 / 16 }, FB_REELS, '9:16.'),
      minSizePx: official({ width: 540, height: 960 }, FB_REELS),
      recommendedSizePx: official({ width: 1080, height: 1920 }, FB_REELS),
      frameRate: official({ min: 24, max: 60 }, FB_REELS),
      durationSeconds: official({ min: 3, max: 90 }, FB_REELS, 'Hasta 60 s si va como historia de la página.'),
    },
    text: {},
    notes: [official('La descripción admite hashtags; la guía no indica su límite ni el peso máximo.', FB_REELS)],
    safeZone: metaSafeZone,
  },
  {
    network: 'facebook',
    format: 'page_post',
    label: 'Publicación de página',
    media: ['image', 'video'],
    text: {},
    notes: [official('La guía oficial leída no da límites de texto ni de foto.', FB_PAGES)],
  },
  {
    network: 'tiktok',
    format: 'video',
    label: 'Vídeo',
    media: ['video'],
    video: {
      fileTypes: official(['MP4', 'WebM', 'MOV'], TIKTOK_MEDIA),
      frameRate: official({ min: 23, max: 60 }, TIKTOK_MEDIA),
      sidePx: official({ min: 360, max: 4096 }, TIKTOK_MEDIA),
      durationSeconds: official(
        { max: 600 },
        TIKTOK_MEDIA,
        'Hasta 10 min por API; 3 min para todos los creadores, 5 o 10 según la cuenta.',
      ),
      maxFileSize: official({ amount: 4, unit: 'GB' }, TIKTOK_MEDIA),
    },
    text: {
      caption: official({ maxLength: 2200, unit: 'utf16' }, TIKTOK_POST),
    },
    notes: [official('Los hashtags y las menciones deben ir separados por un espacio.', TIKTOK_POST)],
    safeZone: verticalSafeZone,
  },
  {
    network: 'tiktok',
    format: 'photo',
    label: 'Fotos',
    media: ['image'],
    image: {
      fileTypes: official(['WebP', 'JPEG'], TIKTOK_MEDIA),
      maxResolution: official('1080p', TIKTOK_MEDIA),
      maxFileSize: official({ amount: 20, unit: 'MB' }, TIKTOK_MEDIA, 'Por imagen.'),
    },
    text: {},
  },
  {
    network: 'linkedin',
    format: 'page_post',
    label: 'Publicación de página',
    media: ['image', 'video'],
    text: {
      caption: unverified({ maxLength: 3000, unit: 'characters' }, LINKEDIN_LIMITS),
      truncation: [
        unverified({ characters: 210, context: 'desktop' }, LINKEDIN_LIMITS),
        unverified({ characters: 140, context: 'mobile' }, LINKEDIN_LIMITS),
      ],
    },
    notes: [
      official('El carrusel orgánico no está soportado por la API (solo patrocinado).', LINKEDIN_POSTS),
      official(
        'Las menciones se escriben @[Nombre](urn:li:organization:…) con el nombre exacto, mayúsculas incluidas; los hashtags van en el texto.',
        LINKEDIN_POSTS,
      ),
    ],
  },
  {
    network: 'x',
    format: 'post',
    label: 'Publicación',
    media: ['image', 'video'],
    image: {
      fileTypes: official(['JPG', 'PNG', 'GIF', 'WEBP'], X_MEDIA),
      maxFileSize: official({ amount: 5, unit: 'MB' }, X_MEDIA, 'Los GIF, hasta 15 MB.'),
    },
    video: {
      minSizePx: official({ width: 32, height: 32 }, X_MEDIA),
      maxSizePx: official({ width: 1280, height: 1024 }, X_MEDIA),
      aspectRatio: official({ min: 1 / 3, max: 3 }, X_MEDIA, 'De 1:3 a 3:1.'),
      frameRate: official({ max: 60 }, X_MEDIA),
      durationSeconds: official({ min: 0.5, max: 1200 }, X_MEDIA, 'Cuenta estándar; Premium, hasta 125 min.'),
      maxFileSize: official({ amount: 8, unit: 'GB' }, X_MEDIA, 'Cuenta estándar; Premium, hasta 16 GB.'),
    },
    text: {},
    notes: [official('La página leída no da la longitud del texto ni el número de hashtags.', X_MEDIA)],
  },
  {
    network: 'youtube',
    format: 'short',
    label: 'Short',
    media: ['video'],
    video: {
      maxResolution: official('1080p', YOUTUBE_SHORTS),
      durationSeconds: official({ max: 180 }, YOUTUBE_SHORTS),
    },
    text: {
      title: official({ maxLength: 100, unit: 'characters' }, YOUTUBE_SHORTS),
    },
    notes: [official('Vídeo vertical.', YOUTUBE_SHORTS)],
    safeZone: verticalSafeZone,
  },
  {
    network: 'pinterest',
    format: 'pin',
    label: 'Pin',
    media: ['image', 'video'],
    image: {
      fileTypes: unverified(['PNG', 'JPEG'], PINTEREST_SPECS, PINTEREST_NOTE),
      recommendedAspectRatio: unverified('2:3', PINTEREST_SPECS, PINTEREST_NOTE),
      recommendedSizePx: unverified({ width: 1000, height: 1500 }, PINTEREST_SPECS, PINTEREST_NOTE),
      maxFileSize: unverified(
        { amount: 20, unit: 'MB' },
        PINTEREST_SPECS,
        `Desde el escritorio; 32 MB desde la aplicación. ${PINTEREST_NOTE}`,
      ),
    },
    video: {
      fileTypes: unverified(['MP4', 'MOV', 'M4V'], PINTEREST_SPECS, PINTEREST_NOTE),
      aspectRatio: unverified({ min: 1 / 2, max: 1.91 }, PINTEREST_SPECS, `De 1:2 a 1,91:1. ${PINTEREST_NOTE}`),
      durationSeconds: unverified(
        { min: 4, max: 900 },
        PINTEREST_SPECS,
        `La página da 5 y 15 min según el apartado: fuentes en conflicto. ${PINTEREST_NOTE}`,
      ),
      maxFileSize: unverified({ amount: 2, unit: 'GB' }, PINTEREST_SPECS, PINTEREST_NOTE),
    },
    text: {
      title: unverified(
        { maxLength: 100, unit: 'characters' },
        PINTEREST_SPECS,
        `Se ven los primeros 40, aproximadamente. ${PINTEREST_NOTE}`,
      ),
      caption: unverified({ maxLength: 800, unit: 'characters' }, PINTEREST_SPECS, PINTEREST_NOTE),
    },
  },
  {
    network: 'google_business',
    format: 'post',
    label: 'Publicación',
    media: ['image'],
    image: {
      fileTypes: unverified(['JPG', 'PNG'], GBP_MEDIA),
      recommendedAspectRatio: unverified('4:3', GBP_MEDIA),
      minFileSize: unverified({ amount: 10, unit: 'KB' }, GBP_MEDIA),
      maxFileSize: unverified({ amount: 5, unit: 'MB' }, GBP_MEDIA),
    },
    text: {
      caption: unverified({ maxLength: 1500, unit: 'characters' }, GBP_MEDIA, 'Cifra aproximada.'),
      callToActions: official(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'], GBP_API),
    },
    notes: [official('La API solo admite el medio por dirección web (sourceUrl).', GBP_API)],
  },
];

/** Formatos de una red, en el orden del catálogo. */
export function formatsOf(network: string): NetworkFormatSpec[] {
  return FORMAT_SPECS.filter((spec) => spec.network === network);
}

export function getFormatSpec(network: string, format: string): NetworkFormatSpec | undefined {
  return FORMAT_SPECS.find((spec) => spec.network === network && spec.format === format);
}

/** ¿Existe esa pareja de red y formato en el catálogo? */
export function isKnownTarget(network: string, format: string): boolean {
  return getFormatSpec(network, format) !== undefined;
}

export interface CanvasRatios {
  ratios: AspectRatio[];
  /** Procedencia del dato de la red en que se basa. */
  provenance: SpecProvenance;
}

/**
 * Proporciones del lienzo (1:1, 4:5, 9:16, 16:9) que caben en el margen que la
 * red admite para ese formato. `null` si no se conoce ese margen: no se sabe,
 * que no es lo mismo que «vale cualquiera».
 */
export function allowedCanvasRatios(spec: NetworkFormatSpec, media: MediaKind = spec.media[0]!): CanvasRatios | null {
  const range = media === 'image' ? spec.image?.aspectRatio : spec.video?.aspectRatio;
  if (!range) return null;
  const { min = 0, max = Infinity } = range.value;
  const tolerance = 1e-6;
  return {
    ratios: ASPECT_RATIOS.filter((ratio) => {
      const value = aspectRatioValue(ratio);
      return value >= min - tolerance && value <= max + tolerance;
    }),
    provenance: range.provenance,
  };
}

/** Proporción recomendada por la red, si es una de las del lienzo. `null` si no hay o no es ninguna de ellas. */
export function recommendedCanvasRatio(
  spec: NetworkFormatSpec,
  media: MediaKind = spec.media[0]!,
): { ratio: AspectRatio; provenance: SpecProvenance } | null {
  const recommended = media === 'image' ? spec.image?.recommendedAspectRatio : spec.video?.recommendedAspectRatio;
  const ratio = ASPECT_RATIOS.find((candidate) => candidate === recommended?.value);
  return ratio && recommended ? { ratio, provenance: recommended.provenance } : null;
}
