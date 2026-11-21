import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fake } from '@/test/fakeSupabase';
import { addPerson, BASE, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';
import { exportBrandConfig } from './config';
import { emptyProfile } from './profile';

const WIZARD = `${BASE}/marcas/nueva`;
const DRAFT_KEY = `rrss.brandDraft.${ORG_ID}`;

type UI = ReturnType<typeof renderApp>['user'];

const heading = () => screen.getByRole('heading', { level: 2 });
const next = (user: UI) => user.click(screen.getByRole('button', { name: /Siguiente/ }));

/** Como la RPC real: guarda una versión nueva y la deja vigente. */
function registerSaveProfile() {
  fake.rpc('save_brand_profile', (args) => {
    const row = {
      id: `perfil-${fake.rows('brand_profiles').length + 1}`,
      brand_id: args.p_brand_id,
      organization_id: ORG_ID,
      version: fake.rows('brand_profiles').length + 1,
      status: 'active',
      schema_version: 1,
      data: args.p_data,
      provenance: args.p_provenance,
      change_note: args.p_change_note,
      created_by: 'user-me',
      created_at: '2026-11-16T10:00:00Z',
    };
    fake.rows('brand_profiles').push(row);
    return row;
  });
}

describe('Asistente de alta de marca', () => {
  beforeEach(() => {
    seedWorkspace({ orgRole: 'owner', brands: [] });
    registerSaveProfile();
  });

  it('empieza en el paso 1 de 7 y no deja avanzar sin nombre', async () => {
    const { user } = renderApp(WIZARD);
    expect(await screen.findByRole('heading', { name: 'Nueva marca' })).toBeInTheDocument();
    expect(heading()).toHaveTextContent('1/7 Datos básicos');

    await next(user);
    expect(await screen.findByText('Escribe el nombre de la marca para continuar.')).toBeInTheDocument();
    expect(heading()).toHaveTextContent('1/7');
  });

  it('tampoco se puede saltar al resumen o a otro paso desde la barra de pasos', async () => {
    const { user } = renderApp(WIZARD);
    await screen.findByRole('heading', { name: 'Nueva marca' });
    await user.click(screen.getByRole('button', { name: 'Paso 6 de 7: Fuentes' }));
    expect(heading()).toHaveTextContent('1/7 Datos básicos');
    expect(screen.getByText('Escribe el nombre de la marca para continuar.')).toBeInTheDocument();
  });

  it('avanza y retrocede por los siete pasos conservando lo escrito', async () => {
    const { user } = renderApp(WIZARD);
    await user.type(await screen.findByLabelText('Nombre comercial'), 'Casa Nueva');
    await next(user);
    expect(heading()).toHaveTextContent('2/7 El negocio');
    await user.type(screen.getByLabelText('Descripción del negocio'), 'Cocina de mercado');

    await next(user);
    expect(heading()).toHaveTextContent('3/7 Público y objetivos');
    await next(user);
    expect(heading()).toHaveTextContent('4/7 Voz de la marca');
    await next(user);
    expect(heading()).toHaveTextContent('5/7 Identidad visual');
    await next(user);
    expect(heading()).toHaveTextContent('6/7 Fuentes de conocimiento');
    await next(user);
    expect(heading()).toHaveTextContent('7/7 Revisa y crea');
    expect(screen.queryByRole('button', { name: /Siguiente/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('wizard-summary')).getByText('Casa Nueva')).toBeInTheDocument();

    for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: /Atrás/ }));
    expect(heading()).toHaveTextContent('2/7 El negocio');
    expect(screen.getByLabelText('Descripción del negocio')).toHaveValue('Cocina de mercado');
    await user.click(screen.getByRole('button', { name: /Atrás/ }));
    expect(heading()).toHaveTextContent('1/7');
    expect(screen.getByLabelText('Nombre comercial')).toHaveValue('Casa Nueva');
    // En el primer paso no hay «Atrás», hay «Cancelar» hacia el panel.
    expect(screen.queryByRole('button', { name: /Atrás/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cancelar' })).toHaveAttribute('href', BASE);
  });

  it('«Ir al resumen» salta al final, y sin nombre no se puede crear', async () => {
    const { user } = renderApp(WIZARD);
    await user.type(await screen.findByLabelText('Nombre comercial'), 'Casa Nueva');
    await next(user);
    await user.click(screen.getByRole('button', { name: 'Ir al resumen' }));
    expect(heading()).toHaveTextContent('7/7');
    expect(screen.getByRole('button', { name: /Crear marca/ })).toBeEnabled();
  });

  it('al terminar guarda la marca, el perfil, las fuentes y la deja activa', async () => {
    const { user } = renderApp(WIZARD);
    await user.type(await screen.findByLabelText('Nombre comercial'), '  Casa Nueva ');
    await user.type(screen.getByLabelText(/^Sector/), 'Restauración');
    await user.type(screen.getByLabelText(/^Página web/), 'https://casanueva.example');
    await next(user);
    await user.type(screen.getByLabelText('Descripción del negocio'), 'Cocina de mercado');
    await next(user);
    await user.type(screen.getByTestId('profile-goals'), 'Más reservas{Enter}');
    await next(user);
    await user.type(screen.getByTestId('profile-tone'), 'Cercano{Enter}');
    await next(user);
    await next(user);
    await user.type(screen.getByTestId('wizard-url'), 'casanueva.example');
    await user.click(screen.getByTestId('wizard-url-add'));
    expect(screen.getByText('https://casanueva.example/')).toBeInTheDocument();
    await next(user);

    const summary = within(screen.getByTestId('wizard-summary'));
    expect(summary.getByText('Casa Nueva')).toBeInTheDocument();
    expect(summary.getByText(/Restauración/)).toBeInTheDocument();
    expect(summary.getByText('Cercano')).toBeInTheDocument();

    // Una persona tarda más de lo que tarda el autoguardado en llegar al resumen y pulsar: se espera a que ya se haya guardado.
    await waitFor(() => expect(window.localStorage.getItem(DRAFT_KEY)).toContain('"step":6'));
    await user.click(screen.getByRole('button', { name: /Crear marca/ }));

    await waitFor(() => expect(window.location.pathname).toMatch(/^\/o\/org-1\/m\/.+\/inicio$/));

    // La marca, con los datos básicos limpios y en la organización correcta.
    expect(fake.callsTo('brands', 'insert')[0]?.payload).toEqual({
      organization_id: ORG_ID,
      name: 'Casa Nueva',
      sector: 'Restauración',
      website: 'https://casanueva.example',
      timezone: 'Europe/Madrid',
      default_locale: 'es',
    });
    const brandId = fake.rows('brands')[0]?.id;

    // El perfil, con lo escrito en cada paso, como primera versión y con nota de alta.
    const save = fake.callsTo('save_brand_profile', 'rpc')[0]?.payload as {
      p_brand_id: string;
      p_data: ReturnType<typeof emptyProfile>;
      p_change_note: string;
    };
    expect(save.p_brand_id).toBe(brandId);
    expect(save.p_change_note).toBe('Alta de la marca');
    expect(save.p_data.business.description).toBe('Cocina de mercado');
    expect(save.p_data.goals).toEqual(['Más reservas']);
    expect(save.p_data.voice.tone).toEqual(['Cercano']);

    // La fuente web y el estado final.
    expect(fake.callsTo('brand_knowledge_sources', 'insert')[0]?.payload).toMatchObject({
      brand_id: brandId,
      kind: 'website',
      url: 'https://casanueva.example/',
    });
    expect(fake.rows('brands')[0]?.status).toBe('active');
    expect(fake.callsTo('brands', 'update')[0]?.payload).toEqual({ status: 'active' });

    // El borrador local ya no hace falta.
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(await screen.findByText('Marca creada')).toBeInTheDocument();
  });

  it('si no se puede crear la marca, lo dice y conserva todo lo escrito', async () => {
    fake.failNext('brands', 'insert', { code: '42501', message: 'permission denied' });
    const { user } = renderApp(WIZARD);
    await user.type(await screen.findByLabelText('Nombre comercial'), 'Casa Nueva');
    await next(user);
    await user.click(screen.getByRole('button', { name: 'Ir al resumen' }));
    await user.click(screen.getByRole('button', { name: /Crear marca/ }));

    expect(await screen.findByText('No tienes permiso para hacer esto.')).toBeInTheDocument();
    expect(window.location.pathname).toBe(WIZARD);
    expect(screen.getByRole('button', { name: /Crear marca/ })).toBeEnabled();
    expect(fake.callsTo('save_brand_profile', 'rpc')).toHaveLength(0);
  });

  it('si falla el guardado del perfil, no duplica la marca y lleva a terminarla desde «Marca»', async () => {
    fake.failNext('save_brand_profile', 'rpc', { message: 'Hay un problema con el perfil.' });
    const { user } = renderApp(WIZARD);
    await user.type(await screen.findByLabelText('Nombre comercial'), 'Casa Nueva');
    await next(user);
    await user.click(screen.getByRole('button', { name: 'Ir al resumen' }));
    await user.click(screen.getByRole('button', { name: /Crear marca/ }));

    await waitFor(() => expect(window.location.pathname).toMatch(/\/m\/.+\/marca$/));
    expect(fake.rows('brands')).toHaveLength(1);
    expect(await screen.findByText(/no se pudo completar el alta: Hay un problema con el perfil/)).toBeInTheDocument();
  });

  it('guarda el borrador solo y lo recupera al volver', async () => {
    const first = renderApp(WIZARD);
    await first.user.type(await screen.findByLabelText('Nombre comercial'), 'Casa Nueva');
    await next(first.user);
    await waitFor(() => expect(window.localStorage.getItem(DRAFT_KEY)).toContain('Casa Nueva'));
    first.unmount();

    const second = renderApp(WIZARD);
    expect(await screen.findByTestId('wizard-recovered')).toBeInTheDocument();
    expect(heading()).toHaveTextContent('2/7 El negocio');

    await second.user.click(screen.getByRole('button', { name: 'Empezar de cero' }));
    expect(screen.queryByTestId('wizard-recovered')).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent('1/7');
    expect(screen.getByLabelText('Nombre comercial')).toHaveValue('');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('un archivo de logotipo no válido se rechaza con un aviso', async () => {
    const { user } = renderApp(WIZARD);
    await user.type(await screen.findByLabelText('Nombre comercial'), 'Casa Nueva');
    await user.click(screen.getByRole('button', { name: 'Paso 5 de 7: Identidad' }));
    const input = screen.getByTestId('wizard-logo-input');
    await user.upload(input, new File(['x'], 'logo.exe', { type: 'application/x-msdownload' }));
    expect((await screen.findAllByText(/«logo.exe» es de un tipo que no se admite/))[0]).toBeInTheDocument();
    // No se añade a la lista de archivos elegidos.
    expect(screen.queryByRole('button', { name: 'Quitar logo.exe' })).not.toBeInTheDocument();
  });
});

describe('Asistente: quién puede usarlo', () => {
  it('un miembro sin rol de administración ve que no puede crear marcas', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'editor' });
    renderApp(WIZARD);
    expect(await screen.findByText('No puedes crear marcas')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-wizard')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver' })).toHaveAttribute('href', BASE);
  });

  it('un administrador sí', async () => {
    seedWorkspace({ orgRole: 'admin' });
    renderApp(WIZARD);
    expect(await screen.findByTestId('brand-wizard')).toBeInTheDocument();
  });
});

