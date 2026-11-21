import { ChevronLeft, Download, FileCheck2, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  Spinner,
} from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { LegalFooter } from '@/features/legal/LegalFooter';
import { LEGAL_DOCUMENTS, LEGAL_VERSIONS, legalPath } from '@/features/legal/legal';
import { UserMenu } from '@/layout/AppShell';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import {
  acceptedCurrent,
  DeletionError,
  useAcceptLegal,
  useAccountDeletionCheck,
  useDeleteAccount,
  useExportMyData,
  useLegalAcceptances,
} from './api';

const DOCUMENT_LABEL = { terms: 'Condiciones de uso', privacy: 'Política de privacidad' } as const;

/** «Mi cuenta»: documentos aceptados, descargar mis datos y borrar la cuenta. */
export function AccountPage() {
  const user = useUser();
  const fullName = typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : '';

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6" data-testid="account-page">
      <div className="flex items-center justify-between gap-3">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Volver
        </Link>
        <UserMenu compact />
      </div>
      <h1 className="mt-4 text-2xl">Mi cuenta y privacidad</h1>
      <p className="mt-1 text-sm text-muted">
        {fullName ? `${fullName} · ` : ''}
        {user.email}
      </p>

      <div className="mt-6 space-y-5">
        <LegalCard />
        <ExportCard />
        <DeleteCard />
      </div>
      <LegalFooter className="mt-10" />
    </main>
  );
}

