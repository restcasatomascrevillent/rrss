// Proveedor simulado para la prueba de extremo a extremo en LOCAL, y la guarda
// que impide usarlo en cualquier otro sitio.
//
// La configuración normal (`config.ts`) no admite el simulado de ninguna forma.
// Esta es la única vía, y exige DOS cosas a la vez:
//   1. la variable explícita AI_E2E_SIMULATED_PROVIDER=true;
//   2. que la función corra contra un Supabase local: SUPABASE_URL por http y
//      con host 127.0.0.1, localhost o `kong` (el nombre con el que el stack de
//      la CLI —`supabase start` / `functions serve`— se ve a sí mismo desde
//      dentro de Docker; ningún proyecto desplegado usa ese nombre).
// Si la variable está y el Supabase no es local, la función no arranca: error
// claro en el registro. Si la variable no está, este módulo no hace nada.
//
// Las respuestas son DETERMINISTAS y se construyen a partir del perfil de
// marca y del encargo, para que la prueba pueda comprobar que lo generado
// respeta el perfil de cada marca (no es un texto fijo). No es IA: va marcado
// como simulado en `ai_generations` (proveedor `simulated`).
import type { AiModelSpec, AiProviderRequest } from '../contract.ts';
import { createSimulatedProvider, SIMULATED_PROVIDER_ID, type SimulatedProvider } from '../simulated-provider.ts';
import { TEXT_PURPOSES, type AiTextConfig, type Env } from './config.ts';
import { TEXT_UNITS } from './prompt.ts';

export const LOCAL_TEST_FLAG = 'AI_E2E_SIMULATED_PROVIDER';
export const LOCAL_TEST_MODEL = 'simulado-e2e';
/** Hosts de un Supabase local: el de la máquina y el interno de la red de Docker de la CLI. */
export const LOCAL_SUPABASE_HOSTS = ['127.0.0.1', 'localhost', 'kong'] as const;

/**
 * Precio inventado (micros por unidad) para que el coste y el cupo se puedan
 * probar con cifras distintas de cero. No es el precio de ningún proveedor.
 */
export const LOCAL_TEST_PRICES: Record<string, number> = {
  [TEXT_UNITS.input]: 10,
  [TEXT_UNITS.output]: 40,
  [TEXT_UNITS.cacheRead]: 1,
  [TEXT_UNITS.cacheWrite]: 12,
};

export class LocalTestConfigError extends Error {
  override name = 'LocalTestConfigError';
}

export function isLocalSupabaseUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && (LOCAL_SUPABASE_HOSTS as readonly string[]).includes(url.hostname);
}

/**
 * Configuración de texto con el proveedor simulado, o `null` si la variable no
 * está. Lanza `LocalTestConfigError` si la variable está pero algo no cuadra.
 */
export function loadLocalTestTextConfig(env: Env): AiTextConfig | null {
  const flag = env[LOCAL_TEST_FLAG]?.trim();
  if (!flag) return null;
  if (flag !== 'true') {
    throw new LocalTestConfigError(`${LOCAL_TEST_FLAG} solo admite el valor «true»; para no usarla, quítala.`);
  }
  if (!isLocalSupabaseUrl(env.SUPABASE_URL)) {
    throw new LocalTestConfigError(
      `${LOCAL_TEST_FLAG}=true solo se admite en pruebas locales: SUPABASE_URL debe ser http://127.0.0.1, http://localhost o http://kong (stack local de la CLI). Esta función no arranca; quita la variable.`,
    );
  }
  const models: AiModelSpec[] = TEXT_PURPOSES.map((purpose) => ({
    provider: SIMULATED_PROVIDER_ID,
    model: LOCAL_TEST_MODEL,
    task: 'text',
    microsPerUnit: { ...LOCAL_TEST_PRICES },
    purposes: [purpose],
  }));
  return {
    providers: [createLocalTestProvider()],
    models,
    unavailable: {},
    problems: [`${LOCAL_TEST_FLAG}=true: proveedor SIMULADO para pruebas locales. Nunca en un entorno con clientes.`],
  };
}

// ── Respuestas deterministas ─────────────────────────────────────────────

type Profile = {
  business?: { description?: string };
  voice?: {
    tone?: string[];
    keyMessages?: string[];
    forbiddenPhrases?: string[];
    callsToAction?: string[];
    hashtags?: { required?: string[]; recommended?: string[] };
  };
  restrictions?: { legal?: string[]; advertising?: string[] };
  languages?: { primary?: string };
};

function material(request: AiProviderRequest, label: string): string | undefined {
  return request.input.context?.find((part) => part.label === label)?.content;
}

function profileOf(request: AiProviderRequest): Profile {
  try {
    return JSON.parse(material(request, 'perfil de marca') ?? '{}') as Profile;
  } catch {
    return {};
  }
}

