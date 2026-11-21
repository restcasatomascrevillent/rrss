import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DIR_ESTADO, ESTADO_JSON, LOCAL, type Estado } from './apoyo';

/** Espera (hasta `margenMs`; 0 = un solo intento) a que la URL responda con éxito. */
async function responde(url: string, margenMs: number): Promise<boolean> {
  const limite = Date.now() + margenMs;
  for (;;) {
    const respuesta = await fetch(url).catch(() => null);
    if (respuesta?.ok) return true;
    if (Date.now() >= limite) return false;
    await new Promise((listo) => setTimeout(listo, 2_000));
  }
}

/**
 * Antes de la tanda: comprueba que el backend es el LOCAL y que responde, y
 * prepara el estado compartido. Cada tanda usa correos con un sufijo propio,
 * así no hace falta vaciar la base de datos entre ejecuciones.
 *
 * Con E2E_CONTINUAR=1 se reutiliza el estado de la tanda anterior (para
 * relanzar un solo archivo mientras se depura).
 */
export default async function globalSetup(): Promise<void> {
  // playwright.config.ts lee la URL y la clave anónima de `supabase status` y se las pasa a Vite.
  const url = process.env.E2E_SUPABASE_URL_DETECTADA ?? '';
  if (!url) {
    throw new Error('No se pudo leer `supabase status`: arranca el Supabase local con `supabase start`.');
  }
  if (url !== LOCAL.api) {
    throw new Error(
      `La prueba e2e solo corre contra el Supabase local (${LOCAL.api}); \`supabase status\` da «${url}».`,
    );
  }

  // En CI los servicios pueden tardar unos segundos en responder tras `supabase start`.
  const margen = process.env.CI ? 60_000 : 0;
  const salud = await responde(`${LOCAL.api}/auth/v1/health`, margen);
  if (!salud) throw new Error('El Supabase local no responde. Arráncalo con `supabase start`.');
  const buzon = await responde(`${LOCAL.buzon}/api/v1/info`, margen);
  if (!buzon) throw new Error(`El buzón de correo local no responde en ${LOCAL.buzon}.`);

  if (process.env.E2E_CONTINUAR === '1' && existsSync(ESTADO_JSON)) return;

  rmSync(DIR_ESTADO, { recursive: true, force: true });
  mkdirSync(DIR_ESTADO, { recursive: true });
  const estado: Estado = { tanda: Date.now().toString(36), claves: {} };
  writeFileSync(ESTADO_JSON, JSON.stringify(estado, null, 2));
}
