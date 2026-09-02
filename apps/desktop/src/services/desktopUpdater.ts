import { relaunch } from '@tauri-apps/plugin-process';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';

import { isTauriRuntime } from '@/services/desktopHost';
import type { UpdateDescriptor } from '@/services/updateState';

export type UpdateDownloadEvent =
  | { type: 'started'; contentLength?: number }
  | { type: 'progress'; chunkLength: number }
  | { type: 'finished' };

let pendingUpdate: Update | null = null;

export const desktopUpdater = {
  check: async (): Promise<UpdateDescriptor | null> => {
    requireTauriRuntime();
    if (pendingUpdate) {
      await pendingUpdate.close();
      pendingUpdate = null;
    }
    const candidate = await check();
    if (!candidate) return null;
    pendingUpdate = candidate;
    return {
      currentVersion: candidate.currentVersion,
      version: candidate.version,
      ...(candidate.date ? { date: candidate.date } : {}),
      ...(candidate.body ? { body: candidate.body } : {}),
    };
  },
  download: async (onEvent: (event: UpdateDownloadEvent) => void): Promise<void> => {
    const update = requirePendingUpdate();
    await update.download((event) => onEvent(normalizeDownloadEvent(event)));
  },
  install: async (): Promise<void> => {
    const update = requirePendingUpdate();
    await update.install({ restartAfterInstall: false });
  },
  restart: async (): Promise<void> => {
    requireTauriRuntime();
    await relaunch();
  },
};

function normalizeDownloadEvent(event: DownloadEvent): UpdateDownloadEvent {
  switch (event.event) {
    case 'Started':
      return {
        type: 'started',
        ...(event.data.contentLength ? { contentLength: event.data.contentLength } : {}),
      };
    case 'Progress':
      return { type: 'progress', chunkLength: event.data.chunkLength };
    case 'Finished':
      return { type: 'finished' };
  }
}

function requirePendingUpdate(): Update {
  if (!pendingUpdate) throw new Error('Check for an update before downloading or installing it.');
  return pendingUpdate;
}

function requireTauriRuntime(): void {
  if (!isTauriRuntime()) throw new Error('Signed updates are unavailable in a browser preview.');
}
