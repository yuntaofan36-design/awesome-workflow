import { apiRequest } from './apiClient';
import { desktopHost, isTauriRuntime } from './desktopHost';

export type DeveloperWorkspace = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'developer' | 'member';
};

export type DeveloperApplication = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  summary: string;
  kind: 'desktop';
  createdAt: string;
  defaultLocale: 'en-US' | 'zh-CN';
  localizations: Record<string, { name?: string; summary?: string }>;
};

export type DeveloperRelease = {
  id: string;
  applicationId: string;
  version: string;
  status: 'draft' | 'uploading' | 'validating' | 'ready' | 'approved' | 'rejected';
  createdAt: string;
  manifest: Record<string, unknown> & { kind: 'desktop'; appId: string; version: string };
  validationEvidence: ValidationEvidence[];
};

export type ValidationEvidence = {
  id: string;
  check: string;
  outcome: 'passed' | 'failed';
  observedAt: string;
  details: Record<string, unknown>;
};

export type DeveloperReleaseListItem = {
  application: DeveloperApplication;
  release: DeveloperRelease;
  artifactCount: number;
  reviewCount: number;
};

export type DeveloperReleaseStatus = {
  release: DeveloperRelease;
  artifacts: Array<{
    id: string;
    releaseId: string;
    fileName: string;
    size: number;
    sha256: string;
    status: 'pending_upload' | 'uploaded' | 'validated' | 'rejected';
    validationEvidence: ValidationEvidence[];
  }>;
  reviews: Array<{
    id: string;
    decision: 'approve' | 'reject';
    comment: string;
    createdAt: string;
  }>;
};

export type DeveloperCatalogEntry = {
  applicationId: string;
  releaseId: string;
  channel: 'dev' | 'canary' | 'stable';
  version: string;
};

export type DeveloperRun = {
  id: string;
  applicationId: string;
  releaseId: string;
  status:
    | 'queued'
    | 'dispatched'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'needs_user_approval';
  trigger: 'manual' | 'schedule' | 'api';
  attempt: number;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
};

export type DesktopPublishResult = {
  releaseId: string;
  version: string;
  status: string;
  artifacts: Array<{ fileName: string; status: string }>;
};

const browserWorkspace: DeveloperWorkspace = {
  id: '42bf7a23-b1a2-4b66-8c55-2d0b29e216ad',
  name: 'Product Automation Lab',
  role: 'owner',
};
const browserApplications: DeveloperApplication[] = [
  {
    id: '2fd3491c-c53c-4a7c-a377-3c21cce19861',
    workspaceId: browserWorkspace.id,
    slug: 'hello-runner',
    name: 'Hello Runner',
    summary: 'A Python applet running inside the managed workspace runtime.',
    kind: 'desktop',
    createdAt: new Date(Date.now() - 864_000_000).toISOString(),
    defaultLocale: 'en-US',
    localizations: {
      'zh-CN': { name: '你好 Runner', summary: '运行于工作台托管环境的 Python 微应用。' },
    },
  },
];
const browserReleases: DeveloperReleaseListItem[] = ['0.3.0', '0.2.1'].map((version, index) => ({
  application: browserApplications[0]!,
  release: {
    id: index
      ? 'c56bb47a-51ea-4576-8fe8-8bf608589434'
      : '8a32ada1-7af9-4df7-903a-df7b05718343',
    applicationId: browserApplications[0]!.id,
    version,
    status: index ? 'rejected' : 'approved',
    createdAt: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
    manifest: { kind: 'desktop', appId: browserApplications[0]!.slug, version },
    validationEvidence: [],
  },
  artifactCount: 1,
  reviewCount: 1,
}));
const browserCatalog = new Map<string, DeveloperCatalogEntry>();
const browserRuns: DeveloperRun[] = Array.from({ length: 18 }, (_, index) => {
  const started = Date.now() - index * 14_400_000;
  const failed = index % 5 === 4;
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    applicationId: browserApplications[0]!.id,
    releaseId: browserReleases[0]!.release.id,
    status: failed ? 'failed' : 'succeeded',
    trigger: index % 3 === 0 ? 'schedule' : 'manual',
    attempt: 1,
    errorCode: failed ? 'runtime_exit_nonzero' : null,
    queuedAt: new Date(started - 2_000).toISOString(),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + 8_000 + (index % 6) * 3_000).toISOString(),
    result: failed ? null : { rows: 24 + index },
  };
});

