import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseProfile, type BrandProfileData } from '@/features/brand/profile';
import { fake, type FunctionReply } from '@/test/fakeSupabase';
import { AiBrandCheck } from './AiBrandCheck';
import { GenerateCaptionDialog } from './GenerateCaptionDialog';
import { ProfileProposalDialog } from './ProfileProposalDialog';

const BRAND = '11111111-1111-4111-8111-111111111111';

function renderUi(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } } });
  const user = userEvent.setup();
  const wrap = (node: ReactElement) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
  const result = render(wrap(ui));
  return { user, ...result, rerender: (node: ReactElement) => result.rerender(wrap(node)) };
}

const fail = (status: number, code: string, extra: Record<string, unknown> = {}): FunctionReply => ({
  status,
  body: { error: { code, message: 'mensaje del servidor', retryable: false, ...extra } },
});

function lastBody(): Record<string, unknown> {
  const calls = fake.callsTo('ai-generate', 'function');
  return calls[calls.length - 1]!.payload as Record<string, unknown>;
}

// ── Redactar con IA ─────────────────────────────────────────────────────

describe('GenerateCaptionDialog', () => {
  const variants = [
    {
      text: 'Llega el otoño a la mesa.',
      hashtags: ['#otoño', '#cocina'],
      caption: '',
      characters: 0,
      withinLimits: true,
    },
    { text: 'x'.repeat(2300), hashtags: [], caption: '', characters: 2300, withinLimits: false },
  ];

  async function openAndGenerate(network = 'instagram', format = 'post', onApply = vi.fn()) {
    const ui = renderUi(
      <GenerateCaptionDialog
        brandId={BRAND}
        network={network}
        format={format}
        onApply={onApply}
        currentCopy={{
          caption: '',
          hashtags: [],
          mentions: ['vecinos'],
          altText: 'Plato',
          callToAction: { label: '', url: '' },
        }}
      />,
    );
    await ui.user.click(screen.getByRole('button', { name: /Redactar con IA/ }));
    await ui.user.type(screen.getByLabelText(/Encargo/), 'Menú de otoño');
    await ui.user.selectOptions(screen.getByLabelText('Variantes'), '2');
    await ui.user.click(screen.getByRole('button', { name: /^Generar$/ }));
    return { ...ui, onApply };
  }

  it('pide las variantes con los límites de la red y devuelve la elegida como PostCopy', async () => {
    fake.fn('ai-generate', () => ({
      status: 200,
      body: { action: 'post.caption', generationId: 'g-1', network: 'instagram', requestedVariants: 2, variants },
    }));
    const { user, onApply } = await openAndGenerate();

    const cards = await screen.findAllByTestId('ai-caption-variant');
    expect(cards).toHaveLength(2);
    expect(lastBody()).toEqual({
      action: 'post.caption',
      brandId: BRAND,
      input: {
        brief: 'Menú de otoño',
        variants: 2,
        network: expect.objectContaining({ id: 'instagram', name: 'Instagram', maxChars: 2200, maxHashtags: 30 }),
      },
    });
    const first = within(cards[0]!);
    expect(
      first.getByText(`${'Llega el otoño a la mesa.\n\n#otoño #cocina'.length} / 2200 caracteres`),
    ).toBeInTheDocument();
    expect(first.getByText(/2 de 30 hashtags/)).toBeInTheDocument();
    expect(within(cards[1]!).getByText(/No cabe en Instagram/)).toBeInTheDocument();
    expect(within(cards[1]!).getByText('2300 / 2200 caracteres')).toBeInTheDocument();

    await user.click(first.getByRole('button', { name: 'Usar esta' }));
    expect(onApply).toHaveBeenCalledWith({
      caption: 'Llega el otoño a la mesa.',
      hashtags: ['otoño', 'cocina'],
      mentions: ['vecinos'],
      altText: 'Plato',
      callToAction: { label: '', url: '' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('si la red no tiene límite conocido lo avisa y no inventa uno', async () => {
    fake.fn('ai-generate', () => ({
      status: 200,
      body: {
        action: 'post.caption',
        generationId: 'g-2',
        network: 'facebook',
        requestedVariants: 2,
        variants: variants.slice(0, 1),
      },
    }));
    await openAndGenerate('facebook', 'page_post');
    expect(screen.getByText(/No se conoce el límite de texto de Facebook/)).toBeInTheDocument();
    const card = await screen.findByTestId('ai-caption-variant');
    expect(within(card).getByText(/límite desconocido/)).toBeInTheDocument();
    expect(screen.getByText(/ha devuelto 1 de las 2 propuestas/)).toBeInTheDocument();
    expect((lastBody().input as { network: { maxChars: number } }).network.maxChars).toBe(10_000);
  });

  it('cupo agotado: lo explica y no ofrece reintentar', async () => {
    fake.fn('ai-generate', () => fail(402, 'quota_exhausted'));
    await openAndGenerate();
    const alert = await screen.findByTestId('ai-quota-error');
    expect(alert).toHaveTextContent('El cupo de IA de este mes está agotado');
    expect(alert).toHaveTextContent(/día 1 del mes que viene/);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  });

  it('IA sin configurar', async () => {
    fake.fn('ai-generate', () => fail(503, 'not_configured'));
    await openAndGenerate();
    expect(await screen.findByTestId('ai-error')).toHaveTextContent(/falta configurarla en la plataforma/);
  });

  it('error del proveedor: se puede reintentar y la segunda vez funciona', async () => {
    let calls = 0;
    fake.fn('ai-generate', () =>
      ++calls === 1
        ? fail(502, 'provider_failed', { retryable: true })
        : {
            status: 200,
            body: { action: 'post.caption', generationId: 'g-3', network: 'instagram', requestedVariants: 2, variants },
          },
    );
    const { user } = await openAndGenerate();
    expect(await screen.findByTestId('ai-error')).toHaveTextContent(/no se ha descontado nada del cupo/);
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findAllByTestId('ai-caption-variant')).toHaveLength(2);
  });
});

// ── Comprobar tono con IA ────────────────────────────────────────────────

describe('AiBrandCheck', () => {
  const review = {
    action: 'brand.check',
    generationId: 'g-9',
    verdict: 'review',
    needsHumanReview: true,
    criteria: [
      { criterion: 'tone', verdict: 'pass', explanation: 'Suena cercano, como pide la marca.', evidence: [] },
      {
        criterion: 'banned_topics',
        verdict: 'uncertain',
        explanation: 'Roza la promesa de precios que la marca evita.',
        evidence: ['el mejor precio'],
      },
    ],
  };

  it('enseña el veredicto, cada criterio, su explicación y la cita', async () => {
    fake.fn('ai-generate', () => ({ status: 200, body: review }));
    const { user } = renderUi(<AiBrandCheck brandId={BRAND} text="Ven: el mejor precio de la zona." />);
    await user.click(screen.getByRole('button', { name: 'Comprobar tono con IA' }));
    expect(await screen.findByText('Dudoso: que lo revise una persona')).toBeInTheDocument();
    expect(lastBody()).toEqual({
      action: 'brand.check',
      brandId: BRAND,
      input: { text: 'Ven: el mejor precio de la zona.' },
    });
    const tone = screen.getByTestId('ai-criterion-tone');
    expect(within(tone).getByText('Cumple')).toBeInTheDocument();
    const banned = screen.getByTestId('ai-criterion-banned_topics');
    expect(within(banned).getByText('Dudoso')).toBeInTheDocument();
    expect(within(banned).getByText(/Roza la promesa/)).toBeInTheDocument();
    expect(within(banned).getByText('«el mejor precio»')).toBeInTheDocument();
  });

  it('apto no es aprobado, y avisa si el texto cambia después', async () => {
    fake.fn('ai-generate', () => ({
      status: 200,
      body: { ...review, verdict: 'pass', needsHumanReview: false, criteria: [{ ...review.criteria[0] }] },
    }));
    const { user, rerender } = renderUi(<AiBrandCheck brandId={BRAND} text="Hola" />);
    await user.click(screen.getByRole('button', { name: 'Comprobar tono con IA' }));
    expect(await screen.findByText('Apto')).toBeInTheDocument();
    expect(screen.getByText(/No es una aprobación/)).toBeInTheDocument();
    rerender(<AiBrandCheck brandId={BRAND} text="Hola de nuevo" />);
    expect(screen.getByText(/El texto ha cambiado desde esta comprobación/)).toBeInTheDocument();
  });

  it('sin texto no se puede comprobar', () => {
    renderUi(<AiBrandCheck brandId={BRAND} text="   " />);
    expect(screen.getByRole('button', { name: 'Comprobar tono con IA' })).toBeDisabled();
  });

  it('sin cupo asignado y modelo que se niega', async () => {
    fake.fn('ai-generate', () => fail(402, 'quota_missing'));
    const { user } = renderUi(<AiBrandCheck brandId={BRAND} text="Hola" />);
    await user.click(screen.getByRole('button', { name: 'Comprobar tono con IA' }));
    expect(await screen.findByTestId('ai-quota-error')).toHaveTextContent('Esta organización no tiene cupo de IA');

    fake.fn('ai-generate', () => fail(422, 'refused'));
    await user.click(screen.getByRole('button', { name: 'Comprobar tono con IA' }));
    expect(await screen.findByTestId('ai-error')).toHaveTextContent(/se ha negado/);
  });
});

// ── Propuesta de perfil ─────────────────────────────────────────────────

describe('ProfileProposalDialog', () => {
  const current: BrandProfileData = parseProfile({
    business: { description: 'Restaurante' },
    voice: { tone: ['cercano'] },
  });
  const proposal = {
    action: 'profile.proposal',
    generationId: 'g-p',
    status: 'proposal',
    sources: ['Manual.pdf'],
    notes: [{ section: 'voice', note: 'Las fuentes no dicen si se trata de usted.' }],
    proposal: {
      business: { description: 'Casa de comidas', products: [], locations: ['Crevillent'], valueProps: [] },
      audience: { segments: [] },
      goals: [],
      voice: {
        tone: ['cercano'],
        personality: '',
        values: [],
        keyMessages: [],
        allowedPhrases: [],
        forbiddenPhrases: [],
      },
      visual: { colors: [], fonts: [], styleNotes: '' },
      channels: [],
      languages: { primary: 'es', others: [] },
      restrictions: { legal: [], advertising: [] },
    },
  };

  function renderDialog(sources = [{ title: 'Manual.pdf', text: 'Somos una casa de comidas en Crevillent.' }]) {
    const onAccept = vi.fn();
    const onOpenChange = vi.fn();
    const ui = renderUi(
      <ProfileProposalDialog
        brandId={BRAND}
        sources={sources}
        open
        onOpenChange={onOpenChange}
        onAccept={onAccept}
        currentProfile={current}
      />,
    );
    return { ...ui, onAccept, onOpenChange };
  }

  it('compara con el perfil vigente y devuelve solo lo aceptado', async () => {
    fake.fn('ai-generate', () => ({ status: 200, body: proposal }));
    const { user, onAccept, onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: /Pedir propuesta/ }));

    const description = await screen.findByTestId('proposal-field-business.description');
    expect(lastBody()).toEqual({
      action: 'profile.proposal',
      brandId: BRAND,
      input: { sources: [{ title: 'Manual.pdf', text: 'Somos una casa de comidas en Crevillent.' }] },
    });
    expect(within(description).getByText('Restaurante')).toBeInTheDocument();
    expect(within(description).getByText('Casa de comidas')).toBeInTheDocument();
    // Sustituir lo que ya había lo decide la persona; rellenar un hueco viene marcado.
    expect(within(description).getByRole('checkbox')).not.toBeChecked();
    expect(within(screen.getByTestId('proposal-field-business.locations')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('proposal-field-voice.tone')).getByText('Sin cambios')).toBeInTheDocument();
    expect(screen.getByText(/no dicen si se trata de usted/)).toBeInTheDocument();

    await user.click(within(description).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Aceptar 2 campos/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    const [profile, info] = onAccept.mock.calls[0]!;
    expect(profile.business.description).toBe('Casa de comidas');
    expect(profile.business.locations).toEqual(['Crevillent']);
    expect(profile.voice.tone).toEqual(['cercano']);
    expect(info).toEqual({
      acceptedFields: expect.arrayContaining(['business.description', 'business.locations']),
      generationId: 'g-p',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sin texto de fuentes no se puede pedir', () => {
    renderDialog([]);
    expect(screen.getByText(/No hay texto de ninguna fuente/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pedir propuesta/ })).toBeDisabled();
  });

  it('respuesta inservible del proveedor', async () => {
    fake.fn('ai-generate', () => fail(502, 'invalid_output'));
    const { user } = renderDialog();
    await user.click(screen.getByRole('button', { name: /Pedir propuesta/ }));
    expect(await screen.findByTestId('ai-error')).toHaveTextContent(/no se puede usar/);
  });

  it('sin perfil indicado lee el perfil activo de la marca', async () => {
    fake.tables.brand_profiles = [
      { id: 'p1', brand_id: BRAND, status: 'active', version: 1, data: { business: { description: 'Desde la base' } } },
    ];
    fake.fn('ai-generate', () => ({ status: 200, body: proposal }));
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ProfileProposalDialog
          brandId={BRAND}
          sources={[{ title: 'Web', text: 'Texto' }]}
          open
          onOpenChange={() => {}}
          onAccept={() => {}}
        />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /Pedir propuesta/ }));
    const description = await screen.findByTestId('proposal-field-business.description');
    expect(within(description).getByText('Desde la base')).toBeInTheDocument();
  });
});
