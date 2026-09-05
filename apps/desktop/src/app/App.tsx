import { lazy, Suspense } from 'react';
import { Spin } from '@arco-design/web-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import '@arco-design/web-react/es/Spin/style/css.js';

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
const DeveloperPlatformLayout = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperPlatformLayout')).DeveloperPlatformLayout,
}));
const DeveloperApplicationsPage = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperApplicationsPage')).DeveloperApplicationsPage,
}));
const DeveloperDevelopPage = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperDevelopPage')).DeveloperDevelopPage,
}));
const DeveloperUploadPage = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperUploadPage')).DeveloperUploadPage,
}));
const DeveloperVersionsPage = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperVersionsPage')).DeveloperVersionsPage,
}));
const DeveloperLogsPage = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperLogsPage')).DeveloperLogsPage,
}));
const DeveloperAnalyticsPage = lazy(async () => ({
  default: (await import('@/pages/developer/DeveloperAnalyticsPage')).DeveloperAnalyticsPage,
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
        <Route path="/developer" element={<DeveloperPlatformLayout />}>
          <Route index element={<DeveloperApplicationsPage />} />
          <Route path="develop" element={<DeveloperDevelopPage />} />
          <Route path="upload" element={<DeveloperUploadPage />} />
          <Route path="versions" element={<DeveloperVersionsPage />} />
          <Route path="logs" element={<DeveloperLogsPage />} />
          <Route path="analytics" element={<DeveloperAnalyticsPage />} />
        </Route>
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