describe('Asistente: importar una configuración JSON', () => {
  beforeEach(() => seedWorkspace({ orgRole: 'owner', brands: [] }));

  const upload = async (user: UI, text: string, name = 'marca.json') =>
    user.upload(await screen.findByTestId('wizard-import-input'), new File([text], name, { type: 'application/json' }));

  it('una configuración válida rellena el asistente y lleva al resumen para revisarla', async () => {
    const profile = emptyProfile();
    profile.business.description = 'Importada';
    profile.voice.tone = ['Sereno'];
    const config = exportBrandConfig(
      { name: 'Marca Importada', sector: 'Moda', website: '', timezone: 'Europe/Madrid', default_locale: 'es' },
      profile,
    );
    const { user } = renderApp(WIZARD);
    await upload(user, JSON.stringify(config));

    expect(await screen.findByText('Configuración importada. Revísala antes de crear la marca.')).toBeInTheDocument();
    expect(heading()).toHaveTextContent('7/7');
    const summary = within(screen.getByTestId('wizard-summary'));
    expect(summary.getByText('Marca Importada')).toBeInTheDocument();
    expect(summary.getByText('Sereno')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Crear marca/ }));
    await waitFor(() => expect(fake.callsTo('save_brand_profile', 'rpc')).toHaveLength(1));
    expect((fake.callsTo('save_brand_profile', 'rpc')[0]?.payload as { p_change_note: string }).p_change_note).toBe(
      'Importada desde configuración',
    );
  });

  it('un archivo que no es JSON se rechaza sin tocar el asistente', async () => {
    const { user } = renderApp(WIZARD);
    await upload(user, 'esto no es json {');
    const errors = await screen.findByTestId('wizard-import-errors');
    expect(errors).toHaveTextContent('No se ha podido importar');
    expect(errors).toHaveTextContent('El archivo no es una configuración válida.');
    expect(heading()).toHaveTextContent('1/7');
    expect(screen.getByLabelText('Nombre comercial')).toHaveValue('');
  });

  it('un JSON de otro tipo o con datos erróneos dice qué falla', async () => {
    const { user } = renderApp(WIZARD);
    await upload(user, JSON.stringify({ format: 'otra-cosa', version: 1 }));
    const errors = await screen.findByTestId('wizard-import-errors');
    expect(errors).toHaveTextContent('No es una configuración de marca');

    await upload(
      user,
      JSON.stringify({
        format: 'rrss.brand-config',
        version: 1,
        brand: { name: '' },
        profile: { visual: { colors: [{ hex: 'rojo' }] } },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('wizard-import-errors')).toHaveTextContent('Falta el nombre de la marca'),
    );
    expect(screen.getByTestId('wizard-import-errors')).toHaveTextContent('#RRGGBB');
    expect(heading()).toHaveTextContent('1/7');
  });

  it('un archivo de una versión que la app no entiende se rechaza', async () => {
    const { user } = renderApp(WIZARD);
    await upload(user, JSON.stringify({ format: 'rrss.brand-config', version: 99, brand: { name: 'X' }, profile: {} }));
    expect(await screen.findByTestId('wizard-import-errors')).toHaveTextContent('Versión de configuración no admitida');
  });
});

// Un miembro invitado al equipo no debe poder ni ver el asistente por error.
describe('Asistente: el equipo de la organización', () => {
  it('no cambia por haber más personas en la organización', async () => {
    seedWorkspace({ orgRole: 'member', brandRole: 'manager' });
    addPerson('otra', 'Otra Persona', 'owner');
    renderApp(WIZARD);
    expect(await screen.findByText('No puedes crear marcas')).toBeInTheDocument();
  });
});
