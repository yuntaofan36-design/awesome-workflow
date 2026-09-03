import { ConfigProvider, Spin } from '@arco-design/web-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { AuthGate } from '../components/AuthGate';
import { useI18n } from '../i18n/I18nProvider';

const ShellLayout = lazy(async () => {
  const module = await import('../components/ShellLayout');
  return { default: module.ShellLayout };
});

export function App() {
  const { arcoLocale, t } = useI18n();
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
            <Suspense
              fallback={
                <div className="auth-boot" role="status" aria-live="polite" aria-busy="true">
                  <span>{t('asyncFailure.shellScope')}</span>
                  <Spin dot tip={t('asyncFailure.shellLoading')} />
                </div>
              }
            >
              <ShellLayout />
            </Suspense>
          </AuthGate>
        </BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  );
}
