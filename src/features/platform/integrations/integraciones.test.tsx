import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IntegrationSettingRow } from '@/lib/database.types';
import { ALL_AVAILABLE, fake } from '@/test/fakeSupabase';
import { BRAND_BASE, BRAND_ID, ORG_ID, renderApp, seedWorkspace } from '@/test/fixtures';

// Plataforma → Integraciones y lo que cambia en el resto de la interfaz:
// el navegador manda los valores al guardar y nunca recibe un secreto de vuelta.

const SECRET = 'token-de-prueba-del-tunel-9f8e';
const WORKER_TOKEN = `rrss_wgt_${'q'.repeat(43)}`;

/** Servidor simulado de `platform-integrations` con estado: se comporta como la función real. */
function serveIntegrations() {
  const settings: IntegrationSettingRow[] = [];
  const responses: unknown[] = [];
  fake.fn('platform-integrations', (raw) => {
    const body = raw as { action: string; integration?: string; values?: Record<string, string | null> };
    let reply: { status: number; body: unknown };
    if (body.action === 'availability') reply = { status: 200, body: { ...ALL_AVAILABLE } };
    else if (body.action === 'status') {
      reply = {
        status: 200,
        body: {
          settings: settings.map((s) => ({ ...s })),
          tests: [],
          audit: [],
          environment: ['STRIPE_SECRET_KEY'],
          availability: { ...ALL_AVAILABLE, billing: false },
        },
      };
    } else if (body.action === 'save') {
      for (const [key, value] of Object.entries(body.values ?? {})) {
        const at = settings.findIndex((s) => s.setting_key === key);
        if (at >= 0) settings.splice(at, 1);
        if (value === null) continue;
        const secret = key.endsWith('TOKEN');
        // Como la base de datos: del secreto, solo la pista.
        settings.push({
          setting_key: key,
          integration: body.integration!,
          is_secret: secret,
          value: secret ? null : value,
          hint: secret ? `…${value.slice(-4)}` : null,
          updated_at: '2026-11-20T10:00:00Z',
          updated_by_email: 'yo@example.com',
        });
      }
      reply = { status: 200, body: { saved: Object.keys(body.values ?? {}) } };
    } else if (body.action === 'test') {
      reply = {
        status: 200,
        body: {
          ok: true,
          message: 'ComfyUI 0.9.1 responde.',
          checks: [{ name: 'ComfyUI', ok: true, message: 'ComfyUI 0.9.1 responde.' }],
        },
      };
    } else if (body.action === 'generate_worker_token') {
      // Como la función: guarda la huella y devuelve el token una sola vez.
      const at = settings.findIndex((s) => s.setting_key === 'WORKER_GATEWAY_TOKEN');
      if (at >= 0) settings.splice(at, 1);
      settings.push({
        setting_key: 'WORKER_GATEWAY_TOKEN',
        integration: 'media_worker',
        is_secret: true,
        value: null,
        hint: '…beef',
        updated_at: '2026-11-21T10:00:00Z',
        updated_by_email: 'yo@example.com',
      });
      reply = { status: 200, body: { token: WORKER_TOKEN } };
    } else reply = { status: 400, body: { error: { message: 'Acción desconocida.' } } };
    responses.push(reply.body);
    return reply;
  });
  return { settings, responses };
}

