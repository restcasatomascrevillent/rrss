import { MailCheck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, Field, Input } from '@/components/ui';
import { APP_NAME } from '@/config/app';
import { LegalFooter } from '@/features/legal/LegalFooter';
import { LEGAL_VERSIONS, legalPath } from '@/features/legal/legal';
import { translateError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { redirectTarget, useAuth } from './AuthProvider';

function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-fg">
            {APP_NAME.charAt(0)}
          </div>
          <h1 className="text-2xl">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
        <Card>
          <CardBody>{children}</CardBody>
        </Card>
        {footer && <p className="mt-5 text-center text-sm text-muted">{footer}</p>}
        <LegalFooter className="mt-8" />
      </div>
    </main>
  );
}

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="auth-error"
      className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger"
    >
      {message}
    </p>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (authError) return setError(translateError(authError));
    navigate(redirectTarget(location.state), { replace: true });
  }

  return (
    <AuthLayout
      title="Inicia sesión"
      subtitle={`Accede a ${APP_NAME} con tu cuenta.`}
      footer={
        <>
          ¿No tienes cuenta?{' '}
          <Link to="/registro" state={location.state} className={linkClass}>
            Crear cuenta
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" data-testid="login-form" noValidate>
        <Field label="Correo electrónico">
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="login-email"
            />
          )}
        </Field>
        <Field label="Contraseña">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="login-password"
            />
          )}
        </Field>
        <FormError message={error} />
        <Button
          type="submit"
          className="w-full"
          loading={loading}
          disabled={!email || !password}
          data-testid="login-submit"
        >
          Entrar
        </Button>
        <p className="text-center text-sm">
          <Link to="/recuperar" className={linkClass}>
            He olvidado mi contraseña
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Consentimiento: casilla sin marcar; sin ella no se crea la cuenta.
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  const passwordTooShort = password.length > 0 && password.length < 8;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const { data, error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Las versiones aceptadas viajan en los metadatos del alta; la base de
        // datos las apunta con la hora del servidor (legal_acceptances).
        data: {
          full_name: fullName.trim(),
          legal: { terms_version: LEGAL_VERSIONS.terms, privacy_version: LEGAL_VERSIONS.privacy },
        },
        emailRedirectTo: window.location.origin,
      },
    });
    setLoading(false);
    if (authError) return setError(translateError(authError));
    // Si el proyecto exige confirmar el correo no hay sesión todavía.
    if (!data.session) return setPendingConfirmation(true);
    navigate(redirectTarget(location.state), { replace: true });
  }

  if (pendingConfirmation) {
    return (
      <AuthLayout title="Revisa tu correo" subtitle="Solo falta un paso.">
        <div className="space-y-3 text-center text-sm" data-testid="register-confirm">
          <MailCheck className="mx-auto h-8 w-8 text-primary" aria-hidden />
          <p>
            Hemos enviado un enlace de confirmación a <strong>{email}</strong>. Ábrelo para activar tu cuenta.
          </p>
          <Link to="/login" className={linkClass}>
            Volver a iniciar sesión
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Crea tu cuenta"
      subtitle="Empieza a gestionar tus marcas en minutos."
      footer={
        <>
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" state={location.state} className={linkClass}>
            Iniciar sesión
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" data-testid="register-form" noValidate>
        <Field label="Nombre">
          {(p) => (
            <Input
              {...p}
              autoComplete="name"
              required
              maxLength={120}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              data-testid="register-name"
            />
          )}
        </Field>
        <Field label="Correo electrónico">
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="register-email"
            />
          )}
        </Field>
        <Field label="Contraseña" hint="Mínimo 8 caracteres." error={passwordTooShort ? 'Le faltan caracteres.' : null}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="register-password"
            />
          )}
        </Field>
        <label className="flex items-start gap-2.5 text-sm" data-testid="register-legal">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            data-testid="register-accept"
          />
          <span>
            He leído y acepto las{' '}
            <Link to={legalPath('terms')} target="_blank" className={linkClass}>
              condiciones de uso
            </Link>{' '}
            y la{' '}
            <Link to={legalPath('privacy')} target="_blank" className={linkClass}>
              política de privacidad
            </Link>
            .
          </span>
        </label>
        <FormError message={error} />
        <Button
          type="submit"
          className="w-full"
          loading={loading}
          disabled={!fullName.trim() || !email || password.length < 8 || !accepted}
          data-testid="register-submit"
        >
          Crear cuenta
        </Button>
      </form>
    </AuthLayout>
  );
}

export function RecoverPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const { error: authError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/restablecer`,
    });
    setLoading(false);
    if (authError) return setError(translateError(authError));
    setSent(true);
  }

  return (
    <AuthLayout
      title="Recupera tu contraseña"
      subtitle="Te enviaremos un enlace para crear una nueva."
      footer={
        <Link to="/login" className={linkClass}>
          Volver a iniciar sesión
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm" data-testid="recover-sent">
          Si existe una cuenta con <strong>{email}</strong>, recibirás un correo con el enlace en unos minutos.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Correo electrónico">
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="recover-email"
              />
            )}
          </Field>
          <FormError message={error} />
          <Button type="submit" className="w-full" loading={loading} disabled={!email} data-testid="recover-submit">
            Enviar enlace
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { user, loading: sessionLoading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const { error: authError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (authError) return setError(translateError(authError));
    navigate('/', { replace: true });
  }

  return (
    <AuthLayout title="Nueva contraseña" subtitle="Elige una contraseña que no uses en otro sitio.">
      {!sessionLoading && !user ? (
        <div className="space-y-3 text-sm">
          <p>El enlace no es válido o ha caducado. Pide uno nuevo.</p>
          <Link to="/recuperar" className={linkClass}>
            Pedir otro enlace
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Contraseña nueva" hint="Mínimo 8 caracteres.">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="reset-password"
              />
            )}
          </Field>
          <FormError message={error} />
          <Button
            type="submit"
            className="w-full"
            loading={loading}
            disabled={password.length < 8}
            data-testid="reset-submit"
          >
            Guardar contraseña
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
