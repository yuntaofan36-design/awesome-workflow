import { createAppI18n } from '@awesome-workflow/i18n';

export const demoResources = {
  'en-US': {
    translation: {
      app: { title: 'Signal Board · Awesome Workflow' },
      board: {
        body: 'This page has scripts, but no same-origin access to the shell. Every host action crosses a capability-checked port.',
        bridge: 'BRIDGE',
        eyebrow: 'Sandbox channel / v1',
        host: 'HOST',
        identity: 'IDENTITY',
        isolated: 'Isolated',
        kicker: 'REFERENCE MICRO-APP',
        nameFirst: 'Signal',
        nameSecond: 'Board',
        navigate: 'Open releases',
        notify: 'Send host notification',
        runtimeHealthy: 'Runtime healthy',
      },
      notification: { completed: 'Signal Board completed a capability-checked host call.' },
      status: {
        connected: 'Connected / {{theme}}',
        connecting: 'Connecting',
        notConnected: 'Not connected',
        standalone: 'Standalone',
        withheld: 'Withheld',
      },
      theme: { dark: 'Dark', light: 'Light' },
    },
  },
  'zh-CN': {
    translation: {
      app: { title: '信号面板 · Awesome Workflow' },
      board: {
        body: '此页面可以运行脚本，但无法同源访问 Shell。所有宿主操作都必须通过能力校验的通信端口。',
        bridge: '通信桥',
        eyebrow: '沙箱渠道 / v1',
        host: '宿主',
        identity: '身份',
        isolated: '已隔离',
        kicker: '微应用参考实现',
        nameFirst: '信号',
        nameSecond: '面板',
        navigate: '打开 Release',
        notify: '发送宿主通知',
        runtimeHealthy: '运行时健康',
      },
      notification: { completed: '信号面板已完成一次经过能力校验的宿主调用。' },
      status: {
        connected: '已连接 / {{theme}}',
        connecting: '连接中',
        notConnected: '未连接',
        standalone: '独立运行',
        withheld: '未提供',
      },
      theme: { dark: '深色', light: '浅色' },
    },
  },
} as const;

export async function createDemoI18n(locale: 'en-US' | 'zh-CN') {
  return createAppI18n(demoResources, locale);
}