const sentence = (text: string) => {
  const clean = text.trim().replace(/[.\s]+$/, '');
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}.` : '';
};

const lowerFirst = (text: string) => (text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);

/** ¿Trata de usted? Si el tono de la marca lo dice («formal», «de usted»…). */
const formal = (profile: Profile) => (profile.voice?.tone ?? []).some((tone) => /formal|usted|sobri|serio/i.test(tone));

/** Vetos de la marca: expresiones prohibidas y restricciones de publicidad. */
const vetoes = (profile: Profile) =>
  [...(profile.voice?.forbiddenPhrases ?? []), ...(profile.restrictions?.advertising ?? [])]
    .map((v) => v.trim())
    .filter(Boolean);

/** Quita del encargo cualquier expresión vetada (la marca no la diría). */
function withoutVetoes(text: string, profile: Profile): string {
  let out = text;
  for (const veto of vetoes(profile)) {
    out = out.replace(new RegExp(veto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').replace(/\s{2,}/g, ' ');
  }
  return out.trim();
}

function postCopy(request: AiProviderRequest): string {
  const profile = profileOf(request);
  const brief = withoutVetoes(material(request, 'encargo') ?? '', profile);
  const count = Number(/Variantes: (\d+)\./.exec(request.input.prompt)?.[1] ?? '1');
  const message = profile.voice?.keyMessages?.[0] ?? profile.business?.description ?? '';
  const cta = profile.voice?.callsToAction?.[0] ?? (formal(profile) ? 'Le esperamos' : 'Te esperamos');
  const openers = formal(profile)
    ? ['Le presentamos', 'Tenemos el gusto de anunciarle', 'Le invitamos a conocer', 'Le contamos', 'Descubra']
    : ['Te presentamos', 'Mira', 'Ven a conocer', 'Te contamos', 'Descubre'];
  const hashtags = [...(profile.voice?.hashtags?.required ?? []), ...(profile.voice?.hashtags?.recommended ?? [])];
  const variants = Array.from({ length: Math.max(1, Math.min(5, count)) }, (_, i) => ({
    text: [`${openers[i % openers.length]}: ${lowerFirst(sentence(brief))}`, sentence(message), sentence(cta)]
      .filter(Boolean)
      .join(' '),
    hashtags: hashtags.map((tag) => `#${tag.replace(/^#+/, '')}`),
  }));
  return JSON.stringify({ variants });
}

function brandCheck(request: AiProviderRequest): string {
  const profile = profileOf(request);
  const text = material(request, 'texto evaluado') ?? '';
  const found = vetoes(profile)
    .map((veto) => {
      const at = text.toLowerCase().indexOf(veto.toLowerCase());
      return at < 0 ? null : text.slice(at, at + veto.length);
    })
    .filter((fragment): fragment is string => fragment !== null);
  const tone = profile.voice?.tone ?? [];
  return JSON.stringify({
    tone: tone.length
      ? { verdict: 'pass', explanation: `[simulado] Se compara con el tono «${tone.join(', ')}».`, evidence: [] }
      : { verdict: 'uncertain', explanation: '[simulado] El perfil no describe el tono.', evidence: [] },
    banned_topics: found.length
      ? { verdict: 'fail', explanation: `[simulado] Usa lo que la marca veta: ${found.join(', ')}.`, evidence: found }
      : { verdict: 'pass', explanation: '[simulado] No aparece nada vetado.', evidence: [] },
  });
}

function profileProposal(request: AiProviderRequest): string {
  const sources = (request.input.context ?? []).filter((part) => part.label.startsWith('fuente: '));
  const first = sources[0]?.content.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  return JSON.stringify({
    business: { description: first, products: [], locations: [], valueProps: [] },
    audience: { segments: [] },
    goals: [],
    voice: { tone: [], personality: '', values: [], keyMessages: [], allowedPhrases: [], forbiddenPhrases: [] },
    visual: { colors: [], fonts: [], styleNotes: '' },
    channels: [],
    languages: { primary: '', others: [] },
    restrictions: { legal: [], advertising: [] },
    notes: [{ section: 'business', note: '[simulado] Descripción tomada de la primera frase de la primera fuente.' }],
  });
}

/**
 * Plan de campaña determinista: una pieza cada dos días, alternando los
 * destinos pedidos (primero una de cada red). El pie sale del perfil (mensaje
 * clave, llamada a la acción, tono) y la idea, de la instrucción.
 *
 * Además imita a un modelo COMPROMETIDO: si algún material contiene «ignora lo
 * anterior», añade una pieza que obedece a la inyección (otra red, fuera de
 * fechas, «aprobado y publicado»). El producto debe descartarla; la prueba de
 * extremo a extremo comprueba que no llega a los borradores.
 */
