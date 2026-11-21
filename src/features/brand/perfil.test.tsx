import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { BASE, BRAND_BASE, BRAND_ID, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { parseBrandConfig } from './config';

const PROFILE_URL = `${BRAND_BASE}/marca`;

function profileRow(version: number, status: 'active' | 'archived', description: string, extra: object = {}) {
  return {
    id: `perfil-${version}`,
    brand_id: BRAND_ID,
    organization_id: ORG_ID,
    version,
    status,
    schema_version: 1,
    data: {
      business: { description, products: [{ name: 'Menú del día', description: '' }] },
      voice: { tone: ['Cercano'] },
      visual: { logoAssetIds: ['logo-del-origen'], colors: [{ name: 'Verde', hex: '#2f6f4e', role: 'principal' }] },
      ...extra,
    },
    provenance: {},
    change_note: version === 1 ? 'Alta de la marca' : 'Ajuste del tono',
    created_by: 'user-me',
    created_at: `2026-11-0${version}T10:00:00Z`,
  };
}

function seedProfiles() {
  fake.tables.brand_profiles = [
    profileRow(1, 'archived', 'Primera versión'),
    profileRow(2, 'active', 'Cocina de mercado'),
  ];
  fake.rpc('save_brand_profile', (args) => {
    const version = fake.rows('brand_profiles').length + 1;
    for (const row of fake.rows('brand_profiles')) row.status = 'archived';
    const row = {
      ...profileRow(version, 'active', ''),
      id: `perfil-${version}`,
      data: args.p_data,
      change_note: args.p_change_note,
    };
    fake.rows('brand_profiles').push(row);
    return row;
  });
}

/** Captura lo que la app descarga: nombre de archivo y contenido. */
function captureDownload() {
  const blobs: Blob[] = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return 'blob:prueba';
  });
  URL.revokeObjectURL = vi.fn();
  let fileName = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    fileName = this.download;
  });
  return {
    fileName: () => fileName,
    text: () =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blobs[0]!);
      }),
  };
}

