// Esquemas del reel por plantilla.
//
//  * La PLANTILLA es un dato (JSON, con versión): cómo se monta un reel —
//    lienzo, ritmo, movimiento de las fotos, transición, estilo del texto,
//    música y exportación—. No lleva nada de ningún cliente.
//  * El PLAN es lo que propone la IA (o una persona) para una pieza concreta:
//    qué fotos y clips, en qué orden, qué textos y cuándo, y qué música.
//
// El motor (`build.ts`) ejecuta plantilla + plan con FFmpeg. Todo lo que
// depende del tamaño va en proporciones, para poder renderizar la misma
// plantilla a menor resolución (borradores) sin tocarla.
import { z } from 'zod';
import { focalPointSchema, storagePathSchema } from '../handlers/shared.ts';

export const REEL_TEMPLATE_SCHEMA_VERSION = 1;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #RRGGBB');
const evenInt = (min: number, max: number) =>
  z
    .number()
    .int()
    .min(min)
    .max(max)
    .refine((v) => v % 2 === 0, 'Debe ser par');

export const textPositionSchema = z.enum(['top', 'center', 'bottom']);
export const photoMotionSchema = z.enum(['none', 'zoom-in', 'zoom-out', 'pan-right', 'pan-left', 'alternate']);
export const transitionTypeSchema = z.enum(['cut', 'fade', 'fadeblack', 'dissolve', 'slideleft', 'slideup']);

export const reelTemplateSchema = z.strictObject({
  schemaVersion: z.literal(REEL_TEMPLATE_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  /** Lienzo vertical 9:16. Todas las piezas se normalizan a este tamaño y ritmo. */
  canvas: z
    .strictObject({
      width: evenInt(180, 1080).default(1080),
      height: evenInt(320, 1920).default(1920),
      fps: z.number().int().min(15).max(60).default(30),
    })
    .refine((c) => c.width * 16 === c.height * 9, 'El lienzo debe ser 9:16'),
  timing: z.strictObject({
    /** Segundos que dura cada foto si el plan no dice otra cosa. */
    photoSeconds: z.number().min(0.5).max(10).default(2.5),
    /** Máximo que se toma de cada clip si el plan no dice otra cosa. */
    maxClipSeconds: z.number().min(0.5).max(30).default(4),
    /** Duración máxima del reel. Un plan que la supere se rechaza. */
    maxTotalSeconds: z.number().min(3).max(90).default(30),
  }),
  /** Paso de una pieza a la siguiente: corte seco o fundido. */
  transition: z.strictObject({
    type: transitionTypeSchema.default('fade'),
    seconds: z.number().min(0).max(2).default(0.4),
  }),
  /** Movimiento suave sobre las fotos (los clips ya se mueven). */
  photoMotion: z.strictObject({
    type: photoMotionSchema.default('alternate'),
    /** Cuánto se amplía o se desplaza: 0,08 = un 8 %. */
    amount: z.number().min(0).max(0.3).default(0.08),
  }),
  text: z.strictObject({
    /** `default` o el nombre de una tipografía instalada en el trabajador. */
    font: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/)
      .default('default'),
    /** Tamaño de letra como fracción del ancho del lienzo. */
    sizeRatio: z.number().min(0.02).max(0.15).default(0.06),
    color: hexColor.default('#FFFFFF'),
    position: textPositionSchema.default('bottom'),
    /** Distancia al borde como fracción del alto (deja libre la zona de botones de la red). */
    marginRatio: z.number().min(0).max(0.4).default(0.2),
    /** Ancho máximo del bloque de texto como fracción del ancho. */
    maxWidthRatio: z.number().min(0.4).max(1).default(0.84),
    lineHeight: z.number().min(1).max(2).default(1.3),
    /** Caja de color detrás de cada línea. */
    box: z
      .strictObject({
        color: hexColor.default('#000000'),
        opacity: z.number().min(0).max(1).default(0.55),
        /** Relleno de la caja como fracción del tamaño de letra. */
        paddingRatio: z.number().min(0).max(1).default(0.35),
      })
      .nullable()
      .default(null),
    /** Contorno de la letra. */
    outline: z
      .strictObject({
        color: hexColor.default('#000000'),
        /** Grosor como fracción del tamaño de letra. */
        widthRatio: z.number().min(0).max(0.2).default(0.06),
      })
      .nullable()
      .default(null),
    /** Aparición y desaparición del texto. */
    fadeSeconds: z.number().min(0).max(1).default(0.25),
  }),
  audio: z.strictObject({
    /** Volumen de la música (atenuada bajo la imagen): 0 a 1. */
    musicVolume: z.number().min(0).max(1).default(0.35),
    /** Volumen del sonido original de los clips. 0 = se silencian. */
    clipVolume: z.number().min(0).max(1).default(0),
    fadeInSeconds: z.number().min(0).max(5).default(0.5),
    fadeOutSeconds: z.number().min(0).max(5).default(1),
  }),
  export: z.strictObject({
    /** Calidad de H.264: menor = mejor y más pesado. */
    crf: z.number().int().min(16).max(32).default(21),
    preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']).default('veryfast'),
    audioBitrateKbps: z.number().int().min(64).max(256).default(128),
  }),
});
export type ReelTemplate = z.output<typeof reelTemplateSchema>;
export type ReelTemplateInput = z.input<typeof reelTemplateSchema>;

