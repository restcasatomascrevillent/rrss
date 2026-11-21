import { ArrowLeft, Plug, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { useAdminOrganizations, useIsPlatformAdmin } from '@/features/orgs/api';
import { UserMenu } from '@/layout/AppShell';
import { formatBytes, formatDate } from '@/lib/utils';
import { AiQuotaPanel } from './AiQuotaPanel';
import { BillingPanel } from './BillingPanel';
import { PlansEditor } from './PlansEditor';

export function PlatformPage() {
  const user = useUser();
  const admin = useIsPlatformAdmin(user.id);
  const orgs = useAdminOrganizations(admin.data === true);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex items-center justify-between">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Volver a mis organizaciones
        </Link>
        <UserMenu compact />
      </div>
      <main>
        {admin.isPending ? (
          <Spinner />
        ) : admin.data !== true ? (
          <Card>
            <EmptyState
              icon={ShieldCheck}
              title="Zona reservada"
              description="Esta sección es solo para los administradores de la plataforma."
            />
          </Card>
        ) : (
          <>
            <PageHeader
              title="Plataforma"
              description="Todas las organizaciones dadas de alta y lo que ocupan."
              action={
                <Link
                  to="/plataforma/integraciones"
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-subtle"
                  data-testid="platform-integrations-link"
                >
                  <Plug className="h-4 w-4" aria-hidden />
                  Integraciones
                </Link>
              }
            />
            <Card className="overflow-hidden">
              {orgs.isPending ? (
                <Spinner />
              ) : orgs.isError ? (
                <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-left text-sm" data-testid="platform-orgs">
                    <caption className="sr-only">Organizaciones de la plataforma</caption>
                    <thead className="border-b border-border bg-subtle text-xs text-muted">
                      <tr>
                        <th scope="col" className="px-5 py-3 font-medium">
                          Organización
                        </th>
                        <th scope="col" className="px-3 py-3 font-medium">
                          Alta
                        </th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">
                          Miembros
                        </th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">
                          Marcas
                        </th>
                        <th scope="col" className="px-3 py-3 text-right font-medium">
                          Recursos
                        </th>
                        <th scope="col" className="px-5 py-3 text-right font-medium">
                          Almacenamiento
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {orgs.data.map((org) => (
                        <tr key={org.id}>
                          <th scope="row" className="px-5 py-3 font-medium">
                            {org.name} <Badge className="ml-1">{org.kind === 'agency' ? 'Agencia' : 'Empresa'}</Badge>
                          </th>
                          <td className="px-3 py-3 text-muted">{formatDate(org.created_at)}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{org.members}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{org.brands}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{org.assets}</td>
                          <td className="px-5 py-3 text-right tabular-nums">
                            {formatBytes(Number(org.storage_bytes))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            {orgs.data && (
              <div className="mt-6">
                <AiQuotaPanel organizations={orgs.data} />
              </div>
            )}
            <div className="mt-6 space-y-6">
              <BillingPanel />
              <PlansEditor />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
