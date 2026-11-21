import type { BrandProfileData, ProfileSectionKey } from './profile';

export interface CompletenessCheck {
  key: string;
  section: ProfileSectionKey;
  label: string;
  done: boolean;
}

export interface Completeness {
  percent: number;
  checks: CompletenessCheck[];
  missing: CompletenessCheck[];
}

/** Qué le falta al perfil para que la IA pueda trabajar bien con la marca. */
export function profileCompleteness(profile: BrandProfileData): Completeness {
  const checks: CompletenessCheck[] = [
    {
      key: 'description',
      section: 'business',
      label: 'Describe el negocio',
      done: profile.business.description.length >= 20,
    },
    {
      key: 'products',
      section: 'business',
      label: 'Añade productos o servicios',
      done: profile.business.products.length > 0,
    },
    {
      key: 'valueProps',
      section: 'business',
      label: 'Indica qué os diferencia',
      done: profile.business.valueProps.length > 0,
    },
    {
      key: 'audience',
      section: 'audience',
      label: 'Define el público objetivo',
      done: profile.audience.segments.length > 0,
    },
    { key: 'goals', section: 'goals', label: 'Marca los objetivos en redes', done: profile.goals.length > 0 },
    { key: 'tone', section: 'voice', label: 'Define el tono de comunicación', done: profile.voice.tone.length > 0 },
    {
      key: 'keyMessages',
      section: 'voice',
      label: 'Escribe los mensajes clave',
      done: profile.voice.keyMessages.length > 0,
    },
    {
      key: 'publishingRules',
      section: 'voice',
      label: 'Fija hashtags, llamadas a la acción o política de emojis',
      done: hasPublishingRules(profile),
    },
    { key: 'colors', section: 'visual', label: 'Añade los colores de marca', done: profile.visual.colors.length > 0 },
    { key: 'fonts', section: 'visual', label: 'Añade las tipografías', done: profile.visual.fonts.length > 0 },
    { key: 'logo', section: 'visual', label: 'Sube el logotipo', done: profile.visual.logoAssetIds.length > 0 },
    { key: 'channels', section: 'channels', label: 'Indica las redes que usáis', done: profile.channels.length > 0 },
  ];
  const done = checks.filter((c) => c.done).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    checks,
    missing: checks.filter((c) => !c.done),
  };
}

/** Alguna de las reglas de publicación que lee el verificador de marca está definida. */
export function hasPublishingRules(profile: BrandProfileData): boolean {
  const { hashtags, callsToAction, emojis } = profile.voice;
  return (
    hashtags.required.length > 0 ||
    hashtags.recommended.length > 0 ||
    callsToAction.length > 0 ||
    emojis.allowed !== null ||
    emojis.max !== null
  );
}
