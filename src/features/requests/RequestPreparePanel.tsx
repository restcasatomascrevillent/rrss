// «Preparar el encargo» en la pantalla del encargo, para quien edita la marca:
// tomarlo, soltarlo y entregar una pieza que ya existe (del mismo destino),
// después de pasar el verificador de marca. Es lo mismo que hace la
// herramienta `agency/`, con las mismas funciones de la base de datos.
import { Hand, PackageCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Field,
  Notice,
  Select,
  Skeleton,
} from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { useActiveProfile } from '@/features/brand/api';
import { BrandCheckResultView } from '@/features/brandcheck/ui/BrandCheckPanel';
import { contentPaths, targetLabel } from '@/features/content/labels';
import { useOrg } from '@/features/orgs/context';
import type { ContentRequestRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatDateTime } from '@/lib/utils';
import { checkForRequest, prepareState, useDeliverableItems, usePieceToDeliver, usePrepareMutations } from './prepare';

export function RequestPreparePanel({ request }: { request: ContentRequestRow }) {
  const { org } = useOrg();
  const user = useUser();
  const state = prepareState(request, user.id);
  const mutations = usePrepareMutations(request.brand_id);
  const items = useDeliverableItems(request.brand_id, request.network, request.format, state === 'mine');
  const profile = useActiveProfile(request.brand_id);
  // Por defecto, la pieza del encargo (si la tiene): lo normal es entregarla después de editarla.
  const [chosen, setChosen] = useState<string | null>(request.content_id);
  const piece = usePieceToDeliver(request.brand_id, state === 'mine' ? chosen : null);
  const [confirming, setConfirming] = useState(false);

  if (state === 'none') return null;

  const document = piece.data?.current?.document ?? null;
  const check = document ? checkForRequest(document, request, profile.data?.data ?? null) : null;
  const blocked = check?.verdict === 'fail';
  const options = items.data ?? [];

  const take = () =>
    mutations.take.mutate(request.id, {
      onSuccess: () => toast.success('Encargo tomado: nadie más lo preparará mientras lo tengas.'),
      onError: (e) => toast.error(translateError(e)),
    });
  const release = () =>
    mutations.release.mutate(request.id, {
      onSuccess: () => toast.success('Encargo soltado: vuelve a la cola.'),
      onError: (e) => toast.error(translateError(e)),
    });
  const deliver = () => {
    if (!document || !piece.data || blocked) return;
    mutations.deliver.mutate(
      { request, title: piece.data.item.title, document },
      {
        onSuccess: () => toast.success('Entregado: el cliente ya puede revisarlo.'),
        onError: (e) => toast.error(translateError(e)),
        onSettled: () => setConfirming(false),
      },
    );
  };

  return (
    <Card data-testid="request-prepare">
      <CardHeader
        title="Preparar el encargo"
        description="Tómalo para que nadie más lo prepare a la vez y entrega una pieza de Contenidos."
      />
      <CardBody className="space-y-4">
        {state === 'takeable' && (
          <Button onClick={take} loading={mutations.take.isPending} data-testid="request-take">
            <Hand className="h-4 w-4" aria-hidden />
            Tomar el encargo
          </Button>
        )}
        {state === 'taken_by_other' && (
          <Notice>
            Lo está preparando otra persona hasta el {formatDateTime(request.claimed_until!)}. Si lo suelta o se le
            acaba el tiempo, podrás tomarlo.
          </Notice>
        )}
        {state === 'other_session' && (
          <Notice>
            Lo tienes tomado desde otra sesión (la herramienta de la agencia) hasta el{' '}
            {formatDateTime(request.claimed_until!)}. Entrégalo desde allí o suéltalo allí para hacerlo aquí.
          </Notice>
        )}
        {state === 'mine' && (
          <>
            <p className="text-sm text-muted">
              Lo tienes tomado hasta el {formatDateTime(request.claimed_until!)}. Prepara la pieza en Contenidos (
              {targetLabel(request.network, request.format)}) y elígela aquí para entregarla.
            </p>
            {items.isPending ? (
              <Skeleton className="h-10" />
            ) : items.isError ? (
              <ErrorState error={items.error} onRetry={() => void items.refetch()} />
            ) : options.length === 0 ? (
              <Notice>
                No hay piezas de {targetLabel(request.network, request.format)} con contenido.{' '}
                <Link to={contentPaths(org.id, request.brand_id).list} className="font-medium underline">
                  Crea una en Contenidos
                </Link>{' '}
                y vuelve aquí.
              </Notice>
            ) : (
              <Field label="Pieza que se entrega">
                {(props) => (
                  <Select
                    {...props}
                    value={chosen ?? ''}
                    onChange={(e) => setChosen(e.target.value || null)}
                    data-testid="request-deliver-piece"
                  >
                    <option value="">Elige una pieza</option>
                    {options.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title} · versión {item.current_version}
                        {item.id === request.content_id ? ' (la del encargo)' : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}

            {chosen && piece.isPending && <Skeleton className="h-24" />}
            {chosen && piece.isError && <ErrorState error={piece.error} onRetry={() => void piece.refetch()} />}
            {piece.data && !document && (
              <Notice tone="warning">
                {piece.data.current?.documentError ?? 'Esta pieza todavía no tiene contenido que entregar.'}
              </Notice>
            )}
            {check && (
              <div data-testid="request-deliver-check">
                <BrandCheckResultView result={check} />
              </div>
            )}
            {blocked && (
              <Notice tone="warning">
                El verificador de marca encuentra bloqueos: corrígelos en el editor antes de entregar.
              </Notice>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setConfirming(true)} disabled={!document || blocked} data-testid="request-deliver">
                <PackageCheck className="h-4 w-4" aria-hidden />
                Entregar
              </Button>
              <Button
                variant="ghost"
                onClick={release}
                loading={mutations.release.isPending}
                data-testid="request-release"
              >
                <Undo2 className="h-4 w-4" aria-hidden />
                Soltar el encargo
              </Button>
            </div>
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="¿Entregar esta pieza?"
        description={
          request.content_id && chosen !== request.content_id
            ? 'Su documento se guardará como versión nueva de la pieza del encargo, en borrador, y el cliente podrá revisarla.'
            : 'Se guardará como versión nueva de la pieza del encargo, en borrador, y el cliente podrá revisarla.'
        }
        confirmLabel="Entregar"
        destructive={false}
        loading={mutations.deliver.isPending}
        onConfirm={deliver}
      />
    </Card>
  );
}
