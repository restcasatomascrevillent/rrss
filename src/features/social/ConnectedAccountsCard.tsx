import { AlertTriangle, AtSign, KeyRound, Link2, Settings2, Unlink } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  Input,
  LinkButton,
  Notice,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { useUser } from '@/features/auth/AuthProvider';
import { useIsPlatformAdmin } from '@/features/orgs/api';
import { useBrand } from '@/features/orgs/context';
import { useSocialConnectModes } from '@/features/platform/integrations/useFeature';
import type { SocialAccountRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { startSocialConnect, useConnectWithToken, useDisconnectAccount, useSocialAccounts } from './api';
import { quotaWarning, tokenExpiresSoon } from './calendar';
import { CONNECT_RESULT } from './connectResult';
import { ImportPostsPanel } from './ImportPostsPanel';
import { CONNECTED_ACCOUNTS_ANCHOR } from './links';

/**
 * Ajustes de la marca · Cuentas conectadas. Solo aparece si el entorno tiene la
 * publicación (VITE_SOCIAL_PUBLISHING_ENABLED y, en el servidor, las claves de
 * cifrado de los tokens). Se conecta por OAuth (si está la aplicación de Meta
 * del producto) o pegando un token de página. Conectar y desconectar es de
 * quien gestiona la marca; los demás ven qué cuenta hay.
 */
export function ConnectedAccountsCard() {
  const { brand, can } = useBrand();
  const canManage = can('manage');
  const modes = useSocialConnectModes();
  const enabled = modes.publishing;
  const [pasting, setPasting] = useState(false);
  const accounts = useSocialAccounts(brand.id);
  const disconnect = useDisconnectAccount(brand.id);
  const [connecting, setConnecting] = useState(false);
  const [confirming, setConfirming] = useState<SocialAccountRow | null>(null);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const user = useUser();
  const platformAdmin = useIsPlatformAdmin(user.id).data === true;

  // Desde un aviso («Conectar cuenta»): bajar hasta esta tarjeta en cuanto se pinta.
  const linked = location.hash === `#${CONNECTED_ACCOUNTS_ANCHOR}`;
  useEffect(() => {
    if (!linked || !enabled) return;
    document.getElementById(CONNECTED_ACCOUNTS_ANCHOR)?.scrollIntoView({ block: 'start' });
  }, [linked, enabled]);

  // Vuelta de Meta: decir cómo fue y limpiar la dirección.
  useEffect(() => {
    const result = params.get('social');
    if (!result) return;
    const info = CONNECT_RESULT[result] ?? CONNECT_RESULT.failed!;
    if (info.ok) toast.success(info.text);
    else toast.error(info.text);
    const next = new URLSearchParams(params);
    next.delete('social');
    setParams(next, { replace: true });
  }, [params, setParams]);

  if (!enabled) return null;

  const instagram = accounts.data?.find((a) => a.network === 'instagram') ?? null;

  const connect = async () => {
    setConnecting(true);
    try {
      window.location.assign(await startSocialConnect(brand.id, 'instagram'));
    } catch (error) {
      toast.error(translateError(error));
      setConnecting(false);
    }
  };

  const needsConnecting = !instagram || instagram.status === 'needs_reauth';
  const tokenLabel = instagram?.connection_method === 'token' ? 'Renovar la conexión avanzada' : 'Conexión avanzada (agencia)';
  const tokenButton = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} size="sm" onClick={() => setPasting(true)} data-testid="social-connect-token">
      <KeyRound className="h-4 w-4" aria-hidden />
      {tokenLabel}
    </Button>
  );

  return (
    <Card data-testid="social-accounts" id={CONNECTED_ACCOUNTS_ANCHOR} className="scroll-mt-6">
      <CardHeader
        title="Cuentas conectadas"
        description={
          modes.socialOAuth
            ? 'Las redes donde se publica lo que se programa en el calendario. Se conectan con el inicio de sesión de Meta: nunca se guarda una contraseña.'
            : 'Las redes donde se publica lo que se programa en el calendario. El acceso se guarda cifrado.'
        }
      />
      <CardBody className="space-y-3">
        {accounts.isPending ? (
          <Skeleton className="h-14" />
        ) : accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : instagram ? (
          <AccountRow account={instagram} canManage={canManage} onDisconnect={() => setConfirming(instagram)} />
        ) : (
          <p className="text-sm text-muted" data-testid="social-accounts-empty">
            No hay ninguna cuenta de Instagram conectada.
          </p>
        )}
        {canManage && instagram?.status === 'active' && <ImportPostsPanel brandId={brand.id} account={instagram} />}
        {canManage && accounts.isSuccess && needsConnecting && modes.socialOAuth && (
          <div className="space-y-3" data-testid="social-connect-meta">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void connect()} loading={connecting} data-testid="social-connect-instagram">
                <Link2 className="h-4 w-4" aria-hidden />
                {instagram ? 'Volver a conectar con Meta' : 'Conectar con Meta'}
              </Button>
              {!instagram && (
                <p className="min-w-[12rem] flex-1 text-xs text-muted">
                  Hace falta una cuenta profesional de Instagram (de empresa o de creador) unida a una página de
                  Facebook.
                </p>
              )}
            </div>
            {modes.socialToken && (
              <details className="rounded-lg border border-border px-3 py-2" data-testid="social-connect-advanced">
                <summary className="cursor-pointer select-none text-sm font-medium text-muted hover:text-fg">
                  Opciones avanzadas
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-muted">
                    Para agencias que ya tienen su propia aplicación de Meta y una clave de acceso de página de larga duración.
                  </p>
                  {tokenButton('secondary')}
                </div>
              </details>
            )}
          </div>
        )}
        {canManage && accounts.isSuccess && needsConnecting && !modes.socialOAuth && modes.socialToken && (
          <ActionNotice
            tone="info"
            icon={Settings2}
            title="La conexión con Meta aún no está activada en la plataforma"
            action={
              <>
                {platformAdmin && (
                  <LinkButton to="/plataforma/integraciones" variant="secondary" data-testid="social-oauth-setup">
                    Activarla
                  </LinkButton>
                )}
                {tokenButton('primary')}
              </>
            }
            why={
              <>
                El botón «Conectar con Meta» sale cuando la plataforma tiene completa su aplicación de Meta, incluida la
                dirección de vuelta a la aplicación. Mientras tanto, se puede conectar la cuenta con la conexión avanzada,
                que suele preparar la agencia.
              </>
            }
            data-testid="social-oauth-off"
          />
        )}
      </CardBody>
      <TokenConnectDialog brandId={brand.id} open={pasting} onOpenChange={setPasting} />
      <ConfirmDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="¿Desconectar la cuenta?"
        description="Lo programado para esta cuenta se detiene hasta que conectes una. Lo ya publicado no cambia."
        confirmLabel="Desconectar"
        loading={disconnect.isPending}
        onConfirm={() =>
          confirming &&
          disconnect.mutate(confirming.id, {
            onSuccess: () => {
              toast.success('Cuenta desconectada');
              setConfirming(null);
            },
            onError: (error) => toast.error(translateError(error)),
          })
        }
      />
    </Card>
  );
}

