// Plantillas de reel incluidas en el trabajador: archivos JSON de
// `worker/templates/`, validados al cargar. Añadir una plantilla es añadir un
// archivo, no tocar código.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermanentError } from '../errors.ts';
import { reelTemplateSchema, type ReelTemplate } from './schema.ts';

export const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');

export function loadTemplates(directory: string = TEMPLATES_DIR): Map<string, ReelTemplate> {
  const templates = new Map<string, ReelTemplate>();
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const parsed = reelTemplateSchema.safeParse(JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
    if (!parsed.success) throw new Error(`Plantilla inválida «${file}»: ${parsed.error.message}`);
    if (`${parsed.data.id}.json` !== file) throw new Error(`La plantilla «${file}» debe llamarse como su id`);
    templates.set(parsed.data.id, parsed.data);
  }
  return templates;
}

export function findTemplate(templates: Map<string, ReelTemplate>, id: string): ReelTemplate {
  const template = templates.get(id);
  if (!template) {
    throw new PermanentError(`No existe la plantilla «${id}». Disponibles: ${[...templates.keys()].join(', ')}`);
  }
  return template;
}
