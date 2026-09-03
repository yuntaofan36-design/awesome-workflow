import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { LocalizedAsyncErrorBoundary } from './components/AsyncErrorBoundary';
import { createShellI18n, ShellI18nProvider } from './i18n/I18nProvider';
import { installVitePreloadErrorRecovery } from './runtime/preloadRecovery';
import './styles/arco';
import './styles/index.css';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Web shell root is missing');

installVitePreloadErrorRecovery(import.meta.url);

void createShellI18n().then((instance) => {
  createRoot(root).render(
    <StrictMode>
      <ShellI18nProvider instance={instance}>
        <LocalizedAsyncErrorBoundary>
          <App />
        </LocalizedAsyncErrorBoundary>
      </ShellI18nProvider>
    </StrictMode>,
  );
});
