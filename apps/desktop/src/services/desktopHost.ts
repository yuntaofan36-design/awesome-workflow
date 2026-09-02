import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import type { AgentSnapshot, AppletManifest, EnrolledDevice, RunAppletResult } from '@/types';

const browserSnapshot: AgentSnapshot = {
  developerMode: true,
  target: { os: 'windows', arch: 'x64' },
  sync: { revision: 42, offline: false, lastSyncAt: Math.floor(Date.now() / 1000) - 18 },
  installationRevision: 7,
  device: {
    deviceId: '0a758fd3-c85d-4d36-8f0c-604d3d77879a',
    apiBaseUrl: 'https://api.example.test/api/v1',
  },
  installed: [
    {
      manifest: {
        schemaVersion: 1,
        appId: 'hello-runner',
        name: 'Hello Runner',
        version: '0.1.0',
        description: 'Reference Python applet using a scoped runner lease.',
        artifacts: [
          {
            name: 'windows-runtime',
            fileName: 'hello-runner.zip',
            mediaType: 'application/zip',
            size: 4096,
            sha256: 'a'.repeat(64),
            platform: { os: 'windows', arch: 'x64' },
          },
        ],
        integrity: { algorithm: 'sha256', digest: 'b'.repeat(64) },
        signature: { algorithm: 'ed25519', keyId: 'demo-key', value: 'c'.repeat(64) },
        kind: 'desktop',
        runtimes: [
          {
            platform: { os: 'windows', arch: 'x64' },
            artifact: 'windows-runtime',
            kind: 'python',
            entry: 'main.py',
            python: '3.12',
          },
        ],
        dependencies: [],
        capabilities: [
          { kind: 'filesystem', access: 'read', scopes: [{ scope: 'workspace' }] },
          { kind: 'notifications' },
        ],
        runMode: 'parallel',
        minHostVersion: '0.1.0',
      },
      installPath: 'C:\\AwesomeWorkflow\\apps\\hello-runner\\0.1.0',
      installedAt: Math.floor(Date.now() / 1000) - 7_200,
      active: true,
      managed: true,
    },
  ],
  tasks: [
    {
      taskId: '46fe79de-cb55-451d-8e73-5b7b834ba66b',
      appId: 'hello-runner',
      version: '0.1.0',
      status: 'succeeded',
      pid: 14720,
      logPath: 'C:\\AwesomeWorkflow\\tasks\\46fe79de\\task.log',
      startedAt: Math.floor(Date.now() / 1000) - 320,
      finishedAt: Math.floor(Date.now() / 1000) - 306,
    },
  ],
};

export function isTauriRuntime() {
  return '__TAURI_INTERNALS__' in window;
}

export const desktopHost = {
  snapshot: async () =>
    isTauriRuntime() ? invoke<AgentSnapshot>('agent_snapshot') : structuredClone(browserSnapshot),
  enrollDevice: (workspaceId: string, name: string) =>
    isTauriRuntime()
      ? invoke<EnrolledDevice>('desktop_device_enroll', { input: { workspaceId, name } })
      : Promise.resolve<EnrolledDevice>({
          deviceId: browserSnapshot.device!.deviceId,
          name,
          os: browserSnapshot.target.os,
          arch: browserSnapshot.target.arch,
          agentVersion: '0.1.0',
          apiBaseUrl: browserSnapshot.device!.apiBaseUrl,
        }),
  validateDevelopmentApplet: (path: string) =>
    isTauriRuntime()
      ? invoke<AppletManifest>('validate_development_applet', { path })
      : Promise.resolve(browserSnapshot.installed[0]!.manifest),
  registerDevelopmentApplet: (path: string) => invoke('register_development_applet', { path }),
  installSignedPackage: (input: {
    packagePath: string;
    sha256: string;
    signature: string;
    keyId: string;
    manifest: AppletManifest;
  }) => invoke('install_signed_package', { input }),
  runApplet: (appId: string, version?: string) =>
    isTauriRuntime()
      ? invoke<RunAppletResult>('run_applet', { input: { appId, version, args: [] } })
      : Promise.resolve<RunAppletResult>({
          runtime: 'process',
          task: structuredClone(browserSnapshot.tasks[0]!),
        }),
  stopTask: (taskId: string) =>
    isTauriRuntime() ? invoke('stop_task', { taskId }) : Promise.resolve(undefined),
  uninstallApplet: (appId: string, version: string) => invoke('uninstall_applet', { appId, version }),
  readTaskLog: (taskId: string) =>
    isTauriRuntime()
      ? invoke<string>('read_task_log', { taskId })
      : Promise.resolve('[runner] starting hello-runner\nprogress 100%\n[runner] exit status 0'),
  chooseDirectory: async () => {
    if (!isTauriRuntime()) return 'C:\\dev\\hello-runner';
    const selected = await open({ directory: true, multiple: false, title: 'Choose an applet directory' });
    return selected ?? null;
  },
  choosePackage: async () => {
    if (!isTauriRuntime()) return 'C:\\dist\\hello-runner-0.1.0.awpkg';
    const selected = await open({
      directory: false,
      multiple: false,
      title: 'Choose a signed .awpkg',
      filters: [{ name: 'Awesome Workflow package', extensions: ['awpkg'] }],
    });
    return selected ?? null;
  },
};
