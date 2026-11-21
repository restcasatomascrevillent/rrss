import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentItemRow, ContentVersionRow } from '@/lib/database.types';

// Fake mínimo del cliente de Supabase: registra cada consulta y cada RPC, y
// responde lo que la prueba configure por tabla y operación o por función.
interface Recorded {
  target: string;
  payload?: unknown;
  filters: [string, ...unknown[]][];
}
const state = vi.hoisted(() => ({
  calls: [] as Recorded[],
  responses: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const call: Recorded = { target: `${table}:select`, filters: [] };
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'is', 'not', 'in', 'ilike', 'order', 'range', 'limit', 'single']) {
      chain[name] = (...args: unknown[]) => {
        if (name !== 'select' && name !== 'single') call.filters.push([name, ...args]);
        return chain;
      };
    }
    for (const op of ['insert', 'update']) {
      chain[op] = (payload: unknown) => {
        call.target = `${table}:${op}`;
        call.payload = payload;
        return chain;
      };
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      state.calls.push(call);
      return Promise.resolve(state.responses[call.target] ?? { data: [], error: null }).then(resolve, reject);
    };
    return chain;
  };
  const rpc = async (fn: string, args: unknown) => {
    state.calls.push({ target: `rpc:${fn}`, payload: args, filters: [] });
    return state.responses[`rpc:${fn}`] ?? { data: null, error: null };
  };
  return { supabaseConfigured: true, supabase: { from, rpc } };
});

import {
  CONTENT_VERSION_CONFLICT,
  archiveContentItem,
  contentKeys,
  createContentItem,
  fetchContent,
  isVersionConflict,
  readVersionDocument,
  restoreContentVersion,
  saveContentVersion,
  setContentStatus,
  updateContentItem,
  useContentMutations,
} from './api';
import { DOCUMENT_SCHEMA_VERSION, DocumentError, createEmptyDocument } from './document';

const ITEM: ContentItemRow = {
  id: 'c1',
  brand_id: 'b1',
  organization_id: 'o1',
  title: 'Menú de otoño',
  network: 'instagram',
  format: 'post',
  status: 'draft',
  current_version: 2,
  archived_at: null,
  created_by: 'u1',
  created_at: '2026-11-17T10:00:00Z',
  updated_at: '2026-11-17T10:00:00Z',
};

const versionRow = (data: unknown, version = 2): ContentVersionRow => ({
  id: `v${version}`,
  content_id: 'c1',
  brand_id: 'b1',
  organization_id: 'o1',
  version,
  schema_version: 1,
  data: data as ContentVersionRow['data'],
  change_note: '',
  restored_from: null,
  created_by: 'u1',
  created_at: '2026-11-17T10:00:00Z',
});

const respond = (target: string, data: unknown, error: unknown = null) => {
  state.responses[target] = { data, error };
};
const targets = () => state.calls.map((call) => call.target);

beforeEach(() => {
  state.calls = [];
  state.responses = {};
});

