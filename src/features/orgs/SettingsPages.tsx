import { ChevronLeft, ChevronRight, LogOut, MoreHorizontal, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import { ActivityList } from '@/features/audit/ActivityList';
import { useUser } from '@/features/auth/AuthProvider';
import { InviteDialog } from '@/features/invitations/InviteDialog';
import { assignableOrgRoles, BRAND_ROLE_LABEL, canRemoveMember, ORG_ROLE_LABEL } from '@/features/permissions/roles';
import { useFeature } from '@/features/platform/integrations/useFeature';
import type { OrgKind, OrgRole } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { cn, formatDate } from '@/lib/utils';
import {
  useAuditLogs,
  useInvitations,
  useOrgMembers,
  useRemoveMember,
  useRevokeInvitation,
  useSetMemberRole,
  useUpdateOrganization,
  type Member,
} from './api';
import { useOrg } from './context';

export function SettingsLayout() {
  const { org, isAdmin } = useOrg();
  const base = `/o/${org.id}/ajustes`;
  const drive = useFeature('drive');
  const tabs = [
    { to: `${base}/general`, label: 'General' },
    { to: `${base}/equipo`, label: 'Equipo' },
    ...(isAdmin ? [{ to: `${base}/actividad`, label: 'Actividad' }] : []),
    ...(isAdmin ? [{ to: `${base}/ia`, label: 'Consumo de IA' }] : []),
    ...(isAdmin ? [{ to: `${base}/plan`, label: 'Plan' }] : []),
    // Biblioteca con Google Drive: solo si el entorno la tiene y está configurada.
    ...(drive ? [{ to: `${base}/drive`, label: 'Google Drive' }] : []),
    // RGPD: exportar y borrar la organización, solo propietarios.
    ...(org.role === 'owner' ? [{ to: `${base}/datos`, label: 'Datos' }] : []),
  ];
  return (
    <>
      <PageHeader title="Configuración" description={`Organización ${org.name}`} />
      <nav aria-label="Secciones de configuración" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                '-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium',
                isActive ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

export function GeneralSettingsPage() {
  const { org } = useOrg();
  // La clave reinicia el formulario cuando los datos guardados cambian.
  return <GeneralSettingsForm key={`${org.name}|${org.kind}`} />;
}

function GeneralSettingsForm() {
  const { org, isAdmin } = useOrg();
  const update = useUpdateOrganization(org.id);
  const [name, setName] = useState(org.name);
  const [kind, setKind] = useState<OrgKind>(org.kind);

  const dirty = name.trim() !== org.name || kind !== org.kind;

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      { name: name.trim(), kind },
      { onSuccess: () => toast.success('Cambios guardados'), onError: (e) => toast.error(translateError(e)) },
    );
  }

  return (
    <Card>
      <CardHeader
        title="Datos de la organización"
        description={isAdmin ? undefined : 'Solo los administradores pueden cambiarlos.'}
      />
      <CardBody>
        <form onSubmit={submit} className="max-w-lg space-y-4">
          <Field label="Nombre">
            {(p) => (
              <Input
                {...p}
                required
                maxLength={120}
                disabled={!isAdmin}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="org-settings-name"
              />
            )}
          </Field>
          <Field label="Tipo" hint="Solo cambia cómo se presenta la organización; no afecta a los permisos.">
            {(p) => (
              <Select {...p} disabled={!isAdmin} value={kind} onChange={(e) => setKind(e.target.value as OrgKind)}>
                <option value="business">Empresa</option>
                <option value="agency">Agencia</option>
              </Select>
            )}
          </Field>
          {isAdmin && (
            <Button
              type="submit"
              loading={update.isPending}
              disabled={!dirty || !name.trim()}
              data-testid="org-settings-save"
            >
              Guardar cambios
            </Button>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function MemberRow({ member, onRemove }: { member: Member; onRemove: (member: Member) => void }) {
  const { org } = useOrg();
  const user = useUser();
  const setRole = useSetMemberRole(org.id);
  const isSelf = member.user_id === user.id;
  const roles = assignableOrgRoles(org.role, member.role).filter((r) => r !== member.role);
  const removable = canRemoveMember(org.role, member.role, isSelf);

  return (
    <li className="flex items-center gap-3 px-5 py-3" data-testid={`member-${member.email}`}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.full_name || member.email} {isSelf && <span className="font-normal text-muted">(tú)</span>}
        </p>
        <p className="truncate text-xs text-muted">{member.email}</p>
      </div>
      <Badge tone={member.role === 'member' ? 'neutral' : 'primary'}>{ORG_ROLE_LABEL[member.role]}</Badge>
      {(roles.length > 0 || removable) && (
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Acciones para ${member.full_name || member.email}`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {roles.length > 0 && <MenuLabel>Cambiar rol</MenuLabel>}
            {roles.map((role) => (
              <MenuItem
                key={role}
                onSelect={() =>
                  setRole.mutate(
                    { userId: member.user_id, role },
                    {
                      onSuccess: () => toast.success('Rol actualizado'),
                      onError: (e) => toast.error(translateError(e)),
                    },
                  )
                }
              >
                {ORG_ROLE_LABEL[role]}
              </MenuItem>
            ))}
            {roles.length > 0 && removable && <MenuSeparator />}
            {removable && (
              <MenuItem destructive onSelect={() => onRemove(member)}>
                {isSelf ? 'Salir de la organización' : 'Quitar de la organización'}
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
      )}
    </li>
  );
}

export function TeamSettingsPage() {
  const { org, isAdmin, brands } = useOrg();
  const user = useUser();
  const navigate = useNavigate();
  const members = useOrgMembers(org.id);
  const invitations = useInvitations(org.id);
  const remove = useRemoveMember(org.id);
  const revoke = useRevokeInvitation(org.id);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const invitableRoles: OrgRole[] = org.role === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin'];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name;
  const removingSelf = removing?.user_id === user.id;

  function confirmRemove() {
    if (!removing) return;
    // Con la promesa y no con los avisos de `mutate`: al salir uno mismo, la organización desaparece de la
    // lista y esta pantalla se desmonta antes de que la mutación termine; los avisos de `mutate` no se ejecutarían.
    remove.mutateAsync(removing.user_id).then(
      () => {
        setRemoving(null);
        if (removingSelf) navigate('/', { replace: true });
        else toast.success('Miembro quitado');
      },
      (e: unknown) => {
        setRemoving(null);
        toast.error(translateError(e));
      },
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Miembros"
          description="Quién forma parte de la organización."
          action={
            isAdmin && (
              <Button size="sm" onClick={() => setInviting(true)} data-testid="invite-open">
                <UserPlus className="h-4 w-4" aria-hidden />
                Invitar
              </Button>
            )
          }
        />
        {members.isPending ? (
          <Spinner />
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => void members.refetch()} />
        ) : (
          <ul className="divide-y divide-border">
            {members.data.map((member) => (
              <MemberRow key={member.user_id} member={member} onRemove={setRemoving} />
            ))}
          </ul>
        )}
      </Card>

      {!isAdmin && (
        <Button
          variant="secondary"
          onClick={() => setRemoving(members.data?.find((m) => m.user_id === user.id) ?? null)}
          disabled={!members.data}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Salir de la organización
        </Button>
      )}

      {(isAdmin || (invitations.data?.length ?? 0) > 0) && (
        <Card>
          <CardHeader
            title="Invitaciones pendientes"
            description="El enlace de cada invitación solo se muestra al crearla; si se ha perdido, anúlala y crea otra."
          />
          {invitations.isPending ? (
            <Spinner />
          ) : invitations.isError ? (
            <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} />
          ) : invitations.data.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">No hay invitaciones pendientes.</p>
          ) : (
            <ul className="divide-y divide-border">
              {invitations.data.map((inv) => (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center gap-3 px-5 py-3"
                  data-testid={`invitation-${inv.email}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{inv.email}</p>
                    <p className="text-xs text-muted">
                      {ORG_ROLE_LABEL[inv.org_role]}
                      {inv.brand_id &&
                        inv.brand_role &&
                        ` · ${BRAND_ROLE_LABEL[inv.brand_role]} en ${brandName(inv.brand_id) ?? 'una marca'}`}{' '}
                      · caduca el {formatDate(inv.expires_at)}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={revoke.isPending && revoke.variables === inv.id}
                    onClick={() =>
                      revoke.mutate(inv.id, {
                        onSuccess: () => toast.success('Invitación anulada'),
                        onError: (e) => toast.error(translateError(e)),
                      })
                    }
                  >
                    Anular
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        orgId={org.id}
        orgRoles={invitableRoles}
        brands={brands.filter((b) => b.status !== 'archived')}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removingSelf ? '¿Salir de la organización?' : `¿Quitar a ${removing?.full_name || removing?.email}?`}
        description={
          removingSelf
            ? 'Perderás el acceso a todas sus marcas. Para volver necesitarás una invitación nueva.'
            : 'Perderá el acceso a la organización y a todas sus marcas.'
        }
        confirmLabel={removingSelf ? 'Salir' : 'Quitar'}
        onConfirm={confirmRemove}
        loading={remove.isPending}
      />
    </div>
  );
}

export function ActivitySettingsPage() {
  const { org, isAdmin } = useOrg();
  const [page, setPage] = useState(0);
  const logs = useAuditLogs(org.id, { page, enabled: isAdmin });

  if (!isAdmin) return <p className="text-sm text-muted">Solo los administradores pueden ver la actividad.</p>;
  return (
    <Card>
      <CardHeader title="Actividad" description="Registro de los cambios hechos en la organización y sus marcas." />
      <ActivityList
        page={logs.data}
        isPending={logs.isPending}
        error={logs.error}
        onRetry={() => void logs.refetch()}
      />
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Más recientes
        </Button>
        <span className="text-xs text-muted">Página {page + 1}</span>
        <Button variant="secondary" size="sm" disabled={!logs.data?.hasMore} onClick={() => setPage((p) => p + 1)}>
          Anteriores
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </Card>
  );
}