export const developerApi = {
  listWorkspaces: (): Promise<DeveloperWorkspace[]> =>
    isTauriRuntime() ? apiRequest('/workspaces') : Promise.resolve(structuredClone([browserWorkspace])),

  async listApplications(workspaceId: string): Promise<DeveloperApplication[]> {
    const values = isTauriRuntime()
      ? await apiRequest<Array<DeveloperApplication & { kind: 'web' | 'desktop' }>>(
          `/workspaces/${encodeURIComponent(workspaceId)}/applications`,
        )
      : browserApplications;
    return structuredClone(values.filter((application) => application.kind === 'desktop'));
  },

  async createApplication(input: {
    workspaceId: string;
    slug: string;
    name: string;
    summary: string;
    defaultLocale: 'en-US' | 'zh-CN';
  }): Promise<DeveloperApplication> {
    if (isTauriRuntime()) {
      return apiRequest(`/workspaces/${encodeURIComponent(input.workspaceId)}/applications`, {
        method: 'POST',
        body: {
          slug: input.slug,
          name: input.name,
          summary: input.summary,
          defaultLocale: input.defaultLocale,
          localizations: {},
          kind: 'desktop',
        },
      });
    }
    const application: DeveloperApplication = {
      ...input,
      id: crypto.randomUUID(),
      kind: 'desktop',
      createdAt: new Date().toISOString(),
      localizations: {},
    };
    browserApplications.unshift(application);
    return structuredClone(application);
  },

  async listReleases(workspaceId: string, applicationId?: string): Promise<DeveloperReleaseListItem[]> {
    const values = isTauriRuntime()
      ? await apiRequest<DeveloperReleaseListItem[]>(
          `/workspaces/${encodeURIComponent(workspaceId)}/releases`,
        )
      : browserReleases;
    return structuredClone(
      values.filter(
        (item) => item.application.kind === 'desktop' && (!applicationId || item.application.id === applicationId),
      ),
    );
  },

  async releaseStatus(releaseId: string): Promise<DeveloperReleaseStatus> {
    if (isTauriRuntime()) return apiRequest(`/releases/${encodeURIComponent(releaseId)}/status`);
    const item = browserReleases.find((candidate) => candidate.release.id === releaseId);
    if (!item) throw new Error('release_not_found');
    return {
      release: structuredClone(item.release),
      artifacts: [
        {
          id: crypto.randomUUID(),
          releaseId,
          fileName: `${item.application.slug}-${item.release.version}.zip`,
          size: 184_320,
          sha256: 'a'.repeat(64),
          status: item.release.status === 'rejected' ? 'rejected' : 'validated',
          validationEvidence: [],
        },
      ],
      reviews: [
        {
          id: crypto.randomUUID(),
          decision: item.release.status === 'rejected' ? 'reject' : 'approve',
          comment: item.release.status === 'rejected' ? 'Runtime entry is missing.' : 'Workspace review passed.',
          createdAt: item.release.createdAt,
        },
      ],
    };
  },

  listCatalog(workspaceId: string, channel: DeveloperCatalogEntry['channel']) {
    if (isTauriRuntime()) {
      return apiRequest<DeveloperCatalogEntry[]>(
        `/catalog?workspaceId=${encodeURIComponent(workspaceId)}&channel=${channel}&kind=desktop`,
      );
    }
    return Promise.resolve(
      structuredClone([...browserCatalog.values()].filter((entry) => entry.channel === channel)),
    );
  },

  async promote(input: {
    applicationId: string;
    releaseId: string;
    channel: DeveloperCatalogEntry['channel'];
    expectedCurrentReleaseId: string | null;
  }): Promise<DeveloperCatalogEntry> {
    if (isTauriRuntime()) {
      return apiRequest(
        `/applications/${encodeURIComponent(input.applicationId)}/channels/${input.channel}/promote`,
        {
          method: 'POST',
          body: {
            releaseId: input.releaseId,
            expectedCurrentReleaseId: input.expectedCurrentReleaseId,
          },
        },
      );
    }
    const version = browserReleases.find((item) => item.release.id === input.releaseId)?.release.version;
    if (!version) throw new Error('release_not_found');
    const value = { ...input, version };
    browserCatalog.set(`${input.applicationId}:${input.channel}`, value);
    return structuredClone(value);
  },

  async publishPackage(input: { applicationId: string; metadataPath: string }): Promise<DesktopPublishResult> {
    const result = await desktopHost.publishDesktopPackage(input);
    if (!isTauriRuntime()) {
      const application = browserApplications.find((candidate) => candidate.id === input.applicationId);
      if (application) {
        browserReleases.unshift({
          application,
          release: {
            id: result.releaseId,
            applicationId: application.id,
            version: result.version,
            status: result.status as DeveloperRelease['status'],
            createdAt: new Date().toISOString(),
            manifest: { kind: 'desktop', appId: application.slug, version: result.version },
            validationEvidence: [],
          },
          artifactCount: result.artifacts.length,
          reviewCount: 0,
        });
      }
    }
    return result;
  },

  async listRuns(workspaceId: string, applicationId?: string): Promise<DeveloperRun[]> {
    const values = isTauriRuntime()
      ? await apiRequest<DeveloperRun[]>(`/runs?workspaceId=${encodeURIComponent(workspaceId)}`)
      : browserRuns;
    return structuredClone(values.filter((run) => !applicationId || run.applicationId === applicationId));
  },
};
