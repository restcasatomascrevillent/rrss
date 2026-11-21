// Google Drive SIMULADO para la prueba de extremo a extremo en LOCAL, con la
// misma guarda que la IA y Meta (`../ai/text/local-test.ts`):
//   1. DRIVE_E2E_SIMULATED=true, explícita;
//   2. SUPABASE_URL de un Supabase local (http y 127.0.0.1, localhost o kong).
// Si la variable está y el Supabase no es local, la función no arranca. Si no
// está, este módulo no hace nada. La clave de cifrado es fija y pública: solo
// vale aquí.
import { isLocalSupabaseUrl, LocalTestConfigError } from '../ai/text/local-test.ts';
import { parseKeyRing, type TokenKeyRing } from '../social/crypto.ts';
import { createSimulatedDrive, type SimulatedDrive } from './simulated-drive.ts';

export const DRIVE_LOCAL_TEST_FLAG = 'DRIVE_E2E_SIMULATED';
const LOCAL_KEY_ID = 'local';
/** 32 bytes fijos y públicos (los mismos que en social/local-test.ts): NO es un secreto. */
const LOCAL_KEY = 'local-solo-para-pruebas-rrss-!!!';

let shared: SimulatedDrive | null = null;

export interface DriveLocalTest {
  drive: SimulatedDrive;
  keyRing: TokenKeyRing;
  problems: string[];
}

export function loadDriveLocalTest(env: Record<string, string | undefined>): DriveLocalTest | null {
  const flag = env[DRIVE_LOCAL_TEST_FLAG]?.trim();
  if (!flag) return null;
  if (flag !== 'true') {
    throw new LocalTestConfigError(`${DRIVE_LOCAL_TEST_FLAG} solo admite el valor «true»; para no usarla, quítala.`);
  }
  if (!isLocalSupabaseUrl(env.SUPABASE_URL)) {
    throw new LocalTestConfigError(
      `${DRIVE_LOCAL_TEST_FLAG}=true solo se admite en pruebas locales: SUPABASE_URL debe ser http://127.0.0.1, http://localhost o http://kong (stack local de la CLI). Esta función no arranca; quita la variable.`,
    );
  }
  shared ??= createSimulatedDrive();
  return {
    drive: shared,
    keyRing: parseKeyRing(`${LOCAL_KEY_ID}:${btoa(LOCAL_KEY)}`, LOCAL_KEY_ID),
    problems: [
      `${DRIVE_LOCAL_TEST_FLAG}=true: Google Drive SIMULADO para pruebas locales. Nunca en un entorno con clientes.`,
    ],
  };
}
