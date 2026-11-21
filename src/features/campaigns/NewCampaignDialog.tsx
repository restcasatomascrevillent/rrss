import { Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Dialog, Field, Input, Notice, Textarea } from '@/components/ui';
import { AiRequestError } from '@/features/ai/api';
import { AiErrorNotice } from '@/features/ai/AiErrorNotice';
import { NETWORKS } from '@/features/content/networks';
import { translateError } from '@/lib/errors';
import { useCampaignMutations, validatePlanRequest, type PlanRequestInput } from './api';
import { campaignPaths } from './labels';
import { MAX_INSTRUCTION_CHARS, nextWeek, shortDay } from './plan';

/**
 * Pedir un plan: qué se quiere («prepara la semana que viene»), redes y
 * fechas. Con la IA, el plan se genera al momento y queda por revisar; en modo
 * agencia, se crea un encargo para la agencia.
 */
export function NewCampaignDialog({
  orgId,
  brandId,
  mode,
  open,
  onOpenChange,
  textSourceCount,
}: {
  orgId: string;
  brandId: string;
  mode: 'ai' | 'agency';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fuentes de texto de la marca que se pueden enviar a la IA. */
  textSourceCount: number;
}) {
  const navigate = useNavigate();
  const mutations = useCampaignMutations(brandId);
  const week = nextWeek(new Date());
  const [instruction, setInstruction] = useState('');
  const [title, setTitle] = useState('');
  const [networks, setNetworks] = useState<string[]>(['instagram']);
  const [startsOn, setStartsOn] = useState(week.start);
  const [endsOn, setEndsOn] = useState(week.end);
  const [useSources, setUseSources] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = mutations.createWithAi.isPending || mutations.requestFromAgency.isPending;
  const aiError = mutations.createWithAi.error instanceof AiRequestError ? mutations.createWithAi.error : null;

  function toggle(network: string) {
    setNetworks((current) =>
      current.includes(network) ? current.filter((n) => n !== network) : [...current, network],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input: PlanRequestInput = {
      brandId,
      title: title.trim() || `Plan del ${shortDay(startsOn)} al ${shortDay(endsOn)}`,
      instruction,
      networks: NETWORKS.map((n) => n.id).filter((id) => networks.includes(id)),
      startsOn,
      endsOn,
      useSources: useSources && textSourceCount > 0,
    };
    const invalid = validatePlanRequest(input);
    setProblem(invalid);
    if (invalid) return;
    try {
      if (mode === 'ai') {
        const { campaign, discarded } = await mutations.createWithAi.mutateAsync(input);
        toast.success(
          discarded.length
            ? `Plan listo. Se han descartado ${discarded.length} propuestas que no encajaban (otra red, otras fechas o de más).`
            : 'Plan listo: revísalo antes de aceptarlo.',
        );
        onOpenChange(false);
        navigate(campaignPaths(orgId, brandId).item(campaign.id));
      } else {
        const campaign = await mutations.requestFromAgency.mutateAsync(input);
        toast.success('Plan pedido a la agencia');
        onOpenChange(false);
        navigate(campaignPaths(orgId, brandId).item(campaign.id));
      }
    } catch (error) {
      // Los fallos de la IA se explican dentro del diálogo; el resto, en un aviso.
      if (!(error instanceof AiRequestError)) toast.error(translateError(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={mode === 'ai' ? 'Preparar un plan con IA' : 'Pedir un plan a la agencia'}
      description={
        mode === 'ai'
          ? 'Cuenta qué quieres preparar. La IA propone un plan explicado; tú lo revisas y, al aceptarlo, sus piezas se crean como borradores. Nada se aprueba ni se publica solo.'
          : 'Cuenta qué quieres preparar. La agencia entrega un plan explicado; tú lo revisas y, al aceptarlo, sus piezas se crean como borradores.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="new-campaign-form" loading={pending} data-testid="campaign-submit">
            <Sparkles className="h-4 w-4" aria-hidden />
            {mode === 'ai' ? 'Preparar el plan' : 'Pedir el plan'}
          </Button>
        </>
      }
    >
      <form id="new-campaign-form" onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field
          label="¿Qué quieres preparar?"
          hint="Por ejemplo: «Prepara la semana que viene» o «Campaña de 3 semanas para el menú de otoño»."
        >
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              maxLength={MAX_INSTRUCTION_CHARS}
              value={instruction}
              placeholder="Prepara la semana que viene"
              onChange={(e) => setInstruction(e.target.value)}
              data-testid="campaign-instruction"
            />
          )}
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Redes</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {NETWORKS.map((network) => (
              <label key={network.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={networks.includes(network.id)}
                  onChange={() => toggle(network.id)}
                  data-testid={`campaign-network-${network.id}`}
                />
                {network.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Desde">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                data-testid="campaign-starts"
              />
            )}
          </Field>
          <Field label="Hasta">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
                data-testid="campaign-ends"
              />
            )}
          </Field>
        </div>
        <Field label="Nombre de la campaña" optional hint="Si lo dejas vacío, se llamará por sus fechas.">
          {(props) => (
            <Input
              {...props}
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="campaign-title"
            />
          )}
        </Field>
        {mode === 'ai' && textSourceCount > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={useSources}
              onChange={(e) => setUseSources(e.target.checked)}
              data-testid="campaign-use-sources"
            />
            <span>
              Tener en cuenta las fuentes de texto de la marca ({textSourceCount}). Se leen como información, nunca como
              órdenes.
            </span>
          </label>
        )}
        {problem && <Notice tone="warning">{problem}</Notice>}
        {aiError && <AiErrorNotice error={aiError} />}
      </form>
    </Dialog>
  );
}