function LegalCard() {
  const user = useUser();
  const acceptances = useLegalAcceptances(user.id);
  const accept = useAcceptLegal(user.id);
  const rows = acceptances.data ?? [];
  const upToDate = acceptedCurrent(rows);

  return (
    <Card data-testid="account-legal">
      <CardHeader
        title="Documentos aceptados"
        description="Qué versión de las condiciones de uso y de la política de privacidad aceptaste, y cuándo."
      />
      <CardBody className="space-y-3 text-sm">
        {acceptances.isPending ? (
          <Spinner />
        ) : acceptances.isError ? (
          <ErrorState error={acceptances.error} onRetry={() => void acceptances.refetch()} />
        ) : (
          <>
            {rows.length === 0 ? (
              <p className="text-muted">No consta ninguna aceptación de esta cuenta.</p>
            ) : (
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <FileCheck2 className="h-4 w-4 text-muted" aria-hidden />
                    <span className="font-medium">{DOCUMENT_LABEL[r.document]}</span>
                    <span className="text-muted">
                      versión {r.version} · {formatDate(r.accepted_at)}
                    </span>
                    {r.version === LEGAL_VERSIONS[r.document] && <Badge tone="success">Vigente</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {!upToDate && (
              <div className="space-y-2 rounded-lg bg-subtle p-3" data-testid="account-legal-pending">
                <p>
                  Hay una versión vigente que no consta como aceptada: lee las{' '}
                  <Link to={legalPath('terms')} target="_blank" className="text-primary underline">
                    condiciones de uso
                  </Link>{' '}
                  y la{' '}
                  <Link to={legalPath('privacy')} target="_blank" className="text-primary underline">
                    política de privacidad
                  </Link>
                  .
                </p>
                <Button
                  size="sm"
                  loading={accept.isPending}
                  onClick={() =>
                    accept.mutate(undefined, {
                      onSuccess: () => toast.success('Aceptación guardada'),
                      onError: (e) => toast.error(translateError(e)),
                    })
                  }
                  data-testid="account-legal-accept"
                >
                  He leído y acepto las versiones vigentes
                </Button>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted">
          Documentos: {LEGAL_DOCUMENTS.map((d) => d.title).join(', ')}. Son un borrador pendiente de revisión jurídica.
        </p>
      </CardBody>
    </Card>
  );
}

function ExportCard() {
  const exportData = useExportMyData();
  return (
    <Card data-testid="account-export">
      <CardHeader
        title="Descargar mis datos"
        description="Un archivo con tus datos personales: perfil, organizaciones y roles, documentos aceptados, tu actividad, y los encargos, comentarios, piezas y archivos que creaste."
      />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Los documentos de las piezas y los archivos son de cada organización: los descarga su propietario desde
          Configuración → Datos.
        </p>
        <Button
          variant="secondary"
          loading={exportData.isPending}
          onClick={() =>
            exportData.mutate(undefined, {
              onSuccess: () => toast.success('Descarga preparada'),
              onError: (e) => toast.error(translateError(e)),
            })
          }
          data-testid="account-export-download"
        >
          <Download className="h-4 w-4" aria-hidden />
          Descargar mis datos
        </Button>
      </CardBody>
    </Card>
  );
}

function DeleteCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid="account-delete">
      <CardHeader
        title="Borrar mi cuenta"
        description="Se borran tu cuenta, tu perfil y los documentos que aceptaste, y tu nombre desaparece de la autoría de lo que hiciste. El trabajo de las organizaciones (piezas, archivos, comentarios) se queda en ellas, sin tu nombre."
      />
      <CardBody>
        <Button variant="danger" onClick={() => setOpen(true)} data-testid="account-delete-open">
          <Trash2 className="h-4 w-4" aria-hidden />
          Borrar mi cuenta
        </Button>
        {open && <DeleteAccountDialog open={open} onOpenChange={setOpen} />}
      </CardBody>
    </Card>
  );
}

function DeleteAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const user = useUser();
  const navigate = useNavigate();
  const check = useAccountDeletionCheck(user.id, open);
  const remove = useDeleteAccount(user.id);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const email = user.email ?? '';
  const blocking = check.data?.blocking ?? [];
  const withAccount = check.data?.deleted_with_account ?? [];
  const confirmed = confirmation.trim().toLowerCase() === email.toLowerCase() && password.length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    remove.mutate(
      { confirmation: confirmation.trim(), password },
      {
        onSuccess: () => {
          toast.success('Tu cuenta se ha borrado');
          navigate('/login', { replace: true });
        },
        onError: (e) => {
          setError(translateError(e));
          if (e instanceof DeletionError && e.code === 'owner_of_shared_organizations') void check.refetch();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Borrar mi cuenta"
      description="No se puede deshacer."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            type="submit"
            form="delete-account-form"
            loading={remove.isPending}
            disabled={!confirmed || check.isPending || blocking.length > 0}
            data-testid="account-delete-confirm"
          >
            Borrar mi cuenta para siempre
          </Button>
        </>
      }
    >
      {check.isPending ? (
        <Spinner label="Comprobando tus organizaciones…" />
      ) : check.isError ? (
        <ErrorState error={check.error} onRetry={() => void check.refetch()} />
      ) : (
        <form id="delete-account-form" onSubmit={submit} className="space-y-4 text-sm" noValidate>
          {blocking.length > 0 && (
            <div data-testid="account-delete-blocking">
              <Notice tone="warning">
                Eres la única persona propietaria de{' '}
                {blocking.length === 1 ? 'esta organización, que tiene' : 'estas organizaciones, que tienen'} más
                miembros. Antes de borrar tu cuenta, nombra a otra persona propietaria (Configuración → Equipo) o borra
                la organización (Configuración → Datos):
                <ul className="mt-2 list-disc pl-5">
                  {blocking.map((o) => (
                    <li key={o.organization_id}>
                      <Link to={`/o/${o.organization_id}/ajustes/equipo`} className="underline">
                        {o.name}
                      </Link>{' '}
                      ({o.members} miembros)
                    </li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}
          {withAccount.length > 0 && (
            <div data-testid="account-delete-with-account">
              <Notice tone="warning">
                Se borrarán también, con todos sus datos y archivos, las organizaciones donde eres el único miembro:{' '}
                <strong>{withAccount.map((o) => o.name).join(', ')}</strong>. Si quieres conservar una copia, exporta
                antes sus datos desde Configuración → Datos.
              </Notice>
            </div>
          )}
          <Field label={`Escribe tu correo (${email}) para confirmar`}>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="off"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                disabled={blocking.length > 0}
                data-testid="account-delete-email"
              />
            )}
          </Field>
          <Field label="Tu contraseña">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={blocking.length > 0}
                data-testid="account-delete-password"
              />
            )}
          </Field>
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 font-medium text-danger"
              data-testid="account-delete-error"
            >
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
