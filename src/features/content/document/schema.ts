import { z } from 'zod';

// Formato del documento de una publicación: un lienzo con una o varias páginas
// de capas y el texto que la acompaña. Es propio y no depende de ningún editor ni motor de dibujo: el
// editor, el render del servidor y la IA leen y escriben este mismo JSON.
// Se guarda en content_versions.data; `schemaVersion` permite migrarlo
// (ver migrate.ts) sin migraciones de base de datos.
//
// Versiones:
//   1  lienzo, capas (imagen, texto, logotipo, forma) y texto de la publicación.
//   2  grupos de capas (`groupId`, opcional). Un documento de la 1 se lee igual:
//      sus capas quedan sin grupo.
//   3  desenfoque de las imágenes (`blur`, opcional). Un documento de la 2 se
//      lee igual: sus imágenes quedan nítidas. Se sube la versión para que una
//      aplicación anterior no abra (y al guardar pierda) un desenfoque que no
//      sabe dibujar: dirá que el documento es de una versión más reciente.
//   4  páginas (`pages`, de 1 a 10, cada una con sus capas) en lugar de una sola
//      lista de capas: un carrusel es UNA pieza con varias páginas en UNA
//      versión. Todas comparten el lienzo (misma proporción y color de fondo) y
//      el texto de la publicación (`copy`, uno por pieza). Un documento de la 3
//      se lee como uno de una sola página con las mismas capas.
//   5  ediciones sencillas, todas opcionales y sin cambiar el original: en las
//      imágenes, ajustes de luz y color (`adjust`), girar, voltear, enderezar y
//      recortar (`turn`, `flipX`, `flipY`, `straighten`, `crop`), fondo
//      (`backdrop`) y sombra (`shadow`); en los textos, contorno (`outline`),
//      sombra y fondo del texto (`background`); en las formas, sombra y más
//      figuras (triángulo, estrella, corazón, flecha, destello, globo y línea).
//      Un documento de la 4 se lee igual. Se sube la versión por la misma
//      razón que en la 3: una aplicación anterior no debe abrir (y al guardar
//      perder) lo que no sabe dibujar.
export const DOCUMENT_SCHEMA_VERSION = 5;

/** Desenfoque máximo de una imagen (intensidad, en %). */
export const MAX_IMAGE_BLUR = 100;

// ── Lienzo ───────────────────────────────────────────────────────────────

export const ASPECT_RATIOS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/**
 * Lienzo lógico de cada proporción. Todas las medidas del documento (posición,
 * tamaño, cuerpo de letra, trazo) van en estas unidades. No es la resolución
 * de exportación: quien dibuja escala el lienzo entero al tamaño que necesite.
 */
export const CANVAS_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
};

/** Proporción como número (ancho / alto). */
export function aspectRatioValue(ratio: AspectRatio): number {
  const [w, h] = ratio.split(':').map(Number) as [number, number];
  return w / h;
}

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const color = z.string().regex(HEX_COLOR, 'El color debe tener el formato #RRGGBB');
const coordinate = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().positive().max(100_000);

export const canvasSchema = z
  .object({
    aspectRatio: z.enum(ASPECT_RATIOS),
    width: size,
    height: size,
    backgroundColor: color.default('#FFFFFF'),
  })
  .superRefine((canvas, ctx) => {
    if (Math.abs(canvas.width / canvas.height - aspectRatioValue(canvas.aspectRatio)) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['width'],
        message: 'El tamaño del lienzo no corresponde a su proporción',
      });
    }
  });

// ── Capas ────────────────────────────────────────────────────────────────

/**
 * Anclaje de una capa, por eje. Decide qué se conserva al adaptar el documento
 * a otra proporción (ver adapt.ts):
 *  - `left` / `top`, `right` / `bottom`: la distancia a ese borde.
 *  - `center`: la posición relativa de su centro.
 *  - `stretch`: la distancia relativa a los dos bordes (la capa se estira).
 */
export const ANCHORS_X = ['left', 'center', 'right', 'stretch'] as const;
export const ANCHORS_Y = ['top', 'center', 'bottom', 'stretch'] as const;
export type AnchorX = (typeof ANCHORS_X)[number];
export type AnchorY = (typeof ANCHORS_Y)[number];

const anchorSchema = z
  .object({ x: z.enum(ANCHORS_X).default('center'), y: z.enum(ANCHORS_Y).default('center') })
  .default({});

// Común a todas las capas. `x`, `y` son la esquina superior izquierda de la
// caja sin girar; `rotation`, grados en sentido horario alrededor de su centro.
// El orden de apilado es el del array `layers`: la primera capa queda al fondo.
const layerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'El identificador de la capa solo admite letras, números, guion y guion bajo');

