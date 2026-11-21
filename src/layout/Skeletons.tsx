import { Skeleton } from '@/components/ui';

// Siluetas grises mientras llegan los datos: el armazón (menú y cabecera) y el
// hueco de la sección se pintan al momento, en lugar de «Cargando…» a pantalla
// completa. Llevan role="status" para los lectores de pantalla.

/** Hueco de una sección: título, una línea y unas tarjetas. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Cargando…" data-testid="page-skeleton">
      <span className="sr-only">Cargando…</span>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-3 h-4 w-72 max-w-full" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="mt-6 h-48" />
    </div>
  );
}

/** Armazón completo (antes de saber la organización): lateral, cabecera y sección. */
export function ShellSkeleton() {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]" data-testid="shell-skeleton">
      <aside
        className="sticky top-0 hidden h-dvh flex-col gap-4 border-r border-border bg-surface p-4 lg:flex"
        aria-hidden
      >
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <div className="mt-2 space-y-2">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      </aside>
      <div className="min-w-0">
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 lg:hidden" aria-hidden>
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
        <div className="mx-auto w-full max-w-6xl px-4 pb-28 pt-6 sm:px-6 lg:px-10 lg:pt-10">
          <PageSkeleton />
        </div>
        <div
          className="fixed inset-x-0 bottom-0 flex h-14 items-center justify-around border-t border-border bg-surface lg:hidden"
          aria-hidden
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-10" />
          ))}
        </div>
      </div>
    </div>
  );
}
