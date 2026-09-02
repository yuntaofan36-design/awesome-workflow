import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import './styles/index.css';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Web shell root is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
