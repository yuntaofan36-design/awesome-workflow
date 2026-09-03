import React from 'react';
import ReactDOM from 'react-dom/client';

import '@arco-design/web-react/dist/css/arco.css';
import './styles/index.css';
import { App } from './app/App';
import { initializeDesktopLocale } from './i18n/runtime';

const localeRuntime = await initializeDesktopLocale();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App localeRuntime={localeRuntime} />
  </React.StrictMode>,
);
