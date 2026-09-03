import { ConfigProvider } from '@arco-design/web-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { AuthGate } from '../components/AuthGate';
import { ShellLayout } from '../components/ShellLayout';
import { useI18n } from '../i18n/I18nProvider';

export function App() {
  const { arcoLocale } = useI18n();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 20_000 },
        },
      }),
  );

  return (
    <ConfigProvider locale={arcoLocale} componentConfig={{ Card: { bordered: false } }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthGate>
            <ShellLayout />
          </AuthGate>
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  );
}