describe('Plataforma → Integraciones', () => {
  it('el token del trabajador se genera, se enseña una vez y se puede revocar', async () => {
    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    const server = serveIntegrations();
    const { user } = renderApp('/plataforma/integraciones');
    await user.click(await screen.findByRole('tab', { name: 'Trabajador de medios (Fly.io)' }));
    const card = await screen.findByTestId('integration-media_worker');
    const zone = within(card).getByTestId('setting-WORKER_GATEWAY_TOKEN');
    expect(within(zone).getByText('Sin generar')).toBeInTheDocument();
    // No hay campo para pegarlo a mano.
    expect(within(zone).queryByRole('textbox')).toBeNull();
    await user.click(within(zone).getByTestId('integration-generate-worker-token'));
    expect(await within(zone).findByTestId('worker-token-value')).toHaveValue(WORKER_TOKEN);
    expect(within(zone).getByText(/no se volverá a ver/)).toBeInTheDocument();
    expect(await within(zone).findByText('Generado')).toBeInTheDocument();
    // Revocar: borra el ajuste (con confirmación).
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(zone).getByTestId('integration-revoke-worker-token'));
    await waitFor(() => expect(server.settings.find((r) => r.setting_key === 'WORKER_GATEWAY_TOKEN')).toBeUndefined());
    expect(within(zone).queryByTestId('worker-token-value')).toBeNull();
  });

  it('quien no es superadministrador no la ve', async () => {
    seedWorkspace({ orgRole: 'owner' });
    renderApp('/plataforma/integraciones');
    expect(await screen.findByText('Zona reservada')).toBeInTheDocument();
    expect(fake.callsTo('platform-integrations', 'function')).toEqual([]);
  });

  it('el superadministrador guarda ComfyUI, lo prueba y lo ve configurado sin ver el secreto', async () => {
    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    const server = serveIntegrations();
    const { user } = renderApp('/plataforma/integraciones');

    await user.click(await screen.findByRole('tab', { name: 'ComfyUI propio' }));
    const card = await screen.findByTestId('integration-comfyui');
    expect(within(card).getAllByText('Sin configurar').length).toBeGreaterThan(1);

    const url = within(within(card).getByTestId('setting-COMFYUI_BASE_URL')).getByRole('textbox');
    await user.type(url, 'https://tunel.ejemplo.test');
    const token = within(card).getByLabelText(/Token de acceso/);
    expect(token).toHaveAttribute('type', 'password');
    await user.type(token, SECRET);
    await user.selectOptions(within(card).getByLabelText(/Región de los datos/), 'eu');
    await user.click(within(card).getByTestId('integration-save'));

    await waitFor(() => expect(server.settings).toHaveLength(3));
    const saves = fake
      .callsTo('platform-integrations', 'function')
      .filter((c) => (c.payload as { action: string }).action === 'save');
    expect(saves[0]!.payload).toEqual({
      action: 'save',
      integration: 'comfyui',
      values: { COMFYUI_BASE_URL: 'https://tunel.ejemplo.test', COMFYUI_API_TOKEN: SECRET, COMFYUI_DATA_REGION: 'eu' },
    });

    // Tras guardar: configurado, la pista y quién; el campo del secreto vacío.
    const state = await within(card).findByTestId('setting-state-COMFYUI_API_TOKEN');
    await within(state).findByText('Configurado');
    expect(state).toHaveTextContent('…9f8e');
    expect(state).toHaveTextContent('yo@example.com');
    expect(within(card).getByLabelText(/Token de acceso/)).toHaveValue('');
    expect(document.body.textContent).not.toContain(SECRET);
    // Ninguna respuesta del servidor llevó el secreto.
    expect(JSON.stringify(server.responses)).not.toContain(SECRET);

    await user.click(within(card).getByTestId('integration-test'));
    expect(await within(card).findByTestId('integration-test-result')).toHaveTextContent('Funciona');

    // Lo que viene de una variable de entorno se dice, sin valor.
    await user.click(screen.getByRole('tab', { name: 'Stripe' }));
    const stripe = await screen.findByTestId('integration-stripe');
    expect(within(stripe).getByTestId('setting-state-STRIPE_SECRET_KEY')).toHaveTextContent(
      'En la variable de entorno del servidor',
    );
  });

  it('borrar un ajuste manda null y el servidor deja de tenerlo', async () => {
    seedWorkspace({ orgRole: 'owner', platformAdmin: true });
    const server = serveIntegrations();
    server.settings.push({
      setting_key: 'COMFYUI_API_TOKEN',
      integration: 'comfyui',
      is_secret: true,
      value: null,
      hint: '…abcd',
      updated_at: '2026-11-19T10:00:00Z',
      updated_by_email: 'otra@example.com',
    });
    const { user } = renderApp('/plataforma/integraciones');
    await user.click(await screen.findByRole('tab', { name: 'ComfyUI propio' }));
    const card = await screen.findByTestId('integration-comfyui');
    const field = await within(card).findByTestId('setting-COMFYUI_API_TOKEN');
    await user.click(within(field).getByRole('button', { name: 'Borrar' }));
    await user.click(within(card).getByTestId('integration-save'));
    await waitFor(() => expect(server.settings).toEqual([]));
  });
});

