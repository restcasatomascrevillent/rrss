// Adaptador del perfil de marca a las reglas del verificador.

import type { BrandRules } from './types';

/**
 * Forma mínima del perfil que se lee (estructural, compatible con `BrandProfileData`
 * de `src/features/brand`, sin importarlo): palabras vetadas, hashtags obligatorios
 * y recomendados, llamadas a la acción y política de emojis (todo en `voice`) y
 * colores (`visual.colors`). `null` en la política de emojis = no definido.
 */
export interface ProfileLike {
  voice?: {
    forbiddenPhrases?: string[];
    hashtags?: { required?: string[]; recommended?: string[] };
    callsToAction?: string[];
    emojis?: { allowed?: boolean | null; max?: number | null };
  };
  visual?: { colors?: { name?: string; hex: string }[] };
}

/** Reglas que se quieran fijar a mano; si se pasan, mandan sobre las del perfil. */
export type ExtraBrandRules = Pick<
  BrandRules,
  'requiredHashtags' | 'recommendedHashtags' | 'callsToAction' | 'emojiPolicy'
>;

export function brandRulesFromProfile(
  profile: ProfileLike | null | undefined,
  extra: ExtraBrandRules = {},
): BrandRules {
  const voice = profile?.voice;
  const rules: BrandRules = {
    forbiddenPhrases: voice?.forbiddenPhrases ?? [],
    brandColors: (profile?.visual?.colors ?? []).map((c) => ({ name: c.name, hex: c.hex })),
    requiredHashtags: voice?.hashtags?.required ?? [],
    recommendedHashtags: voice?.hashtags?.recommended ?? [],
    callsToAction: voice?.callsToAction ?? [],
  };
  const allowed = voice?.emojis?.allowed ?? undefined;
  const max = voice?.emojis?.max ?? undefined;
  if (allowed !== undefined || max !== undefined) {
    rules.emojiPolicy = {
      ...(allowed !== undefined ? { allowed } : {}),
      ...(max !== undefined ? { max } : {}),
    };
  }
  // Solo pisan las reglas que de verdad se pasan.
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) (rules as Record<string, unknown>)[key] = value;
  }
  return rules;
}
