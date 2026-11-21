import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake mínimo del cliente de Supabase: registra las llamadas y responde lo que
// se le configure por tabla/operación.
const state = vi.hoisted(() => ({
  calls: [] as string[],
  queue: [] as { storage_path: string }[],
  deleteAssetRows: [{ id: 'a1', storage_path: 'o/b/media/1-a.png' }] as { id: string; storage_path: string }[],
  removeError: null as { message: string } | null,
  mediaStorage: false,
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let op = 'select';
    const chain: Record<string, unknown> = {};
    const result = () => {
      if (table === 'storage_cleanup_queue' && op === 'select') return { data: state.queue, error: null };
      if (table === 'storage_cleanup_queue' && op === 'delete') return { data: null, error: null };
      if (table === 'media_assets' && op === 'delete') return { data: state.deleteAssetRows, error: null };
      return { data: [], error: null };
    };
    for (const name of ['select', 'eq', 'order', 'limit', 'in']) chain[name] = () => chain;
    chain.delete = () => {
      op = 'delete';
      state.calls.push(`delete ${table}`);
      return chain;
    };
    chain.then = (resolve: (value: unknown) => unknown) => resolve(result());
    return chain;
  };
  return {
    supabaseConfigured: true,
    supabase: {
      from: builder,
      storage: {
        from: () => ({
          remove: async (paths: string[]) => {
            state.calls.push(`remove ${paths.join(',')}`);
            return { data: [], error: state.removeError };
          },
          createSignedUrls: async (paths: string[]) => {
            state.calls.push(`firma supabase ${paths.join(',')}`);
            return { data: paths.map((path) => ({ path, signedUrl: `https://supabase.test/${path}` })), error: null };
          },
        }),
      },
      // Edge Functions: disponibilidad de R2 y `media-storage`.
      functions: {
        invoke: async (name: string, options: { body?: { paths?: string[] } } = {}) => {
          if (name === 'platform-integrations') return { data: { mediaStorage: state.mediaStorage }, error: null };
          state.calls.push(`${name} ${(options.body?.paths ?? []).join(',')}`);
          const paths = options.body?.paths ?? [];
          if (name === 'media-storage/discard') return { data: { removed: paths, failed: [] }, error: null };
          if (name === 'media-storage/delete') return { data: { removed: paths, failed: [] }, error: null };
          if (name === 'media-storage/sign') {
            const urls = Object.fromEntries(
              paths.filter((p) => p.includes('/r2-')).map((p) => [p, `https://r2.test/${p}`]),
            );
            return { data: { urls }, error: null };
          }
          return { data: null, error: new Error('sin simular') };
        },
      },
    },
  };
});

import { discardUploadedMedia, resetMediaStorageAvailability, signStoragePaths } from '@/features/storage/api';
import { deleteAssets, sortFacets, sweepStorageCleanup } from './api';

beforeEach(() => {
  state.calls = [];
  state.queue = [];
  state.removeError = null;
  state.mediaStorage = false;
  resetMediaStorageAvailability();
});

describe('sweepStorageCleanup', () => {
  it('no hace nada si la cola está vacía', async () => {
    expect(await sweepStorageCleanup('brand')).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it('borra los archivos anotados y después sus anotaciones', async () => {
    state.queue = [{ storage_path: 'o/b/media/1-a.jpg' }, { storage_path: 'o/b/media/2-b.jpg' }];
    expect(await sweepStorageCleanup('brand')).toBe(2);
    expect(state.calls).toEqual(['remove o/b/media/1-a.jpg,o/b/media/2-b.jpg', 'delete storage_cleanup_queue']);
  });

  it('si Storage falla conserva las anotaciones para reintentar', async () => {
    state.queue = [{ storage_path: 'o/b/media/1-a.jpg' }];
    state.removeError = { message: 'boom' };
    expect(await sweepStorageCleanup('brand')).toBe(0);
    expect(state.calls).toEqual(['remove o/b/media/1-a.jpg']);
  });
});

describe('deleteAssets', () => {
  it('borra la fila y después el archivo y su anotación', async () => {
    await deleteAssets(['a1']);
    expect(state.calls).toEqual(['delete media_assets', 'remove o/b/media/1-a.png', 'delete storage_cleanup_queue']);
  });

  it('no hace nada sin ids', async () => {
    await deleteAssets([]);
    expect(state.calls).toEqual([]);
  });
});

describe('sortFacets', () => {
  it('ordena en castellano y quita repetidos y vacíos', () => {
    expect(sortFacets(['útil', 'zeta', 'abeto', 'abeto', ''], ['verano', '', 'Ñandú'])).toEqual({
      tags: ['abeto', 'útil', 'zeta'],
      folders: ['Ñandú', 'verano'],
    });
  });
});

describe('con Cloudflare R2 en el servidor', () => {
  it('borrar pasa por media-storage, que borra cada archivo en su almacén y su anotación', async () => {
    state.mediaStorage = true;
    await deleteAssets(['a1']);
    expect(state.calls).toEqual(['delete media_assets', 'media-storage/delete o/b/media/1-a.png']);
  });

  it('firmar: lo de R2 lo firma el servidor; el resto, Supabase con la sesión', async () => {
    state.mediaStorage = true;
    const urls = await signStoragePaths(['o/b/media/r2-a.jpg', 'o/b/media/b.jpg'], 3600);
    expect(urls.get('o/b/media/r2-a.jpg')).toBe('https://r2.test/o/b/media/r2-a.jpg');
    expect(urls.get('o/b/media/b.jpg')).toBe('https://supabase.test/o/b/media/b.jpg');
    expect(state.calls).toEqual([
      'media-storage/sign o/b/media/r2-a.jpg,o/b/media/b.jpg',
      'firma supabase o/b/media/b.jpg',
    ]);
  });

  it('sin R2, ni se pregunta a media-storage', async () => {
    await signStoragePaths(['o/b/media/r2-a.jpg'], 3600);
    expect(state.calls).toEqual(['firma supabase o/b/media/r2-a.jpg']);
  });
});

describe('borrado compensatorio de un alta fallida', () => {
  it('con R2, pide al servidor que borre el archivo subido sin recurso', async () => {
    state.mediaStorage = true;
    await discardUploadedMedia('o/b/media/1-a.jpg');
    expect(state.calls).toEqual(['media-storage/discard o/b/media/1-a.jpg']);
  });

  it('sin R2 no llama a nada (Supabase ya lo borra el cliente)', async () => {
    await discardUploadedMedia('o/b/media/1-a.jpg');
    expect(state.calls).toEqual([]);
  });
});