describe('interruptores: compilación Y servidor', () => {
  it('con VITE_AI_TEXT_ENABLED pero sin IA configurada en el servidor, Campañas no sale', async () => {
    vi.stubEnv('VITE_AI_TEXT_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.fn('platform-integrations', () => ({ status: 200, body: { ...ALL_AVAILABLE, aiText: false } }));
    renderApp(`${BRAND_BASE}/campanas`);
    await waitFor(() => expect(window.location.pathname).toBe(`${BRAND_BASE}/inicio`));
    expect(screen.queryByRole('link', { name: /Campañas/ })).not.toBeInTheDocument();
  });

  it('si el servidor no contesta, no se enseña nada que dependa de él', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.fn('platform-integrations', () => {
      throw new Error('sin red');
    });
    const { user } = renderApp(`${BRAND_BASE}/marca`);
    await user.click(await screen.findByRole('tab', { name: /Datos/ }));
    await screen.findByTestId('brand-ai-mode');
    expect(screen.queryByTestId('social-accounts')).toBeNull();
  });

  it('con VITE_DRIVE_LIBRARY_ENABLED pero sin Google Drive configurado, no se ofrece conectar', async () => {
    vi.stubEnv('VITE_DRIVE_LIBRARY_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.fn('platform-integrations', () => ({ status: 200, body: { ...ALL_AVAILABLE, drive: false } }));
    renderApp(`/o/${ORG_ID}/ajustes/drive`);
    expect(await screen.findByTestId('drive-not-configured')).toBeInTheDocument();
    expect(screen.queryByTestId('drive-connect')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Google Drive' })).toBeNull();
  });

  it('con Google Drive configurado, sale en los ajustes y se puede conectar', async () => {
    vi.stubEnv('VITE_DRIVE_LIBRARY_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.fn('platform-integrations', () => ({ status: 200, body: { ...ALL_AVAILABLE } }));
    renderApp(`/o/${ORG_ID}/ajustes/drive`);
    expect(await screen.findByTestId('drive-connect')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Google Drive' })).toBeInTheDocument();
  });
});

describe('conectar Instagram con un token', () => {
  it('sin aplicación de Meta solo se ofrece el token; se valida en el servidor y la cuenta queda «con token»', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.social_accounts = [];
    fake.fn('platform-integrations', () => ({ status: 200, body: { ...ALL_AVAILABLE, socialOAuth: false } }));
    fake.fn('social-connect/token', (body) => {
      const { igUserId } = body as { igUserId: string };
      fake.tables.social_accounts = [
        {
          id: 'acc-1',
          brand_id: BRAND_ID,
          organization_id: ORG_ID,
          network: 'instagram',
          provider: 'meta',
          external_id: igUserId,
          username: 'casa_demo',
          display_name: 'Casa Demo',
          page_id: '1000',
          status: 'active',
          scopes: ['instagram_basic', 'instagram_content_publish'],
          token_expires_at: null,
          token_checked_at: '2026-11-20T10:00:00Z',
          quota_usage: null,
          quota_total: null,
          quota_checked_at: null,
          last_error: null,
          connected_by: 'user-me',
          connected_at: '2026-11-20T10:00:00Z',
          disconnected_at: null,
          connection_method: 'token',
          created_at: '2026-11-20T10:00:00Z',
          updated_at: '2026-11-20T10:00:00Z',
        },
      ];
      return {
        status: 200,
        body: {
          accountId: 'acc-1',
          username: 'casa_demo',
          expiresAt: null,
          dataAccessExpiresAt: '2027-02-18T10:00:00Z',
          tokenType: 'PAGE',
          warnings: [],
        },
      };
    });
    const { user } = renderApp(`${BRAND_BASE}/marca`);
    await user.click(await screen.findByRole('tab', { name: /Datos/ }));
    const card = await screen.findByTestId('social-accounts');
    await within(card).findByTestId('social-connect-token');
    expect(within(card).queryByTestId('social-connect-instagram')).toBeNull();

    await user.click(within(card).getByTestId('social-connect-token'));
    expect(await screen.findByText(/La clave de acceso sustituye al inicio de sesión con Meta/)).toBeInTheDocument();
    expect(screen.getByText(/Caduca cuando lo diga Meta/)).toBeInTheDocument();
    await user.type(screen.getByTestId('social-token-ig-id'), '17841400000000001');
    await user.type(screen.getByTestId('social-token-value'), 'EAAprueba0000000000000000');
    await user.click(screen.getByTestId('social-token-submit'));

    await waitFor(() => expect(fake.callsTo('social-connect/token', 'function')).toHaveLength(1));
    expect(fake.callsTo('social-connect/token', 'function')[0]!.payload).toEqual({
      brandId: BRAND_ID,
      network: 'instagram',
      igUserId: '17841400000000001',
      accessToken: 'EAAprueba0000000000000000',
    });
    expect(await within(card).findByTestId('social-account-token')).toHaveTextContent('Conexión avanzada');
    expect(within(card).getByText(/conexión avanzada, sin fecha de caducidad/)).toBeInTheDocument();
  });

  it('si Meta rechaza el token, se dice en el diálogo', async () => {
    vi.stubEnv('VITE_SOCIAL_PUBLISHING_ENABLED', 'true');
    seedWorkspace({ orgRole: 'owner' });
    fake.tables.social_accounts = [];
    fake.fn('social-connect/token', () => ({
      status: 400,
      body: { error: { code: 'invalid_token', message: 'Meta dice que ese token no es válido.' } },
    }));
    const { user } = renderApp(`${BRAND_BASE}/marca`);
    await user.click(await screen.findByRole('tab', { name: /Datos/ }));
    await user.click(await screen.findByTestId('social-connect-token'));
    await user.type(screen.getByTestId('social-token-ig-id'), '17841400000000001');
    await user.type(screen.getByTestId('social-token-value'), 'EAAcaducado000000000000000');
    await user.click(screen.getByTestId('social-token-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Meta dice que ese token no es válido.');
  });
});
