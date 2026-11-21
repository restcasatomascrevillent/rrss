import { Check, Minus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, Notice, Spinner } from '@/components/ui';
import { formatMicros } from '@/features/ai/money';
import { useOrg } from '@/features/orgs/context';
import type { OrganizationPlanUsage, PlanRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn, formatDate } from '@/lib/utils';
import { useOpenBillingPortal, usePlans, usePlanUsage, useStartCheckout } from './api';
import {
  FEATURE_LABEL,
  INTERVAL_LABEL,
  PLAN_FEATURES,
  SOURCE_LABEL,
  STATUS_LABEL,
  storageText,
  usageRatio,
  usageText,
} from './labels';
import { useFeature } from '@/features/platform/integrations/useFeature';

/**
 * Configuración → Plan: plan vigente, uso frente a sus límites y, si la
 * facturación está activa (`VITE_BILLING_ENABLED` y Stripe configurado en el servidor), contratar o cambiar de plan
 * en Stripe. Solo propietarios y administradores (lo impone también la base de datos).
 */
export function PlanSettingsPage({ billingEnabled: forced }: { billingEnabled?: boolean }) {
  // Interruptor de compilación Y Stripe configurado en el servidor (useFeature).
  const live = useFeature('billing');
  const billingEnabled = forced ?? live;
  const { org, isAdmin } = useOrg();
  const usage = usePlanUsage(org.id, isAdmin);
  const [params] = useSearchParams();

  if (!isAdmin) return <p className="text-sm text-muted">Solo los administradores pueden ver el plan.</p>;

  return (
    <div className="space-y-6" data-testid="plan-page">
      {billingEnabled && params.get('pago') === 'ok' && (
        <Notice>
          Stripe ha recibido el pago. El plan cambia aquí en cuanto Stripe nos lo confirme, normalmente en unos
          segundos: recarga la página si no lo ves.
        </Notice>
      )}
      {usage.isPending ? (
        <Spinner />
      ) : usage.isError ? (
        <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <CurrentPlan data={usage.data} billingEnabled={billingEnabled} />
          <Usage data={usage.data} />
          {billingEnabled && <ChangePlan orgId={org.id} data={usage.data} />}
        </>
      )}
    </div>
  );
}

const AI_FEATURES: string[] = ['ai_text', 'ai_image', 'ai_video'];

