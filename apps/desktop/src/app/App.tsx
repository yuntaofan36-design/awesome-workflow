import { lazy, Suspense } from 'react';
import { Spin } from '@arco-design/web-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { AuthGate } from '@/components/AuthGate';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { useLocale } from '@/i18n/localeContext';
import type { DesktopLocaleRuntime } from '@/i18n/runtime';

const DashboardPage = lazy(async () => ({
  default: (await import('@/pages/DashboardPage')).DashboardPage,
}));
const InstalledPage = lazy(async () => ({
  default: (await import('@/pages/InstalledPage')).InstalledPage,
}));
const TasksPage = lazy(async () => ({
  default: (await import('@/pages/TasksPage')).TasksPage,
}));
const DeveloperPage = lazy(async () => ({
  default: (await import('@/pages/DeveloperPage')).DeveloperPage,
}));
const SchedulesPage = lazy(async () => ({
  default: (await import('@/pages/SchedulesPage')).SchedulesPage,
}));
const SecurityPage = lazy(async () => ({
  default: (await import('@/pages/SecurityPage')).SecurityPage,
}));
const UpdatePage = lazy(async () => ({
  default: (await import('@/pages/UpdatePage')).UpdatePage,
}));
const AppShell = lazy(async () => ({
  default: (await import('@/components/AppShell')).AppShell,
}));

export function App({ localeRuntime }: { localeRuntime: DesktopLocaleRuntime }) {
  return (
    <LocaleProvider runtime={localeRuntime}>
      <BrowserRouter>
        <AuthGate>
          <Suspense fallback={<DesktopLoading />}>
            <AppShell>
              <DesktopRoutes />
            </AppShell>
          </Suspense>
        </AuthGate>
      </BrowserRouter>
    </LocaleProvider>
  );
}

function DesktopRoutes() {
  return (
    <Suspense fallback={<DesktopLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/installed" element={<InstalledPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/developer" element={<DeveloperPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/updates" element={<UpdatePage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

function DesktopLoading() {
  const { t } = useLocale();

  return (
    <div className="route-loading" role="status" aria-live="polite">
      <Spin size={28} />
      <span>{t('common.loading')}</span>
    </div>
  );
}
