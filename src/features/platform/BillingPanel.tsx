import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  ErrorState,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
} from '@/components/ui';
import { periodStartOf } from '@/features/ai/api';
import { formatMicros, moneyUnitLabel, parseUnitsToMicros } from '@/features/ai/money';
import { useAssignPlan, useBillingOverview, useClearAiQuota, usePlans } from '@/features/billing/api';
import { SOURCE_LABEL, STATUS_LABEL } from '@/features/billing/labels';
import type { BillingOverviewRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn, formatBytes } from '@/lib/utils';

function monthLabel(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/**
 * Plataforma → cuánto deja cada cliente este mes: plan, ingresos del plan,
 * coste de IA y margen. Desde aquí se asigna un plan a mano (clientes sin Stripe).
 */
export function BillingPanel({ now = new Date() }: { now?: Date }) {
  const period = periodStartOf(now);
  const overview = useBillingOverview(period);
  const clear = useClearAiQuota();
  const [editing, setEditing] = useState<BillingOverviewRow | null>(null);

  const rows = overview.data ?? [];
  const totals = rows.reduce(
    (acc, row) => ({
      revenue: acc.revenue + Number(row.monthly_revenue_micros),
      cost: acc.cost + Number(row.ai_cost_micros),
    }),
    { revenue: 0, cost: 0 },
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Ingresos, coste y margen · ${monthLabel(period)}`}
        description="Ingresos = precio del plan (o el pactado) llevado a un mes; coste = IA consumida este mes. Las suscripciones canceladas o en prueba no suman ingresos."
      />
      {overview.isPending ? (
        <Spinner />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm" data-testid="billing-overview">
              <caption className="sr-only">Margen por organización</caption>
              <thead className="border-b border-border bg-subtle text-xs text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Organización
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Plan
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    Ingresos
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    Coste de IA
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    Margen
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Cupo de IA
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const margin = Number(row.margin_micros);
                  return (
                    <tr key={row.organization_id}>
                      <th scope="row" className="px-5 py-3 font-medium">
                        {row.organization_name}
                        <p className="text-xs font-normal text-muted">
                          {row.brands} marcas · {row.members} personas · {formatBytes(Number(row.storage_bytes))}
                        </p>
                      </th>
                      <td className="px-3 py-3">
                        <span className="font-medium">{row.plan_name}</span>
                        <p className="text-xs text-muted">
                          {SOURCE_LABEL[row.source]}
                          {row.source === 'stripe' && ` · ${STATUS_LABEL[row.status]}`}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatMicros(Number(row.monthly_revenue_micros))}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatMicros(Number(row.ai_cost_micros))}</td>
                      <td
                        className={cn('px-3 py-3 text-right font-medium tabular-nums', margin < 0 && 'text-danger')}
                        data-testid={`margin-${row.organization_id}`}
                      >
                        {formatMicros(margin)}
                      </td>
                      <td className="px-3 py-3">
                        {Number(row.ai_limit_micros) > 0 ? formatMicros(Number(row.ai_limit_micros)) : 'Sin IA'}
                        {row.ai_limit_overridden && (
                          <div className="mt-1 flex items-center gap-2">
                            <Badge tone="warning">Sobrescrito</Badge>
                            <button
                              type="button"
                              className="text-xs font-medium text-primary hover:underline"
                              onClick={() =>
                                clear.mutate(row.organization_id, {
                                  onSuccess: () => toast.success('Cupo de IA devuelto al del plan'),
                                  onError: (e) => toast.error(translateError(e)),
                                })
                              }
                            >
                              Volver al del plan
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setEditing(row)}
                          data-testid={`assign-plan-${row.organization_id}`}
                        >
                          Cambiar plan
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-border bg-subtle text-sm font-medium">
                <tr>
                  <th scope="row" className="px-5 py-3" colSpan={2}>
                    Total
                  </th>
                  <td className="px-3 py-3 text-right tabular-nums">{formatMicros(totals.revenue)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatMicros(totals.cost)}</td>
                  <td className="px-3 py-3 text-right tabular-nums" data-testid="margin-total">
                    {formatMicros(totals.revenue - totals.cost)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          <CardBody>
            <p className="text-xs text-muted">
              Los precios de los planes y los costes de IA se cuentan en la misma unidad (créditos o euros); si no, el
              margen no tendría sentido. Los ingresos son el precio de catálogo, no lo cobrado: impuestos, descuentos y
              prorrateos están en Stripe.
            </p>
          </CardBody>
        </>
      )}
      {editing && <AssignPlanDialog row={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function AssignPlanDialog({ row, onClose }: { row: BillingOverviewRow; onClose: () => void }) {
  const plans = usePlans();
  const assign = useAssignPlan();
  const [planId, setPlanId] = useState('');
  const [price, setPrice] = useState(
    row.custom_price_micros === null ? '' : String(Number(row.custom_price_micros) / 1_000_000).replace('.', ','),
  );
  const [note, setNote] = useState('');
  const priceMicros = price.trim() ? parseUnitsToMicros(price) : null;
  const priceError =
    price.trim() && priceMicros === null ? 'Escribe un importe positivo, con coma para los decimales.' : null;
  const paysWithStripe = row.source === 'stripe' && !['canceled', 'incomplete_expired'].includes(row.status);
  const choices = (plans.data ?? []).filter((p) => p.active);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (priceError) return;
    assign.mutate(
      {
        organizationId: row.organization_id,
        planId: planId === 'default' ? null : planId,
        customPriceMicros: planId === 'default' ? null : priceMicros,
        note: note.trim(),
      },
      {
        onSuccess: () => {
          toast.success('Plan asignado');
          onClose();
        },
        onError: (e) => toast.error(translateError(e)),
      },
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Plan de ${row.organization_name}`}
      description={`Ahora: ${row.plan_name} (${SOURCE_LABEL[row.source].toLowerCase()}). El cambio vale al momento y queda en el registro de actividad de la organización.`}
    >
      {paysWithStripe ? (
        <Notice tone="warning">
          Esta organización paga con Stripe. Cambia o cancela su suscripción en Stripe; el plan se actualizará aquí con
          el aviso de Stripe.
        </Notice>
      ) : plans.isPending ? (
        <Spinner />
      ) : (
        <form onSubmit={submit} className="space-y-4" id="assign-plan-form">
          <Field label="Plan">
            {(p) => (
              <Select
                {...p}
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                required
                data-testid="assign-plan-select"
              >
                <option value="">Elige un plan</option>
                <option value="default">El plan por defecto</option>
                {choices.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {planId !== 'default' && (
            <Field
              label={`Precio pactado por periodo (${moneyUnitLabel()})`}
              optional
              hint="Vacío: el precio del plan. Para clientes con un precio acordado (Enterprise, agencias)."
              error={priceError}
            >
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  data-testid="assign-plan-price"
                />
              )}
            </Field>
          )}
          <Field label="Nota" optional>
            {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={assign.isPending} disabled={!planId} data-testid="assign-plan-save">
              Asignar plan
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