describe('Perfil de marca: edición y versiones', () => {
  beforeEach(() => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfiles();
  });

  it('muestra la versión vigente y la completitud', async () => {
    renderApp(PROFILE_URL);
    expect(await screen.findByText(/Perfil de Casa Demo · versión 2 · \d+% completo/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Descripción del negocio')).toHaveValue('Cocina de mercado');
  });

  it('un cambio aparece como pendiente y se guarda como versión nueva con su nota', async () => {
    const { user } = renderApp(PROFILE_URL);
    const description = await screen.findByLabelText('Descripción del negocio');
    expect(screen.queryByTestId('profile-save-bar')).not.toBeInTheDocument();

    await user.type(description, ' y de temporada');
    expect(await screen.findByText('Hay cambios sin guardar')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nota del cambio (opcional)'), 'Más detalle');
    await user.click(screen.getByRole('button', { name: 'Guardar versión' }));

    expect(await screen.findByText('Perfil guardado (versión 3)')).toBeInTheDocument();
    const call = fake.callsTo('save_brand_profile', 'rpc')[0]?.payload as {
      p_brand_id: string;
      p_change_note: string;
      p_data: { business: { description: string } };
    };
    expect(call.p_brand_id).toBe(BRAND_ID);
    expect(call.p_change_note).toBe('Más detalle');
    expect(call.p_data.business.description).toBe('Cocina de mercado y de temporada');
    await waitFor(() => expect(screen.queryByText('Hay cambios sin guardar')).not.toBeInTheDocument());
    expect(screen.getByText(/Perfil de Casa Demo · versión 3/)).toBeInTheDocument();
  });

  it('las reglas de publicación se editan en «Voz» y se guardan en la versión nueva', async () => {
    const { user } = renderApp(`${PROFILE_URL}?seccion=voz`);
    // El perfil de partida es anterior a estos campos: se lee sin quejarse y con todo vacío.
    expect(await screen.findByTestId('profile-emoji-policy')).toHaveValue('undefined');
    await user.type(screen.getByTestId('profile-hashtags-required'), '#MiMarca{Enter}');
    await user.type(screen.getByTestId('profile-hashtags-recommended'), 'Tapas{Enter}');
    await user.type(screen.getByTestId('profile-ctas'), 'Reserva tu mesa{Enter}');
    await user.selectOptions(screen.getByTestId('profile-emoji-policy'), 'yes');
    await user.type(screen.getByTestId('profile-emoji-max'), '3');
    await user.click(await screen.findByRole('button', { name: 'Guardar versión' }));
    await screen.findByText('Perfil guardado (versión 3)');
    const call = fake.callsTo('save_brand_profile', 'rpc')[0]?.payload as {
      p_data: { voice: { hashtags: unknown; callsToAction: string[]; emojis: unknown } };
    };
    expect(call.p_data.voice.hashtags).toEqual({ required: ['MiMarca'], recommended: ['Tapas'] });
    expect(call.p_data.voice.callsToAction).toEqual(['Reserva tu mesa']);
    expect(call.p_data.voice.emojis).toEqual({ allowed: true, max: 3 });
  });

  it('con «No se usan» no se pide el máximo de emojis', async () => {
    const { user } = renderApp(`${PROFILE_URL}?seccion=voz`);
    await user.selectOptions(await screen.findByTestId('profile-emoji-policy'), 'no');
    expect(screen.queryByTestId('profile-emoji-max')).not.toBeInTheDocument();
  });

  it('descartar devuelve lo guardado', async () => {
    const { user } = renderApp(PROFILE_URL);
    const description = await screen.findByLabelText('Descripción del negocio');
    await user.type(description, ' extra');
    await user.click(await screen.findByRole('button', { name: 'Descartar' }));
    expect(screen.getByLabelText('Descripción del negocio')).toHaveValue('Cocina de mercado');
    expect(screen.queryByText('Hay cambios sin guardar')).not.toBeInTheDocument();
    expect(fake.callsTo('save_brand_profile', 'rpc')).toHaveLength(0);
  });

  it('si el guardado falla lo explica y no pierde los cambios', async () => {
    fake.failNext('save_brand_profile', 'rpc', { code: '42501', message: 'permission denied' });
    const { user } = renderApp(PROFILE_URL);
    await user.type(await screen.findByLabelText('Descripción del negocio'), ' extra');
    await user.click(await screen.findByRole('button', { name: 'Guardar versión' }));
    expect(await screen.findByText('No tienes permiso para hacer esto.')).toBeInTheDocument();
    expect(screen.getByLabelText('Descripción del negocio')).toHaveValue('Cocina de mercado extra');
    expect(screen.getByText('Hay cambios sin guardar')).toBeInTheDocument();
  });

  it('el historial lista las versiones con autor y nota, y marca la vigente', async () => {
    const { user } = renderApp(PROFILE_URL);
    await user.click(await screen.findByRole('button', { name: /Historial/ }));
    const list = await screen.findByTestId('history-list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Más reciente primero.
    expect(items[0]).toHaveTextContent('Versión 2');
    expect(items[0]).toHaveTextContent('Vigente');
    expect(items[0]).toHaveTextContent('Yo Mismo');
    expect(items[0]).toHaveTextContent('«Ajuste del tono»');
    expect(items[1]).toHaveTextContent('Versión 1');
    expect(items[1]).not.toHaveTextContent('Vigente');
  });

  it('se puede restaurar una versión antigua: crea otra versión nueva con esos datos', async () => {
    const { user } = renderApp(PROFILE_URL);
    await user.click(await screen.findByRole('button', { name: /Historial/ }));
    const list = await screen.findByTestId('history-list');
    await user.click(within(within(list).getAllByRole('listitem')[1]!).getByRole('button', { name: 'Ver' }));

    expect(await screen.findByRole('heading', { name: 'Versión 1' })).toBeInTheDocument();
    // La versión se ve en solo lectura.
    expect(await within(screen.getByRole('dialog')).findByDisplayValue('Primera versión')).toBeDisabled();
    await user.click(await screen.findByTestId('history-restore'));

    expect(await screen.findByText('Perfil guardado (versión 3)')).toBeInTheDocument();
    const call = fake.callsTo('save_brand_profile', 'rpc')[0]?.payload as {
      p_change_note: string;
      p_data: { business: { description: string } };
    };
    expect(call.p_change_note).toBe('Restaurada la versión 1');
    expect(call.p_data.business.description).toBe('Primera versión');
    // Nada se pierde: las dos anteriores siguen ahí.
    expect(fake.rows('brand_profiles')).toHaveLength(3);
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Versión 1/ })).not.toBeInTheDocument());
  });

  it('la versión vigente no ofrece restaurarse', async () => {
    const { user } = renderApp(PROFILE_URL);
    await user.click(await screen.findByRole('button', { name: /Historial/ }));
    const list = await screen.findByTestId('history-list');
    await user.click(within(within(list).getAllByRole('listitem')[0]!).getByRole('button', { name: 'Ver' }));
    expect(await screen.findByRole('heading', { name: 'Versión 2' })).toBeInTheDocument();
    expect(screen.queryByTestId('history-restore')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Todas las versiones/ }));
    expect(await screen.findByTestId('history-list')).toBeInTheDocument();
  });

  it('sin ninguna versión guardada, el historial lo dice', async () => {
    fake.tables.brand_profiles = [];
    const { user } = renderApp(PROFILE_URL);
    expect(await screen.findByText(/sin guardar todavía/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Historial/ }));
    expect(await screen.findByText('Todavía no se ha guardado ninguna versión.')).toBeInTheDocument();
  });
});

