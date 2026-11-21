// Cifrado de los tokens de las redes (AES-256-GCM con WebCrypto, igual en Deno
// y en Node). La base de datos solo guarda el texto cifrado; la clave vive en
// los secretos de las Edge Functions:
//
//   SOCIAL_TOKEN_KEYS    lista «id:clave_en_base64», separada por comas; cada
//                        clave, 32 bytes aleatorios (openssl rand -base64 32).
//   SOCIAL_TOKEN_KEY_ID  la que cifra lo nuevo. Las demás solo descifran: así
//                        se rota sin perder las cuentas ya conectadas.
//
// El dato asociado (AAD) ata cada texto cifrado a su cuenta (marca, red y
// cuenta en la red): copiar el token cifrado de una cuenta a otra fila no sirve.
// Formato guardado: base64(iv de 12 bytes ‖ texto cifrado con su etiqueta).

export interface TokenKeyRing {
  currentKeyId: string;
  keys: Map<string, Uint8Array>;
}

export class TokenKeyError extends Error {
  override name = 'TokenKeyError';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Lee las claves del entorno. Lanza TokenKeyError con un mensaje claro si algo no cuadra. */
export function parseKeyRing(rawKeys: string | undefined, currentKeyId: string | undefined): TokenKeyRing {
  if (!rawKeys?.trim())
    throw new TokenKeyError('Falta SOCIAL_TOKEN_KEYS (claves para cifrar los tokens de las redes).');
  const keys = new Map<string, Uint8Array>();
  for (const entry of rawKeys
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const at = entry.indexOf(':');
    const id = at > 0 ? entry.slice(0, at) : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id))
      throw new TokenKeyError('SOCIAL_TOKEN_KEYS: cada clave va como «id:base64».');
    let key: Uint8Array;
    try {
      key = fromBase64(entry.slice(at + 1));
    } catch {
      throw new TokenKeyError(`SOCIAL_TOKEN_KEYS: la clave «${id}» no está en base64.`);
    }
    if (key.length !== 32) throw new TokenKeyError(`SOCIAL_TOKEN_KEYS: la clave «${id}» debe tener 32 bytes.`);
    keys.set(id, key);
  }
  const current = currentKeyId?.trim() || [...keys.keys()][0];
  if (!current || !keys.has(current)) {
    throw new TokenKeyError('SOCIAL_TOKEN_KEY_ID no coincide con ninguna clave de SOCIAL_TOKEN_KEYS.');
  }
  return { currentKeyId: current, keys };
}

/** Dato asociado que ata el texto cifrado a una cuenta. */
export function tokenBinding(p: { brandId: string; network: string; externalId: string }): string {
  return `rrss.social-token.v1|${p.brandId}|${p.network}|${p.externalId}`;
}

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function importKey(raw: Uint8Array): Promise<AesKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(
  ring: TokenKeyRing,
  plaintext: string,
  binding: string,
): Promise<{ keyId: string; ciphertext: string }> {
  const key = await importKey(ring.keys.get(ring.currentKeyId)!);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(binding) },
      key,
      encoder.encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return { keyId: ring.currentKeyId, ciphertext: toBase64(out) };
}

export async function decryptToken(
  ring: TokenKeyRing,
  keyId: string,
  ciphertext: string,
  binding: string,
): Promise<string> {
  const raw = ring.keys.get(keyId);
  if (!raw) throw new TokenKeyError(`No está la clave «${keyId}» con la que se cifró el token: no se puede descifrar.`);
  const bytes = fromBase64(ciphertext);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(binding) },
      await importKey(raw),
      bytes.slice(12),
    );
    return decoder.decode(plain);
  } catch {
    throw new TokenKeyError('El token cifrado no corresponde a esta cuenta o está dañado.');
  }
}
