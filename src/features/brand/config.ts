import { z } from 'zod';
import type { BrandRow } from '@/lib/database.types';
import { brandProfileSchema, type BrandProfileData } from './profile';

// Configuración declarativa y versionada de una marca: sirve para altas
// masivas, migraciones y copias de seguridad. Importarla crea una marca nueva.
export const BRAND_CONFIG_FORMAT = 'rrss.brand-config';
export const BRAND_CONFIG_VERSION = 1;

export const brandBasicsSchema = z.object({
  name: z.string().trim().min(1, 'Falta el nombre de la marca').max(120),
  sector: z.string().trim().max(120).default(''),
  website: z.string().trim().max(300).default(''),
  timezone: z.string().trim().min(1).max(64).default('Europe/Madrid'),
  default_locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'El idioma debe ser un código como «es» o «es-ES»')
    .default('es'),
});
export type BrandBasics = z.infer<typeof brandBasicsSchema>;

export const brandConfigSchema = z.object({
  format: z.literal(BRAND_CONFIG_FORMAT, {
    errorMap: () => ({ message: `No es una configuración de marca (se esperaba format: "${BRAND_CONFIG_FORMAT}")` }),
  }),
  version: z.literal(BRAND_CONFIG_VERSION, {
    errorMap: () => ({
      message: `Versión de configuración no admitida (esta aplicación entiende la ${BRAND_CONFIG_VERSION})`,
    }),
  }),
  exportedAt: z.string().optional(),
  brand: brandBasicsSchema,
  profile: brandProfileSchema,
});
export type BrandConfig = z.infer<typeof brandConfigSchema>;

export function exportBrandConfig(
  brand: Pick<BrandRow, 'name' | 'sector' | 'website' | 'timezone' | 'default_locale'>,
  profile: BrandProfileData,
  now: Date = new Date(),
): BrandConfig {
  return {
    format: BRAND_CONFIG_FORMAT,
    version: BRAND_CONFIG_VERSION,
    exportedAt: now.toISOString(),
    brand: {
      name: brand.name,
      sector: brand.sector,
      website: brand.website,
      timezone: brand.timezone,
      default_locale: brand.default_locale,
    },
    // Los logotipos son archivos de la marca de origen: sus identificadores no
    // valen en otra marca, así que no viajan en la configuración.
    profile: { ...profile, visual: { ...profile.visual, logoAssetIds: [] } },
  };
}

export type ImportResult = { ok: true; config: BrandConfig } | { ok: false; errors: string[] };

export function parseBrandConfig(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['El archivo no es una configuración válida.'] };
  }
  const parsed = brandConfigSchema.safeParse(raw);
  if (parsed.success) {
    return {
      ok: true,
      config: {
        ...parsed.data,
        profile: { ...parsed.data.profile, visual: { ...parsed.data.profile.visual, logoAssetIds: [] } },
      },
    };
  }
  const errors = parsed.error.issues.slice(0, 8).map((issue) => {
    const where = issue.path.join(' › ');
    return where ? `${where}: ${issue.message}` : issue.message;
  });
  if (parsed.error.issues.length > 8) errors.push(`…y ${parsed.error.issues.length - 8} problemas más.`);
  return { ok: false, errors };
}

export function configFileName(brandName: string): string {
  const slug = brandName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${slug || 'marca'}.brand-config.json`;
}