describe('createContentItem', () => {
  it('crea la pieza con el título limpio, en la marca y organización indicadas', async () => {
    respond('content_items:insert', ITEM);
    const created = await createContentItem({
      organizationId: 'o1',
      brandId: 'b1',
      title: '  Menú de otoño ',
      network: 'instagram',
      format: 'post',
    });
    expect(created).toBe(ITEM);
    expect(state.calls).toEqual([
      {
        target: 'content_items:insert',
        payload: {
          brand_id: 'b1',
          organization_id: 'o1',
          title: 'Menú de otoño',
          network: 'instagram',
          format: 'post',
        },
        filters: [],
      },
    ]);
  });

  it('no llega al servidor sin nombre o con una red y formato que no existen', async () => {
    const base = { organizationId: 'o1', brandId: 'b1', title: 'x', network: 'instagram', format: 'post' };
    await expect(createContentItem({ ...base, title: '   ' })).rejects.toThrow('Ponle un nombre al contenido.');
    await expect(createContentItem({ ...base, title: 'x'.repeat(201) })).rejects.toThrow(/demasiado largo/);
    await expect(createContentItem({ ...base, format: 'short' })).rejects.toThrow(/red y formato no existe/);
    await expect(createContentItem({ ...base, network: 'myspace' })).rejects.toThrow(/red y formato no existe/);
    expect(state.calls).toEqual([]);
  });

  it('propaga el rechazo de la base de datos', async () => {
    respond('content_items:insert', null, { code: '42501', message: 'new row violates row-level security policy' });
    await expect(
      createContentItem({ organizationId: 'o1', brandId: 'b1', title: 'x', network: 'instagram', format: 'post' }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('updateContentItem', () => {
  it('cambia el título, o la red y el formato a la vez', async () => {
    respond('content_items:update', [ITEM]);
    await updateContentItem({ contentId: 'c1', title: ' Otro ' });
    await updateContentItem({ contentId: 'c1', target: { network: 'instagram', format: 'reel' } });
    expect(state.calls.map((call) => call.payload)).toEqual([
      { title: 'Otro' },
      { network: 'instagram', format: 'reel' },
    ]);
    expect(state.calls[0]!.filters).toEqual([['eq', 'id', 'c1']]);
  });

  it('rechaza un destino que no existe y un cambio vacío sin llegar al servidor', async () => {
    await expect(updateContentItem({ contentId: 'c1', target: { network: 'x', format: 'reel' } })).rejects.toThrow(
      /red y formato no existe/,
    );
    await expect(updateContentItem({ contentId: 'c1' })).rejects.toThrow(/ningún cambio/);
    expect(state.calls).toEqual([]);
  });

  it('si no cambia ninguna fila (sin permiso o archivada) lo dice como falta de permiso', async () => {
    respond('content_items:update', []);
    await expect(updateContentItem({ contentId: 'c1', title: 'x' })).rejects.toMatchObject({ code: '42501' });
  });
});

describe('saveContentVersion', () => {
  it('guarda el documento normalizado, con su versión de esquema y la versión esperada', async () => {
    const saved = versionRow({}, 3);
    respond('rpc:save_content_version', saved);
    const document = { ...createEmptyDocument(), copy: { caption: 'Hola', hashtags: ['#otoño'] } };

    expect(await saveContentVersion({ contentId: 'c1', document, note: 'Con pie', expectedVersion: 2 })).toBe(saved);
    expect(state.calls).toEqual([
      {
        target: 'rpc:save_content_version',
        payload: {
          p_content_id: 'c1',
          p_data: expect.objectContaining({
            schemaVersion: DOCUMENT_SCHEMA_VERSION,
            copy: expect.objectContaining({ caption: 'Hola', hashtags: ['otoño'], mentions: [] }),
          }),
          p_schema_version: DOCUMENT_SCHEMA_VERSION,
          p_change_note: 'Con pie',
          p_expected_version: 2,
        },
        filters: [],
      },
    ]);
  });

  it('sin nota ni versión esperada manda una nota vacía y ninguna comprobación', async () => {
    respond('rpc:save_content_version', versionRow({}));
    await saveContentVersion({ contentId: 'c1', document: createEmptyDocument() });
    expect(state.calls[0]!.payload).toMatchObject({ p_change_note: '', p_expected_version: null });
  });

  it('un documento que no cumple el esquema no llega al servidor', async () => {
    const broken = { ...createEmptyDocument(), pages: [{ id: 'p1', layers: [{ id: 'a', type: 'text' }] }] } as never;
    const error = await saveContentVersion({ contentId: 'c1', document: broken }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).reason).toBe('invalid');
    expect((error as DocumentError).issues.length).toBeGreaterThan(0);
    expect(state.calls).toEqual([]);
  });

  it('el aviso de que otra persona guardó antes se reconoce con isVersionConflict', async () => {
    const conflict = { code: CONTENT_VERSION_CONFLICT, message: 'Otra persona ha guardado una versión más reciente' };
    respond('rpc:save_content_version', null, conflict);
    const error = await saveContentVersion({
      contentId: 'c1',
      document: createEmptyDocument(),
      expectedVersion: 1,
    }).catch((e: unknown) => e);
    expect(isVersionConflict(error)).toBe(true);
    expect(isVersionConflict({ code: '42501' })).toBe(false);
    expect(isVersionConflict(new Error('x'))).toBe(false);
    expect(isVersionConflict(null)).toBe(false);
  });
});

describe('restaurar, cambiar de estado y archivar', () => {
  it('llaman a su función con los argumentos justos', async () => {
    respond('rpc:restore_content_version', versionRow({}, 4));
    respond('rpc:set_content_status', ITEM);
    respond('rpc:archive_content_item', ITEM);

    await restoreContentVersion({ contentId: 'c1', version: 1, expectedVersion: 3 });
    await setContentStatus({ contentId: 'c1', status: 'approved', expectedVersion: 4 });
    await setContentStatus({ contentId: 'c1', status: 'in_review' });
    await archiveContentItem({ contentId: 'c1' });
    await archiveContentItem({ contentId: 'c1', archived: false });

    expect(state.calls.map((call) => [call.target, call.payload])).toEqual([
      ['rpc:restore_content_version', { p_content_id: 'c1', p_version: 1, p_change_note: '', p_expected_version: 3 }],
      ['rpc:set_content_status', { p_content_id: 'c1', p_status: 'approved', p_expected_version: 4 }],
      ['rpc:set_content_status', { p_content_id: 'c1', p_status: 'in_review', p_expected_version: null }],
      ['rpc:archive_content_item', { p_content_id: 'c1', p_archived: true }],
      ['rpc:archive_content_item', { p_content_id: 'c1', p_archived: false }],
    ]);
  });
});

describe('leer', () => {
  it('readVersionDocument devuelve el documento en el esquema actual', () => {
    const document = createEmptyDocument({ aspectRatio: '4:5' });
    const loaded = readVersionDocument(versionRow(document));
    expect(loaded).toEqual({ row: versionRow(document), document, documentError: null });
  });

  it('una versión ilegible no lanza: dice por qué y deja ver el resto', () => {
    expect(readVersionDocument(versionRow({ schemaVersion: 1, canvas: 'roto' }))).toMatchObject({
      document: null,
      documentError: 'El documento no es válido.',
    });
    expect(readVersionDocument(versionRow({ schemaVersion: 99 })).documentError).toMatch(/versión más reciente/);
    expect(readVersionDocument(versionRow(null)).document).toBeNull();
  });

  it('fetchContent trae la pieza con su versión vigente', async () => {
    const document = createEmptyDocument();
    respond('content_items:select', ITEM);
    respond('content_versions:select', versionRow(document));

    const loaded = await fetchContent('c1');
    expect(loaded.item).toBe(ITEM);
    expect(loaded.current?.document).toEqual(document);
    expect(targets()).toEqual(['content_items:select', 'content_versions:select']);
    expect(state.calls[1]!.filters).toEqual([
      ['eq', 'content_id', 'c1'],
      ['eq', 'version', 2],
    ]);
  });

  it('una idea sin documento no pide ninguna versión', async () => {
    respond('content_items:select', { ...ITEM, status: 'idea', current_version: 0 });
    expect((await fetchContent('c1')).current).toBeNull();
    expect(targets()).toEqual(['content_items:select']);
  });
});

describe('useContentMutations', () => {
  function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = renderHook(() => useContentMutations('o1', 'b1'), { wrapper });
    return { hook, invalidate };
  }

  it('no expone `mutate`: lo que sigue a un cambio cuelga de la promesa', () => {
    const { hook } = setup();
    for (const mutation of Object.values(hook.result.current)) {
      expect(Object.keys(mutation).sort()).toEqual(['error', 'isPending', 'mutateAsync', 'reset']);
    }
    expect(Object.keys(hook.result.current).sort()).toEqual([
      'archive',
      'create',
      'restore',
      'saveVersion',
      'setStatus',
      'update',
    ]);
  });

  it('la promesa se resuelve, con las listas refrescadas, aunque la pantalla ya no esté montada', async () => {
    respond('rpc:archive_content_item', { ...ITEM, archived_at: '2026-11-17T11:00:00Z' });
    const { hook, invalidate } = setup();

    let after = 'nada';
    let promise: Promise<void> | undefined;
    act(() => {
      promise = hook.result.current.archive.mutateAsync({ contentId: 'c1' }).then((item) => {
        after = `archivada ${item.archived_at}`;
      });
    });
    hook.unmount(); // la pieza desaparece de la lista y su ficha se desmonta
    await act(async () => {
      await promise;
    });

    expect(after).toBe('archivada 2026-11-17T11:00:00Z');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: contentKeys.all('b1') });
  });

  it('crear usa la organización y la marca del hook, y un fallo rechaza la promesa', async () => {
    respond('content_items:insert', ITEM);
    const { hook, invalidate } = setup();
    await act(async () => {
      await hook.result.current.create.mutateAsync({ title: 'Nueva', network: 'tiktok', format: 'video' });
    });
    expect(state.calls[0]!.payload).toMatchObject({ brand_id: 'b1', organization_id: 'o1', network: 'tiktok' });
    expect(invalidate).toHaveBeenCalledTimes(1);

    let failure: unknown;
    await act(async () => {
      failure = await hook.result.current.create
        .mutateAsync({ title: '', network: 'tiktok', format: 'video' })
        .catch((e: unknown) => e);
    });
    expect((failure as Error).message).toBe('Ponle un nombre al contenido.');
    expect(invalidate).toHaveBeenCalledTimes(1); // un fallo no refresca nada
  });
});
