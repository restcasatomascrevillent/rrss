import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Card, EmptyState } from '@/components/ui';
import { APP_NAME } from '@/config/app';
import { AuthProvider, RequireAuth, RequireGuest } from '@/features/auth/AuthProvider';
import { BrandLayout, OrgLayout, RootRedirect } from '@/features/orgs/layouts';
import { RouteErrorBoundary } from '@/layout/ErrorBoundary';
import { ShellSkeleton } from '@/layout/Skeletons';
import { ThemeProvider, useTheme } from '@/layout/theme';
import { lazyRoute } from '@/lib/lazyRoute';
import { supabaseConfigured } from '@/lib/supabase';

// Todas las pantallas se cargan cuando se visitan (o se precargan, ver abajo).
// `lazyRoute` recarga una vez si el trozo ya no existe tras un despliegue.
const LoginPage = lazyRoute(() => import('@/features/auth/AuthPages').then((m) => m.LoginPage));
const RegisterPage = lazyRoute(() => import('@/features/auth/AuthPages').then((m) => m.RegisterPage));
const RecoverPage = lazyRoute(() => import('@/features/auth/AuthPages').then((m) => m.RecoverPage));
const ResetPasswordPage = lazyRoute(() => import('@/features/auth/AuthPages').then((m) => m.ResetPasswordPage));
const InvitationPage = lazyRoute(() => import('@/features/invitations/InvitationPage').then((m) => m.InvitationPage));
const WelcomePage = lazyRoute(() => import('@/features/orgs/WelcomePage').then((m) => m.WelcomePage));
const OrgHomePage = lazyRoute(() => import('@/features/orgs/OrgHomePage').then((m) => m.OrgHomePage));
const SettingsLayout = lazyRoute(() => import('@/features/orgs/SettingsPages').then((m) => m.SettingsLayout));
const GeneralSettingsPage = lazyRoute(() => import('@/features/orgs/SettingsPages').then((m) => m.GeneralSettingsPage));
const TeamSettingsPage = lazyRoute(() => import('@/features/orgs/SettingsPages').then((m) => m.TeamSettingsPage));
const ActivitySettingsPage = lazyRoute(() =>
  import('@/features/orgs/SettingsPages').then((m) => m.ActivitySettingsPage),
);
const AiUsageSettingsPage = lazyRoute(() => import('@/features/ai/AiUsagePage').then((m) => m.AiUsageSettingsPage));
const PlanSettingsPage = lazyRoute(() => import('@/features/billing/PlanSettingsPage').then((m) => m.PlanSettingsPage));
const DriveSettingsPage = lazyRoute(() =>
  import('@/features/drive/DriveSettingsPage').then((m) => m.DriveSettingsPage),
);
const BrandHomePage = lazyRoute(() => import('@/features/brand/BrandHomePage').then((m) => m.BrandHomePage));
const BrandProfilePage = lazyRoute(() => import('@/features/brand/BrandProfilePage').then((m) => m.BrandProfilePage));
const BrandWizardPage = lazyRoute(() => import('@/features/brand/BrandWizardPage').then((m) => m.BrandWizardPage));
const ContentListPage = lazyRoute(() => import('@/features/content/ContentListPage').then((m) => m.ContentListPage));
const ContentEditorPage = lazyRoute(() =>
  import('@/features/content/ContentEditorPage').then((m) => m.ContentEditorPage),
);
const RequestListPage = lazyRoute(() => import('@/features/requests/RequestListPage').then((m) => m.RequestListPage));
const RequestDetailPage = lazyRoute(() =>
  import('@/features/requests/RequestDetailPage').then((m) => m.RequestDetailPage),
);
const CalendarPage = lazyRoute(() => import('@/features/social/CalendarPage').then((m) => m.CalendarPage));
const CampaignListPage = lazyRoute(() =>
  import('@/features/campaigns/CampaignListPage').then((m) => m.CampaignListPage),
);
const CampaignDetailPage = lazyRoute(() =>
  import('@/features/campaigns/CampaignDetailPage').then((m) => m.CampaignDetailPage),
);
const AnalyticsPage = lazyRoute(() => import('@/features/analytics/AnalyticsPage').then((m) => m.AnalyticsPage));
const LibraryPage = lazyRoute(() => import('@/features/library/LibraryPage').then((m) => m.LibraryPage));
const ReelsPage = lazyRoute(() => import('@/features/reels/ReelsPage').then((m) => m.ReelsPage));
const PlatformPage = lazyRoute(() => import('@/features/platform/PlatformPage').then((m) => m.PlatformPage));
const IntegrationsPage = lazyRoute(() =>
  import('@/features/platform/integrations/IntegrationsPage').then((m) => m.IntegrationsPage),
);
const BrandTeamPage = lazyRoute(() => import('@/features/team/BrandTeamPage').then((m) => m.BrandTeamPage));
// RGPD: páginas legales públicas, «Mi cuenta» y los datos de la organización.
const LegalPage = lazyRoute(() => import('@/features/legal/LegalPage').then((m) => m.LegalPage));
const AccountPage = lazyRoute(() => import('@/features/privacy/AccountPage').then((m) => m.AccountPage));
const OrganizationDataPage = lazyRoute(() =>
  import('@/features/privacy/OrganizationDataPage').then((m) => m.OrganizationDataPage),
);

