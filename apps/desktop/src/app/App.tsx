import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { AuthGate } from '@/components/AuthGate';
import { AppShell } from '@/components/AppShell';
import { DashboardPage } from '@/pages/DashboardPage';
import { DeveloperPage } from '@/pages/DeveloperPage';
import { InstalledPage } from '@/pages/InstalledPage';
import { SchedulesPage } from '@/pages/SchedulesPage';
import { SecurityPage } from '@/pages/SecurityPage';
import { TasksPage } from '@/pages/TasksPage';
import { UpdatePage } from '@/pages/UpdatePage';

export function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <AppShell>
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
        </AppShell>
      </AuthGate>
    </BrowserRouter>
  );
}