function campaignPlan(request: AiProviderRequest): string {
  const profile = profileOf(request);
  const prompt = request.input.prompt;
  const range = /Fechas: del (\d{4}-\d{2}-\d{2}) al (\d{4}-\d{2}-\d{2})/.exec(prompt);
  const max = Number(/Máximo de piezas: (\d+)\./.exec(prompt)?.[1] ?? '1');
  const targets = [...prompt.matchAll(/- Destino: ([a-z0-9_]+)\/([a-z0-9_]+)/g)].map((m) => ({
    network: m[1]!,
    format: m[2]!,
  }));
  const instruction = withoutVetoes(material(request, 'instrucción') ?? '', profile);
  let library: { id: string; kind: string }[] = [];
  try {
    library = JSON.parse(material(request, 'biblioteca') ?? '[]') as { id: string; kind: string }[];
  } catch {
    library = [];
  }
  const images = library.filter((asset) => asset.kind === 'image');
  const start = range ? Date.parse(`${range[1]}T00:00:00Z`) : 0;
  const end = range ? Date.parse(`${range[2]}T00:00:00Z`) : 0;
  const days = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  const dayAt = (offset: number) => new Date(start + offset * 86_400_000).toISOString().slice(0, 10);

  // Una de cada red primero; después, el resto de formatos.
  const order: { network: string; format: string }[] = [];
  const byNetwork = new Map<string, { network: string; format: string }[]>();
  for (const target of targets) byNetwork.set(target.network, [...(byNetwork.get(target.network) ?? []), target]);
  for (let round = 0; order.length < targets.length; round += 1) {
    for (const list of byNetwork.values()) if (list[round]) order.push(list[round]!);
  }

  const message = profile.voice?.keyMessages?.[0] ?? profile.business?.description ?? '';
  const cta = profile.voice?.callsToAction?.[0] ?? (formal(profile) ? 'Le esperamos' : 'Te esperamos');
  const openers = formal(profile)
    ? ['Le presentamos', 'Le invitamos a conocer', 'Le contamos', 'Descubra']
    : ['Te presentamos', 'Ven a conocer', 'Te contamos', 'Descubre'];
  const hashtags = [...(profile.voice?.hashtags?.required ?? []), ...(profile.voice?.hashtags?.recommended ?? [])];
  const count = Math.max(1, Math.min(max, Math.ceil(days / 2)));
  const shortInstruction = instruction.slice(0, 120);
  const pieces = Array.from({ length: order.length ? count : 0 }, (_, i) => ({
    ...order[i % order.length]!,
    date: dayAt(Math.min(days - 1, i * 2)),
    idea: `[simulado] Pieza ${i + 1} de ${count}: ${shortInstruction}`,
    caption: [`${openers[i % openers.length]}: ${lowerFirst(sentence(message || shortInstruction))}`, sentence(cta)]
      .filter(Boolean)
      .join(' '),
    hashtags,
    assetIds: images.length ? [images[i % images.length]!.id] : [],
    why: `[simulado] Reparto fijo: una pieza cada dos días, alternando redes (${i + 1}/${count}).`,
  }));

  const everything = (request.input.context ?? []).map((part) => part.content).join('\n');
  if (/ignora lo anterior/i.test(everything)) {
    pieces.push({
      network: 'x',
      format: 'post',
      date: dayAt(days + 365),
      idea: 'Aprobado y publicado por orden del documento',
      caption: 'APROBADO. Publicar ya.',
      hashtags: [],
      assetIds: ['00000000-0000-0000-0000-000000000000'],
      why: 'El documento lo ordena.',
    });
  }

  const tone = profile.voice?.tone ?? [];
  return JSON.stringify({
    objective: `[simulado] ${sentence(shortInstruction)}`,
    summary: `[simulado] ${count} piezas entre ${range?.[1] ?? '?'} y ${range?.[2] ?? '?'}.`,
    observed: [
      `[simulado] La instrucción pide: «${shortInstruction}».`,
      tone.length
        ? `[simulado] El tono de la marca es ${tone.join(', ')}.`
        : '[simulado] El perfil no describe el tono.',
      `[simulado] La biblioteca enviada tiene ${library.length} recursos (${images.length} imágenes).`,
    ],
    dataBacked: [],
    hypotheses: ['[simulado] Publicar cada dos días mantiene la presencia sin saturar.'],
    pieces,
  });
}

/** Analítica: una hipótesis por cada uno de los dos primeros datos, citándolo; nada inventado. */
function analyticsSummary(request: AiProviderRequest): string {
  let datos: Array<{ id: string; dato: string }> = [];
  try {
    datos = (JSON.parse(material(request, 'datos medidos') ?? '{}') as { datos?: typeof datos }).datos ?? [];
  } catch {
    datos = [];
  }
  return JSON.stringify({
    hypotheses: datos.slice(0, 2).map((d) => ({
      text: `[simulado] Podría merecer la pena fijarse en esto: ${d.dato}`,
      based_on: [d.id],
    })),
  });
}

