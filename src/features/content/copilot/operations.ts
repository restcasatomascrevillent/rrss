import { z } from 'zod';
import type { PageView } from '../document';

// Contrato de la respuesta del copiloto por voz (`editor.copilot` de
// `ai-generate`, docs/copiloto-voz.md) visto desde el navegador. El servidor ya
// valida y sanea las operaciones; aquí se vuelven a validar con un esquema
// ESTRICTO antes de que nada toque el documento: una respuesta que no cumpla
// no se aplica (ni una parte).

export const COPILOT_OPS = [
  'add_text',
  'update_text',
  'set_background_image',
  'blur_image',
  'add_logo',
  'move_layer',
  'remove_layer',
  'set_background_color',
] as const;
export const COPILOT_TEXT_STYLES = ['title', 'subtitle', 'body', 'small'] as const;
export const COPILOT_POSITIONS = ['top', 'upper', 'middle', 'lower', 'bottom'] as const;
export const COPILOT_ALIGNS = ['left', 'center', 'right'] as const;
/** Pasos máximos de un movimiento relativo (igual que `MAX_MOVE_STEPS` del servidor). */
export const COPILOT_MAX_MOVE_STEPS = 6;
/** Un paso de movimiento relativo: el 5 % del lado del lienzo. */
export const COPILOT_MOVE_STEP = 0.05;

export type CopilotTextStyle = (typeof COPILOT_TEXT_STYLES)[number];
export type CopilotPosition = (typeof COPILOT_POSITIONS)[number];
export type CopilotAlign = (typeof COPILOT_ALIGNS)[number];

export const copilotOperationSchema = z.strictObject({
  op: z.enum(COPILOT_OPS),
  target: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
  text: z.string().max(1000).nullable(),
  style: z.enum(COPILOT_TEXT_STYLES).nullable(),
  assetId: z.string().uuid().nullable(),
  position: z.enum(COPILOT_POSITIONS).nullable(),
  align: z.enum(COPILOT_ALIGNS).nullable(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  font: z.string().max(120).nullable(),
  blur: z.number().finite().min(0).max(100).nullable(),
  // Movimiento relativo de move_layer, en pasos (un paso = 5 % del lienzo). El
  // servidor solo los manda cuando se usan: sin ellos, null.
  dx: z.number().int().min(-COPILOT_MAX_MOVE_STEPS).max(COPILOT_MAX_MOVE_STEPS).nullable().default(null),
  dy: z.number().int().min(-COPILOT_MAX_MOVE_STEPS).max(COPILOT_MAX_MOVE_STEPS).nullable().default(null),
});
export type CopilotOperation = z.infer<typeof copilotOperationSchema>;

export const copilotResponseSchema = z.strictObject({
  action: z.literal('editor.copilot'),
  generationId: z.string().uuid(),
  operations: z.array(copilotOperationSchema).max(20),
  discarded: z
    .array(z.strictObject({ index: z.number().int().min(0), op: z.string().max(40), reason: z.string().max(300) }))
    .max(40),
  note: z.string().max(300),
});
export type CopilotResponse = z.infer<typeof copilotResponseSchema>;

/** Valida la respuesta del servidor. `null` si no cumple el contrato: no se aplica nada. */
export function parseCopilotResponse(value: unknown): CopilotResponse | null {
  const result = copilotResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Capa tal como se le enseña a la IA: lo justo para referirse a ella. */
export interface CopilotLayerSummary {
  id: string;
  type: 'image' | 'text' | 'logo' | 'shape';
  name?: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked?: boolean;
  blur?: number;
}

/**
 * Estado de la página activa que viaja a la IA (sin direcciones, recursos de
 * otros ni el texto de la publicación): el copiloto solo ve y toca esa página.
 */
export function summarizeDocument(document: Pick<PageView, 'canvas' | 'layers'>): {
  canvas: { aspectRatio: string; width: number; height: number; backgroundColor: string };
  layers: CopilotLayerSummary[];
} {
  return {
    canvas: {
      aspectRatio: document.canvas.aspectRatio,
      width: document.canvas.width,
      height: document.canvas.height,
      backgroundColor: document.canvas.backgroundColor.toUpperCase(),
    },
    layers: document.layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      ...(layer.name ? { name: layer.name } : {}),
      ...(layer.type === 'text' ? { text: layer.text } : {}),
      x: Math.round(layer.x),
      y: Math.round(layer.y),
      width: Math.round(layer.width),
      height: Math.round(layer.height),
      ...(layer.locked ? { locked: true } : {}),
      ...(layer.type === 'image' && layer.blur ? { blur: layer.blur } : {}),
    })),
  };
}

/** Palabras de un texto: minúsculas, sin signos ni espacios repetidos. Las tildes y los números cuentan. */
export function dictationWords(text: string): string {
  return text
    .normalize('NFC')
    .toLocaleLowerCase('es')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * ¿Está el texto en lo dictado? (misma regla que el servidor: cada línea con las
 * mismas palabras y en el mismo orden; se perdonan mayúsculas y puntuación).
 * El navegador lo comprueba otra vez: la IA no redacta.
 */
export function isDictated(text: string, transcript: string): boolean {
  const haystack = ` ${dictationWords(transcript)} `;
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every((line) => {
    const words = dictationWords(line);
    return words !== '' && haystack.includes(` ${words} `);
  });
}

/** Quita las operaciones con texto que no se ha dictado. Devuelve las que quedan y cuántas se han quitado. */
export function keepDictated(
  operations: CopilotOperation[],
  transcript: string,
): { operations: CopilotOperation[]; removed: number } {
  const kept = operations.filter((op) => op.text === null || isDictated(op.text, transcript));
  return { operations: kept, removed: operations.length - kept.length };
}
