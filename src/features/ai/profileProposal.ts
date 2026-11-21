// Comparación campo a campo entre el perfil vigente y la propuesta de la IA,
// y el perfil que resulta de aceptar unos campos sí y otros no. Puro: sin red
// ni React.
import { brandProfileSchema, parseProfile, type BrandProfileData } from '@/features/brand/profile';

export const PROPOSAL_MAX_SOURCES = 20;
export const PROPOSAL_MAX_CHARS = 400_000;

type Section = keyof BrandProfileData;

export interface ProfileField {
  /** `business.description`, `goals`… */
  id: string;
  section: Section;
  key: string | null;
  label: string;
}

export const SECTION_LABEL: Record<string, string> = {
  business: 'Negocio',
  audience: 'Público',
  goals: 'Objetivos',
  voice: 'Voz',
  visual: 'Identidad visual',
  channels: 'Canales',
  languages: 'Idiomas',
  restrictions: 'Restricciones',
  competitors: 'Competidores',
  references: 'Referencias',
};

const field = (section: Section, key: string | null, label: string): ProfileField => ({
  id: key ? `${section}.${key}` : section,
  section,
  key,
  label,
});

/** Campos que la propuesta puede traer (los del esquema de `profile.proposal`). */
export const PROPOSAL_FIELDS: ProfileField[] = [
  field('business', 'description', 'Descripción del negocio'),
  field('business', 'products', 'Productos y servicios'),
  field('business', 'locations', 'Ubicaciones'),
  field('business', 'valueProps', 'Propuestas de valor'),
  field('audience', 'segments', 'Segmentos de público'),
  field('goals', null, 'Objetivos'),
  field('voice', 'tone', 'Tono'),
  field('voice', 'personality', 'Personalidad'),
  field('voice', 'values', 'Valores'),
  field('voice', 'keyMessages', 'Mensajes clave'),
  field('voice', 'allowedPhrases', 'Expresiones recomendadas'),
  field('voice', 'forbiddenPhrases', 'Expresiones prohibidas'),
  field('visual', 'colors', 'Colores'),
  field('visual', 'fonts', 'Tipografías'),
  field('visual', 'styleNotes', 'Notas de estilo'),
  field('channels', null, 'Canales'),
  field('languages', 'primary', 'Idioma principal'),
  field('languages', 'others', 'Otros idiomas'),
  field('restrictions', 'legal', 'Restricciones legales'),
  field('restrictions', 'advertising', 'Restricciones publicitarias'),
];

export function fieldValue(profile: BrandProfileData, f: ProfileField): unknown {
  const section = profile[f.section] as unknown;
  return f.key ? (section as Record<string, unknown>)[f.key] : section;
}

export function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return value === null || value === undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Quita las filas a medias que el esquema del perfil rechazaría (sin nombre, color mal escrito…). */
function cleanFieldValue(f: ProfileField, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const rows = value.filter(isRecord);
  switch (f.id) {
    case 'business.products':
    case 'audience.segments':
      return rows.filter((r) => str(r.name));
    case 'visual.colors':
      return rows.filter((r) => /^#[0-9a-fA-F]{6}$/.test(str(r.hex)));
    case 'visual.fonts':
      return rows.filter((r) => str(r.family)).map((r) => ({ license: '', ...r }));
    case 'channels':
      return rows.filter((r) => str(r.platform));
    default:
      return value;
  }
}

export type FieldStatus = 'changed' | 'same' | 'empty' | 'invalid';

export interface FieldComparison {
  field: ProfileField;
  current: unknown;
  /** Valor propuesto ya normalizado con el esquema del perfil (o `undefined` si no encaja). */
  proposed: unknown;
  status: FieldStatus;
}

/** Lee el valor propuesto de un campo y lo pasa por el esquema del perfil. */
function proposedValue(proposal: Record<string, unknown>, f: ProfileField): { ok: boolean; value: unknown } {
  const rawSection = proposal[f.section];
  const raw = f.key ? (isRecord(rawSection) ? rawSection[f.key] : undefined) : rawSection;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const cleaned = cleanFieldValue(f, raw);
  const shape = brandProfileSchema.shape[f.section];
  const parsed = shape.safeParse(f.key ? { [f.key]: cleaned } : cleaned);
  if (!parsed.success) return { ok: false, value: undefined };
  const value = f.key ? (parsed.data as Record<string, unknown>)[f.key] : parsed.data;
  return { ok: true, value };
}

export function compareProfiles(current: BrandProfileData, proposal: Record<string, unknown>): FieldComparison[] {
  return PROPOSAL_FIELDS.map((f) => {
    const now = fieldValue(current, f);
    const { ok, value } = proposedValue(proposal, f);
    let status: FieldStatus;
    if (!ok) status = 'invalid';
    else if (isEmptyValue(value)) status = 'empty';
    else if (JSON.stringify(value) === JSON.stringify(now)) status = 'same';
    else status = 'changed';
    return { field: f, current: now, proposed: value, status };
  });
}

/** Selección inicial: lo que rellena un hueco del perfil vigente; lo que lo sustituye, lo decide la persona. */
export function defaultSelection(comparisons: FieldComparison[]): Set<string> {
  return new Set(comparisons.filter((c) => c.status === 'changed' && isEmptyValue(c.current)).map((c) => c.field.id));
}

/**
 * Perfil vigente con los campos aceptados de la propuesta. Lo que no se acepta
 * (y lo que la propuesta no trae: logotipos, competidores, referencias) queda igual.
 */
export function applyProposal(
  current: BrandProfileData,
  comparisons: FieldComparison[],
  accepted: ReadonlySet<string>,
): BrandProfileData {
  const next = structuredClone(current) as Record<string, unknown>;
  for (const c of comparisons) {
    if (!accepted.has(c.field.id) || c.status !== 'changed') continue;
    let value = c.proposed;
    if (c.field.id === 'visual.fonts' && Array.isArray(value)) {
      // La propuesta no trae licencias: se conservan las de las tipografías que ya estaban.
      const licenses = new Map(current.visual.fonts.map((font) => [font.family.toLowerCase(), font.license]));
      value = (value as { family: string; license: string }[]).map((font) => ({
        ...font,
        license: font.license || licenses.get(font.family.toLowerCase()) || '',
      }));
    }
    if (c.field.key) next[c.field.section] = { ...(next[c.field.section] as object), [c.field.key]: value };
    else next[c.field.section] = value;
  }
  return parseProfile(next);
}
