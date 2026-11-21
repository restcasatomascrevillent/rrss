// Direcciones firmadas de las imágenes de Drive.
//
// Una etiqueta <img>, Konva o el trabajador piden la imagen con una dirección
// sin cabeceras, así que la sesión no viaja. La función comprueba ANTES (al
// firmar) que quien la pide ve la marca del recurso, y firma una dirección que
// vale como mucho dos horas para ese archivo de esa conexión:
//
//   v1.<id de clave>.<conexión>.<archivo>.<full|thumb>.<caduca (s)>.<firma>
//
// La firma es HMAC-SHA-256 con una clave derivada de SOCIAL_TOKEN_KEYS (la
// misma que cifra los tokens; derivada para otro uso, no se reutiliza tal
// cual). La caducidad se redondea a la hora: la misma imagen tiene la misma
// dirección durante un rato y el navegador la reutiliza de su caché.
import type { TokenKeyRing } from '../social/crypto.ts';

export type Variant = 'full' | 'thumb';

const encoder = new TextEncoder();
const HOUR = 3600;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(raw: Uint8Array) {
  const derived = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array([...encoder.encode('rrss.drive-ticket.v1|'), ...raw])),
  );
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signature(raw: Uint8Array, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(raw), encoder.encode(payload));
  return base64url(new Uint8Array(sig));
}

export interface TicketTarget {
  connectionId: string;
  fileId: string;
  variant: Variant;
}

/** Caducidad: entre una y dos horas desde ahora, redondeada a la hora. */
export function ticketExpiry(nowSeconds: number): number {
  return (Math.floor(nowSeconds / HOUR) + 2) * HOUR;
}

export async function signTicket(ring: TokenKeyRing, target: TicketTarget, nowSeconds: number): Promise<string> {
  const payload = [
    'v1',
    ring.currentKeyId,
    target.connectionId,
    target.fileId,
    target.variant,
    String(ticketExpiry(nowSeconds)),
  ].join('.');
  return `${payload}.${await signature(ring.keys.get(ring.currentKeyId)!, payload)}`;
}

/** El destino de una dirección firmada, o null si no vale (firma, forma o caducidad). */
export async function verifyTicket(
  ring: TokenKeyRing,
  ticket: string,
  nowSeconds: number,
): Promise<TicketTarget | null> {
  const parts = ticket.split('.');
  if (parts.length !== 7 || parts[0] !== 'v1') return null;
  const [, keyId, connectionId, fileId, variant, exp, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^[0-9a-f-]{36}$/i.test(connectionId) || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return null;
  if (variant !== 'full' && variant !== 'thumb') return null;
  if (!/^\d{1,12}$/.test(exp) || Number(exp) < nowSeconds) return null;
  const raw = ring.keys.get(keyId);
  if (!raw) return null;
  const expected = await signature(raw, parts.slice(0, 6).join('.'));
  // Comparación en tiempo constante.
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { connectionId, fileId, variant } : null;
}