/**
 * Desenfoque de la pieza, de 0 (nítida) a 100: la misma escala que `blur` en
 * las imágenes del documento de contenidos (versión 3). El radio es el 5 % del
 * lado menor del lienzo por cada 100 (ver `blurSigma` en build.ts).
 */
const blurSchema = z.number().min(0).max(100).optional();

const mediaItemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('photo'),
    path: storagePathSchema,
    focalPoint: focalPointSchema.optional(),
    /** Segundos en pantalla; por defecto, los de la plantilla. */
    seconds: z.number().min(0.5).max(10).optional(),
    blur: blurSchema,
  }),
  z.strictObject({
    type: z.literal('video'),
    path: storagePathSchema,
    focalPoint: focalPointSchema.optional(),
    /** Segundo del clip en el que se empieza a tomar. */
    startAt: z.number().min(0).default(0),
    /** Segundos que se toman; por defecto, el máximo de la plantilla. */
    seconds: z.number().min(0.5).max(30).optional(),
    blur: blurSchema,
  }),
]);

export const reelPlanSchema = z.strictObject({
  /** Fotos y clips reales, en el orden en que aparecen. */
  media: z.array(mediaItemSchema).min(1).max(20),
  /** Textos superpuestos, con sus tiempos sobre el vídeo final (segundos). */
  texts: z
    .array(
      z
        .strictObject({
          text: z.string().min(1).max(200),
          start: z.number().min(0),
          end: z.number().positive(),
          position: textPositionSchema.optional(),
        })
        .refine((t) => t.end > t.start, 'El texto debe terminar después de empezar'),
    )
    .max(20)
    .default([]),
  /** Música opcional. Si es más corta que el reel, se repite. */
  music: z
    .strictObject({
      path: storagePathSchema,
      startAt: z.number().min(0).default(0),
      /** Volumen; por defecto, el de la plantilla. */
      volume: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** Tipografía de la marca (archivo .ttf u .otf del cubo). Manda sobre la de la plantilla. */
  fontPath: storagePathSchema.regex(/\.(ttf|otf)$/i, 'La tipografía debe ser .ttf u .otf').optional(),
});
export type ReelPlan = z.output<typeof reelPlanSchema>;

// ───────────────────────────── Plan v2 (editor) ─────────────────────────────
//
// El editor de reels (src/features/reels/editor/project.ts) guarda y encarga
// este plan. Lo que en v1 decidía la plantilla para todo el reel (transición,
// estilo del texto, volúmenes) aquí va en cada elemento: la plantilla solo
// rellena los valores de partida. Un plan v1 se migra a v2 al leerlo
// (`migratePlanV1`) y se monta con el mismo motor.

export const REEL_PLAN_V2_MAX_SECONDS = 90;
export const REEL_PLAN_V2_MAX_CLIPS = 30;
export const REEL_PLAN_V2_MAX_TEXTS = 30;
export const REEL_PLAN_V2_MAX_CUES = 200;

const elementIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const fontPathSchema = storagePathSchema.regex(/\.(ttf|otf)$/i, 'La tipografía debe ser .ttf u .otf');

export const transitionSchema = z.strictObject({
  type: transitionTypeSchema,
  seconds: z.number().min(0).max(2),
});
export type ReelTransition = z.output<typeof transitionSchema>;

/** Estilo de un texto o de los subtítulos. Mismas proporciones que el estilo de la plantilla. */
export const textStyleSchema = z.strictObject({
  /** Archivo .ttf/.otf de la marca (lo comprueba la base de datos). Sin él, la tipografía por defecto. */
  fontPath: fontPathSchema.optional(),
  /** Nombre de la familia, solo para la vista previa del navegador. */
  fontFamily: z.string().max(100).optional(),
  sizeRatio: z.number().min(0.02).max(0.15),
  color: hexColor,
  marginRatio: z.number().min(0).max(0.4),
  maxWidthRatio: z.number().min(0.4).max(1),
  lineHeight: z.number().min(1).max(2),
  box: z
    .strictObject({
      color: hexColor,
      opacity: z.number().min(0).max(1),
      paddingRatio: z.number().min(0).max(1),
    })
    // `request_media_job` pasa la petición por jsonb_strip_nulls: «sin franja» llega
    // como campo ausente, no como null. Ausente = null.
    .nullable()
    .default(null),
  outline: z.strictObject({ color: hexColor, widthRatio: z.number().min(0).max(0.2) }).nullable().default(null),
  fadeSeconds: z.number().min(0).max(1),
});
export type ReelTextStyle = z.output<typeof textStyleSchema>;

/** Subtítulo de un clip, en segundos DEL ARCHIVO: sigue sincronizado al recortar o mover el clip. */
export const cueSchema = z
  .strictObject({
    start: z.number().min(0),
    end: z.number().positive(),
    text: z.string().min(1).max(200),
  })
  .refine((c) => c.end > c.start, 'El subtítulo debe terminar después de empezar');
export type ReelCue = z.output<typeof cueSchema>;

const clipBase = {
  id: elementIdSchema,
  path: storagePathSchema,
  focalPoint: focalPointSchema.optional(),
  blur: blurSchema,
  /** Transición que entra desde el elemento anterior (en el primero no cuenta). Por defecto, la de la plantilla. */
  transition: transitionSchema.optional(),
};

export const clipV2Schema = z.discriminatedUnion('type', [
  z.strictObject({
    ...clipBase,
    type: z.literal('photo'),
    /** Segundos en pantalla. */
    seconds: z.number().min(0.5).max(10),
    /** Movimiento de la foto; por defecto, el de la plantilla. */
    motion: z.enum(['none', 'zoom-in', 'zoom-out', 'pan-right', 'pan-left']).optional(),
  }),
  z.strictObject({
    ...clipBase,
    type: z.literal('video'),
    /** Segundo del archivo en el que empieza el tramo. */
    in: z.number().min(0),
    /** Segundo del archivo en el que acaba (se recorta a lo que dure el archivo). */
    out: z.number().positive(),
    /** Volumen del sonido del clip: 0 = silenciado, 1 = original. */
    volume: z.number().min(0).max(1),
    subtitles: z.array(cueSchema).max(REEL_PLAN_V2_MAX_CUES).optional(),
  }),
]);
export type ReelClipV2 = z.output<typeof clipV2Schema>;

export const textV2Schema = z
  .strictObject({
    id: elementIdSchema,
    text: z.string().min(1).max(200),
    start: z.number().min(0),
    end: z.number().positive(),
    position: textPositionSchema,
    style: textStyleSchema,
  })
  .refine((t) => t.end > t.start, 'El texto debe terminar después de empezar');
export type ReelTextV2 = z.output<typeof textV2Schema>;

export const reelPlanV2Schema = z
  .strictObject({
    version: z.literal(2),
    clips: z.array(clipV2Schema).min(1).max(REEL_PLAN_V2_MAX_CLIPS),
    texts: z.array(textV2Schema).max(REEL_PLAN_V2_MAX_TEXTS).default([]),
    /** Cómo se dibujan los subtítulos de los clips. Sin esto (o apagado), no se dibujan. */
    subtitles: z
      .strictObject({ enabled: z.boolean(), position: textPositionSchema, style: textStyleSchema })
      .optional(),
    music: z
      .strictObject({
        path: storagePathSchema,
        startAt: z.number().min(0),
        volume: z.number().min(0).max(1),
        fadeInSeconds: z.number().min(0).max(5),
        fadeOutSeconds: z.number().min(0).max(5),
        /** La licencia es de la marca: queda dicho que se confirmó y con qué nota. */
        license: z.strictObject({ confirmed: z.boolean(), note: z.string().max(300).optional() }).optional(),
      })
      .optional(),
    /** Tipografía por defecto de la marca (la pone la base de datos si hay textos o subtítulos). */
    fontPath: fontPathSchema.optional(),
  })
  .superRefine((plan, ctx) => {
    plan.clips.forEach((clip, index) => {
      if (clip.type !== 'video') return;
      const length = clip.out - clip.in;
      if (length < 0.5 || length > 60) {
        ctx.addIssue({
          code: 'custom',
          path: ['clips', index],
          message: 'El tramo de un clip debe durar entre 0,5 y 60 s',
        });
      }
    });
  });
export type ReelPlanV2 = z.output<typeof reelPlanV2Schema>;
export type ReelPlanV2Input = z.input<typeof reelPlanV2Schema>;

/** Estilo de texto v2 a partir del de la plantilla. */
export function templateTextStyle(template: ReelTemplate, fontPath?: string): ReelTextStyle {
  const t = template.text;
  return {
    ...(fontPath ? { fontPath } : {}),
    sizeRatio: t.sizeRatio,
    color: t.color,
    marginRatio: t.marginRatio,
    maxWidthRatio: t.maxWidthRatio,
    lineHeight: t.lineHeight,
    box: t.box ? { ...t.box } : null,
    outline: t.outline ? { ...t.outline } : null,
    fadeSeconds: t.fadeSeconds,
  };
}

/**
 * Plan v1 → v2, con la plantilla con la que se encargó. Da el MISMO vídeo:
 * mismas duraciones (los clips se recortan después a lo que duren), la
 * transición de la plantilla en cada paso, el estilo de texto de la plantilla
 * y sus volúmenes. Las fotos sin movimiento propio siguen el de la plantilla
 * (también el ciclo de «alternate»).
 */
export function migratePlanV1(plan: ReelPlan, template: ReelTemplate): ReelPlanV2 {
  const transition = { type: template.transition.type, seconds: template.transition.seconds };
  return {
    version: 2,
    clips: plan.media.map((item, index): ReelClipV2 => {
      const base = {
        id: `m${index + 1}`,
        path: item.path,
        ...(item.focalPoint ? { focalPoint: item.focalPoint } : {}),
        ...(item.blur !== undefined ? { blur: item.blur } : {}),
        transition: { ...transition },
      };
      if (item.type === 'photo') {
        return { ...base, type: 'photo', seconds: item.seconds ?? template.timing.photoSeconds };
      }
      const seconds = item.seconds ?? template.timing.maxClipSeconds;
      return {
        ...base,
        type: 'video',
        in: item.startAt,
        out: item.startAt + seconds,
        volume: template.audio.clipVolume,
      };
    }),
    texts: plan.texts.map((text, index) => ({
      id: `t${index + 1}`,
      text: text.text,
      start: text.start,
      end: text.end,
      position: text.position ?? template.text.position,
      style: templateTextStyle(template),
    })),
    ...(plan.music
      ? {
          music: {
            path: plan.music.path,
            startAt: plan.music.startAt,
            volume: plan.music.volume ?? template.audio.musicVolume,
            fadeInSeconds: template.audio.fadeInSeconds,
            fadeOutSeconds: template.audio.fadeOutSeconds,
          },
        }
      : {}),
    ...(plan.fontPath ? { fontPath: plan.fontPath } : {}),
  };
}

const outputSchema = z.strictObject({
  path: storagePathSchema.regex(/\.mp4$/i, 'La salida debe ser .mp4'),
  /** Portada opcional (JPEG) sacada del propio reel. */
  posterPath: storagePathSchema.regex(/\.jpe?g$/i, 'La portada debe ser .jpg').optional(),
  /** Ancho de salida, para borradores más ligeros. Por defecto, el del lienzo. */
  width: evenInt(180, 1080).optional(),
});

const templateRefSchema = z.union([z.strictObject({ id: z.string().min(1).max(60) }), reelTemplateSchema]);

/** Pieza (contenido de formato reel) de la que sale el encargo: solo viaja a la procedencia. */
const contentRefSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  version: z.number().int().positive(),
});

/** Carga solo con el plan v1 (esquema publicado `reel-payload.v1`). */
export const reelPayloadV1Schema = z.strictObject({
  template: templateRefSchema,
  plan: reelPlanSchema,
  output: outputSchema,
});

export const reelPayloadSchema = z.strictObject({
  /** Una plantilla incluida en el trabajador (por su id) o una plantilla completa. */
  template: templateRefSchema,
  /** Plan v2 (con `version: 2`) o v1 (sin versión, se migra al leerlo). */
  plan: z.union([reelPlanV2Schema, reelPlanSchema]),
  content: contentRefSchema.optional(),
  output: outputSchema,
});
export type ReelPayload = z.input<typeof reelPayloadSchema>;

/** Plan de una carga ya validada, siempre en v2. */
export function planAsV2(plan: ReelPlanV2 | ReelPlan, template: ReelTemplate): ReelPlanV2 {
  return 'version' in plan ? plan : migratePlanV1(plan, template);
}
