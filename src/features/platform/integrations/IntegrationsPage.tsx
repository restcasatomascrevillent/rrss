import { ArrowLeft, CheckCircle2, CircleSlash, KeyRound, Plug, ShieldCheck, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import {
  aiImageEnabled,
  aiTextEnabled,
  aiVoiceCopilotEnabled,
  driveLibraryEnabled,
  socialPublishingEnabled,
} from '@/config/app';
import { useUser } from '@/features/auth/AuthProvider';
import { billingEnabled } from '@/features/billing/labels';
import { useIsPlatformAdmin } from '@/features/orgs/api';
import { UserMenu } from '@/layout/AppShell';
import type { IntegrationSettingRow, IntegrationTestRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatDateTime } from '@/lib/utils';
import {
  useGenerateTokenKey,
  useGenerateWorkerToken,
  useIntegrationStatus,
  useSaveIntegration,
  useTestIntegration,
  type IntegrationStatus,
  type ProbeResult,
} from './api';
import { UI_INTEGRATIONS, type UiField, type UiIntegration } from './catalog';

const ACTION_LABEL: Record<string, string> = { set: 'Guardó', delete: 'Borró', test: 'Probó la conexión de' };
const TITLE: Record<string, string> = Object.fromEntries(UI_INTEGRATIONS.map((i) => [i.id, i.title]));

/**
 * Plataforma → Integraciones (solo superadministradores): las claves de Meta,
 * ComfyUI, IA y Stripe se meten aquí en lugar de en los secretos de las
 * funciones. Los secretos se escriben y no se vuelven a ver: la pantalla solo
 * sabe «configurado · pista · fecha · quién».
 */
export function IntegrationsPage() {
  const user = useUser();
  const admin = useIsPlatformAdmin(user.id);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex items-center justify-between">
        <Link
          to="/plataforma"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Volver a Plataforma
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
              title="Integraciones"
              description="Las claves de los servicios externos. Se guardan cifradas en la base de datos y mandan sobre las variables de entorno de las funciones; los secretos no se vuelven a ver."
            />
            <IntegrationsBody />
          </>
        )}
      </main>
    </div>
  );
}

function IntegrationsBody() {
  const status = useIntegrationStatus();
  if (status.isPending) return <Spinner />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const data = status.data;
  return (
    <div className="space-y-6">
      <BuildFlags status={data} />
      <Tabs defaultValue={UI_INTEGRATIONS[0]!.id}>
        <TabsList label="Integraciones">
          {UI_INTEGRATIONS.map((i) => (
            <TabsTrigger key={i.id} value={i.id}>
              {i.title}
            </TabsTrigger>
          ))}
        </TabsList>
        {UI_INTEGRATIONS.map((i) => (
          <TabsContent key={i.id} value={i.id} className="pt-4">
            <IntegrationCard integration={i} status={data} />
          </TabsContent>
        ))}
      </Tabs>
      <Activity status={data} />
    </div>
  );
}

