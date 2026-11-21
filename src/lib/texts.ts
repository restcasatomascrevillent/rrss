// Diccionario de textos para quien usa la aplicación (un dueño de negocio, no
// una persona técnica): actividad, estados, zonas horarias y avisos que antes
// enseñaban nombres de tablas, siglas o formatos («insert en content_comments»,
// «Europe/Madrid», «Exportar JSON», «unidades de cuenta»).
//
// Regla: lo que ve el usuario no lleva nombres de tablas ni de campos, ni siglas
// como UTC o JSON, ni «undefined»/«null». `src/lib/texts.test.ts` lo vigila
// recorriendo estos textos y los de las pantallas. Las explicaciones técnicas
// van plegadas o solo en las pantallas de la agencia (Plataforma).

// ───────────────────────────── Actividad ─────────────────────────────

/** Lo que hizo una acción del registro cuando no hay una frase propia. */
export const ACTIVITY_VERB: Record<string, string> = {
  insert: 'añadió',
  update: 'cambió',
  delete: 'eliminó',
};

/** Qué se tocó, con su artículo, para cada tabla del registro de auditoría. */
export const ACTIVITY_NOUN: Record<string, string> = {
  organizations: 'los datos de la organización',
  organization_members: 'un miembro de la organización',
  brands: 'una marca',
  brand_members: 'un miembro de la marca',
  brand_profiles: 'el perfil de la marca',
  brand_knowledge_sources: 'una fuente de conocimiento',
  brand_fonts: 'una tipografía de la marca',
  media_assets: 'un archivo de la biblioteca',
  invitations: 'una invitación',
  usage_quotas: 'el cupo mensual de IA',
  subscriptions: 'el plan de la organización',
  content_items: 'una publicación',
  content_versions: 'una versión de una publicación',
  content_comments: 'un comentario de una publicación',
  content_requests: 'un encargo',
  content_request_comments: 'un comentario de un encargo',
  campaigns: 'una campaña',
  campaign_plans: 'el plan de una campaña',
  social_accounts: 'una cuenta de red social',
  scheduled_publications: 'una publicación programada',
  drive_connections: 'la conexión con Google Drive',
};

/** Frase para una acción que no tiene redacción propia: nunca enseña el nombre de la tabla. */
export function describeUnknownActivity(action: string, entity: string): string {
  const verb = ACTIVITY_VERB[action];
  const noun = ACTIVITY_NOUN[entity];
  if (verb && noun) return `${verb} ${noun}`;
  return 'hizo un cambio';
}

export const CONTENT_STATUS_TEXT: Record<string, string> = {
  idea: 'idea',
  draft: 'borrador',
  in_review: 'en revisión',
  approved: 'aprobado',
};

export const CAMPAIGN_STATUS_TEXT: Record<string, string> = {
  requested: 'pedida a la agencia',
  proposed: 'con plan por revisar',
  accepted: 'aceptada',
  discarded: 'descartada',
};

/** Recorta un comentario para la línea de actividad. */
export function excerpt(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

// ───────────────────────────── Zonas horarias ─────────────────────────────

/** Las zonas que se usan de verdad, con el nombre que las conoce un dueño. Van primero. */
const COMMON_TIME_ZONES: ReadonlyArray<readonly [string, string]> = [
  ['Europe/Madrid', 'España peninsular y Baleares'],
  ['Atlantic/Canary', 'Canarias'],
  ['Europe/Lisbon', 'Portugal'],
  ['Europe/London', 'Reino Unido'],
  ['Europe/Paris', 'Francia'],
  ['Europe/Berlin', 'Alemania'],
  ['Europe/Rome', 'Italia'],
  ['America/Mexico_City', 'México (Ciudad de México)'],
  ['America/Bogota', 'Colombia'],
  ['America/Argentina/Buenos_Aires', 'Argentina'],
  ['America/Santiago', 'Chile'],
  ['America/Lima', 'Perú'],
  ['America/New_York', 'Estados Unidos (costa este)'],
  ['America/Los_Angeles', 'Estados Unidos (costa oeste)'],
  ['UTC', 'Hora universal'],
];

const REGION_NAME: Record<string, string> = {
  Africa: 'África',
  America: 'América',
  Antarctica: 'Antártida',
  Arctic: 'Ártico',
  Asia: 'Asia',
  Atlantic: 'Atlántico',
  Australia: 'Australia',
  Europe: 'Europa',
  Indian: 'Índico',
  Pacific: 'Pacífico',
  Etc: 'Otras',
};

/** «Europe/Madrid» → «España peninsular y Baleares»; «Africa/Abidjan» → «Abidjan (África)». */
export function timeZoneLabel(zone: string): string {
  const common = COMMON_TIME_ZONES.find(([id]) => id === zone);
  if (common) return common[1];
  const parts = zone.split('/');
  const city = (parts.at(-1) ?? zone).replaceAll('_', ' ');
  const region = parts.length > 1 ? REGION_NAME[parts[0]!] : undefined;
  return region ? `${city} (${region})` : city;
}

/** Zonas para el selector: las habituales primero, las demás por nombre, y la actual si no estuviera. */
export function sortTimeZones(all: readonly string[], current: string): string[] {
  const commonIds = COMMON_TIME_ZONES.map(([id]) => id);
  const rest = all
    .filter((z) => !commonIds.includes(z))
    .sort((a, b) => timeZoneLabel(a).localeCompare(timeZoneLabel(b), 'es'));
  const list = [...commonIds, ...rest];
  return list.includes(current) ? list : [current, ...list];
}

// ───────────────────────────── Avisos y botones ─────────────────────────────

export const TEXT = {
  /** Botón del perfil de marca que baja la configuración a un archivo. */
  exportConfig: 'Descargar configuración',
  /** Botón del asistente que crea una marca a partir de ese archivo. */
  importConfig: 'Subir una configuración guardada',
  /** Mensaje cuando el archivo no se puede leer. */
  configNotReadable: 'El archivo no es una configuración válida.',
  creditUnit: { one: 'crédito', other: 'créditos' },
} as const;

// ───────────────────────────── Erratas conocidas ─────────────────────────────

const KNOWN_TYPOS: ReadonlyArray<readonly [RegExp, string]> = [
  [/publicaciónes/g, 'publicaciones'],
  [/Publicaciónes/g, 'Publicaciones'],
];

/** Corrige erratas conocidas en textos que no controlamos (avisos guardados, mensajes de terceros). */
export function cleanText(text: string): string {
  return KNOWN_TYPOS.reduce((acc, [pattern, fix]) => acc.replace(pattern, fix), text);
}
