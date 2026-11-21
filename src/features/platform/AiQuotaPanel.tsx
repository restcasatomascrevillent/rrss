import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardBody, CardHeader, Field, Input, Notice, Select } from '@/components/ui';
import { periodStartOf, usePlatformAiCost, useSetAiQuota } from '@/features/ai/api';
import { formatMicros, moneyEstimateNote, moneyUnitLabel, parseUnitsToMicros } from '@/features/ai/money';
import { translateError } from '@/lib/errors';

interface OrgOption {
  id: string;
  name: string;
}

/** Plataforma → asignar el cupo mensual de IA de una organización (`admin_set_ai_quota`, auditado). */
export function AiQuotaPanel({ organizations, now = new Date() }: { organizations: OrgOption[]; now?: Date }) {
  const setQuota = useSetAiQuota();
  const period = periodStartOf(now);
  const costs = usePlatformAiCost(period, organizations.length > 0);
  const [orgId, setOrgId] = useState('');
  const [amount, setAmount] = useState('');
  const [saved, setSaved] = useState<{ name: string; micros: number } | null>(null);

  const micros = parseUnitsToMicros(amount);
  const amountError =
    amount.trim() && micros === null ? 'Escribe un importe positivo, con coma para los decimales (hasta 6).' : null;
  const selectedCost = costs.data?.find((row) => row.organization_id === orgId);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!orgId || micros === null) return;
    const name = organizations.find((o) => o.id === orgId)?.name ?? '';
    setQuota.mutateAsync({ organizationId: orgId, monthlyLimitMicros: micros }).then(
      (row) => {
        setSaved({ name, micros: Number(row.limit_value) });
        toast.success('Cupo de IA guardado');
      },
      (error) => toast.error(translateError(error)),
    );
  }

  return (
    <Card>
      <CardHeader
        title="Cupo mensual de IA"
        description="Lo que cada organización puede gastar en IA al mes. Sin cupo, la organización no puede usar la IA."
      />
      <CardBody className="space-y-4">
        <form onSubmit={submit} className="grid max-w-2xl gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <Field label="Organización">
            {(p) => (
              <Select {...p} value={orgId} onChange={(e) => setOrgId(e.target.value)} data-testid="ai-quota-org">
                <option value="">Elige una organización</option>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={`Cupo al mes (${moneyUnitLabel()})`} error={amountError}>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                data-testid="ai-quota-amount"
              />
            )}
          </Field>
          <Button
            type="submit"
            loading={setQuota.isPending}
            disabled={!orgId || micros === null}
            data-testid="ai-quota-save"
          >
            Guardar cupo
          </Button>
        </form>
        {orgId && costs.data && (
          <p className="text-sm text-muted" data-testid="ai-quota-org-cost">
            Coste de IA de esta organización este mes: {formatMicros(Number(selectedCost?.cost_micros ?? 0))}.
          </p>
        )}
        {saved && (
          <Notice>
            <span data-testid="ai-quota-saved">
              Cupo de {saved.name}: {formatMicros(saved.micros)} al mes.
            </span>
          </Notice>
        )}
        <p className="text-xs text-muted">
          Guardar sustituye el cupo vigente, que desde aquí no se puede consultar (solo lo ven los administradores de
          cada organización). El cambio queda en el registro de actividad. Un cupo de 0 bloquea la IA de esa
          organización. {moneyEstimateNote()}
        </p>
      </CardBody>
    </Card>
  );
}
