import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { createShellI18n, ShellI18nProvider } from './i18n/I18nProvider';
import './styles/index.css';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Web shell root is missing');

void createShellI18n().then((instance) => {
  createRoot(root).render(
    <StrictMode>
      <ShellI18nProvider instance={instance}>
        <App />
      </ShellI18nProvider>
    </StrictMode>,
  );
});
