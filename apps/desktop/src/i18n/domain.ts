import type { AuthProvider } from '@/services/session';
import type { DesktopCapability, DesktopPlatform, DesktopRuntime, DesktopTask } from '@/types';

import type { Translate } from './localeContext';

export function providerLabel(provider: AuthProvider, t: Translate): string {
  return t(`auth.providers.${provider.id}`);
}

export function providerStatusLabel(provider: AuthProvider, t: Translate): string {
  return t(`enums.providerStatus.${provider.status}`);
}

export function platformRoleLabel(role: string, t: Translate): string {
  const key = role === 'platform_admin' ? 'platformAdmin' : 'officialReviewer';
  return t(`enums.platformRole.${key}`);
}

export function workspaceRoleLabel(role: string, t: Translate): string {
  const normalized = role.trim().toLowerCase();
  if (['owner', 'admin', 'developer', 'member'].includes(normalized)) {
    return t(`enums.workspaceRole.${normalized}`);
  }
  return role;
}

export function taskStatusLabel(status: DesktopTask['status'], t: Translate): string {
  return t(`enums.taskStatus.${status}`);
}

export function runModeLabel(runMode: 'singleton' | 'serial' | 'parallel', t: Translate): string {
  return t(`enums.runMode.${runMode}`);
}

export function runtimeLabel(runtime: DesktopRuntime['kind'], t: Translate): string {
  return t(`enums.runtime.${runtime === 'web-ui' ? 'webUi' : runtime}`);
}

export function platformLabel(platform: DesktopPlatform, t: Translate): string {
  return `${t(`enums.platform.${platform.os}`)} · ${platform.arch}`;
}

export function capabilityLabel(capability: DesktopCapability, t: Translate): string {
  switch (capability.kind) {
    case 'filesystem':
      return t('enums.capability.filesystem', {
        access: accessLabel(capability.access, t),
      });
    case 'network':
      return t('enums.capability.network', { count: capability.domains.length });
    case 'clipboard':
      return t('enums.capability.clipboard', {
        access: accessLabel(capability.access, t),
      });
    case 'shortcut':
      return t('enums.capability.shortcut', { count: capability.accelerators.length });
    case 'background':
      return t('enums.capability.background', {
        modes: capability.modes.map((mode) => t(`enums.capability.modes.${mode}`)).join(' · '),
      });
    case 'lifecycle':
      return t('enums.capability.lifecycle', {
        elevation: t(
          `enums.capability.elevation.${capability.elevation === 'user-approved' ? 'userApproved' : 'never'}`,
        ),
      });
    case 'subprocess':
      return t('enums.capability.subprocess', { count: capability.executables.length });
    case 'notifications':
      return t('enums.capability.notifications');
  }
}

function accessLabel(access: 'read' | 'write' | 'read-write', t: Translate): string {
  return t(`enums.capability.access.${access === 'read-write' ? 'readWrite' : access}`);
}
