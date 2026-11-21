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
  Select,
  Spinner,
} from '@/components/ui';
import { formatMicros, moneyUnitLabel, parseUnitsToMicros } from '@/features/ai/money';
import { usePlans, useSavePlan, useSetDefaultPlan } from '@/features/billing/api';
import {
  FEATURE_LABEL,
  GIB,
  INTERVAL_LABEL,
  PLAN_FEATURES,
  parseGigabytes,
  parseLimit,
} from '@/features/billing/labels';
import type { BillingInterval, PlanFeature, PlanInsert, PlanRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatBytes } from '@/lib/utils';

const limit = (n: number | null) => (n === null ? 'Sin límite' : String(n));

/** Plataforma → planes: precio, periodo, cuotas y funciones. Editar un plan cambia sus límites al momento. */
export function PlansEditor() {
  const plans = usePlans();
  const setDefault = useSetDefaultPlan();
  const [editing, setEditing] = useState<PlanRow | 'new' | null>(null);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Planes"
        description="Son datos: cambiar un plan cambia al momento los límites de todas las organizaciones que lo tienen, sin desplegar."
        action={
          <Button size="sm" onClick={() => setEditing('new')} data-testid="plan-new">
            Nuevo plan
          </Button>
        }
      />
      {plans.isPending ? (
        <Spinner />
      ) : plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-left text-sm" data-testid="plans-table">
            <caption className="sr-only">Planes de la plataforma</caption>
            <thead className="border-b border-border bg-subtle text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  Plan
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Precio
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Marcas
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Personas
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Almacenamiento
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  IA al mes
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {plans.data.map((plan) => (
                <tr key={plan.id} className={plan.active ? undefined : 'text-muted'}>
                  <th scope="row" className="px-5 py-3 font-medium">
                    {plan.name} {plan.is_default && <Badge tone="primary">Por defecto</Badge>}{' '}
                    {plan.is_public && <Badge tone="success">En línea</Badge>}{' '}
                    {!plan.active && <Badge>Desactivado</Badge>}
                    <p className="text-xs font-normal text-muted">
                      {plan.features.map((f) => FEATURE_LABEL[f]).join(' · ') || 'Sin funciones extra'}
                    </p>
                  </th>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatMicros(plan.price_micros)} {INTERVAL_LABEL[plan.billing_interval]}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{limit(plan.max_brands)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{limit(plan.max_members)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {plan.max_storage_bytes === null ? 'Sin límite' : formatBytes(plan.max_storage_bytes)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {plan.ai_monthly_micros > 0 ? formatMicros(plan.ai_monthly_micros) : 'Sin IA'}
                  </td>
                  <td className="space-x-2 whitespace-nowrap px-5 py-3 text-right">
                    {!plan.is_default && plan.active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={setDefault.isPending && setDefault.variables === plan.id}
                        onClick={() =>
                          setDefault.mutate(plan.id, {
                            onSuccess: () => toast.success(`«${plan.name}» es ahora el plan por defecto`),
                            onError: (e) => toast.error(translateError(e)),
                          })
                        }
                      >
                        Hacer por defecto
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditing(plan)}
                      data-testid={`plan-edit-${plan.code}`}
                    >
                      Editar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CardBody>
        <p className="text-xs text-muted">
          El plan por defecto es el de las organizaciones sin plan asignado y el de las que dejan de pagar. Un plan no
          se borra: se desactiva, y quien ya lo tiene lo conserva.
        </p>
      </CardBody>
      {editing && <PlanDialog plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

const units = (micros: number) => (micros / 1_000_000).toString().replace('.', ',');
const gigabytes = (bytes: number | null) => (bytes === null ? '' : (bytes / GIB).toString().replace('.', ','));

function PlanDialog({ plan, onClose }: { plan: PlanRow | null; onClose: () => void }) {
  const save = useSavePlan();
  const [code, setCode] = useState('');
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [price, setPrice] = useState(plan ? units(plan.price_micros) : '0');
  const [interval, setInterval] = useState<BillingInterval>(plan?.billing_interval ?? 'month');
  const [brands, setBrands] = useState(plan?.max_brands?.toString() ?? '');
  const [members, setMembers] = useState(plan?.max_members?.toString() ?? '');
  const [storage, setStorage] = useState(gigabytes(plan?.max_storage_bytes ?? null));
  const [ai, setAi] = useState(plan ? units(plan.ai_monthly_micros) : '0');
  const [features, setFeatures] = useState<PlanFeature[]>(plan?.features ?? []);
  const [isPublic, setIsPublic] = useState(plan?.is_public ?? false);
  const [active, setActive] = useState(plan?.active ?? true);
  const [stripePrice, setStripePrice] = useState(plan?.stripe_price_id ?? '');
  const [order, setOrder] = useState(String(plan?.sort_order ?? 50));

  const priceMicros = parseUnitsToMicros(price);
  const aiMicros = parseUnitsToMicros(ai);
  const maxBrands = parseLimit(brands);
  const maxMembers = parseLimit(members);
  const maxStorage = parseGigabytes(storage);
  const errors = {
    code: plan || /^[a-z][a-z0-9_-]{1,39}$/.test(code) ? null : 'Minúsculas, números, guion; empieza por letra.',
    price: priceMicros === null ? 'Escribe un importe (0 si es gratis o a medida).' : null,
    ai: aiMicros === null ? 'Escribe un importe (0 si no incluye IA).' : null,
    brands: maxBrands === undefined ? 'Un número entero, o vacío para sin límite.' : null,
    members: maxMembers === undefined ? 'Un número entero, o vacío para sin límite.' : null,
    storage: maxStorage === undefined ? 'Gigabytes (con coma para decimales), o vacío para sin límite.' : null,
    stripe: stripePrice.trim() && !/^price_[A-Za-z0-9_]+$/.test(stripePrice.trim()) ? 'Empieza por «price_».' : null,
    order: /^-?\d{1,6}$/.test(order.trim()) ? null : 'Un número entero.',
  };
  const invalid = Object.values(errors).some(Boolean) || !name.trim();

  function toggle(feature: PlanFeature) {
    setFeatures((current) =>
      current.includes(feature) ? current.filter((f) => f !== feature) : [...current, feature],
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    const changes = {
      name: name.trim(),
      description: description.trim(),
      price_micros: priceMicros!,
      billing_interval: interval,
      max_brands: maxBrands ?? null,
      max_members: maxMembers ?? null,
      max_storage_bytes: maxStorage ?? null,
      ai_monthly_micros: aiMicros!,
      features: PLAN_FEATURES.filter((f) => features.includes(f)),
      is_public: isPublic,
      active,
      stripe_price_id: stripePrice.trim() || null,
      sort_order: Number(order),
    };
    const input = plan
      ? { id: plan.id, changes }
      : { id: null, changes: { ...changes, code: code.trim() } satisfies PlanInsert };
    save.mutate(input, {
      onSuccess: () => {
        toast.success(plan ? 'Plan guardado: los límites ya están en vigor' : 'Plan creado');
        onClose();
      },
      onError: (e) => toast.error(translateError(e)),
    });
  }

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && onClose()}
      title={plan ? `Editar ${plan.name}` : 'Nuevo plan'}
      description={`Importes en ${moneyUnitLabel()}, la misma moneda que los costes de IA.`}
    >
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" data-testid="plan-form">
        {!plan && (
          <Field label="Código" hint="Identificador fijo, no se puede cambiar después." error={errors.code}>
            {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} data-testid="plan-code" />}
          </Field>
        )}
        <Field label="Nombre">
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={60}
              required
              onChange={(e) => setName(e.target.value)}
              data-testid="plan-name-input"
            />
          )}
        </Field>
        <Field label="Descripción" optional className="sm:col-span-2">
          {(p) => <Input {...p} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={`Precio (${moneyUnitLabel()})`} error={errors.price}>
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              data-testid="plan-price"
            />
          )}
        </Field>
        <Field label="Periodo">
          {(p) => (
            <Select {...p} value={interval} onChange={(e) => setInterval(e.target.value as BillingInterval)}>
              <option value="month">Mensual</option>
              <option value="year">Anual</option>
            </Select>
          )}
        </Field>
        <Field label="Marcas activas" hint="Vacío: sin límite." error={errors.brands}>
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              value={brands}
              onChange={(e) => setBrands(e.target.value)}
              data-testid="plan-brands"
            />
          )}
        </Field>
        <Field label="Personas" hint="Vacío: sin límite." error={errors.members}>
          {(p) => <Input {...p} inputMode="numeric" value={members} onChange={(e) => setMembers(e.target.value)} />}
        </Field>
        <Field label="Almacenamiento (GB)" hint="Vacío: sin límite." error={errors.storage}>
          {(p) => <Input {...p} inputMode="decimal" value={storage} onChange={(e) => setStorage(e.target.value)} />}
        </Field>
        <Field label={`Cupo de IA al mes (${moneyUnitLabel()})`} hint="0: el plan no incluye IA." error={errors.ai}>
          {(p) => <Input {...p} inputMode="decimal" value={ai} onChange={(e) => setAi(e.target.value)} />}
        </Field>
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">Funciones incluidas</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {PLAN_FEATURES.map((feature) => (
              <label key={feature} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={features.includes(feature)}
                  onChange={() => toggle(feature)}
                  data-testid={`plan-feature-${feature}`}
                />
                {FEATURE_LABEL[feature]}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Precio de Stripe" optional hint="price_… del producto en Stripe." error={errors.stripe}>
          {(p) => <Input {...p} value={stripePrice} onChange={(e) => setStripePrice(e.target.value)} />}
        </Field>
        <Field label="Orden" error={errors.order}>
          {(p) => <Input {...p} inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          Se puede contratar en línea
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            disabled={plan?.is_default}
            onChange={(e) => setActive(e.target.checked)}
          />
          Activo (se puede asignar)
        </label>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={save.isPending} disabled={invalid} data-testid="plan-save">
            {plan ? 'Guardar' : 'Crear plan'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