// Sección de una marca → su pantalla, para precargarla al entrar.
const BRAND_SECTIONS: Record<string, { preload: () => Promise<void> }> = {
  inicio: BrandHomePage,
  contenidos: ContentListPage,
  encargos: RequestListPage,
  calendario: CalendarPage,
  campanas: CampaignListPage,
  analitica: AnalyticsPage,
  biblioteca: LibraryPage,
  marca: BrandProfilePage,
  equipo: BrandTeamPage,
};

/**
 * Empieza a descargar la pantalla de la dirección a la que se entra a la vez
 * que la sesión y la organización, en vez de esperar a que lleguen.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function preloadScreenFor(pathname: string): void {
  const brand = /^\/o\/[^/]+\/m\/[^/]+\/([^/]+)(\/[^/]+)?/.exec(pathname);
  if (brand) {
    const [, section = '', detail] = brand;
    if (section === 'contenidos' && detail) void ContentEditorPage.preload();
    else if (section === 'encargos' && detail) void RequestDetailPage.preload();
    else if (section === 'campanas' && detail) void CampaignDetailPage.preload();
    else void BRAND_SECTIONS[section]?.preload();
    return;
  }
  if (/^\/o\/[^/]+\/ajustes/.test(pathname)) void SettingsLayout.preload();
  else if (/^\/o\/[^/]+\/?$/.test(pathname)) void OrgHomePage.preload();
  else if (/^\/(login|registro|recuperar|restablecer)/.test(pathname)) void LoginPage.preload();
}

/** Las secciones de la barra principal, cuando el navegador está libre: abrirlas ya no espera. */
function usePreloadMainSections() {
  useEffect(() => {
    if (import.meta.env.MODE === 'test') return;
    const run = () => {
      for (const screen of [BrandHomePage, ContentListPage, CalendarPage, LibraryPage]) void screen.preload();
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = globalThis.setTimeout(run, 2000);
    return () => globalThis.clearTimeout(id);
  }, []);
}

function MissingConfig() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4" data-testid="missing-config">
      <Card className="max-w-lg">
        <EmptyState
          icon={Settings2}
          title={`Falta configurar ${APP_NAME}`}
          description="La aplicación no sabe a qué proyecto de Supabase conectarse. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (en .env.local o en las variables del despliegue) y vuelve a arrancarla."
        />
      </Card>
    </main>
  );
}

function NotFound() {
  return <Navigate to="/" replace />;
}

function ThemedToaster() {
  const { choice } = useTheme();
  return <Toaster position="top-center" richColors closeButton theme={choice} />;
}

export function App() {
  usePreloadMainSections();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
          mutations: { retry: 0 },
        },
      }),
  );

  if (!supabaseConfigured) {
    return (
      <ThemeProvider>
        <MissingConfig />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <RouteErrorBoundary fullScreen>
              <Suspense fallback={<ShellSkeleton />}>
                <Routes>
                  <Route element={<RequireGuest />}>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/registro" element={<RegisterPage />} />
                    <Route path="/recuperar" element={<RecoverPage />} />
                  </Route>
                  <Route path="/restablecer" element={<ResetPasswordPage />} />
                  <Route path="/invitacion/:token" element={<InvitationPage />} />
                  <Route path="/legal/:slug" element={<LegalPage />} />

                  <Route element={<RequireAuth />}>
                    <Route path="/" element={<RootRedirect />} />
                    <Route path="/bienvenida" element={<WelcomePage />} />
                    <Route path="/plataforma" element={<PlatformPage />} />
                    <Route path="/plataforma/integraciones" element={<IntegrationsPage />} />
                    <Route path="/cuenta" element={<AccountPage />} />
                    <Route path="/o/:orgId" element={<OrgLayout />}>
                      <Route index element={<OrgHomePage />} />
                      <Route path="marcas/nueva" element={<BrandWizardPage />} />
                      <Route path="ajustes" element={<SettingsLayout />}>
                        <Route index element={<Navigate to="general" replace />} />
                        <Route path="general" element={<GeneralSettingsPage />} />
                        <Route path="equipo" element={<TeamSettingsPage />} />
                        <Route path="actividad" element={<ActivitySettingsPage />} />
                        <Route path="ia" element={<AiUsageSettingsPage />} />
                        <Route path="plan" element={<PlanSettingsPage />} />
                        <Route path="datos" element={<OrganizationDataPage />} />
                        <Route path="drive" element={<DriveSettingsPage />} />
                      </Route>
                      <Route path="m/:brandId" element={<BrandLayout />}>
                        <Route index element={<Navigate to="inicio" replace />} />
                        <Route path="inicio" element={<BrandHomePage />} />
                        <Route path="contenidos" element={<ContentListPage />} />
                        <Route path="contenidos/:contentId" element={<ContentEditorPage />} />
                        <Route path="encargos" element={<RequestListPage />} />
                        <Route path="encargos/:requestId" element={<RequestDetailPage />} />
                        <Route path="calendario" element={<CalendarPage />} />
                        {/* Sin IA de texto y fuera del modo agencia, la lista vuelve al inicio. */}
                        <Route path="campanas" element={<CampaignListPage />} />
                        <Route path="campanas/:campaignId" element={<CampaignDetailPage />} />
                        <Route path="analitica" element={<AnalyticsPage />} />
                        <Route path="biblioteca" element={<LibraryPage />} />
                        {/* Sin trabajador de medios desplegado, la pantalla vuelve a la biblioteca. */}
                        <Route path="biblioteca/reels" element={<ReelsPage />} />
                        <Route path="marca" element={<BrandProfilePage />} />
                        <Route path="equipo" element={<BrandTeamPage />} />
                      </Route>
                    </Route>
                  </Route>
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </BrowserRouter>
          <ThemedToaster />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