const layerBase = {
  id: layerIdSchema,
  name: z.string().max(120).default(''),
  x: coordinate,
  y: coordinate,
  width: size,
  height: size,
  rotation: z.number().finite().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  anchor: anchorSchema,
  /**
   * Grupo al que pertenece (versión 2). Las capas con el mismo `groupId` se
   * eligen y se mueven juntas en el editor; cada una conserva su posición y su
   * lugar en el apilado. Sin grupo, el campo no está.
   */
  groupId: layerIdSchema.optional(),
  /**
   * La capa la produjo la IA (por ejemplo, un texto redactado con IA). Opcional
   * y sin valor por defecto: los documentos antiguos no cambian. Lo lee la
   * marca de contenido generado con IA (ver content/aiLabel.ts).
   */
  aiGenerated: z.boolean().optional(),
};

/** De dónde sale una imagen: un recurso de la biblioteca o una generación de IA. Nunca la imagen incrustada. */
export const imageSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), assetId: z.string().uuid() }),
  z.object({ kind: z.literal('generation'), generationId: z.string().uuid() }),
]);


// ── Ediciones sencillas (versión 5) ──────────────────────────────────────

/** Filtros rápidos de una foto (ver editor/imageEffects/filters.ts). */
export const IMAGE_FILTERS = ['bw', 'sepia', 'vivid', 'warm', 'cool', 'fade', 'drama'] as const;
export type ImageFilter = (typeof IMAGE_FILTERS)[number];

const slider = z.number().finite().min(-100).max(100);

/**
 * Ajustes de luz y color de una foto: de -100 a 100 (la nitidez, de 0 a 100) y
 * 0 es «sin cambio». Un valor a 0 y sin filtro no se guarda (ver `isNeutralAdjust`).
 */
export const imageAdjustSchema = z.object({
  brightness: slider.default(0),
  contrast: slider.default(0),
  saturation: slider.default(0),
  temperature: slider.default(0),
  sharpness: z.number().finite().min(0).max(100).default(0),
  filter: z.enum(IMAGE_FILTERS).optional(),
});
export type ImageAdjust = z.infer<typeof imageAdjustSchema>;

export function isNeutralAdjust(adjust: ImageAdjust | undefined): boolean {
  return (
    !adjust ||
    (adjust.brightness === 0 &&
      adjust.contrast === 0 &&
      adjust.saturation === 0 &&
      adjust.temperature === 0 &&
      adjust.sharpness === 0 &&
      !adjust.filter)
  );
}

/** Máximo de grados que se puede enderezar una foto, a cada lado. */
export const MAX_STRAIGHTEN = 45;

/** Menor lado de un recorte, como fracción de la foto: así no se llega a un recorte de un píxel. */
export const MIN_CROP_SIDE = 0.02;

/**
 * Recorte de la foto, como fracciones (0–1) de la foto YA girada, volteada y
 * enderezada (no de la original): así vale igual con cualquier resolución.
 */
export const cropSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(MIN_CROP_SIDE).max(1),
    height: z.number().finite().min(MIN_CROP_SIDE).max(1),
  })
  .superRefine((crop, ctx) => {
    if (crop.x + crop.width > 1.0001 || crop.y + crop.height > 1.0001) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'El recorte se sale de la foto' });
    }
  });
export type ImageCrop = z.infer<typeof cropSchema>;

/**
 * Sombra de una capa. Las medidas van en unidades del lienzo, como el resto
 * del documento, y la opacidad de 0 a 1.
 */
export const shadowSchema = z.object({
  color,
  blur: z.number().finite().min(0).max(500),
  offsetX: z.number().finite().min(-2000).max(2000).default(0),
  offsetY: z.number().finite().min(-2000).max(2000).default(0),
  opacity: z.number().min(0).max(1).default(0.4),
});
export type LayerShadow = z.infer<typeof shadowSchema>;

/**
 * Fondo de una imagen, detrás de ella y dentro de su caja: un color, un
 * degradado o la propia foto desenfocada llenando la caja. No referencia
 * ningún recurso más (así la base de datos no tiene nada nuevo que comprobar).
 */
export const backdropSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), color }),
  z.object({
    kind: z.literal('gradient'),
    from: color,
    to: color,
    /** Grados: 0 = de arriba abajo; 90 = de izquierda a derecha. */
    angle: z.number().finite().min(0).max(360).default(180),
  }),
  z.object({
    kind: z.literal('blur'),
    blur: z.number().finite().min(1).max(MAX_IMAGE_BLUR).default(60),
  }),
]);
export type ImageBackdrop = z.infer<typeof backdropSchema>;

