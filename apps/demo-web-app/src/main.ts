import { connectToHost, type ThemeSnapshot, type UserSummary } from '@awesome-workflow/web-sdk';

import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('Application root is missing');
}

root.innerHTML = `
  <section class="board-shell">
    <div class="eyebrow"><span></span> sandbox channel / v1</div>
    <header>
      <div>
        <p class="kicker">REFERENCE MICRO-APP</p>
        <h1>Signal<br />Board</h1>
      </div>
      <div class="dial" aria-label="runtime healthy"><strong>100</strong><small>isolated</small></div>
    </header>
    <div class="status-grid">
      <article><span>HOST</span><strong id="host-status">connecting</strong></article>
      <article><span>IDENTITY</span><strong id="identity">withheld</strong></article>
      <article><span>BRIDGE</span><strong>MessageChannel</strong></article>
    </div>
    <div class="pulse-line"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <footer>
      <p>This page has scripts, but no same-origin access to the shell. Every host action crosses a capability-checked port.</p>
      <div class="actions">
        <button id="notify" disabled>Send host notification</button>
        <button id="navigate" class="secondary" disabled>Open deployments</button>
      </div>
    </footer>
  </section>
`;

const hostStatus = requiredElement('#host-status');
const identity = requiredElement('#identity');
const notifyButton = requiredButton('#notify');
const navigateButton = requiredButton('#navigate');

const targetOrigin = import.meta.env.VITE_HOST_ORIGIN ?? 'http://localhost:4300';

void connectToHost({ targetOrigin })
  .then(async (bridge) => {
    const [theme, user] = await Promise.all([bridge.theme.getCurrent(), bridge.user.getSummary()]);
    renderContext(theme, user);
    notifyButton.disabled = false;
    navigateButton.disabled = false;
    notifyButton.addEventListener('click', () => {
      void bridge.broker.request({
        operation: 'notifications.show',
        payload: { message: 'Signal Board completed a capability-checked host call.', level: 'success' },
      });
    });
    navigateButton.addEventListener('click', () => {
      void bridge.navigation.navigate('/apps/control-plane/releases');
    });
  })
  .catch((error: unknown) => {
    hostStatus.textContent = 'standalone';
    identity.textContent = 'not connected';
    console.warn(error);
  });

function renderContext(theme: ThemeSnapshot, user: UserSummary) {
  hostStatus.textContent = `connected / ${theme.resolved}`;
  identity.textContent = user.displayName;
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function requiredButton(selector: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
