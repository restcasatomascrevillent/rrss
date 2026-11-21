import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingOverviewRow, OrganizationPlanUsage, PlanInsert, PlanRow, PlanUpdate } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { aiKeys } from '@/features/ai/api';

export const billingKeys = {
  usage: (orgId: string) => ['org', orgId, 'plan-usage'] as const,
  plans: ['plans'] as const,
  overview: (periodStart: string) => ['platform', 'billing-overview', periodStart] as const,
};

/** Plan efectivo, suscripción y uso frente a límites (propietarios y administradores). */
export function usePlanUsage(orgId: string, enabled = true) {
  return useQuery({
    queryKey: billingKeys.usage(orgId),
    enabled,
    queryFn: async (): Promise<OrganizationPlanUsage> =>
      unwrap(await supabase.rpc('organization_plan_usage', { p_organization_id: orgId })),
  });
}

/** Planes que ve el usuario: los activos (el superadministrador, todos). */
export function usePlans(enabled = true) {
  return useQuery({
    queryKey: billingKeys.plans,
    enabled,
    queryFn: async (): Promise<PlanRow[]> =>
      unwrap(await supabase.from('plans').select('*').order('sort_order').order('name')),
  });
}

export function useBillingOverview(periodStart: string, enabled = true) {
  return useQuery({
    queryKey: billingKeys.overview(periodStart),
    enabled,
    queryFn: async (): Promise<BillingOverviewRow[]> =>
      unwrap(await supabase.rpc('admin_billing_overview', { p_period_start: periodStart })),
  });
}

function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return (orgId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['platform', 'billing-overview'] }),
      queryClient.invalidateQueries({ queryKey: billingKeys.plans }),
      ...(orgId
        ? [
            queryClient.invalidateQueries({ queryKey: billingKeys.usage(orgId) }),
            queryClient.invalidateQueries({ queryKey: aiKeys.quota(orgId) }),
          ]
        : []),
    ]);
}

export interface AssignPlanInput {
  organizationId: string;
  /** `null` = volver al plan por defecto. */
  planId: string | null;
  customPriceMicros: number | null;
  note: string;
}

export function useAssignPlan() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: async (input: AssignPlanInput) =>
      unwrap(
        await supabase.rpc('admin_set_organization_plan', {
          p_organization_id: input.organizationId,
          p_plan_id: input.planId,
          p_custom_price_micros: input.customPriceMicros,
          p_note: input.note,
        }),
      ),
    onSuccess: (_data, input) => invalidate(input.organizationId),
  });
}

export function useClearAiQuota() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: async (organizationId: string) => {
      unwrap(await supabase.rpc('admin_clear_ai_quota', { p_organization_id: organizationId }));
    },
    onSuccess: (_data, organizationId) => invalidate(organizationId),
  });
}

export function useSavePlan() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: async (input: { id: string; changes: PlanUpdate } | { id: null; changes: PlanInsert }) => {
      if (input.id === null) {
        return unwrap(await supabase.from('plans').insert(input.changes).select('*').single());
      }
      const rows = unwrap(await supabase.from('plans').update(input.changes).eq('id', input.id).select('*'));
      if (rows.length === 0) throw { code: '42501', message: 'permission denied' };
      return rows[0]!;
    },
    onSuccess: () => invalidate(),
  });
}

export function useSetDefaultPlan() {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: async (planId: string) => unwrap(await supabase.rpc('admin_set_default_plan', { p_plan_id: planId })),
    onSuccess: () => invalidate(),
  });
}

// ─────────────────────────── Pago (Stripe) ───────────────────────────
// Las dos funciones devuelven una URL de Stripe; la tarjeta y los datos de pago
// se escriben allí, nunca en la aplicación.

const PAYMENT_ERROR = 'No se ha podido abrir la página de pago. Inténtalo de nuevo en un momento.';

async function billingRedirect(fn: 'billing-checkout' | 'billing-portal', body: Record<string, unknown>) {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke(fn, { body });
  } catch {
    throw new Error(PAYMENT_ERROR);
  }
  if (result.error) {
    const context = (result.error as { context?: unknown }).context;
    if (context instanceof Response) {
      const payload = (await context
        .clone()
        .json()
        .catch(() => null)) as { error?: { message?: unknown } } | null;
      const message = payload?.error?.message;
      if (typeof message === 'string' && message) throw new Error(message);
    }
    throw new Error(PAYMENT_ERROR);
  }
  const url = (result.data as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]*stripe\.com\//i.test(url)) throw new Error(PAYMENT_ERROR);
  return url;
}

/** Abre Stripe Checkout para contratar un plan. */
export function useStartCheckout(navigate: (url: string) => void = (url) => window.location.assign(url)) {
  return useMutation({
    mutationFn: async (input: { organizationId: string; planCode: string }) =>
      navigate(await billingRedirect('billing-checkout', input)),
  });
}

/** Abre el portal de cliente de Stripe (cambiar de plan, de tarjeta, cancelar, facturas). */
export function useOpenBillingPortal(navigate: (url: string) => void = (url) => window.location.assign(url)) {
  return useMutation({
    mutationFn: async (input: { organizationId: string }) => navigate(await billingRedirect('billing-portal', input)),
  });
}