const imageLayerSchema = z.object({
  ...layerBase,
  type: z.literal('image'),
  source: imageSourceSchema,
  /** `cover` llena la caja recortando; `contain` muestra la imagen entera. */
  fit: z.enum(['cover', 'contain']).default('cover'),
  /** Punto de interés de la imagen (0–1): lo que no debe perderse al recortar. */
  focus: z.object({ x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5) }).default({}),
  /**
   * Desenfoque (versión 3), de 0 (nítida) a 100. Es una intensidad relativa a
   * la caja de la capa, no píxeles: el radio real es `blurRadius` (ver
   * blurRadius más abajo), así sale igual en el editor, al exportar a
   * cualquier tamaño y en los reels. Sin desenfoque, el campo no está.
   */
  blur: z.number().finite().min(0).max(MAX_IMAGE_BLUR).optional(),
  /** Ajustes de luz y color y filtro rápido (versión 5). Sin ellos, el campo no está. */
  adjust: imageAdjustSchema.optional(),
  /** Giro de la foto en múltiplos de 90° en sentido horario (versión 5). */
  turn: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
  flipX: z.literal(true).optional(),
  flipY: z.literal(true).optional(),
  /** Enderezar: giro fino de la foto en grados, de -45 a 45 (versión 5). */
  straighten: z.number().finite().min(-MAX_STRAIGHTEN).max(MAX_STRAIGHTEN).optional(),
  crop: cropSchema.optional(),
  backdrop: backdropSchema.optional(),
  /** Sombra de lo que se ve de la foto (útil en un recorte sin fondo). */
  shadow: shadowSchema.optional(),
});

/**
 * Radio del desenfoque, en las unidades de la caja: un 100 % equivale al 5 %
 * del lado menor de la capa (en un fondo de 1080 px, 54 px). Lo usan el lienzo,
 * la exportación y el trabajador de reels (que lo calcula igual sobre el vídeo).
 */
export function blurRadius(blur: number | undefined, box: { width: number; height: number }): number {
  if (!blur || blur <= 0) return 0;
  return (Math.min(blur, MAX_IMAGE_BLUR) / 100) * 0.05 * Math.min(Math.abs(box.width), Math.abs(box.height));
}

const textLayerSchema = z.object({
  ...layerBase,
  type: z.literal('text'),
  text: z.string().max(2000),
  fontFamily: z.string().trim().min(1).max(120),
  /** Cuerpo de letra, en unidades del lienzo. */
  fontSize: z.number().finite().positive().max(2000),
  fontWeight: z.number().int().min(100).max(900).default(400),
  italic: z.boolean().default(false),
  color,
  align: z.enum(['left', 'center', 'right']).default('left'),
  /** Interlineado como múltiplo del cuerpo de letra. */
  lineHeight: z.number().min(0.5).max(4).default(1.2),
  /** Contorno de las letras (versión 5). */
  outline: z.object({ color, width: z.number().finite().positive().max(200) }).optional(),
  shadow: shadowSchema.optional(),
  /** Fondo tras el texto, como una etiqueta (versión 5): relleno con margen y esquinas redondeadas. */
  background: z
    .object({
      color,
      opacity: z.number().min(0).max(1).default(1),
      padding: z.number().finite().min(0).max(1000).default(16),
      radius: z.number().finite().min(0).max(1000).default(0),
    })
    .optional(),
});

/** Logotipo de la marca (un recurso de la biblioteca). Se dibuja siempre entero, sin deformar, dentro de su caja. */
const logoLayerSchema = z.object({
  ...layerBase,
  type: z.literal('logo'),
  assetId: z.string().uuid(),
});

/**
 * Figuras: rectángulo y elipse (de siempre) y las sencillas que se usan como
 * pegatinas (versión 5). La línea solo lleva borde.
 */