function CurrentPlan({ data, billingEnabled }: { data: OrganizationPlanUsage; billingEnabled: boolean }) {
  const { plan, subscription } = data;
  const lapsed = subscription.assigned_plan_code !== null && subscription.assigned_plan_code !== plan.code;
  return (
    <Card>
      <CardHeader title={`Plan ${plan.name}`} description={plan.description || undefined} />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="primary" className="font-semibold">
            <span data-testid="plan-name">{plan.name}</span>
          </Badge>
          <Badge>{SOURCE_LABEL[subscription.source]}</Badge>
          {subscription.source === 'stripe' && (
            <Badge tone={subscription.status === 'active' ? 'success' : 'warning'}>
              <span data-testid="plan-status">{STATUS_LABEL[subscription.status]}</span>
            </Badge>
          )}
          {billingEnabled && plan.price_micros > 0 && (
            <span className="text-muted">
              {formatMicros(subscription.custom_price_micros ?? plan.price_micros)}{' '}
              {INTERVAL_LABEL[plan.billing_interval]}
            </span>
          )}
        </div>
        {subscription.status === 'past_due' && (
          <Notice tone="warning">
            Stripe no ha podido cobrar la última cuota y lo está reintentando. Mientras, conservas el plan: revisa la
            tarjeta para no perderlo.
          </Notice>
        )}
        {lapsed && (
          <Notice tone="warning">
            <span data-testid="plan-lapsed">
              La suscripción está {STATUS_LABEL[subscription.status].toLowerCase()}: mientras no se reactive, la
              organización tiene los límites del plan {plan.name}. No se ha borrado nada.
            </span>
          </Notice>
        )}
        {subscription.current_period_end && subscription.source === 'stripe' && (
          <p className="text-xs text-muted">
            {subscription.cancel_at_period_end
              ? `Se cancelará el ${formatDate(subscription.current_period_end)}.`
              : `Próxima renovación: ${formatDate(subscription.current_period_end)}.`}
          </p>
        )}
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2" aria-label="Funciones del plan">
          {PLAN_FEATURES.map((feature) => {
            // Sin cupo de IA este mes (límite 0, p. ej. el plan Prueba) las funciones de IA no se pueden usar.
            const included =
              plan.features.includes(feature) && (!AI_FEATURES.includes(feature) || data.ai_limit_micros > 0);
            return (
              <li key={feature} className={cn('flex items-center gap-2', !included && 'text-muted')}>
                {included ? (
                  <Check className="h-4 w-4 text-success" aria-hidden />
                ) : (
                  <Minus className="h-4 w-4" aria-hidden />
                )}
                {FEATURE_LABEL[feature]}
                <span className="sr-only">{included ? '(incluido)' : '(no incluido)'}</span>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

function Meter({
  label,
  text,
  ratio,
  testId,
  hint,
}: {
  label: string;
  text: string;
  ratio: number | null;
  testId: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted" data-testid={testId}>
          {text}
        </span>
      </div>
      {ratio !== null && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          className="h-2 overflow-hidden rounded-full bg-subtle"
        >
          <div
            className={cn('h-full rounded-full', ratio >= 1 ? 'bg-danger' : ratio >= 0.8 ? 'bg-warning' : 'bg-primary')}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Usage({ data }: { data: OrganizationPlanUsage }) {
  const { plan, usage } = data;
  const seats = usage.members + usage.pending_invitations;
  const aiLimit = data.ai_limit_micros;
  return (
    <Card>
      <CardHeader
        title="Uso frente a los límites del plan"
        description="Al llegar a un límite no se borra nada: solo deja de poder crearse más hasta liberar sitio o cambiar de plan."
      />
      <CardBody className="space-y-5">
        <Meter
          label="Marcas activas"
          text={usageText(usage.brands, plan.max_brands)}
          ratio={usageRatio(usage.brands, plan.max_brands)}
          testId="plan-usage-brands"
          hint="Las marcas archivadas no cuentan."
        />
        <Meter
          label="Personas"
          text={usageText(usage.members, plan.max_members)}
          ratio={usageRatio(seats, plan.max_members)}
          testId="plan-usage-members"
          hint={
            usage.pending_invitations > 0
              ? `Más ${usage.pending_invitations} con la invitación pendiente, que también ocupan plaza.`
              : undefined
          }
        />
        <Meter
          label="Almacenamiento"
          text={storageText(usage.storage_bytes, plan.max_storage_bytes)}
          ratio={usageRatio(usage.storage_bytes, plan.max_storage_bytes)}
          testId="plan-usage-storage"
        />
        <Meter
          label="IA este mes"
          text={
            aiLimit > 0
              ? `${formatMicros(usage.ai_committed_micros)} de ${formatMicros(aiLimit)}`
              : 'Tu plan no incluye IA'
          }
          ratio={aiLimit > 0 ? usageRatio(usage.ai_committed_micros, aiLimit) : null}
          testId="plan-usage-ai"
          hint={data.ai_limit_overridden ? 'Cupo asignado por la plataforma (sustituye al del plan).' : undefined}
        />
      </CardBody>
    </Card>
  );
}

function ChangePlan({ orgId, data }: { orgId: string; data: OrganizationPlanUsage }) {
  const plans = usePlans();
  const checkout = useStartCheckout();
  const portal = useOpenBillingPortal();
  const { subscription, plan } = data;
  const paying =
    subscription.source === 'stripe' &&
    ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(subscription.status);
  const offered = (plans.data ?? []).filter((p: PlanRow) => p.is_public && p.active && p.stripe_price_id);

  const fail = (error: unknown) => toast.error(translateError(error));

  return (
    <Card>
      <CardHeader
        title="Cambiar de plan"
        description="El pago se hace en Stripe: la tarjeta y los datos de facturación nunca pasan por esta aplicación."
      />
      <CardBody className="space-y-4">
        {paying ? (
          <div className="space-y-2">
            <p className="text-sm">
              Para cambiar de plan o de tarjeta, ver las facturas o cancelar, entra en el portal de cliente de Stripe.
            </p>
            <Button
              loading={portal.isPending}
              onClick={() => portal.mutate({ organizationId: orgId }, { onError: fail })}
              data-testid="billing-portal"
            >
              Gestionar el pago en Stripe
            </Button>
          </div>
        ) : subscription.source === 'manual' && subscription.status === 'active' ? (
          <p className="text-sm text-muted" data-testid="plan-manual">
            Tu plan lo gestiona la plataforma directamente. Para cambiarlo, habla con quien la administra.
          </p>
        ) : plans.isPending ? (
          <Spinner />
        ) : plans.isError ? (
          <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
        ) : offered.length === 0 ? (
          <p className="text-sm text-muted">Ahora mismo no hay planes que se puedan contratar en línea.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="plan-options">
            {offered.map((option) => (
              <li key={option.id} className="flex flex-col gap-2 rounded-xl border border-border p-4">
                <p className="font-semibold">{option.name}</p>
                <p className="text-sm text-muted">
                  {formatMicros(option.price_micros)} {INTERVAL_LABEL[option.billing_interval]}
                </p>
                {option.description && <p className="text-xs text-muted">{option.description}</p>}
                <Button
                  className="mt-auto"
                  variant={option.code === plan.code ? 'secondary' : 'primary'}
                  disabled={option.code === plan.code}
                  loading={checkout.isPending && checkout.variables?.planCode === option.code}
                  onClick={() => checkout.mutate({ organizationId: orgId, planCode: option.code }, { onError: fail })}
                  data-testid={`checkout-${option.code}`}
                >
                  {option.code === plan.code ? 'Plan actual' : `Contratar ${option.name}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {subscription.has_billing_account && !paying && (
          <Button
            variant="ghost"
            loading={portal.isPending}
            onClick={() => portal.mutate({ organizationId: orgId }, { onError: fail })}
          >
            Ver facturas anteriores en Stripe
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
