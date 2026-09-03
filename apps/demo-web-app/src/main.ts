import { applyDocumentLocale, detectBrowserLocale } from '@awesome-workflow/i18n';
import {
  connectToHost,
  type LocaleSnapshot,
  type ThemeSnapshot,
  type UserSummary,
} from '@awesome-workflow/web-sdk';

import { createDemoI18n } from './i18n';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('Application root is missing');
}

const targetOrigin = import.meta.env.VITE_HOST_ORIGIN ?? 'http://localhost:4300';

root.innerHTML = `
  <section class="board-shell">
    <div class="eyebrow"><span></span><b id="eyebrow"></b></div>
    <header>
      <div>
        <p class="kicker" id="kicker"></p>
        <h1><span id="name-first"></span><br /><span id="name-second"></span></h1>
      </div>
      <div class="dial"><strong>100</strong><small id="isolated"></small></div>
    </header>
    <div class="status-grid">
      <article><span id="host-label"></span><strong id="host-status"></strong></article>
      <article><span id="identity-label"></span><strong id="identity"></strong></article>
      <article><span id="bridge-label"></span><strong>MessageChannel</strong></article>
    </div>
    <div class="pulse-line"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <footer>
      <p id="board-body"></p>
      <div class="actions">
        <button id="notify" disabled></button>
        <button id="navigate" class="secondary" disabled></button>
      </div>
    </footer>
  </section>
`;

const localLocale = detectBrowserLocale({
  languages: navigator.languages,
  storage: safeStorage(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

void bootstrap(localLocale.snapshot);

async function bootstrap(initialLocale: LocaleSnapshot) {
  const i18n = await createDemoI18n(initialLocale.locale);
  const hostStatus = requiredElement('#host-status');
  const identity = requiredElement('#identity');
  const notifyButton = requiredButton('#notify');
  const navigateButton = requiredButton('#navigate');
  const dial = requiredElement('.dial');
  let locale = initialLocale;
  let theme: ThemeSnapshot | null = null;
  let user: UserSummary | null = null;
  let connection: 'connected' | 'connecting' | 'standalone' = 'connecting';

  const render = () => {
    applyDocumentLocale(locale, document);
    document.title = String(i18n.t('app.title'));
    setText('#eyebrow', i18n.t('board.eyebrow'));
    setText('#kicker', i18n.t('board.kicker'));
    setText('#name-first', i18n.t('board.nameFirst'));
    setText('#name-second', i18n.t('board.nameSecond'));
    setText('#isolated', i18n.t('board.isolated'));
    setText('#host-label', i18n.t('board.host'));
    setText('#identity-label', i18n.t('board.identity'));
    setText('#bridge-label', i18n.t('board.bridge'));
    setText('#board-body', i18n.t('board.body'));
    notifyButton.textContent = String(i18n.t('board.notify'));
    navigateButton.textContent = String(i18n.t('board.navigate'));
    dial.setAttribute('aria-label', String(i18n.t('board.runtimeHealthy')));
    hostStatus.textContent =
      connection === 'connected' && theme
        ? String(i18n.t('status.connected', { theme: i18n.t(`theme.${theme.resolved}`) }))
        : String(i18n.t(`status.${connection}`));
    identity.textContent =
      user?.displayName ??
      String(i18n.t(connection === 'standalone' ? 'status.notConnected' : 'status.withheld'));
  };

  const changeLocale = async (next: LocaleSnapshot) => {
    locale = next;
    await i18n.changeLanguage(next.locale);
    render();
  };

  render();
  try {
    const bridge = await connectToHost({ targetOrigin });
    bridge.events.on('locale.changed', (next) => void changeLocale(next));
    const [hostLocale, hostTheme, hostUser] = await Promise.all([
      bridge.locale.getCurrent(),
      bridge.theme.getCurrent(),
      bridge.user.getSummary(),
    ]);
    locale = hostLocale;
    theme = hostTheme;
    user = hostUser;
    connection = 'connected';
    await i18n.changeLanguage(locale.locale);
    notifyButton.disabled = false;
    navigateButton.disabled = false;
    notifyButton.addEventListener('click', () => {
      void bridge.broker.request({
        operation: 'notifications.show',
        payload: { message: String(i18n.t('notification.completed')), level: 'success' },
      });
    });
    navigateButton.addEventListener('click', () => {
      void bridge.navigation.navigate('/apps/control-plane/releases');
    });
    render();
  } catch (error: unknown) {
    connection = 'standalone';
    render();
    console.warn(error);
  }
}

function setText(selector: string, value: unknown) {
  requiredElement(selector).textContent = String(value);
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
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
