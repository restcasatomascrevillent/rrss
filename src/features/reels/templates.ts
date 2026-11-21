// Plantillas de reel que ofrece la aplicación.
//
// Fuente única: los archivos JSON de `worker/templates/`, los mismos que carga
// el trabajador. La aplicación los incluye al compilar (Vite) y aquí solo lee
// lo que necesita para elegir y calcular la duración; el esquema completo lo
// valida el trabajador (worker/src/reel/schema.ts), y sus pruebas comprueban
// que cada archivo es válido. Añadir una plantilla es añadir un archivo: la
// ven la aplicación y el trabajador en su siguiente despliegue.
import { z } from 'zod';

const templateSummarySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(1),
  description: z.string().default(''),
  canvas: z
    .object({
      width: z.number().int().positive().default(1080),
      height: z.number().int().positive().default(1920),
      fps: z.number().int().positive().default(30),
    })
    .passthrough(),
  timing: z
    .object({
      photoSeconds: z.number().positive().default(2.5),
      maxClipSeconds: z.number().positive().default(4),
      maxTotalSeconds: z.number().positive().default(30),
    })
    .passthrough(),
  transition: z
    .object({
      type: z.enum(['cut', 'fade', 'fadeblack', 'dissolve', 'slideleft', 'slideup']).default('fade'),
      seconds: z.number().min(0).default(0.4),
    })
    .passthrough(),
  photoMotion: z
    .object({
      type: z.enum(['none', 'zoom-in', 'zoom-out', 'pan-right', 'pan-left', 'alternate']).default('alternate'),
      amount: z.number().min(0).max(0.3).default(0.08),
    })
    .passthrough()
    .default({}),
  // Estilo del texto: el editor lo usa como punto de partida de cada texto nuevo.
  text: z
    .object({
      position: z.enum(['top', 'center', 'bottom']).default('bottom'),
      sizeRatio: z.number().default(0.06),
      color: z.string().default('#FFFFFF'),
      marginRatio: z.number().default(0.2),
      maxWidthRatio: z.number().default(0.84),
      lineHeight: z.number().default(1.3),
      box: z.object({ color: z.string(), opacity: z.number(), paddingRatio: z.number() }).nullable().default(null),
      outline: z.object({ color: z.string(), widthRatio: z.number() }).nullable().default(null),
      fadeSeconds: z.number().default(0.25),
    })
    .passthrough(),
  audio: z
    .object({
      musicVolume: z.number().default(0.35),
      clipVolume: z.number().default(0),
      fadeInSeconds: z.number().default(0.5),
      fadeOutSeconds: z.number().default(1),
    })
    .passthrough()
    .default({}),
  // Exportación (worker/src/reel/schema.ts): para estimar el peso antes de encargar.
  export: z
    .object({
      crf: z.number().int().default(21),
      preset: z.string().default('veryfast'),
      audioBitrateKbps: z.number().int().positive().default(128),
    })
    .passthrough()
    .default({}),
});

export type ReelTemplateSummary = z.infer<typeof templateSummarySchema>;

/** Lee y ordena las plantillas (por nombre). Una plantilla mal formada es un error de compilación de datos: falla. */
export function parseTemplates(files: Record<string, unknown>): ReelTemplateSummary[] {
  return Object.entries(files)
    .map(([file, data]) => {
      const parsed = templateSummarySchema.safeParse(data);
      if (!parsed.success) throw new Error(`Plantilla de reel inválida (${file}): ${parsed.error.message}`);
      return parsed.data;
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

const files = import.meta.glob('../../../worker/templates/*.json', { eager: true, import: 'default' });

export const REEL_TEMPLATES: ReelTemplateSummary[] = parseTemplates(files);
