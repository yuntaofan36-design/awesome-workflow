export type UpdateDescriptor = {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
};

export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'restart-required'
  | 'error';

export type DesktopUpdateState = {
  phase: UpdatePhase;
  update: UpdateDescriptor | null;
  downloadedBytes: number;
  contentLength: number | null;
  error: string | null;
};

export type DesktopUpdateEvent =
  | { type: 'check-started' }
  | { type: 'no-update' }
  | { type: 'update-available'; update: UpdateDescriptor }
  | { type: 'download-started'; contentLength?: number }
  | { type: 'download-progress'; chunkLength: number }
  | { type: 'download-finished' }
  | { type: 'install-started' }
  | { type: 'installed' }
  | { type: 'failed'; error: string };

export function createInitialUpdateState(runtimeAvailable: boolean): DesktopUpdateState {
  return {
    phase: runtimeAvailable ? 'idle' : 'unavailable',
    update: null,
    downloadedBytes: 0,
    contentLength: null,
    error: null,
  };
}

export function reduceDesktopUpdate(
  state: DesktopUpdateState,
  event: DesktopUpdateEvent,
): DesktopUpdateState {
  switch (event.type) {
    case 'check-started':
      return {
        ...state,
        phase: 'checking',
        update: null,
        downloadedBytes: 0,
        contentLength: null,
        error: null,
      };
    case 'no-update':
      return { ...state, phase: 'up-to-date', update: null, error: null };
    case 'update-available':
      return { ...state, phase: 'available', update: event.update, error: null };
    case 'download-started':
      return {
        ...state,
        phase: 'downloading',
        downloadedBytes: 0,
        contentLength: validLength(event.contentLength) ? event.contentLength : null,
        error: null,
      };
    case 'download-progress':
      return {
        ...state,
        phase: 'downloading',
        downloadedBytes: state.downloadedBytes + Math.max(0, event.chunkLength),
      };
    case 'download-finished':
      return { ...state, phase: 'downloaded' };
    case 'install-started':
      return { ...state, phase: 'installing', error: null };
    case 'installed':
      return { ...state, phase: 'restart-required', error: null };
    case 'failed':
      return { ...state, phase: 'error', error: event.error };
  }
}

export function updateProgressPercent(state: DesktopUpdateState): number | null {
  if (!state.contentLength || state.contentLength <= 0) return null;
  return Math.min(100, Math.round((state.downloadedBytes / state.contentLength) * 100));
}

export function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'installing';
}

function validLength(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
