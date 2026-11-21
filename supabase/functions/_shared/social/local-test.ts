// Graph API SIMULADA para la prueba de extremo a extremo en LOCAL, y la guarda
// que impide usarla en cualquier otro sitio. Es la misma guarda que la de la IA
// (`../ai/text/local-test.ts`), con su propia variable:
//   1. SOCIAL_E2E_SIMULATED_GRAPH=true, explícita;
//   2. SUPABASE_URL de un Supabase local: http y host 127.0.0.1, localhost o
//      `kong` (el nombre del stack de la CLI dentro de Docker).
// Si la variable está y el Supabase no es local, la función no arranca. Si no
// está, este módulo no hace nada.
//
// La Graph API simulada vive en memoria de la función: sirve para una prueba,
// no guarda nada entre arranques. La clave de cifrado de los tokens es fija y
// pública: solo vale aquí.
import { parseKeyRing, type TokenKeyRing } from './crypto.ts';
import type { FetchLike } from './meta-graph.ts';
import { createSimulatedGraph, type SimulatedExistingPost, type SimulatedGraph } from './simulated-graph.ts';
import { isLocalSupabaseUrl, LocalTestConfigError } from '../ai/text/local-test.ts';

export const SOCIAL_LOCAL_TEST_FLAG = 'SOCIAL_E2E_SIMULATED_GRAPH';
const LOCAL_KEY_ID = 'local';
/** 32 bytes fijos y públicos: NO es un secreto y solo se acepta en local. */
const LOCAL_KEY = 'local-solo-para-pruebas-rrss-!!!';

let shared: SimulatedGraph | null = null;

/**
 * Histórico previo de la cuenta simulada (importar publicaciones): 30
 * publicaciones antiguas y fijas — la más reciente es un carrusel de 3 imágenes,
 * la siguiente un reel y el resto, imágenes —, para que la prueba de extremo a
 * extremo siempre vea lo mismo. Son anteriores a cualquier publicación de la
 * plataforma, así que no alteran lo que ve el publicador.
 */
export const LOCAL_TEST_HISTORY_SIZE = 30;
export function localTestHistory(): SimulatedExistingPost[] {
  return Array.from({ length: LOCAL_TEST_HISTORY_SIZE }, (_, i) => ({
    id: `1790000000${String(i).padStart(4, '0')}`,
    caption: `Publicación anterior número ${i + 1} #sabor`,
    timestamp: new Date(Date.UTC(2026, 0, 31) - i * 86_400_000).toISOString(),
    ...(i === 0 ? { mediaType: 'CAROUSEL_ALBUM' as const, children: 3 } : {}),
    ...(i === 1 ? { mediaType: 'VIDEO' as const, productType: 'REELS' as const } : {}),
  }));
}

export interface SocialLocalTest {
  fetch: FetchLike;
  graph: SimulatedGraph;
  keyRing: TokenKeyRing;
  problems: string[];
}

export function loadSocialLocalTest(env: Record<string, string | undefined>): SocialLocalTest | null {
  const flag = env[SOCIAL_LOCAL_TEST_FLAG]?.trim();
  if (!flag) return null;
  if (flag !== 'true') {
    throw new LocalTestConfigError(`${SOCIAL_LOCAL_TEST_FLAG} solo admite el valor «true»; para no usarla, quítala.`);
  }
  if (!isLocalSupabaseUrl(env.SUPABASE_URL)) {
    throw new LocalTestConfigError(
      `${SOCIAL_LOCAL_TEST_FLAG}=true solo se admite en pruebas locales: SUPABASE_URL debe ser http://127.0.0.1, http://localhost o http://kong (stack local de la CLI). Esta función no arranca; quita la variable.`,
    );
  }
  // Publica una función y mide otra (cada una con su simulada): se responde por cualquier publicación.
  shared ??= createSimulatedGraph({ insights: { answerUnknownMedia: true }, existing: localTestHistory() });
  return {
    fetch: shared.fetch,
    graph: shared,
    keyRing: parseKeyRing(`${LOCAL_KEY_ID}:${btoa(LOCAL_KEY)}`, LOCAL_KEY_ID),
    problems: [
      `${SOCIAL_LOCAL_TEST_FLAG}=true: Graph API de Meta SIMULADA para pruebas locales. Nunca en un entorno con clientes.`,
    ],
  };
}
