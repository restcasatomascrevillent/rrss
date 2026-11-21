import { Download, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Card, CardBody, CardHeader, Dialog, Field, Input, Notice } from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { useOrg } from '@/features/orgs/context';
import { translateError } from '@/lib/errors';
import { EXPORT_LINK_SECONDS, useDeleteOrganization, useExportOrganization } from './api';

/**
 * Configuración → Datos (solo propietarios): exportar todos los datos de la
 * organización y borrarla. Los demás roles no ven la pestaña y, si llegan por
 * la dirección, vuelven a la configuración general.
 */
export function OrganizationDataPage() {
  const { org } = useOrg();
  if (org.role !== 'owner') return <Navigate to={`/o/${org.id}/ajustes/general`} replace />;
  return (
    <div className="space-y-5" data-testid="org-data-page">
      <ExportOrganizationCard />
      <DeleteOrganizationCard />
    </div>
  );
}

function ExportOrganizationCard() {
  const { org } = useOrg();
  const exportOrg = useExportOrganization(org.id, org.name);
  return (
    <Card data-testid="org-export">
      <CardHeader
        title="Exportar los datos de la organización"
        description="Un archivo con la configuración, los miembros, las marcas con sus perfiles, los contenidos con todas sus versiones, los encargos y la lista de archivos."
      />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Cada archivo va con un enlace de descarga que caduca en {EXPORT_LINK_SECONDS / 60} minutos: descárgalos al
          momento. No incluye el registro de actividad ni el consumo de IA, que tienen sus propias pantallas.
        </p>
        <Button
          variant="secondary"
          loading={exportOrg.isPending}
          onClick={() =>
            exportOrg.mutate(undefined, {
              onSuccess: ({ files }) =>
                toast.success(
                  files === 1 ? 'Exportación lista, con 1 archivo' : `Exportación lista, con ${files} archivos`,
                ),
              onError: (e) => toast.error(translateError(e)),
            })
          }
          data-testid="org-export-download"
        >
          <Download className="h-4 w-4" aria-hidden />
          Exportar los datos
        </Button>
      </CardBody>
    </Card>
  );
}

function DeleteOrganizationCard() {
  const { org } = useOrg();
  const user = useUser();
  const navigate = useNavigate();
  const remove = useDeleteOrganization(org.id, user.id);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmation.trim() === org.name.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    remove.mutate(confirmation, {
      onSuccess: () => {
        toast.success(`Se ha borrado «${org.name}»`);
        navigate('/', { replace: true });
      },
      onError: (e) => setError(translateError(e)),
    });
  }

  return (
    <Card data-testid="org-delete">
      <CardHeader
        title="Borrar la organización"
        description="Se borran sus marcas, perfiles, contenidos, encargos, biblioteca y archivos, y todas las personas pierden el acceso. Las cuentas de los miembros siguen existiendo."
      />
      <CardBody>
        <Button variant="danger" onClick={() => setOpen(true)} data-testid="org-delete-open">
          <Trash2 className="h-4 w-4" aria-hidden />
          Borrar la organización
        </Button>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setConfirmation('');
              setError(null);
            }
          }}
          title={`Borrar «${org.name}»`}
          description="No se puede deshacer."
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                type="submit"
                form="delete-org-form"
                loading={remove.isPending}
                disabled={!confirmed}
                data-testid="org-delete-confirm"
              >
                Borrar para siempre
              </Button>
            </>
          }
        >
          <form id="delete-org-form" onSubmit={submit} className="space-y-4 text-sm" noValidate>
            <Notice tone="warning">
              Si quieres conservar una copia, exporta antes los datos. Del registro de actividad solo quedará constancia
              de que se borró.
            </Notice>
            <Field label={`Escribe el nombre de la organización (${org.name}) para confirmar`}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  data-testid="org-delete-name"
                />
              )}
            </Field>
            {error && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 font-medium text-danger">
                {error}
              </p>
            )}
          </form>
        </Dialog>
      </CardBody>
    </Card>
  );
}
