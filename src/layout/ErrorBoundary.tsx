import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui';
import { isChunkLoadError, pageReloader, reloadOnceForNewVersion } from '@/lib/lazyRoute';
import { cn } from '@/lib/utils';

function reloadPage() {
  pageReloader.reload();
}

/** El trozo de código de la sección ya no existe: hay un despliegue más nuevo. */
export function NewVersionNotice({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div
      role="alert"
      data-testid="new-version-notice"
      className={cn('flex flex-col items-center px-6 py-12 text-center', fullScreen && 'min-h-dvh justify-center')}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
        <RefreshCw className="h-5 w-5" aria-hidden />
      </div>
      <h2 className="text-base">Hay una versión nueva de la aplicación</h2>
      <p className="mt-1 max-w-md text-sm text-muted">
        Recarga la página para seguir. No se pierde nada de lo que ya está guardado.
      </p>
      <Button className="mt-5" onClick={reloadPage}>
        Recargar
      </Button>
    </div>
  );
}

function SectionError({ onRetry, fullScreen }: { onRetry: () => void; fullScreen: boolean }) {
  return (
    <div
      role="alert"
      data-testid="section-error"
      className={cn('flex flex-col items-center px-6 py-12 text-center', fullScreen && 'min-h-dvh justify-center')}
    >
      <AlertTriangle className="mb-3 h-6 w-6 text-danger" aria-hidden />
      <h2 className="text-base">Esta sección no se ha podido mostrar</h2>
      <p className="mt-1 max-w-md text-sm text-muted">
        Ha fallado algo al pintarla. Prueba otra vez; si sigue igual, recarga la página.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onRetry}>Reintentar</Button>
        <Button variant="secondary" onClick={reloadPage}>
          Recargar la página
        </Button>
      </div>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  /** Al cambiar (otra ruta), el error se olvida y se vuelve a intentar. */
  resetKey?: string;
  /** Ocupa toda la pantalla (cuando no hay menú alrededor). */
  fullScreen?: boolean;
}

interface BoundaryState {
  error: unknown;
  /** Se está recargando la página por un trozo de código antiguo. */
  reloading: boolean;
}

/**
 * Límite de errores de una sección: si algo falla al pintarla, enseña un
 * mensaje con «Reintentar» en vez de dejar la pantalla en negro. Si el fallo es
 * de un trozo de código que ya no existe, recarga una vez y, si no basta,
 * enseña el aviso de versión nueva.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, reloading: false };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isChunkLoadError(error)) {
      if (reloadOnceForNewVersion()) this.setState({ reloading: true });
      return;
    }
    console.error('Error al pintar la sección', error, info.componentStack);
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = () => this.setState({ error: null, reloading: false });

  render() {
    const { error, reloading } = this.state;
    const fullScreen = this.props.fullScreen ?? false;
    if (!error) return this.props.children;
    if (reloading) return null;
    if (isChunkLoadError(error)) return <NewVersionNotice fullScreen={fullScreen} />;
    return <SectionError onRetry={this.reset} fullScreen={fullScreen} />;
  }
}

/** Límite de errores que se reinicia al cambiar de ruta. */
export function RouteErrorBoundary({ children, fullScreen }: { children: ReactNode; fullScreen?: boolean }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname} fullScreen={fullScreen}>
      {children}
    </ErrorBoundary>
  );
}
