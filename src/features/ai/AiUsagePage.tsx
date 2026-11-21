import { useMemo, useState } from 'react';
import { Card, CardBody, CardHeader, ErrorState, Field, Notice, Select, Spinner } from '@/components/ui';
import { useOrg } from '@/features/orgs/context';
import { cn } from '@/lib/utils';
import { lastPeriods, periodStartOf, useAiMonthLedger, useAiMonthlyCost, useAiQuota, type MonthLedger } from './api';
import { formatMicros, moneyEstimateNote } from './money';

const HISTORY_MONTHS = 6;
const count = new Intl.NumberFormat('es-ES');

function monthLabel(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/** Ajustes de la organización → Consumo de IA. Solo administradores (lo impone también la RLS). */
export function AiUsageSettingsPage({ now = new Date() }: { now?: Date }) {
  const { org, isAdmin } = useOrg();
  const periods = useMemo(() => lastPeriods(now, HISTORY_MONTHS), [now]);
  const current = periodStartOf(now);
  const [selected, setSelected] = useState(current);

  if (!isAdmin) return <p className="text-sm text-muted">Solo los administradores pueden ver el consumo de IA.</p>;

  return (
    <div className="space-y-6" data-testid="ai-usage-page">
      <QuotaCard orgId={org.id} periodStart={current} />
      <BrandBreakdown orgId={org.id} periods={periods} selected={selected} onSelect={setSelected} />
      <MonthlyHistory orgId={org.id} periods={periods} />
      <p className="text-xs text-muted" data-testid="ai-money-note">
        {moneyEstimateNote()}
      </p>
    </div>
  );
}

function QuotaCard({ orgId, periodStart }: { orgId: string; periodStart: string }) {
  const quota = useAiQuota(orgId);
  const ledger = useAiMonthLedger(orgId, periodStart);

  return (
    <Card>
      <CardHeader
        title={`Cupo de IA · ${monthLabel(periodStart)}`}
        description="Lo que la organización puede gastar en IA este mes. Se renueva el día 1 de cada mes."
      />
      <CardBody>
        {quota.isPending || ledger.isPending ? (
          <Spinner />
        ) : quota.isError || ledger.isError ? (
          <ErrorState
            error={quota.error ?? ledger.error}
            onRetry={() => {
              void quota.refetch();
              void ledger.refetch();
            }}
          />
        ) : quota.data === null ? (
          <div className="space-y-4">
            <Notice tone="warning">
              <span data-testid="ai-no-quota">
                Esta organización no tiene cupo de IA asignado: su plan no incluye IA, así que nadie puede usarla en sus
                marcas. Para tenerla, cambia de plan o pídeselo a quien administra la plataforma.
              </span>
            </Notice>
            {ledger.data.consumedMicros > 0 && <Figures ledger={ledger.data} limit={null} />}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted" data-testid="ai-quota-source">
              {quota.data.source === 'plan'
                ? `Cupo incluido en el plan «${quota.data.plan_name ?? ''}».`
                : 'Cupo asignado por la plataforma (sustituye al del plan).'}
            </p>
            <Figures ledger={ledger.data} limit={Number(quota.data.limit_value)} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Figures({ ledger, limit }: { ledger: MonthLedger; limit: number | null }) {
  const committed = ledger.consumedMicros + ledger.reservedMicros;
  const available = limit === null ? null : Math.max(0, limit - committed);
  const ratio = limit ? Math.min(1, committed / limit) : limit === 0 ? 1 : 0;
  const exhausted = limit !== null && committed >= limit;
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-4">
        {limit !== null && <Figure label="Cupo del mes" value={formatMicros(limit)} testId="ai-quota-limit" />}
        <Figure label="Consumido" value={formatMicros(ledger.consumedMicros)} testId="ai-quota-consumed" />
        <Figure
          label="Reservado"
          value={formatMicros(ledger.reservedMicros)}
          hint="Generaciones en curso: se aparta lo máximo que podrían costar y se ajusta al terminar."
          testId="ai-quota-reserved"
        />
        {available !== null && (
          <Figure label="Disponible" value={formatMicros(available)} testId="ai-quota-available" />
        )}
      </dl>
      {limit !== null && (
        <div>
          <div
            role="progressbar"
            aria-label="Cupo comprometido"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="h-2 overflow-hidden rounded-full bg-subtle"
          >
            <div
              className={cn(
                'h-full rounded-full',
                exhausted ? 'bg-danger' : ratio >= 0.8 ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {count.format(ledger.generations)} {ledger.generations === 1 ? 'generación' : 'generaciones'} este mes.
          </p>
        </div>
      )}
      {exhausted && (
        <Notice tone="warning">
          <span data-testid="ai-quota-exhausted">
            El cupo de IA de este mes está agotado: nadie de la organización puede generar hasta el mes que viene, salvo
            que la plataforma lo amplíe.
          </span>
        </Notice>
      )}
      {ledger.truncated && (
        <Notice tone="warning">
          El mes tiene demasiados apuntes para leerlos todos: estas cifras se quedan cortas.
        </Notice>
      )}
    </div>
  );
}

function Figure({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function BrandBreakdown({
  orgId,
  periods,
  selected,
  onSelect,
}: {
  orgId: string;
  periods: string[];
  selected: string;
  onSelect: (period: string) => void;
}) {
  const { brands } = useOrg();
  const ledger = useAiMonthLedger(orgId, selected);
  const names = new Map(brands.map((b) => [b.id, b.name]));

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Coste por marca"
        description="Coste real de las generaciones terminadas, por el mes en que se pidieron."
        action={
          <Field label="Mes" className="w-48">
            {(p) => (
              <Select {...p} value={selected} onChange={(e) => onSelect(e.target.value)} data-testid="ai-usage-month">
                {periods.map((period) => (
                  <option key={period} value={period}>
                    {monthLabel(period)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        }
      />
      {ledger.isPending ? (
        <Spinner />
      ) : ledger.isError ? (
        <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : ledger.data.byBrand.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">Sin generaciones terminadas en {monthLabel(selected)}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm" data-testid="ai-usage-brands">
            <caption className="sr-only">Coste de IA por marca en {monthLabel(selected)}</caption>
            <thead className="border-b border-border bg-subtle text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  Marca
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Generaciones
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  Coste
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ledger.data.byBrand.map((row) => (
                <tr key={row.brandId ?? 'deleted'}>
                  <th scope="row" className="px-5 py-3 font-medium">
                    {(row.brandId && names.get(row.brandId)) || 'Marca borrada o sin acceso'}
                  </th>
                  <td className="px-3 py-3 text-right tabular-nums">{count.format(row.generations)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{formatMicros(row.costMicros)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border font-medium">
              <tr>
                <th scope="row" className="px-5 py-3">
                  Total
                </th>
                <td className="px-3 py-3 text-right tabular-nums">{count.format(ledger.data.generations)}</td>
                <td className="px-5 py-3 text-right tabular-nums">{formatMicros(ledger.data.consumedMicros)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

function MonthlyHistory({ orgId, periods }: { orgId: string; periods: string[] }) {
  const months = useAiMonthlyCost(orgId, periods);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Coste por mes"
        description="Total de la organización por el mes en que terminó cada generación. En el cambio de mes puede diferir un poco del desglose por marca."
      />
      {months.isPending ? (
        <Spinner />
      ) : months.isError ? (
        <ErrorState error={months.error} onRetry={() => void months.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm" data-testid="ai-usage-months">
            <caption className="sr-only">Coste de IA por mes</caption>
            <thead className="border-b border-border bg-subtle text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  Mes
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Generaciones
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  Coste
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {months.data.map((month) => (
                <tr key={month.periodStart}>
                  <th scope="row" className="px-5 py-3 font-medium capitalize">
                    {monthLabel(month.periodStart)}
                  </th>
                  <td className="px-3 py-3 text-right tabular-nums">{count.format(month.generations)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{formatMicros(month.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
