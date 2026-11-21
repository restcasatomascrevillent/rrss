import { z } from 'zod';

// Modelo del perfil de marca («cerebro de marca»). Se guarda como JSON en
// brand_profiles.data; `PROFILE_SCHEMA_VERSION` permite migrarlo en el futuro.
export const PROFILE_SCHEMA_VERSION = 1;

const text = (max: number) => z.string().trim().max(max).default('');
const list = (maxItems = 50, maxLength = 300) =>
  z
    .array(z.string().trim().max(maxLength))
    .max(maxItems)
    .default([])
    .transform((items) => items.filter((item) => item.length > 0));

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Lista de hashtags: sin almohadilla ni espacios, solo letras, números y guion
 * bajo, sin repetidos (sin distinguir mayúsculas). Lo que no encaja se descarta
 * en lugar de rechazar el perfil entero.
 */
export function normalizeHashtags(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const tag = item.replace(/\s+/g, '').replace(/^[#＃]+/, '');
    const key = tag.toLocaleLowerCase('es');
    if (!tag || tag.length > 100 || !/^[\p{L}\p{N}_]+$/u.test(tag) || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

const hashtagList = (maxItems = 50) => z.array(z.string()).max(maxItems).default([]).transform(normalizeHashtags);

/** Máximo de emojis que se puede fijar en el perfil. */
export const MAX_EMOJIS_LIMIT = 100;

export const brandProfileSchema = z.object({
  business: z
    .object({
      description: text(4000),
      products: z
        .array(z.object({ name: z.string().trim().min(1).max(200), description: text(1000) }))
        .max(100)
        .default([]),
      locations: list(),
      valueProps: list(),
    })
    .default({}),
  audience: z
    .object({
      segments: z
        .array(z.object({ name: z.string().trim().min(1).max(200), description: text(1000) }))
        .max(30)
        .default([]),
    })
    .default({}),
  goals: list(),
  voice: z
    .object({
      tone: list(),
      personality: text(2000),
      values: list(),
      keyMessages: list(50, 500),
      allowedPhrases: list(100),
      forbiddenPhrases: list(100),
      /**
       * Reglas de publicación que lee el verificador de marca (src/features/brandcheck).
       * Perfiles guardados antes de existir estos campos se leen con los valores por
       * defecto: listas vacías y política de emojis sin definir (`null`), de modo que
       * el verificador omite esas comprobaciones en vez de inventarse una regla.
       */
      hashtags: z.object({ required: hashtagList(), recommended: hashtagList() }).default({}),
      callsToAction: list(30, 200),
      emojis: z
        .object({
          /** `null` = el perfil no lo define. */
          allowed: z.boolean().nullable().default(null),
          /** `null` = sin máximo definido. */
          max: z.number().int().min(0).max(MAX_EMOJIS_LIMIT).nullable().default(null),
        })
        .default({}),
    })
    .default({}),
  visual: z
    .object({
      colors: z
        .array(
          z.object({
            name: text(80),
            hex: z.string().trim().regex(HEX_COLOR, 'El color debe tener el formato #RRGGBB'),
            role: text(80),
          }),
        )
        .max(24)
        .default([]),
      fonts: z
        .array(z.object({ family: z.string().trim().min(1).max(120), usage: text(200), license: text(300) }))
        .max(12)
        .default([]),
      logoAssetIds: z.array(z.string().uuid()).max(20).default([]),
      styleNotes: text(2000),
    })
    .default({}),
  channels: z
    .array(z.object({ platform: z.string().trim().min(1).max(40), handle: text(120), url: text(500) }))
    .max(20)
    .default([]),
  languages: z.object({ primary: z.string().trim().max(10).default('es'), others: list(20, 10) }).default({}),
  competitors: z
    .array(z.object({ name: z.string().trim().min(1).max(200), url: text(500) }))
    .max(30)
    .default([]),
  references: z
    .array(z.object({ url: z.string().trim().min(1).max(500), note: text(500) }))
    .max(50)
    .default([]),
  restrictions: z.object({ legal: list(), advertising: list() }).default({}),
});

export type BrandProfileData = z.infer<typeof brandProfileSchema>;
export type ProfileSectionKey = keyof BrandProfileData;

export const PROFILE_SECTIONS: ProfileSectionKey[] = [
  'business',
  'audience',
  'goals',
  'voice',
  'visual',
  'channels',
  'languages',
  'competitors',
  'references',
  'restrictions',
];

export function emptyProfile(): BrandProfileData {
  return brandProfileSchema.parse({});
}

/** Lee un perfil guardado; lo que no encaje con el esquema se sustituye por valores por defecto. */
export function parseProfile(data: unknown): BrandProfileData {
  const strict = brandProfileSchema.safeParse(data ?? {});
  if (strict.success) return strict.data;
  // Recuperación sección a sección: un dato corrupto no debe tirar el perfil entero.
  const source = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const recovered: Record<string, unknown> = {};
  for (const key of PROFILE_SECTIONS) {
    const section = brandProfileSchema.shape[key].safeParse(source[key]);
    if (section.success) recovered[key] = section.data;
  }
  return brandProfileSchema.parse(recovered);
}

/** Limpia lo que el usuario ha dejado a medias (filas sin nombre, colores inválidos) antes de guardar. */
export function normalizeProfile(draft: BrandProfileData): BrandProfileData {
  return brandProfileSchema.parse({
    ...draft,
    business: { ...draft.business, products: draft.business.products.filter((p) => p.name.trim()) },
    audience: { segments: draft.audience.segments.filter((s) => s.name.trim()) },
    visual: {
      ...draft.visual,
      colors: draft.visual.colors.filter((c) => HEX_COLOR.test(c.hex.trim())),
      fonts: draft.visual.fonts.filter((f) => f.family.trim()),
    },
    channels: draft.channels.filter((c) => c.platform.trim()),
    competitors: draft.competitors.filter((c) => c.name.trim()),
    references: draft.references.filter((r) => r.url.trim()),
  });
}

// ── Procedencia ──────────────────────────────────────────────────────────

export const provenanceSchema = z.record(
  z.object({ source: z.enum(['user', 'import', 'ai']), verified: z.boolean(), at: z.string() }),
);
export type Provenance = z.infer<typeof provenanceSchema>;
export type ProvenanceSource = 'user' | 'import' | 'ai';

export function parseProvenance(data: unknown): Provenance {
  const parsed = provenanceSchema.safeParse(data ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Procedencia de la versión nueva: las secciones que cambian pasan a ser de
 * `source`; las que no cambian conservan la suya.
 */
export function nextProvenance(
  previous: Provenance,
  before: BrandProfileData | null,
  after: BrandProfileData,
  source: ProvenanceSource,
  now: string = new Date().toISOString(),
): Provenance {
  const result: Provenance = {};
  for (const key of PROFILE_SECTIONS) {
    const changed = !before || JSON.stringify(before[key]) !== JSON.stringify(after[key]);
    const kept = previous[key];
    if (!changed && kept) result[key] = kept;
    else if (changed && !isEmptySection(after[key])) result[key] = { source, verified: source !== 'ai', at: now };
  }
  return result;
}

function isEmptySection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object' && value !== null) return Object.values(value).every(isEmptySection);
  return value === null || value === undefined;
}