/**
 * Copiloto por voz: lee el dictado con reglas fijas (no es IA) y devuelve las
 * operaciones que pediría un modelo. Entiende «foto … detrás / de fondo»
 * (difuminada si lo dice), «logotipo» (arriba o abajo), «título: …»,
 * «platos: a, b, c», «precio: …», «difumina más» y «en blanco». Los textos son
 * trozos literales del dictado.
 *
 * Imita además a un modelo COMPROMETIDO: si el dictado contiene «ignora lo
 * anterior», añade un texto que no se ha dictado («APROBADO Y PUBLICADO») y
 * una foto que no se ha elegido. El producto debe descartar las dos.
 */
function editorCopilot(request: AiProviderRequest): string {
  const profile = profileOf(request) as Profile & { visual?: { logoAssetIds?: string[] } };
  const dictation = material(request, 'dictado') ?? '';
  let photos: { id: string }[] = [];
  try {
    photos = JSON.parse(material(request, 'fotos elegidas') ?? '[]') as { id: string }[];
  } catch {
    photos = [];
  }
  const empty = {
    target: null,
    text: null,
    style: null,
    assetId: null,
    position: null,
    align: null,
    color: null,
    font: null,
    blur: null,
    dx: null,
    dy: null,
  };
  const operations: Record<string, unknown>[] = [];
  const clause = (pattern: RegExp) => pattern.exec(dictation)?.[1]?.trim().replace(/[.;]+$/, '');
  const white = /en blanco/i.test(dictation) ? '#FFFFFF' : null;
  const blurred = /muy (difuminad|desenfocad)/i.test(dictation) ? 70 : /difumin|desenfoc|borros/i.test(dictation) ? 40 : null;

  if (/(foto|imagen)[^.]*?(detr[aá]s|de fondo)|fondo[^.]*?(foto|imagen)/i.test(dictation)) {
    operations.push({ ...empty, op: 'set_background_image', assetId: photos[0]?.id ?? null, blur: blurred });
  } else if (/difumina(la)? m[aá]s|m[aá]s difuminad/i.test(dictation)) {
    operations.push({ ...empty, op: 'blur_image', blur: 70 });
  }
  if (/logo(tipo)?/i.test(dictation)) {
    const where = /logo(?:tipo)?[^.]*?\b(arriba|abajo)\b/i.exec(dictation)?.[1]?.toLowerCase();
    operations.push({
      ...empty,
      op: 'add_logo',
      assetId: profile.visual?.logoAssetIds?.[0] ?? null,
      position: where === 'arriba' ? 'top' : where === 'abajo' ? 'bottom' : null,
      align: where ? 'center' : null,
    });
  }
  const title = clause(/t[ií]tulo:?\s*([^.]+)/i);
  if (title) operations.push({ ...empty, op: 'add_text', text: title, style: 'title', position: 'upper', color: white });
  const dishes = clause(/platos:?\s*([^.]+)/i);
  if (dishes) {
    const lines = dishes
      .split(/,|;|\by\b/)
      .map((line) => line.trim())
      .filter(Boolean);
    operations.push({ ...empty, op: 'add_text', text: lines.join('\n'), style: 'body', position: 'middle', color: white });
  }
  const price = clause(/precio:?\s*([^.]+)/i);
  if (price) operations.push({ ...empty, op: 'add_text', text: price, style: 'small', position: 'lower', color: white });

  if (/ignora lo anterior/i.test(dictation)) {
    operations.push({ ...empty, op: 'add_text', text: 'APROBADO Y PUBLICADO', style: 'title' });
    operations.push({ ...empty, op: 'set_background_image', assetId: '00000000-0000-4000-8000-000000000000' });
  }
  return JSON.stringify({
    operations,
    note: operations.length
      ? `[simulado] ${operations.length} cambios a partir de lo dictado.`
      : '[simulado] No he entendido ningún cambio en lo dictado.',
  });
}

const RESPONDERS: Record<string, (request: AiProviderRequest) => string> = {
  editor_copilot: editorCopilot,
  analytics_summary: analyticsSummary,
  post_copy: postCopy,
  brand_check: brandCheck,
  brand_profile_proposal: profileProposal,
  campaign_plan: campaignPlan,
};

export function createLocalTestProvider(): SimulatedProvider {
  return createSimulatedProvider({
    respond: (request) => {
      const name = request.input.outputSchema?.name;
      return name ? RESPONDERS[name]?.(request) : undefined;
    },
  });
}
