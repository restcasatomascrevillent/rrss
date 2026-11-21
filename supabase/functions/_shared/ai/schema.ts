// Esquemas de salida estructurada: validación propia y versión «para el proveedor».
//
// Los proveedores garantizan la forma del JSON solo con un subconjunto de JSON
// Schema (en Anthropic no valen `minLength`, `maxLength`, `maximum`, `maxItems`
// ni `minItems` mayor que 1, y ni un rechazo ni un corte por longitud cumplen
// el esquema). Por eso:
//   * al proveedor se le envía el esquema sin esas restricciones (`toProviderSchema`);
//   * la respuesta se valida SIEMPRE aquí con el esquema completo (`validateJson`).
//
// Subconjunto admitido: `type` (también lista de tipos), `enum`, `properties`,
// `required`, `additionalProperties: false`, `items`, `minItems`, `maxItems`,
// `minLength`, `maxLength`, `minimum`, `maximum` y `pattern`. Sin dependencias.
import type { Json, JsonSchema } from './contract.ts';

/** Restricciones que el proveedor no admite y que solo se comprueban aquí. */
const LOCAL_ONLY_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'maxItems']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copia del esquema que cualquier proveedor acepta en modo estricto. */
export function toProviderSchema(schema: JsonSchema): JsonSchema {
  const copy: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined || LOCAL_ONLY_KEYWORDS.has(key)) continue;
    if (key === 'minItems') {
      // Solo se admiten 0 y 1.
      if (typeof value === 'number' && value >= 1) copy.minItems = 1;
    } else if (key === 'properties' && isObject(value)) {
      const properties: { [name: string]: Json } = {};
      for (const [name, child] of Object.entries(value)) {
        properties[name] = isObject(child) ? (toProviderSchema(child as JsonSchema) as Json) : (child as Json);
      }
      copy.properties = properties;
    } else if (key === 'items' && isObject(value)) {
      copy.items = toProviderSchema(value as JsonSchema) as Json;
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

/**
 * Comprueba un valor contra un esquema. Devuelve los incumplimientos (ruta y
 * motivo); lista vacía si cumple. Los mensajes no incluyen el valor recibido:
 * acaban en el registro de generaciones.
 */
export function validateJson(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const problems: string[] = [];
  const expected = schema.type;
  if (typeof expected === 'string' || Array.isArray(expected)) {
    const types = (Array.isArray(expected) ? expected : [expected]).filter((t): t is string => typeof t === 'string');
    if (!types.some((type) => matchesType(value, type))) {
      return [`${path}: se esperaba ${types.join(' o ')} y llegó ${typeOf(value)}`];
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${path}: valor fuera de la lista permitida`);
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) problems.push(`${path}: texto demasiado corto`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) problems.push(`${path}: texto demasiado largo`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${path}: no tiene el formato esperado`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${path}: número demasiado bajo`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${path}: número demasiado alto`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push(`${path}: faltan elementos`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push(`${path}: sobran elementos`);
    if (isObject(schema.items)) {
      value.forEach((item, index) => {
        problems.push(...validateJson(item, schema.items as JsonSchema, `${path}[${index}]`));
      });
    }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string' && !(name in value)) problems.push(`${path}.${name}: falta`);
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (isObject(childSchema)) problems.push(...validateJson(child, childSchema as JsonSchema, `${path}.${name}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${name}: campo no previsto`);
    }
  }

  return problems;
}

/**
 * Lee el texto del modelo como JSON y lo valida. Nunca lanza: devuelve el
 * valor o los motivos por los que no sirve.
 */
export function parseStructuredOutput(
  text: unknown,
  schema: JsonSchema,
): { ok: true; value: Json } | { ok: false; problems: string[] } {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, problems: ['$: respuesta vacía'] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['$: la respuesta no es JSON'] };
  }
  const problems = validateJson(value, schema);
  return problems.length === 0 ? { ok: true, value: value as Json } : { ok: false, problems: problems.slice(0, 10) };
}
