const PRELOAD_RELOAD_STORAGE_KEY = 'aw:web-shell:preload-reload:v1';

export const PRELOAD_RELOAD_COOLDOWN_MS = 60_000;

type ReloadRecord = {
  attemptedAt: number;
  entryUrl: string;
};

export type PreloadReloadDecision = { reload: false } | { record: string; reload: true };

export function decidePreloadReload(
  storedRecord: string | null,
  entryUrl: string,
  now: number,
  cooldownMs = PRELOAD_RELOAD_COOLDOWN_MS,
): PreloadReloadDecision {
  const previous = parseReloadRecord(storedRecord);
  if (previous && now - previous.attemptedAt < cooldownMs) return { reload: false };
  const record: ReloadRecord = { attemptedAt: now, entryUrl };
  return { record: JSON.stringify(record), reload: true };
}

export function installVitePreloadErrorRecovery(entryUrl: string): () => void {
  const onPreloadError = (event: Event) => {
    let decision: PreloadReloadDecision;
    try {
      decision = decidePreloadReload(
        window.sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY),
        entryUrl,
        Date.now(),
      );
      if (!decision.reload) return;
      window.sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, decision.record);
    } catch {
      // Without durable storage an automatic reload could loop indefinitely.
      // Let the rejected lazy import reach the visible error boundary instead.
      return;
    }
    event.preventDefault();
    window.location.reload();
  };

  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}

function parseReloadRecord(value: string | null): ReloadRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ReloadRecord>;
    if (
      typeof parsed.attemptedAt !== 'number' ||
      !Number.isFinite(parsed.attemptedAt) ||
      typeof parsed.entryUrl !== 'string'
    ) {
      return null;
    }
    return { attemptedAt: parsed.attemptedAt, entryUrl: parsed.entryUrl };
  } catch {
    return null;
  }
}
