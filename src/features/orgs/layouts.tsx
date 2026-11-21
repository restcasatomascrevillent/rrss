import { Building2, SearchX } from 'lucide-react';
import { Suspense, useEffect, useMemo } from 'react';
import { Link, Navigate, Outlet, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, EmptyState, ErrorState } from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { connectResultNotice } from '@/features/social/connectResult';
import { PENDING_INVITE_KEY } from '@/features/invitations/pending';
import { useFeature } from '@/features/platform/integrations/useFeature';
import { AppShell } from '@/layout/AppShell';
import { RouteErrorBoundary } from '@/layout/ErrorBoundary';
import { PageSkeleton, ShellSkeleton } from '@/layout/Skeletons';
import { readLocal, writeLocal } from '@/lib/localStore';
import { useBrands, useMyBrandRoles, useMyOrganizations } from './api';
import { BrandContext, lastSelectionKey, makeBrandContext, OrgContext, useOrg, type LastSelection } from './context';

/** «/»: decide a dónde va cada usuario al entrar. */
export function RootRedirect() {
  const user = useUser();
  const orgs = useMyOrganizations(user.id);
  const pendingInvite = readLocal<string | null>(PENDING_INVITE_KEY, null);
  const [params] = useSearchParams();
  const social = params.get('social');

  // La conexión con Meta vuelve a «/» cuando no sabe la marca: sin esto, el fallo no se vería.
  useEffect(() => {
    const info = connectResultNotice(social);
    if (!info) return;
    if (info.ok) toast.success(info.text);
    else toast.error(info.text);
  }, [social]);

  if (pendingInvite) return <Navigate to={`/invitacion/${pendingInvite}`} replace />;

  // Al entrar en frío, con una visita anterior se va directo a la última marca,
  // sin esperar la lista de organizaciones: el armazón de la organización ya
  // comprueba el acceso (y, si no lo hay, olvida esta elección). Si la lista ya
  // está en memoria (p. ej., al salir de una organización) se decide con ella.
  const remembered = readLocal<LastSelection>(lastSelectionKey(user.id), {});
  if (remembered.orgId && orgs.isPending) {
    const rememberedBrand = remembered.brandByOrg?.[remembered.orgId];
    const target = rememberedBrand ? `/o/${remembered.orgId}/m/${rememberedBrand}/inicio` : `/o/${remembered.orgId}`;
    return <Navigate to={target} replace />;
  }

  if (orgs.isPending) return <ShellSkeleton />;
  if (orgs.isError) return <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />;
  if (orgs.data.length === 0) return <Navigate to="/bienvenida" replace />;

  const last = readLocal<LastSelection>(lastSelectionKey(user.id), {});
  const org = orgs.data.find((o) => o.id === last.orgId) ?? orgs.data[0]!;
  const brandId = last.brandByOrg?.[org.id];
  return <Navigate to={brandId ? `/o/${org.id}/m/${brandId}/inicio` : `/o/${org.id}`} replace />;
}

function isSettingsPath(pathname: string): boolean {
  return /^\/o\/[^/]+\/ajustes(\/|$)/.test(pathname);
}

export function OrgLayout() {
  const user = useUser();
  const { orgId = '', brandId } = useParams();
  const orgs = useMyOrganizations(user.id);
  const brands = useBrands(orgId);
  const brandRoles = useMyBrandRoles(orgId, user.id);
  // El menú lo necesita: se pide ya, a la vez que la organización y las marcas.
  useFeature('aiText');
  const { pathname } = useLocation();

  const org = orgs.data?.find((o) => o.id === orgId);
  const lostAccess = orgs.isSuccess && !org;

  // Sin acceso a la organización recordada, «/» no debe volver a traer aquí.
  useEffect(() => {
    if (!lostAccess) return;
    const key = lastSelectionKey(user.id);
    const last = readLocal<LastSelection>(key, {});
    if (last.orgId === orgId) writeLocal(key, { ...last, orgId: undefined });
  }, [lostAccess, orgId, user.id]);

  useEffect(() => {
    if (!org) return;
    const key = lastSelectionKey(user.id);
    const last = readLocal<LastSelection>(key, {});
    const brandByOrg = { ...last.brandByOrg };
    if (brandId) brandByOrg[org.id] = brandId;
    writeLocal(key, { orgId: org.id, brandByOrg });
  }, [org, brandId, user.id]);

  const value = useMemo(
    () =>
      org
        ? {
            org,
            isAdmin: org.role === 'owner' || org.role === 'admin',
            brands: brands.data ?? [],
            brandRoles: brandRoles.data ?? new Map(),
          }
        : null,
    [org, brands.data, brandRoles.data],
  );

  if (orgs.isPending) return <ShellSkeleton />;
  if (orgs.isError) return <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />;
  if (!org || !value) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <EmptyState
          icon={Building2}
          title="No tienes acceso a esta organización"
          description="Puede que el enlace sea antiguo o que ya no formes parte de ella."
          action={
            <Link to="/">
              <Button>Ir a mis organizaciones</Button>
            </Link>
          }
        />
      </main>
    );
  }

  // En Configuración (que es de la organización) se sigue viendo la última
  // marca: el menú no cambia y se vuelve a ella con un toque.
  const shownBrandId =
    brandId ??
    (isSettingsPath(pathname)
      ? readLocal<LastSelection>(lastSelectionKey(user.id), {}).brandByOrg?.[org.id]
      : undefined);
  const brand = value.brands.find((b) => b.id === shownBrandId) ?? null;
  return (
    <OrgContext.Provider value={value}>
      <AppShell orgs={orgs.data} org={org} brands={value.brands} brand={brand}>
        {brands.isPending || brandRoles.isPending ? (
          <PageSkeleton />
        ) : brands.isError ? (
          <ErrorState error={brands.error} onRetry={() => void brands.refetch()} />
        ) : (
          <RouteErrorBoundary>
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        )}
      </AppShell>
    </OrgContext.Provider>
  );
}

export function BrandLayout() {
  const { org, brands, brandRoles } = useOrg();
  const { brandId = '' } = useParams();
  const brand = brands.find((b) => b.id === brandId);
  const value = useMemo(
    () => (brand ? makeBrandContext(org, brand, brandRoles.get(brand.id)) : null),
    [org, brand, brandRoles],
  );

  if (!brand || !value) {
    return (
      <EmptyState
        icon={SearchX}
        title="No encontramos esta marca"
        description="Puede que no exista o que no tengas acceso a ella."
        action={
          <Link to={`/o/${org.id}`}>
            <Button>Ver mis marcas</Button>
          </Link>
        }
      />
    );
  }
  return (
    <BrandContext.Provider value={value}>
      <Outlet />
    </BrandContext.Provider>
  );
}