describe('Perfil de marca: exportar JSON', () => {
  beforeEach(() => {
    seedWorkspace({ orgRole: 'owner' });
    seedProfiles();
  });

  it('descarga un archivo con el nombre de la marca, el perfil guardado y sin los logotipos de origen', async () => {
    const download = captureDownload();
    const { user } = renderApp(PROFILE_URL);
    await user.click(await screen.findByRole('button', { name: /Descargar configuración/ }));

    expect(download.fileName()).toBe('casa-demo.brand-config.json');
    const parsed = parseBrandConfig(await download.text());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.brand).toMatchObject({ name: 'Casa Demo', sector: 'Restauración', default_locale: 'es' });
    expect(parsed.config.profile.business.description).toBe('Cocina de mercado');
    expect(parsed.config.profile.voice.tone).toEqual(['Cercano']);
    expect(parsed.config.profile.visual.logoAssetIds).toEqual([]);
  });

  it('exporta lo guardado, no los cambios aún sin guardar', async () => {
    const download = captureDownload();
    const { user } = renderApp(PROFILE_URL);
    await user.type(await screen.findByLabelText('Descripción del negocio'), ' SIN GUARDAR');
    await user.click(screen.getByRole('button', { name: /Descargar configuración/ }));
    expect(await download.text()).not.toContain('SIN GUARDAR');
  });

  it('lo exportado se puede importar en el asistente de otra marca y llega intacto al resumen', async () => {
    const download = captureDownload();
    const first = renderApp(PROFILE_URL);
    await first.user.click(await screen.findByRole('button', { name: /Descargar configuración/ }));
    const text = await download.text();
    first.unmount();

    const second = renderApp(`${BASE}/marcas/nueva`);
    await second.user.upload(
      await screen.findByTestId('wizard-import-input'),
      new File([text], 'casa-demo.brand-config.json', { type: 'application/json' }),
    );
    const summary = within(await screen.findByTestId('wizard-summary'));
    expect(summary.getByText('Casa Demo')).toBeInTheDocument();
    expect(summary.getByText('Cercano')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-import-errors')).not.toBeInTheDocument();
  });
});

describe('Perfil de marca: quien solo puede mirar', () => {
  beforeEach(() => {
    seedWorkspace({ orgRole: 'member', brandRole: 'viewer' });
    seedProfiles();
  });

  it('ve el perfil sin poder editarlo ni guardar', async () => {
    renderApp(PROFILE_URL);
    expect(await screen.findByLabelText('Descripción del negocio')).toBeDisabled();
    expect(screen.queryByTestId('profile-save-bar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar versión' })).not.toBeInTheDocument();
  });

  it('puede consultar el historial pero no restaurar', async () => {
    const { user } = renderApp(PROFILE_URL);
    await user.click(await screen.findByRole('button', { name: /Historial/ }));
    const list = await screen.findByTestId('history-list');
    await user.click(within(within(list).getAllByRole('listitem')[1]!).getByRole('button', { name: 'Ver' }));
    expect(await screen.findByRole('heading', { name: 'Versión 1' })).toBeInTheDocument();
    await within(screen.getByRole('dialog')).findByDisplayValue('Primera versión');
    expect(screen.queryByTestId('history-restore')).not.toBeInTheDocument();
  });

  it('en «Datos de la marca» no hay guardar ni archivar', async () => {
    renderApp(`${PROFILE_URL}?seccion=datos`);
    expect(await screen.findByLabelText('Nombre comercial')).toBeDisabled();
    expect(screen.queryByTestId('brand-data-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brand-archive')).not.toBeInTheDocument();
  });
});
