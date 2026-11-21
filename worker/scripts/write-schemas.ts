// Escribe los esquemas JSON (JSON Schema) de la plantilla y de la carga del
// reel en `worker/schemas/`. Son lo que se le da a la IA para que proponga un
// plan válido. Se generan desde los esquemas de zod: `npm run schemas`.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  reelPayloadSchema,
  reelPayloadV1Schema,
  reelPlanSchema,
  reelPlanV2Schema,
  reelTemplateSchema,
} from '../src/reel/schema.ts';

export const SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schemas');

export function renderSchemas(): Record<string, string> {
  const render = (schema: z.ZodType) => `${JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2)}\n`;
  return {
    'reel-template.v1.schema.json': render(reelTemplateSchema),
    'reel-plan.v1.schema.json': render(reelPlanSchema),
    'reel-payload.v1.schema.json': render(reelPayloadV1Schema),
    'reel-plan.v2.schema.json': render(reelPlanV2Schema),
    'reel-payload.v2.schema.json': render(reelPayloadSchema),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, content] of Object.entries(renderSchemas())) {
    writeFileSync(path.join(SCHEMAS_DIR, name), content);
    process.stdout.write(`schemas/${name}\n`);
  }
}