function AccountRow({
  account,
  canManage,
  onDisconnect,
}: {
  account: SocialAccountRow;
  canManage: boolean;
  onDisconnect: () => void;
}) {
  const quota = quotaWarning(account.quota_usage, account.quota_total);
  return (
    <div className="rounded-lg border border-border p-3" data-testid="social-account">
      <div className="flex flex-wrap items-center gap-3">
        <AtSign className="h-5 w-5 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">@{account.username || account.external_id}</span>
          <span className="block text-xs text-muted">
            Conectada el {formatDate(account.connected_at)}
            {account.connection_method === 'token' &&
              (account.token_expires_at
                ? ` · conexión avanzada, caduca el ${formatDate(account.token_expires_at)}`
                : ' · conexión avanzada, sin fecha de caducidad')}
          </span>
        </span>
        {account.connection_method === 'token' && (
          <span data-testid="social-account-token">
            <Badge>Conexión avanzada</Badge>
          </span>
        )}
        {account.status === 'active' ? (
          <Badge tone="success">Conectada</Badge>
        ) : (
          <Badge tone="danger">Hay que volver a conectarla</Badge>
        )}
        {canManage && (
          <Button variant="ghost" size="sm" onClick={onDisconnect} data-testid="social-disconnect">
            <Unlink className="h-4 w-4" aria-hidden />
            Desconectar
          </Button>
        )}
      </div>
      {(account.status === 'needs_reauth' || tokenExpiresSoon(account.token_expires_at) || quota) && (
        <ul className="mt-2 space-y-1 text-xs text-warning">
          {account.status === 'needs_reauth' && (
            <Warning>
              El acceso ha caducado o se ha retirado{account.last_error ? `: ${account.last_error}` : ''}. Lo programado
              está detenido.
            </Warning>
          )}
          {account.status === 'active' && tokenExpiresSoon(account.token_expires_at) && (
            <Warning>
              El acceso caduca el {formatDate(account.token_expires_at!)}:{' '}
              {account.connection_method === 'token'
                ? 'renueva la conexión avanzada antes de esa fecha.'
                : 'vuelve a conectar la cuenta antes para renovarlo.'}
            </Warning>
          )}
          {quota && (
            <Warning>
              {quota === 'reached'
                ? `Límite de publicaciones de Instagram alcanzado (${account.quota_usage} de ${account.quota_total} en 24 h): lo programado espera.`
                : `Cerca del límite de publicaciones de Instagram: ${account.quota_usage} de ${account.quota_total} en 24 h.`}
            </Warning>
          )}
        </ul>
      )}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-1.5">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/**
 * Conectar pegando un token: para cuentas que ya tienen su propia aplicación de
 * Meta y un token de página de larga duración. El token va al servidor, que lo
 * valida con Meta y lo guarda cifrado; no se vuelve a ver.
 */
function TokenConnectDialog({
  brandId,
  open,
  onOpenChange,
}: {
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connect = useConnectWithToken(brandId);
  const [igUserId, setIgUserId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (!next) {
      setIgUserId('');
      setAccessToken('');
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    connect.mutate(
      { igUserId: igUserId.trim(), accessToken: accessToken.trim() },
      {
        onSuccess: (result) => {
          toast.success(`Cuenta @${result.username} conectada`);
          for (const warning of result.warnings) toast.warning(warning);
          close(false);
        },
        onError: (e) => setError(translateError(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Conexión avanzada de Instagram"
      description="Para cuentas que ya tienen su aplicación de Meta y una clave de acceso de página de larga duración. Normalmente la hace tu agencia."
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancelar
          </Button>
          <Button
            type="submit"
            form="social-token-form"
            loading={connect.isPending}
            disabled={!igUserId.trim() || !accessToken.trim()}
            data-testid="social-token-submit"
          >
            Comprobar y conectar
          </Button>
        </>
      }
    >
      <form id="social-token-form" className="space-y-4" onSubmit={submit}>
        <Notice tone="warning">
          La clave de acceso sustituye al inicio de sesión con Meta para esta cuenta: se publica y se mide con ella.
          Caduca cuando lo diga Meta; entonces la cuenta pasa a «hay que volver a conectarla» y hay que pegar una nueva.
          Se comprueba con Meta antes de guardarla y se guarda cifrada: no se vuelve a ver.
        </Notice>
        <Field label="Identificador de la cuenta de Instagram" hint="Solo cifras, por ejemplo 17841400000000000.">
          {(props) => (
            <Input
              {...props}
              inputMode="numeric"
              autoComplete="off"
              value={igUserId}
              onChange={(e) => setIgUserId(e.target.value)}
              data-testid="social-token-ig-id"
            />
          )}
        </Field>
        <Field
          label="Clave de acceso de página"
          hint="La da Facebook al iniciar sesión (empieza por EAA). Necesita permiso para publicar en Instagram y, para medir, para ver sus estadísticas."
          error={error}
        >
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              data-testid="social-token-value"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
