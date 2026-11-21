// Piezas comunes de los manejadores de medios: validación de la entrada,
// proporciones de las redes, recorte por punto focal y paso por el almacenamiento.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PermanentError } from '../errors.ts';
import type { MediaTools } from '../ffmpeg/run.ts';
import type { HandlerContext } from '../handler.ts';
import { assertJobPath } from '../storage.ts';

/** Lo que necesitan los manejadores del entorno donde corren. */
export interface MediaDeps {
  tools: MediaTools;
  /** Archivo de la tipografía por defecto para el texto de los vídeos. */
  defaultFontFile?: string;
  /** Carpeta con tipografías instaladas en el trabajador (`<nombre>.ttf` u `.otf`). */
  fontsDir?: string;
}

/** Valida la carga del trabajo. Una carga inválida no se reintenta. */
export function parsePayload<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new PermanentError(`Carga del trabajo inválida: ${issues}`);
  }
  return parsed.data;
}

/** Ruta dentro del cubo: `<organización>/<marca>/<carpeta>/<archivo>`. */
export const storagePathSchema = z.string().min(5).max(600);

/** Punto de interés de la imagen, de 0 a 1 desde la esquina superior izquierda. */
export const focalPointSchema = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type FocalPoint = z.infer<typeof focalPointSchema>;
export const CENTER: FocalPoint = { x: 0.5, y: 0.5 };

/** Proporciones de las redes: cuadrado, retrato, vertical y horizontal. */
export const ASPECTS = { '1:1': [1, 1], '4:5': [4, 5], '9:16': [9, 16], '16:9': [16, 9] } as const;
export const aspectSchema = z.enum(['1:1', '4:5', '9:16', '16:9']);
export type Aspect = z.infer<typeof aspectSchema>;

export const imageFormatSchema = z.enum(['jpeg', 'png', 'webp']);
export type ImageFormat = z.infer<typeof imageFormatSchema>;
export const IMAGE_FORMATS: Record<ImageFormat, { extension: string; contentType: string }> = {
  jpeg: { extension: 'jpg', contentType: 'image/jpeg' },
  png: { extension: 'png', contentType: 'image/png' },
  webp: { extension: 'webp', contentType: 'image/webp' },
};

/** Argumentos de FFmpeg para codificar una imagen fija con la calidad pedida (1–100). */
export function imageEncodeArgs(format: ImageFormat, quality: number): string[] {
  if (format === 'jpeg') {
    // Escala de FFmpeg para JPEG: 2 (mejor) a 31 (peor).
    const qscale = Math.min(31, Math.max(2, Math.round((100 - quality) / 5 + 2)));
    return ['-c:v', 'mjpeg', '-q:v', String(qscale)];
  }
  if (format === 'webp') return ['-c:v', 'libwebp', '-quality', String(quality)];
  return ['-c:v', 'png'];
}

export interface CropBox {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Mayor recorte con la proporción pedida que cabe en la imagen, centrado en
 * el punto focal y sin salirse de los bordes. Con `even`, medidas pares
 * (obligatorio para vídeo H.264).
 */
export function cropToAspect(
  source: { width: number; height: number },
  aspect: Aspect,
  focal: FocalPoint = CENTER,
  even = false,
): CropBox {
  const [aw, ah] = ASPECTS[aspect];
  const snap = (value: number) => (even ? Math.max(2, Math.floor(value / 2) * 2) : Math.max(1, Math.floor(value)));
  let width: number;
  let height: number;
  if (source.width * ah > source.height * aw) {
    height = snap(source.height);
    width = snap((height * aw) / ah);
  } else {
    width = snap(source.width);
    height = snap((width * ah) / aw);
  }
  const place = (size: number, total: number, point: number) =>
    Math.min(Math.max(Math.round(point * total - size / 2), 0), total - size);
  return { width, height, x: place(width, source.width, focal.x), y: place(height, source.height, focal.y) };
}

/** Desplazamiento de recorte como expresión de FFmpeg, para no depender del tamaño de entrada. */
export function focalCropExpr(axis: 'w' | 'h', size: number, point: number): string {
  const total = axis === 'w' ? 'iw' : 'ih';
  return `'min(max(${total}*${point}-${size / 2},0),${total}-${size})'`;
}

/** Baja al disco un archivo del cubo, tras comprobar que es de la marca del trabajo. */
export async function fetchInput(context: HandlerContext, objectPath: string, localName: string): Promise<string> {
  assertJobPath(context.job, objectPath);
  const extension = path
    .extname(objectPath)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');
  const file = path.join(context.workDir, `${localName}${extension}`);
  await context.storage.download(objectPath, file, context.signal);
  return file;
}

/** Sube un resultado al cubo, tras comprobar que la ruta es de la marca del trabajo. */
export async function storeOutput(
  context: HandlerContext,
  localFile: string,
  objectPath: string,
  contentType: string,
): Promise<number> {
  assertJobPath(context.job, objectPath);
  await context.storage.upload(localFile, objectPath, { contentType, signal: context.signal });
  return (await stat(localFile)).size;
}

/** Comprueba pronto todas las rutas de salida, antes de gastar cómputo. */
export function assertOutputPaths(context: HandlerContext, paths: Array<string | undefined>): void {
  for (const objectPath of paths) if (objectPath) assertJobPath(context.job, objectPath);
}

/** Argumentos comunes para exportar H.264 reproducible en cualquier red. */
export function h264Args(options: { crf: number; preset: string }): string[] {
  return [
    '-c:v',
    'libx264',
    '-preset',
    options.preset,
    '-crf',
    String(options.crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];
}
