export type DesktopPlatform = {
  os: 'windows' | 'macos' | 'linux';
  arch: 'x64' | 'arm64';
};

export type ManifestArtifact = {
  name: string;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  platform?: DesktopPlatform;
};

export type DesktopCapability =
  | {
      kind: 'filesystem';
      access: 'read' | 'read-write';
      scopes: Array<{ scope: 'workspace' | 'app-data' | 'user-selected' }>;
    }
  | { kind: 'network'; domains: string[]; methods: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> }
  | { kind: 'clipboard'; access: 'read' | 'write' | 'read-write' }
  | { kind: 'shortcut'; accelerators: string[]; global: boolean }
  | { kind: 'background'; modes: Array<'scheduled' | 'startup' | 'persistent'> }
  | {
      kind: 'lifecycle';
      actions: Array<'install' | 'update' | 'uninstall' | 'service'>;
      elevation: 'never' | 'user-approved';
    }
  | { kind: 'subprocess'; executables: string[] }
  | { kind: 'notifications' };

export type DesktopRuntime = {
  platform: DesktopPlatform;
  artifact: string;
  entry: string;
} & ({ kind: 'python'; python: string } | { kind: 'native' } | { kind: 'web-ui'; allowedOrigins: string[] });

export type AppletManifest = {
  schemaVersion: 1;
  appId: string;
  version: string;
  artifacts: ManifestArtifact[];
  integrity: { algorithm: 'sha256'; digest: string };
  signature: { algorithm: 'ed25519'; keyId: string; value: string };
  kind: 'desktop';
  name: string;
  description: string;
  runtimes: DesktopRuntime[];
  dependencies: Array<
    | { kind: 'python'; version: string; lockArtifact: string }
    | { kind: 'system'; name: string; version?: string }
    | { kind: 'application'; appId: string; version: string }
  >;
  capabilities: DesktopCapability[];
  runMode: 'singleton' | 'serial' | 'parallel';
  minHostVersion: string;
};

export type InstalledApplet = {
  manifest: AppletManifest;
  installPath: string;
  installedAt: number;
  active: boolean;
  managed: boolean;
};

export type DesktopTask = {
  taskId: string;
  appId: string;
  version: string;
  status: 'starting' | 'running' | 'succeeded' | 'failed' | 'stopped';
  pid?: number;
  logPath: string;
  startedAt: number;
  finishedAt?: number;
};

export type RunAppletResult = {
  runtime: 'process' | 'web-ui';
  task: DesktopTask;
};

export type AgentSnapshot = {
  installed: InstalledApplet[];
  tasks: DesktopTask[];
  sync: { revision: number; offline: boolean; lastSyncAt?: number };
  installationRevision: number;
  device: { deviceId: string; apiBaseUrl: string } | null;
  developerMode: boolean;
  target: DesktopPlatform;
};

export type EnrolledDevice = {
  deviceId: string;
  name: string;
  os: DesktopPlatform['os'];
  arch: DesktopPlatform['arch'];
  agentVersion: string;
  apiBaseUrl: string;
};

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  platformRoles: Array<'platform_admin' | 'official_reviewer'>;
};

export function capabilityLabel(capability: DesktopCapability): string {
  switch (capability.kind) {
    case 'filesystem':
      return `files:${capability.access}`;
    case 'network':
      return `network:${capability.domains.length}`;
    case 'clipboard':
      return `clipboard:${capability.access}`;
    case 'shortcut':
      return `shortcuts:${capability.accelerators.length}`;
    case 'background':
      return `background:${capability.modes.join('+')}`;
    case 'lifecycle':
      return `lifecycle:${capability.elevation}`;
    case 'subprocess':
      return `subprocess:${capability.executables.length}`;
    case 'notifications':
      return 'notifications';
  }
}

export function platformLabel(platform: DesktopPlatform): string {
  return `${platform.os}-${platform.arch}`;
}
