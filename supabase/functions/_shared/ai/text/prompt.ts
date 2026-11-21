// Piezas comunes a los adaptadores de texto: cómo viaja el material del cliente
// y cuánto se reserva antes de llamar.
import type { AiInput, AiUsage } from '../contract.ts';

/**
 * Unidades de consumo de los modelos de texto. Son los nombres que deben
 * tener precio en la tabla de precios (configuración):
 *   input_tokens              entrada sin caché
 *   output_tokens             salida (incluye el razonamiento, si el modelo razona)
 *   cache_read_input_tokens   entrada leída de la caché de prompts
 *   cache_write_input_tokens  entrada escrita en la caché (solo Anthropic)
 */
export const TEXT_UNITS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_input_tokens',
  cacheWrite: 'cache_write_input_tokens',
} as const;

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export type ContextPart = NonNullable<AiInput['context']>[number];

/**
 * El material del cliente viaja SIEMPRE delimitado, como dato. Si el propio
 * material contiene la etiqueta de cierre, se neutraliza para que no pueda
 * «salirse» del bloque.
 */
export function renderContextPart(part: ContextPart): string {
  const label = part.label.replace(/["<>\s]+/g, ' ').trim();
  const content = part.content.replace(/<\/material/gi, '<\\/material');
  return `<material etiqueta="${label}">\n${content}\n</material>`;
}

/** Material estable primero (mismo orden relativo): es lo que puede ir a la caché. */
export function orderedContext(input: AiInput): { cacheable: ContextPart[]; volatile: ContextPart[] } {
  const parts = input.context ?? [];
  return { cacheable: parts.filter((part) => part.cacheable), volatile: parts.filter((part) => !part.cacheable) };
}

export function maxOutputTokens(input: AiInput): number {
  const value = input.params?.max_output_tokens;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_TOKENS;
}

// Cota superior aproximada, sin llamar al proveedor: un token cada 2,5
// caracteres (el español real ronda 3-4) más un margen fijo por el envoltorio
// y, con salida estructurada, por el esquema y las instrucciones que añade el
// proveedor. No sustituye al recuento del proveedor: solo sirve para reservar.
const CHARS_PER_TOKEN_FLOOR = 2.5;
const BASE_OVERHEAD_TOKENS = 60;
const SCHEMA_OVERHEAD_TOKENS = 400;

const upperTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN_FLOOR);

/**
 * Consumo máximo previsible de una petición de texto. Con `cacheWrites`, el
 * material estable se cuenta como escritura de caché (su precio más alto).
 */
export function estimateTextUsage(input: AiInput, options: { cacheWrites: boolean }): AiUsage {
  const { cacheable, volatile } = orderedContext(input);
  const chars = (parts: ContextPart[]) => parts.reduce((sum, part) => sum + renderContextPart(part).length, 0);
  const schemaChars = input.outputSchema ? JSON.stringify(input.outputSchema.schema).length : 0;

  const fixed =
    upperTokens((input.instructions ?? '').length + input.prompt.length + chars(volatile) + schemaChars) +
    BASE_OVERHEAD_TOKENS +
    (input.outputSchema ? SCHEMA_OVERHEAD_TOKENS : 0);
  const stable = cacheable.length > 0 ? upperTokens(chars(cacheable)) : 0;

  const usage: AiUsage = { [TEXT_UNITS.output]: maxOutputTokens(input) };
  if (options.cacheWrites && stable > 0) {
    usage[TEXT_UNITS.input] = fixed;
    usage[TEXT_UNITS.cacheWrite] = stable;
  } else {
    usage[TEXT_UNITS.input] = fixed + stable;
  }
  return usage;
}
