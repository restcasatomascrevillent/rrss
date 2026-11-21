/** Lo que significa cada `?social=` con el que vuelve la conexión. */
export const CONNECT_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Cuenta de Instagram conectada' },
  denied: { ok: false, text: 'No se ha conectado: se canceló o no se concedieron los permisos en Meta.' },
  expired: { ok: false, text: 'La conexión caducó o ya se había usado. Vuelve a intentarlo.' },
  no_instagram: {
    ok: false,
    text: 'No hay ninguna cuenta profesional de Instagram unida a una página de Facebook en lo que se concedió.',
  },
  several_accounts: {
    ok: false,
    text: 'Se concedieron varias cuentas de Instagram. Vuelve a conectar y elige solo la de esta marca en el diálogo de Meta.',
  },
  forbidden: { ok: false, text: 'Solo quien gestiona la marca puede conectar sus redes.' },
  failed: { ok: false, text: 'No se pudo conectar la cuenta. Inténtalo de nuevo más tarde.' },
};

/**
 * Cuando la conexión con Meta falla sin saber a qué marca iba (no hay sesión
 * de conexión válida), el servidor vuelve a `/?social=…`, que no tiene tarjeta
 * de cuentas: este aviso evita que el fallo pase en silencio.
 */
export function connectResultNotice(result: string | null): { ok: boolean; text: string } | null {
  if (!result) return null;
  return CONNECT_RESULT[result] ?? CONNECT_RESULT.failed!;
}