/** Qué módulos enseña la interfaz: interruptor de compilación Y servicio configurado. */
function BuildFlags({ status }: { status: IntegrationStatus }) {
  const rows = [
    {
      label: 'Publicación en Instagram',
      build: socialPublishingEnabled(),
      live: status.availability.publishing,
      flag: 'VITE_SOCIAL_PUBLISHING_ENABLED',
    },
    {
      label: 'Botón «Conectar con Meta» (sin él, solo con token)',
      build: socialPublishingEnabled(),
      live: status.availability.socialOAuth,
      flag: 'VITE_SOCIAL_PUBLISHING_ENABLED',
    },
    { label: 'IA de texto', build: aiTextEnabled(), live: status.availability.aiText, flag: 'VITE_AI_TEXT_ENABLED' },
    {
      label: 'IA de imagen',
      build: aiImageEnabled(),
      live: status.availability.aiImage,
      flag: 'VITE_AI_IMAGE_ENABLED',
    },
    {
      label: 'Pago con Stripe',
      build: billingEnabled(),
      live: status.availability.billing,
      flag: 'VITE_BILLING_ENABLED',
    },
    {
      label: 'Copiloto por voz (con la IA de texto)',
      build: aiVoiceCopilotEnabled(),
      live: status.availability.aiText,
      flag: 'VITE_AI_VOICE_COPILOT_ENABLED',
    },
    {
      label: 'Fotos de Google Drive',
      build: driveLibraryEnabled(),
      live: status.availability.drive,
      flag: 'VITE_DRIVE_LIBRARY_ENABLED',
    },
    // Sin variable de compilación: si el servidor guarda en R2, la aplicación tiene que saber leerlo.
    {
      label: 'Archivos en Cloudflare R2',
      build: true,
      live: status.availability.mediaStorage,
      flag: '',
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Qué ve la gente"
        description="Una parte sale en la aplicación si este despliegue la permite (variable de compilación) y su integración está configurada aquí o en el servidor."
      />
      <CardBody>
        <ul className="divide-y divide-border text-sm" data-testid="integration-flags">
          {rows.map((r) => (
            <li key={r.label} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1 font-medium">{r.label}</span>
              {r.build && r.live ? (
                <Badge tone="success">Se enseña</Badge>
              ) : !r.live ? (
                <Badge>Sin configurar</Badge>
              ) : (
                <Badge tone="warning">Configurada, pero este despliegue no la enseña ({r.flag})</Badge>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function TestResult({ test, live }: { test: IntegrationTestRow | undefined; live: ProbeResult | null }) {
  if (live) {
    return (
      <div className="space-y-2" data-testid="integration-test-result" role="status">
        <p className={live.ok ? 'text-sm font-medium text-success' : 'text-sm font-medium text-danger'}>
          {live.ok ? 'Funciona' : 'No funciona'}
        </p>
        <ul className="space-y-1 text-sm">
          {live.checks.map((c) => (
            <li key={c.name} className="flex items-start gap-1.5">
              {c.ok === true ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Bien" />
              ) : c.ok === false ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Mal" />
              ) : (
                <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="No se comprueba" />
              )}
              <span>
                <span className="font-medium">{c.name}:</span> {c.message}
              </span>
            </li>
          ))}
          {live.checks.length === 0 && <li>{live.message}</li>}
        </ul>
      </div>
    );
  }
  if (!test) return <p className="text-sm text-muted">Todavía no se ha probado.</p>;
  return (
    <p className="text-sm" data-testid="integration-last-test">
      <span className={test.ok ? 'font-medium text-success' : 'font-medium text-danger'}>
        {test.ok ? 'Funcionaba' : 'Fallaba'}
      </span>{' '}
      en la última prueba ({formatDateTime(test.tested_at)}
      {test.tested_by_email ? `, ${test.tested_by_email}` : ''}): {test.message}
    </p>
  );
}

function IntegrationCard({ integration, status }: { integration: UiIntegration; status: IntegrationStatus }) {
  const save = useSaveIntegration();
  const test = useTestIntegration();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const stored = new Map(status.settings.map((s) => [s.setting_key, s]));
  const fromEnv = new Set(status.environment);
  const fields = integration.groups.flatMap((g) => g.fields);
  const configured = fields.some((f) => stored.has(f.key) || fromEnv.has(f.key));
  const lastTest = status.tests.find((t) => t.integration === integration.id);

  const changes: Record<string, string | null> = {};
  for (const f of fields) {
    if (removing.has(f.key)) changes[f.key] = null;
    else if (f.key in draft) {
      const value = draft[f.key]!.trim();
      const current = stored.get(f.key)?.value ?? '';
      if (value && (f.secret || value !== current)) changes[f.key] = value;
      if (!value && !f.secret && current) changes[f.key] = null;
    }
  }
  const dirty = Object.keys(changes).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    save.mutate(
      { integration: integration.id, values: changes },
      {
        onSuccess: () => {
          toast.success('Guardado');
          setDraft({});
          setRemoving(new Set());
          setProbe(null);
        },
        onError: (e) => setError(translateError(e)),
      },
    );
  };

  const runTest = () => {
    setProbe(null);
    test.mutate(integration.id, {
      onSuccess: (result) => setProbe(result),
      onError: (e) => toast.error(translateError(e)),
    });
  };

  return (
    <Card data-testid={`integration-${integration.id}`}>
      <CardHeader
        title={integration.title}
        description={integration.description}
        action={configured ? <Badge tone="success">Configurada</Badge> : <Badge>Sin configurar</Badge>}
      />
      <CardBody>
        <form className="space-y-8" onSubmit={submit}>
          {integration.groups.map((group) => (
            <fieldset key={group.title} className="space-y-4">
              <legend className="text-sm font-semibold">{group.title}</legend>
              {group.description && <p className="text-sm text-muted">{group.description}</p>}
              {group.fields.map((field) =>
                field.key === 'SOCIAL_TOKEN_KEYS' ? (
                  <TokenKeys key={field.key} row={stored.get(field.key)} fromEnv={fromEnv.has(field.key)} />
                ) : field.key === 'WORKER_GATEWAY_TOKEN' ? (
                  <WorkerGatewayToken key={field.key} row={stored.get(field.key)} />
                ) : field.key === 'SOCIAL_TOKEN_KEY_ID' ? (
                  <ReadOnlySetting
                    key={field.key}
                    field={field}
                    row={stored.get(field.key)}
                    fromEnv={fromEnv.has(field.key)}
                  />
                ) : (
                  <SettingField
                    key={field.key}
                    field={field}
                    row={stored.get(field.key)}
                    fromEnv={fromEnv.has(field.key)}
                    value={draft[field.key]}
                    removing={removing.has(field.key)}
                    onChange={(value) => setDraft((d) => ({ ...d, [field.key]: value }))}
                    onRemove={(remove) =>
                      setRemoving((r) => {
                        const next = new Set(r);
                        if (remove) next.add(field.key);
                        else next.delete(field.key);
                        return next;
                      })
                    }
                  />
                ),
              )}
            </fieldset>
          ))}
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button type="submit" disabled={!dirty} loading={save.isPending} data-testid="integration-save">
              Guardar
            </Button>
            <Button
              variant="secondary"
              onClick={runTest}
              loading={test.isPending}
              disabled={dirty}
              data-testid="integration-test"
            >
              <Plug className="h-4 w-4" aria-hidden />
              Probar conexión
            </Button>
          </div>
          <p className="text-xs text-muted">
            {integration.testDescription} Se prueba lo guardado{dirty ? ': guarda antes los cambios' : ''}.
          </p>
          <TestResult test={lastTest} live={probe} />
        </form>
      </CardBody>
    </Card>
  );
}

function storedLine(row: IntegrationSettingRow | undefined, fromEnv: boolean, secret: boolean) {
  if (row) {
    return (
      <>
        <Badge tone="success">Configurado</Badge>
        {secret && row.hint && <span className="font-mono">{row.hint}</span>}
        <span>
          {formatDateTime(row.updated_at)}
          {row.updated_by_email ? ` · ${row.updated_by_email}` : ''}
        </span>
        {fromEnv && <span>(manda sobre la variable de entorno)</span>}
      </>
    );
  }
  if (fromEnv) return <Badge tone="primary">En la variable de entorno del servidor</Badge>;
  return <span>Sin configurar</span>;
}

function SettingField({
  field,
  row,
  fromEnv,
  value,
  removing,
  onChange,
  onRemove,
}: {
  field: UiField;
  row: IntegrationSettingRow | undefined;
  fromEnv: boolean;
  value: string | undefined;
  removing: boolean;
  onChange: (value: string) => void;
  onRemove: (remove: boolean) => void;
}) {
  const shown = value ?? (field.secret ? '' : (row?.value ?? ''));
  const placeholder = field.secret
    ? row
      ? 'Escribe uno nuevo para sustituirlo'
      : (field.placeholder ?? '')
    : (field.placeholder ?? '');
  return (
    <div className="space-y-1.5" data-testid={`setting-${field.key}`}>
      <Field label={field.label} hint={field.help} optional>
        {(props) =>
          field.input === 'select' ? (
            <Select {...props} value={shown} disabled={removing} onChange={(e) => onChange(e.target.value)}>
              <option value="">— Sin elegir —</option>
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : field.input === 'textarea' ? (
            <Textarea
              {...props}
              rows={field.secret ? 4 : 3}
              value={shown}
              placeholder={placeholder}
              disabled={removing}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <Input
              {...props}
              type={field.secret ? 'password' : 'text'}
              value={shown}
              placeholder={placeholder}
              disabled={removing}
              autoComplete={field.secret ? 'new-password' : 'off'}
              spellCheck={false}
              onChange={(e) => onChange(e.target.value)}
            />
          )
        }
      </Field>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid={`setting-state-${field.key}`}>
        <code className="rounded bg-subtle px-1.5 py-0.5">{field.key}</code>
        {storedLine(row, fromEnv, field.secret)}
        {row && (
          <Button variant="ghost" size="sm" onClick={() => onRemove(!removing)}>
            {removing ? 'No borrar' : 'Borrar'}
          </Button>
        )}
        {removing && <span className="font-medium text-danger">Se borrará al guardar</span>}
      </div>
    </div>
  );
}

function ReadOnlySetting({
  field,
  row,
  fromEnv,
}: {
  field: UiField;
  row: IntegrationSettingRow | undefined;
  fromEnv: boolean;
}) {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{field.label}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <code className="rounded bg-subtle px-1.5 py-0.5">{field.key}</code>
        {row?.value && <span className="font-mono text-fg">{row.value}</span>}
        {storedLine(row, fromEnv, false)}
      </div>
    </div>
  );
}

function TokenKeys({ row, fromEnv }: { row: IntegrationSettingRow | undefined; fromEnv: boolean }) {
  const generate = useGenerateTokenKey();
  return (
    <div className="space-y-2 text-sm" data-testid="setting-SOCIAL_TOKEN_KEYS">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <code className="rounded bg-subtle px-1.5 py-0.5">SOCIAL_TOKEN_KEYS</code>
        {storedLine(row, fromEnv, false)}
      </div>
      {fromEnv && !row && (
        <Notice>
          Las claves del servidor siguen sirviendo para descifrar lo ya guardado aunque generes una aquí: se usan las
          dos.
        </Notice>
      )}
      <Button
        variant="secondary"
        size="sm"
        loading={generate.isPending}
        onClick={() =>
          generate.mutate(undefined, {
            onSuccess: (r) => toast.success(`Clave de cifrado ${r.keyId} generada`),
            onError: (e) => toast.error(translateError(e)),
          })
        }
        data-testid="integration-generate-key"
      >
        <KeyRound className="h-4 w-4" aria-hidden />
        {row || fromEnv ? 'Generar una clave nueva (rotar)' : 'Generar clave'}
      </Button>
    </div>
  );
}

/**
 * Token del trabajador para `worker-gateway`: se genera aquí (nunca se pega a
 * mano), se enseña UNA vez para copiarlo a Fly y en la base de datos solo
 * queda su huella. Revocar lo borra: el trabajador deja de poder entrar.
 */
function WorkerGatewayToken({ row }: { row: IntegrationSettingRow | undefined }) {
  const generate = useGenerateWorkerToken();
  const save = useSaveIntegration();
  const [token, setToken] = useState<string | null>(null);
  const copy = () => {
    if (!token) return;
    navigator.clipboard?.writeText(token).then(
      () => toast.success('Token copiado'),
      () => toast.error('No se pudo copiar: selecciónalo y cópialo a mano'),
    );
  };
  return (
    <div className="space-y-2 text-sm" data-testid="setting-WORKER_GATEWAY_TOKEN">
      <p className="font-medium">Token del trabajador</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <code className="rounded bg-subtle px-1.5 py-0.5">WORKER_GATEWAY_TOKEN</code>
        {row ? (
          <>
            <Badge tone="success">Generado</Badge>
            <span>
              {formatDateTime(row.updated_at)}
              {row.updated_by_email ? ` · ${row.updated_by_email}` : ''}
            </span>
          </>
        ) : (
          <span>Sin generar</span>
        )}
      </div>
      {token && (
        <Notice tone="warning">
          <span className="block font-medium">Cópialo ahora: no se volverá a ver.</span>
          <span className="mt-1 block">
            Pégalo en Fly (la app → «Secrets») como <code>WORKER_GATEWAY_TOKEN</code>. El anterior, si había, ya no
            vale.
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={token}
              aria-label="Token del trabajador"
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
              data-testid="worker-token-value"
            />
            <Button variant="secondary" size="sm" onClick={copy}>
              Copiar
            </Button>
          </span>
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={generate.isPending}
          onClick={() =>
            generate.mutate(undefined, {
              onSuccess: (r) => setToken(r.token),
              onError: (e) => toast.error(translateError(e)),
            })
          }
          data-testid="integration-generate-worker-token"
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {row ? 'Generar uno nuevo (rotar)' : 'Generar token'}
        </Button>
        {row && (
          <Button
            variant="ghost"
            size="sm"
            loading={save.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  '¿Revocar el token? El trabajador dejará de poder reclamar trabajos hasta que generes otro.',
                )
              )
                return;
              save.mutate(
                { integration: 'media_worker', values: { WORKER_GATEWAY_TOKEN: null } },
                {
                  onSuccess: () => {
                    setToken(null);
                    toast.success('Token revocado');
                  },
                  onError: (e) => toast.error(translateError(e)),
                },
              );
            }}
            data-testid="integration-revoke-worker-token"
          >
            Revocar
          </Button>
        )}
      </div>
    </div>
  );
}

function Activity({ status }: { status: IntegrationStatus }) {
  return (
    <Card>
      <CardHeader title="Actividad" description="Quién cambió o probó qué. Nunca se guarda el valor." />
      <CardBody>
        {status.audit.length === 0 ? (
          <p className="text-sm text-muted">Todavía no hay actividad.</p>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="integration-audit">
            {status.audit.map((a) => (
              <li key={a.id} className="py-2">
                <span className="text-muted">{formatDateTime(a.created_at)}</span> · {a.actor_email ?? 'alguien'}{' '}
                {ACTION_LABEL[a.action] ?? a.action} {a.setting_key ? <code>{a.setting_key}</code> : null}
                {a.setting_key ? ' en ' : ' '}
                {TITLE[a.integration] ?? a.integration}
                {a.action === 'test' && typeof a.data === 'object' && a.data && 'ok' in a.data
                  ? (a.data as { ok: boolean }).ok
                    ? ': funcionaba'
                    : ': fallaba'
                  : ''}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