export const SHAPE_KINDS = ['rectangle', 'ellipse', 'triangle', 'star', 'heart', 'arrow', 'burst', 'speech', 'line'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

const shapeLayerSchema = z.object({
  ...layerBase,
  type: z.literal('shape'),
  shape: z.enum(SHAPE_KINDS),
  fill: color.nullable().default(null),
  stroke: z
    .object({ color, width: z.number().finite().positive().max(1000) })
    .nullable()
    .default(null),
  /** Radio de las esquinas (solo rectángulos). */
  cornerRadius: z.number().finite().min(0).max(100_000).default(0),
  shadow: shadowSchema.optional(),
});

export const layerSchema = z.discriminatedUnion('type', [
  imageLayerSchema,
  textLayerSchema,
  logoLayerSchema,
  shapeLayerSchema,
]);

export const LAYER_TYPES = ['image', 'text', 'logo', 'shape'] as const;
/** Capas como mucho por página. */
export const MAX_LAYERS = 60;

// ── Páginas ──────────────────────────────────────────────────────────────

/**
 * Páginas como mucho en un documento: el techo técnico (el máximo de un
 * carrusel de Instagram al publicar por la API). Lo que admite cada formato lo
 * dice `pageLimits` (pages.ts): un post tiene una, un carrusel de 2 a 10.
 */
export const MAX_PAGES = 10;

/**
 * Una página (una diapositiva de un carrusel). Su orden es el del array
 * `pages`: es el orden en que se publica. Las capas van del fondo al frente.
 */
export const pageSchema = z.object({
  id: layerIdSchema,
  name: z.string().max(120).default(''),
  layers: z.array(layerSchema).max(MAX_LAYERS).default([]),
});

// ── Texto de la publicación ──────────────────────────────────────────────
// Los máximos de aquí son el techo técnico del documento, no los límites de
// ninguna red: esos están en networks.ts y los comprueba el verificador.

const tag = (prefix: string, pattern: RegExp, message: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(new RegExp(`^${prefix}+`), ''))
    .pipe(z.string().min(1, message).max(100).regex(pattern, message));

export const postCopySchema = z.object({
  /** Pie o cuerpo de la publicación. */
  caption: z.string().max(10_000).default(''),
  /** Sin la almohadilla. */
  hashtags: z
    .array(tag('#', /^[\p{L}\p{N}_]+$/u, 'Un hashtag solo admite letras, números y guion bajo'))
    .max(100)
    .default([]),
  /** Sin la arroba. */
  mentions: z
    .array(tag('@', /^[^\s@]+$/, 'Una mención no admite espacios ni arrobas'))
    .max(100)
    .default([]),
  /** Descripción de la imagen para quien no la ve. */
  altText: z.string().max(2000).default(''),
  callToAction: z
    .object({
      label: z.string().trim().max(120).default(''),
      url: z
        .string()
        .trim()
        .max(2000)
        .regex(/^(https?:\/\/\S+)?$/i, 'El enlace debe empezar por http:// o https://')
        .default(''),
    })
    .default({}),
  /**
   * El texto se redactó con IA (lo pone el editor al aplicar una propuesta de
   * la IA). Se mantiene aunque después se retoque: el criterio es conservador.
   */
  aiGenerated: z.boolean().optional(),
});

// ── Documento ────────────────────────────────────────────────────────────

export const contentDocumentSchema = z
  .object({
    schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
    canvas: canvasSchema,
    /** Al menos una. Sin páginas, una vacía. */
    pages: z
      .array(pageSchema)
      .min(1, 'El documento necesita al menos una página')
      .max(MAX_PAGES, `Un documento tiene como mucho ${MAX_PAGES} páginas`)
      .default([{ id: 'p1' }]),
    copy: postCopySchema.default({}),
  })
  .superRefine((document, ctx) => {
    // Los identificadores de las capas son únicos en TODO el documento (no solo
    // en su página): así una capa se encuentra sin saber en qué página está.
    const pages = new Set<string>();
    const seen = new Set<string>();
    document.pages.forEach((page, pageIndex) => {
      if (pages.has(page.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pages', pageIndex, 'id'],
          message: 'Hay dos páginas con el mismo identificador',
        });
      }
      pages.add(page.id);
      page.layers.forEach((layer, index) => {
        if (seen.has(layer.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', pageIndex, 'layers', index, 'id'],
            message: 'Hay dos capas con el mismo identificador',
          });
        }
        seen.add(layer.id);
      });
    });
  });

export type ContentDocument = z.infer<typeof contentDocumentSchema>;
/** Lo que se puede escribir: lo que tiene valor por defecto es opcional. */
export type ContentDocumentInput = z.input<typeof contentDocumentSchema>;
export type Canvas = ContentDocument['canvas'];
export type DocumentPage = ContentDocument['pages'][number];
export type DocumentPageInput = z.input<typeof pageSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type LayerInput = z.input<typeof layerSchema>;
export type LayerType = Layer['type'];
export type ImageLayer = Extract<Layer, { type: 'image' }>;
export type TextLayer = Extract<Layer, { type: 'text' }>;
export type LogoLayer = Extract<Layer, { type: 'logo' }>;
export type ShapeLayer = Extract<Layer, { type: 'shape' }>;
export type ImageSource = z.infer<typeof imageSourceSchema>;
export type LayerAnchor = Layer['anchor'];
export type PostCopy = z.infer<typeof postCopySchema>;
