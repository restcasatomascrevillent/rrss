// scripts/miniaturas-biblioteca.ts: plan, recuento en seco y ejecución con un
// almacén y una base de datos simulados (sin sharp ni red).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ObjectStorage, StorageBackend } from '../../supabase/functions/_shared/storage/contract.ts';
import {
  formatThumbSummary,
  planThumbs,
  runThumbs,
  thumbKey,
  type AssetToThumb,
  type ThumbDb,
} from '../../scripts/miniaturas-biblioteca.ts';

const ORG = randomUUID();
const BRAND = randomUUID();
const asset = (over: Partial<AssetToThumb> = {}): AssetToThumb => {
  const id = randomUUID();
  return {
    id,
    organization_id: ORG,
    brand_id: BRAND,
    storage_path: `${ORG}/${BRAND}/media/${id}-foto.jpg`,
    mime_type: 'image/jpeg',
    bytes: 900_000,
    storage_backend: 'r2',
    ...over,
  };
};

function memory(backend: StorageBackend) {
  const objects = new Map<string, number>();
  const store = {
    backend,
    objects,
    signGet: async (key: string) => `https://${backend}.test/${key}`,
    signPut: async () => {
      throw new Error('no se usa');
    },
    head: async () => null,
    put: async (key: string, _b: Uint8Array | ReadableStream<Uint8Array>, _t: string, bytes: number) => {
      objects.set(key, bytes);
    },
    remove: async () => ({ failed: [] }),
    list: async () => [],
  } as unknown as ObjectStorage & { objects: Map<string, number> };
  return store;
}

function fakeDb(rows: AssetToThumb[]) {
  const registered: string[] = [];
  const thumbs = new Map<string, string>();
  const db: ThumbDb = {
    async page(after, size) {
      return rows
        .filter((r) => !thumbs.has(r.id) && (!after || r.id > after))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, size);
    },
    async registerR2(path) {
      registered.push(path);
    },
    async setThumb(id, path) {
      if (thumbs.has(id)) return false;
      thumbs.set(id, path);
      return true;
    },
  };
  return { db, registered, thumbs };
}

describe('planThumbs', () => {
  it('salta lo pequeño y lo que no se sabe leer', () => {
    const plan = planThumbs([asset(), asset({ bytes: 1000 }), asset({ mime_type: 'image/gif' })]);
    expect(plan.todo).toHaveLength(1);
    expect(Object.keys(plan.skipped)).toHaveLength(2);
  });
  it('el resumen cuenta por marca y almacén', () => {
    const text = formatThumbSummary(planThumbs([asset(), asset(), asset({ storage_backend: 'supabase' })]));
    expect(text).toContain(`${BRAND} | r2 | 2`);
    expect(text).toContain('TOTAL | 3 miniaturas');
  });
});

describe('runThumbs', () => {
  const makeThumb = async () => new Uint8Array(30_000);
  const download = async () => new Uint8Array(900_000);

  it('sube la miniatura al mismo almacén, apunta R2 y guarda thumb_path', async () => {
    const rows = [asset(), asset({ storage_backend: 'supabase' })];
    const { db, registered, thumbs } = fakeDb(rows);
    const r2 = memory('r2');
    const sb = memory('supabase');
    const res = await runThumbs({ db, storeFor: (b) => (b === 'r2' ? r2 : sb), makeThumb, download });
    expect(res.created).toBe(2);
    expect(r2.objects.get(thumbKey(rows[0]!))).toBe(30_000);
    expect(sb.objects.get(thumbKey(rows[1]!))).toBe(30_000);
    expect(registered).toEqual([thumbKey(rows[0]!)]); // solo R2 se apunta
    expect(thumbs.get(rows[0]!.id)).toBe(thumbKey(rows[0]!));
  });

  it('relanzar no duplica nada', async () => {
    const { db, thumbs } = fakeDb([asset(), asset()]);
    const r2 = memory('r2');
    await runThumbs({ db, storeFor: () => r2, makeThumb, download });
    const again = await runThumbs({ db, storeFor: () => r2, makeThumb, download });
    expect(again.created).toBe(0);
    expect(thumbs.size).toBe(2);
  });

  it('respeta --limit y cuenta los fallos sin parar', async () => {
    const { db } = fakeDb([asset(), asset(), asset()]);
    const r2 = memory('r2');
    const limited = await runThumbs({ db, storeFor: () => r2, makeThumb, download, limit: 2 });
    expect(limited.created).toBe(2);
    const { db: db2 } = fakeDb([asset(), asset()]);
    const bad = await runThumbs({
      db: db2,
      storeFor: () => r2,
      makeThumb,
      download: async () => {
        throw new Error('red caída');
      },
    });
    expect(bad.created).toBe(0);
    expect(bad.failed).toHaveLength(2);
  });

  it('una miniatura que no pesa menos que el original no se sube', async () => {
    const { db } = fakeDb([asset()]);
    const r2 = memory('r2');
    const res = await runThumbs({ db, storeFor: () => r2, makeThumb: async () => new Uint8Array(950_000), download });
    expect(res.created).toBe(0);
    expect(r2.objects.size).toBe(0);
  });
});
