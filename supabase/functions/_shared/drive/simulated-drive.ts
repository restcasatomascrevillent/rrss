// Google Drive SIMULADO para las pruebas (unitarias y de extremo a extremo en
// local). Vive en memoria: un Drive con dos carpetas, imágenes PNG de verdad
// (pequeñas, de un color) y un HEIC que el navegador no pinta. El OAuth no
// tiene diálogo: el código se cambia por tokens inventados.
//
// Solo se usa con la guarda de local-test.ts (o desde las pruebas). No es Google.
import { DriveApiError, FOLDER_MIME, type DriveApi, type DriveFile, type DriveTokens } from './contract.ts';

export const SIMULATED_DRIVE_EMAIL = 'drive-simulado@pruebas.test';

// ── PNG mínimo (sin compresión) para que las imágenes se puedan pintar ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: Uint8Array): number[] {
  const head = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(head.length + data.length);
  body.set(head);
  body.set(data, head.length);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** PNG RGB de un solo color. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) raw.set(rgb, y * row + 1 + x * 3);
  }
  // zlib con bloques «stored» (hasta 65535 bytes cada uno) y Adler-32.
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(last, part.length & 0xff, part.length >> 8, ~part.length & 0xff, (~part.length >> 8) & 0xff, ...part);
  }
  let a = 1;
  let b = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push(...u32(((b << 16) | a) >>> 0));
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 2, 0, 0, 0]);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(blocks)),
    ...chunk('IEND', new Uint8Array()),
  ]);
}

// ── El Drive en memoria ──

interface Entry {
  file: DriveFile;
  parent: string;
  bytes: Uint8Array | null;
}

export interface SimulatedDrive extends DriveApi {
  /** Llamadas a la API (para comprobar en las pruebas). */
  calls: string[];
  /** Hace que el token de refresco deje de valer (Google lo revoca). */
  revoke(): void;
  entries(): DriveFile[];
}

export function createSimulatedDrive(): SimulatedDrive {
  const entries = new Map<string, Entry>();
  const add = (
    id: string,
    name: string,
    mimeType: string,
    parent: string,
    png?: Uint8Array,
    w?: number,
    h?: number,
  ) => {
    entries.set(id, {
      parent,
      bytes: png ?? (mimeType === FOLDER_MIME ? null : new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])),
      file: {
        id,
        name,
        mimeType,
        bytes: png ? png.length : mimeType === FOLDER_MIME ? null : 2_400_000,
        width: w ?? null,
        height: h ?? null,
        modifiedTime: '2026-11-15T10:00:00.000Z',
        thumbnailLink: null,
        trashed: false,
      },
    });
  };
  add('simFolderPlatos0001', 'Platos', FOLDER_MIME, 'root');
  add('simFolderLocal00001', 'Local', FOLDER_MIME, 'root');
  add(
    'simImgCoca00000001',
    'Coca de verduras.png',
    'image/png',
    'simFolderPlatos0001',
    solidPng(96, 64, [196, 92, 38]),
    96,
    64,
  );
  add(
    'simImgArroz0000001',
    'Arroz del señoret.png',
    'image/png',
    'simFolderPlatos0001',
    solidPng(64, 64, [222, 170, 60]),
    64,
    64,
  );
  add('simImgSala00000001', 'Sala.png', 'image/png', 'simFolderLocal00001', solidPng(80, 60, [70, 110, 90]), 80, 60);
  add('simImgHeic00000001', 'IMG_0001.HEIC', 'image/heic', 'simFolderPlatos0001');

  let revoked = false;
  let issued = 0;
  const calls: string[] = [];
  const valid = new Set<string>();
  const newTokens = (withRefresh: boolean): DriveTokens => {
    issued++;
    const accessToken = `sim-access-${issued}`;
    valid.add(accessToken);
    return {
      accessToken,
      refreshToken: withRefresh ? `sim-refresh-${issued}` : null,
      expiresInSeconds: 3600,
      scopes: ['https://www.googleapis.com/auth/drive.readonly', 'openid', 'email'],
    };
  };
  const check = (accessToken: string) => {
    if (!valid.has(accessToken)) throw new DriveApiError(401, 'authError', 'Token no válido (simulado)');
  };
  const find = (fileId: string) => {
    const entry = entries.get(fileId);
    if (!entry) throw new DriveApiError(404, 'notFound', 'Archivo no encontrado (simulado)');
    return entry;
  };

  return {
    calls,
    revoke() {
      revoked = true;
      valid.clear();
    },
    entries: () => [...entries.values()].map((e) => e.file),
    authUrl({ redirectUri, state }) {
      const u = new URL(redirectUri);
      u.searchParams.set('code', `sim-code-${crypto.randomUUID()}`);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchangeCode({ code }) {
      calls.push('exchangeCode');
      if (!code.startsWith('sim-code-')) throw new DriveApiError(400, 'invalid_grant', 'Código no válido (simulado)');
      revoked = false;
      return newTokens(true);
    },
    async refresh({ refreshToken }) {
      calls.push('refresh');
      if (revoked || !refreshToken.startsWith('sim-refresh-')) {
        throw new DriveApiError(400, 'invalid_grant', 'Token de refresco revocado (simulado)');
      }
      return newTokens(false);
    },
    async whoAmI(accessToken) {
      check(accessToken);
      return { email: SIMULATED_DRIVE_EMAIL, name: 'Drive simulado' };
    },
    async list(accessToken, { folderId }) {
      check(accessToken);
      calls.push(`list:${folderId}`);
      const files = [...entries.values()]
        .filter((e) => e.parent === folderId)
        .map((e) => e.file)
        .sort(
          (x, y) =>
            Number(y.mimeType === FOLDER_MIME) - Number(x.mimeType === FOLDER_MIME) || x.name.localeCompare(y.name),
        );
      return { files, nextPageToken: null };
    },
    async get(accessToken, fileId) {
      check(accessToken);
      return find(fileId).file;
    },
    async media(accessToken, file) {
      check(accessToken);
      calls.push(`media:${file.id}`);
      const entry = find(file.id);
      if (!entry.bytes) throw new DriveApiError(400, 'notDownloadable', 'Es una carpeta (simulado)');
      return new Response(entry.bytes, { headers: { 'content-type': entry.file.mimeType } });
    },
  };
}
